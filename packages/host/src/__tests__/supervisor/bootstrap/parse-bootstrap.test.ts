/**
 * Declarative-bootstrap PARSERS (pure) — `supervisor/bootstrap/parse-bootstrap.ts`.
 *
 * Covers (parse-don't-validate / fail-closed):
 *   - tenants: a valid JSON array → validated ActiveTenantConfig[]; the parsed
 *     config is byte-identical to the admin-HTTP path (shared parser); malformed
 *     JSON / non-array / idless / invalid id / invalid config / duplicate id all
 *     abort with a Left (no partial seed).
 *   - team tokens: a valid `team → fug_token` object → seeds with canonical teams;
 *     malformed JSON / non-object / array / bad team name / non-`fug_` token /
 *     non-string token / duplicate team all abort — and NO error message ever
 *     contains the token value (NFR-014).
 */

import { describe, it, expect } from "bun:test";
import { parseTenantsBootstrap, parseTeamTokensBootstrap } from "../../../supervisor/bootstrap/parse-bootstrap.js";
import { TOKEN_PREFIX } from "../../../domain/auth.js";

// A valid `fug_`-shaped token (prefix + 43 base64url chars) — high enough for the
// shape gate; the bytes are not real entropy (tests don't mint, they accept).
const FUG = (suffix: string): string => `${TOKEN_PREFIX}${suffix.padEnd(43, "A")}`;

const validTenant = (id: string): Record<string, unknown> => ({
  id,
  team: id,
  keycloakClientMapping: { realm: "fugue", clientId: `${id}-c`, agentClientIdsByDag: {} },
  fsRoot: `/srv/${id}`,
  dagsRoot: `/dags/${id}`,
  secretsRef: `/run/secrets/${id}.env`,
  admission: { maxConcurrentRuns: 2, maxQueuedRuns: 4 },
  eagerPin: false,
});

describe("parseTenantsBootstrap", () => {
  it("parses a valid array into validated active configs", () => {
    const raw = JSON.stringify([validTenant("alpha"), validTenant("beta")]);
    const r = parseTenantsBootstrap("tenants.json", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => c.id)).toEqual(["alpha", "beta"]);
    expect(r.value.every((c) => c.status === "active")).toBe(true);
    expect(r.value[0].dagsRoot).toBe("/dags/alpha");
  });

  it("canonicalizes the team to lowercase (parity with the admin/token paths)", () => {
    const raw = JSON.stringify([{ ...validTenant("alpha"), team: "Alpha" }]);
    const r = parseTenantsBootstrap("tenants.json", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0].team).toBe("alpha");
  });

  it("fails closed on malformed JSON", () => {
    const r = parseTenantsBootstrap("tenants.json", "{not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("config-invalid");
  });

  it("fails closed when the top level is not an array", () => {
    const r = parseTenantsBootstrap("tenants.json", JSON.stringify({ id: "alpha" }));
    expect(r.ok).toBe(false);
  });

  it("fails closed on an entry missing a string id", () => {
    const { id: _id, ...noId } = validTenant("alpha");
    const r = parseTenantsBootstrap("tenants.json", JSON.stringify([noId]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("config-invalid");
  });

  it("fails closed on an invalid tenant id (rejected by the id smart constructor)", () => {
    const r = parseTenantsBootstrap("tenants.json", JSON.stringify([{ ...validTenant("a"), id: "bad:id" }]));
    expect(r.ok).toBe(false);
  });

  it("fails closed on an invalid config (e.g. traversing dagsRoot)", () => {
    const r = parseTenantsBootstrap(
      "tenants.json",
      JSON.stringify([{ ...validTenant("alpha"), dagsRoot: "/dags/../etc" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("fails closed on a duplicate tenant id (ambiguous — never last-writer-wins)", () => {
    const raw = JSON.stringify([validTenant("alpha"), validTenant("alpha")]);
    const r = parseTenantsBootstrap("tenants.json", raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("duplicate");
  });

  it("an empty array is a valid empty seed", () => {
    const r = parseTenantsBootstrap("tenants.json", "[]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });
});

describe("parseTeamTokensBootstrap", () => {
  it("parses a valid team→token object into seeds with canonical teams", () => {
    const raw = JSON.stringify({ "business-sales": FUG("a"), Other: FUG("b") });
    const r = parseTeamTokensBootstrap("tokens.json", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((s) => s.team).sort()).toEqual(["business-sales", "other"]);
  });

  it("fails closed on malformed JSON", () => {
    const r = parseTeamTokensBootstrap("tokens.json", "nope");
    expect(r.ok).toBe(false);
  });

  it("fails closed when the top level is an array, not an object", () => {
    const r = parseTeamTokensBootstrap("tokens.json", JSON.stringify([FUG("a")]));
    expect(r.ok).toBe(false);
  });

  it("fails closed on an invalid team name", () => {
    const r = parseTeamTokensBootstrap("tokens.json", JSON.stringify({ "Bad Team!": FUG("a") }));
    expect(r.ok).toBe(false);
  });

  it("fails closed on a token without the fug_ shape", () => {
    const r = parseTeamTokensBootstrap("tokens.json", JSON.stringify({ "business-sales": "not-a-fug-token" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("config-invalid");
  });

  it("fails closed on a non-string token", () => {
    const r = parseTeamTokensBootstrap("tokens.json", JSON.stringify({ "business-sales": 12345 }));
    expect(r.ok).toBe(false);
  });

  it("fails closed on a duplicate team after canonicalization", () => {
    const r = parseTeamTokensBootstrap(
      "tokens.json",
      JSON.stringify({ "business-sales": FUG("a"), "Business-Sales": FUG("b") }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("duplicate");
  });

  it("NEVER includes the token value in an error message (NFR-014)", () => {
    const secret = FUG("super-secret-leak-canary");
    // Pair the canary token with an INVALID team so the parser fails on this entry.
    const r = parseTeamTokensBootstrap("tokens.json", JSON.stringify({ "Bad Team!": secret }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(secret);
    expect(r.error.message).not.toContain("super-secret-leak-canary");
  });

  it("an empty object is a valid empty seed", () => {
    const r = parseTeamTokensBootstrap("tokens.json", "{}");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });
});
