/**
 * Tests for domain/auth.ts — pure auth logic.
 *
 * Covers:
 * - canAccessDag authorization rules
 * - Token generation (formatToken)
 * - Token hashing (hashToken — deterministic)
 * - Token shape validation (isTeamTokenShape)
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { Hono } from "hono";
import {
  canAccessDag,
  canonicalizeTeamName,
  canonicalTeam,
  formatToken,
  hashToken,
  isTeamTokenShape,
  markAuthenticatedUser,
  markTeam,
  TOKEN_PREFIX,
  TOKEN_MIN_LENGTH,
} from "../../domain/auth.js";
import type { AuthIdentity, AuthenticatedUser } from "../../domain/auth.js";

// The PRODUCTION run-authorization policy (host.ts wiring site, FR-021/FR-022):
// a STATELESS team-membership check against the verified token's `teams`. Pinned
// here so a refactor of the wiring can't silently widen it (e.g. to `() => true`,
// the allow-all AD-5 forbids). `canAccessDag`'s `user` branch delegates to a
// `canRunDag` closure the middleware builds as `(t) => authorizeUserRun(user, t)`.
const authorizeUserRun = (user: AuthenticatedUser, dagTeam: string): boolean =>
  user.teams.includes(dagTeam);

const userIdentity = (sub: string, teams: readonly string[]): AuthIdentity => {
  const user = markAuthenticatedUser({ sub, azp: "fugue-frontend", teams });
  return { kind: "user", sub, azp: "fugue-frontend", canRunDag: (t) => authorizeUserRun(user, t) };
};
import { createListTeamsHandler } from "../../http/handlers/admin/teams.js";
import { createInMemoryTokenStore } from "../../adapters/token-store.js";

describe("canAccessDag", () => {
  it("admin can access any team's DAGs", () => {
    const admin: AuthIdentity = { kind: "admin" };
    expect(canAccessDag(admin, "team-a")).toBe(true);
    expect(canAccessDag(admin, "team-b")).toBe(true);
    expect(canAccessDag(admin, "anything")).toBe(true);
  });

  it("team identity can access own DAGs", () => {
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "team-a")).toBe(true);
  });

  it("team identity cannot access other team's DAGs", () => {
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "team-b")).toBe(false);
  });

  it("team comparison is exact (case-sensitive) — canonicalization is the PRODUCERS' job, not the comparator's", () => {
    // `canAccessDag` is a pure comparator: BOTH sides must already be canonical.
    // Non-canonical raw strings (passed directly here, not via `canonicalTeam`)
    // correctly do NOT match — the ingestion boundaries (`canonicalTeam`) are what
    // guarantee real producers feed canonical values in.
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "Team-A")).toBe(false);
    expect(canAccessDag(identity, "TEAM-A")).toBe(false);
  });

  // PINNING TESTS for the user-run authorization seam (review C7.1, revised by
  // the pass-4 A19 fix): the user branch DELEGATES to the `canRunDag` policy
  // the identity carries — captured at the middleware from the REQUIRED
  // `RealmJwtDeps.authorizeUserRun`. Pin the delegation in both directions so
  // a refactor can't silently widen OR narrow it with a green suite.
  it("a user identity delegates to its canRunDag policy — permissive policy clears every team", () => {
    const user: AuthIdentity = { kind: "user", sub: "user-123", azp: "fugue-frontend", canRunDag: () => true };
    expect(canAccessDag(user, "team-a")).toBe(true);
    expect(canAccessDag(user, "team-b")).toBe(true);
    expect(canAccessDag(user, "any-team")).toBe(true);
  });

  it("a user identity delegates to its canRunDag policy — team-scoped policy refuses other teams", () => {
    const teams: string[] = [];
    const user: AuthIdentity = {
      kind: "user",
      sub: "user-123",
      azp: "fugue-frontend",
      canRunDag: (dagTeam) => {
        teams.push(dagTeam);
        return dagTeam === "team-a";
      },
    };
    expect(canAccessDag(user, "team-a")).toBe(true);
    expect(canAccessDag(user, "team-b")).toBe(false);
    // The policy was consulted with the actual dagTeam, not bypassed.
    expect(teams).toEqual(["team-a", "team-b"]);
  });

  it("a user identity is NOT admin-equivalent — the real admin guard rejects it with 403", async () => {
    // A user cleared by its run policy must not be read as admin power:
    // `canAccessDag` is only the RUN gate. Pin the distinction by driving
    // the ACTUAL handler-level admin guard (`requireAdmin` inside the admin team
    // handlers — the same `kind === "admin"` predicate the router's /admin/*
    // middleware applies as defense-in-depth) with a user identity.
    const user: AuthIdentity = { kind: "user", sub: "u", azp: "fugue-frontend", canRunDag: () => true };
    expect(canAccessDag(user, "team-a")).toBe(true); // run gate clears…

    const app = new Hono<{ Variables: { authIdentity: AuthIdentity } }>();
    app.use("*", async (c, next) => {
      c.set("authIdentity", user);
      await next();
    });
    app.get(
      "/admin/teams",
      createListTeamsHandler({
        tokenStore: createInMemoryTokenStore([]),
        clock: () => 0,
        generateRandomBytes: () => new Uint8Array(32),
      }),
    );

    const res = await app.request("/admin/teams");
    expect(res.status).toBe(403); // …but admin scope is refused
    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });
});

// ── Team canonicalization (the single ingestion-boundary rule) ───────────────
describe("canonicalizeTeamName / canonicalTeam", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(canonicalizeTeamName("  Team-A  ")).toBe("team-a");
    expect(canonicalizeTeamName("TEAM-A")).toBe("team-a");
    expect(canonicalizeTeamName("team-a")).toBe("team-a"); // already canonical → unchanged
  });

  it("canonicalTeam brands the canonical form so it === a write-side team", () => {
    // The write side stores `markTeam(canonicalizeTeamName(...))`; an ingestion
    // value of any casing must produce the SAME branded Team that registration did.
    expect(canonicalTeam("Team-A")).toBe(markTeam("team-a"));
    expect(canonicalTeam("  team-a  ")).toBe(markTeam("team-a"));
  });

  it("a non-canonical ingestion team now AUTHORIZES against its canonical registration (the fixed bug)", () => {
    // Before the fix a JWT/DAG team `"Team-A"` was branded verbatim and `===`
    // mismatched a tenant registered as `"team-a"` → wrongful 403. Routing the
    // ingestion value through `canonicalTeam` closes that mismatch.
    const registered = markTeam("team-a"); // what the write path stores
    const fromJwtClaim = canonicalTeam("Team-A"); // what the ingestion boundary now brands
    const identity: AuthIdentity = { kind: "team", team: fromJwtClaim, label: "Team A" };
    expect(canAccessDag(identity, registered)).toBe(true);
  });

  it("is idempotent (canonical of canonical is canonical)", () => {
    const once = canonicalizeTeamName("  MixedCase  ");
    expect(canonicalizeTeamName(once)).toBe(once);
  });
});

// ── authorizeUserRun (FR-021/FR-022) — stateless team-membership check ───────
describe("authorizeUserRun (user-run authorization policy)", () => {
  const user = (teams: readonly string[]): AuthenticatedUser =>
    markAuthenticatedUser({ sub: "user-1", azp: "fugue-frontend", teams });

  it("member → true", () => {
    expect(authorizeUserRun(user(["team-a", "team-b"]), "team-a")).toBe(true);
    expect(authorizeUserRun(user(["team-a", "team-b"]), "team-b")).toBe(true);
  });

  it("non-member → false", () => {
    expect(authorizeUserRun(user(["team-a"]), "team-b")).toBe(false);
  });

  it("a user with no teams is denied every team (fail-closed)", () => {
    expect(authorizeUserRun(user([]), "team-a")).toBe(false);
    expect(authorizeUserRun(user([]), "")).toBe(false);
  });

  it("membership is exact (case-sensitive — no substring/prefix match)", () => {
    expect(authorizeUserRun(user(["team-a"]), "Team-A")).toBe(false);
    expect(authorizeUserRun(user(["team-alpha"]), "team-al")).toBe(false);
  });
});

// ── SC-005: a user NOT in a DAG's team is denied BY canAccessDag ─────────────
// Property: for ANY user whose `teams` does NOT include `dagTeam`,
// `canAccessDag` is false. `canAccessDag` is called BEFORE concurrency/slot
// acquisition in the run path (run-dag.ts), so this denial precedes admission.
describe("SC-005 — non-member is denied (property)", () => {
  it("∀ user, dagTeam: dagTeam ∉ user.teams ⇒ canAccessDag(user, dagTeam) === false", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string()),
        fc.string(),
        (teams, dagTeam) => {
          fc.pre(!teams.includes(dagTeam)); // precondition: user is NOT in the DAG's team
          return canAccessDag(userIdentity("user-x", teams), dagTeam) === false;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("∀ user, dagTeam: dagTeam ∈ user.teams ⇒ canAccessDag(user, dagTeam) === true (complement)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1 }),
        (teams) => {
          // Pick a member team so membership holds, and assert access is granted.
          const dagTeam = teams[0]!;
          return canAccessDag(userIdentity("user-y", teams), dagTeam) === true;
        },
      ),
      { numRuns: 1000 },
    );
  });

  // Deterministic boundary example pinning the empty-`dagTeam` corner the
  // property test only reaches stochastically: a user with NO teams must be
  // denied even the empty-string team (`[].includes("") === false`). A
  // regression that special-cased `""` (e.g. treating it as "any team") would
  // leave the property green-ish while this example caught it immediately.
  it("a teamless user is denied the empty-string dagTeam (boundary example)", () => {
    expect(canAccessDag(userIdentity("u", []), "")).toBe(false);
  });
});

describe("formatToken", () => {
  it("starts with the token prefix", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it("is at least TOKEN_MIN_LENGTH long", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(token.length).toBeGreaterThanOrEqual(TOKEN_MIN_LENGTH);
  });

  it("produces different tokens for different random bytes", () => {
    const bytes1 = crypto.getRandomValues(new Uint8Array(32));
    const bytes2 = crypto.getRandomValues(new Uint8Array(32));
    const token1 = formatToken(bytes1);
    const token2 = formatToken(bytes2);
    expect(token1).not.toBe(token2);
  });

  it("is deterministic for same input", () => {
    const bytes = new Uint8Array(32).fill(42);
    const token1 = formatToken(bytes);
    const token2 = formatToken(bytes);
    expect(token1).toBe(token2);
  });

  it("contains only URL-safe characters", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    // base64url: [A-Za-z0-9_-] plus the prefix
    expect(token).toMatch(/^fug_[A-Za-z0-9_-]+$/);
  });

  // The TeamToken brand encodes "carries full entropy" — producing one from a
  // wrong-length input would forge the brand at its origin, so the guard
  // throws (a wiring bug, not a runtime input).
  it("throws on too-few random bytes (31) — never silently mints a weak token", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(31));
    expect(() => formatToken(bytes)).toThrow(/expected 32 random bytes, got 31/);
  });

  it("throws on too-many random bytes (33) — the brand demands exactly 32", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(() => formatToken(bytes)).toThrow(/expected 32 random bytes, got 33/);
  });

  it("throws on empty input", () => {
    expect(() => formatToken(new Uint8Array(0))).toThrow(/expected 32 random bytes, got 0/);
  });
});

describe("hashToken", () => {
  it("returns a hex string", async () => {
    const hash = await hashToken("test-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  it("is deterministic", async () => {
    const hash1 = await hashToken("same-input");
    const hash2 = await hashToken("same-input");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });
});

describe("isTeamTokenShape", () => {
  it("returns true for valid token shape", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(isTeamTokenShape(token)).toBe(true);
  });

  it("returns false for string without prefix", () => {
    expect(isTeamTokenShape("no-prefix-token-that-is-long-enough")).toBe(false);
  });

  it("returns false for too-short string with prefix", () => {
    expect(isTeamTokenShape("fug_short")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTeamTokenShape("")).toBe(false);
  });
});
