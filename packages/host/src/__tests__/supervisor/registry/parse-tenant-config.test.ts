/**
 * Shared tenant-config WRITE-BOUNDARY parser — `parseTenantConfigBody`
 * (`supervisor/registry/parse-tenant-config.ts`).
 *
 * This is the ONE validated parser both write paths (admin HTTP + declarative
 * bootstrap) funnel through, so a config registered over HTTP and the identical
 * config seeded from the bootstrap file produce a byte-identical
 * `ActiveTenantConfig`. These tests pin the parse boundary's fail-closed
 * branches directly (the bootstrap-array wrapper is covered in
 * `bootstrap/parse-bootstrap.test.ts`; here we exercise the shared parser itself
 * with an already-branded `TenantId`):
 *   - `agentClientIdsByDag` rejects ANY non-string value (never cast through);
 *   - prototype-laden bodies/maps do not pollute and do not throw (own-
 *     enumerable iteration only, fail-closed when the smuggled value is non-
 *     string);
 *   - blank/missing secretsRef, blank/missing dagsRoot, non-number / negative /
 *     non-integer admission limits, missing team, team canonicalization
 *     (`.trim().toLowerCase()`), and the valid happy path.
 *
 * Plus two `fast-check` PROPERTY invariants the module docstring asserts:
 *   - SC-009 idempotence: re-parsing an arbitrary VALID body yields a
 *     deeply-equal `ActiveTenantConfig` (deterministic, no hidden state);
 *   - team canonicalization is stable across casing/whitespace variants.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { parseTenantConfigBody } from "../../../supervisor/registry/parse-tenant-config.js";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { canonicalizeTeamName } from "../../../domain/auth.js";

// Brand a tenant id through its real smart constructor (the seam that validates
// the shape). Throws if a test ever passes a malformed id — a test-author error.
const id = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test fixture used an invalid tenant id "${s}"`);
  return r.value;
};

const ALPHA = id("alpha");

/** A minimal, VALID body (object-shaped, every required field present). */
const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  team: "alpha",
  keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: {} },
  fsRoot: "/srv/alpha",
  dagsRoot: "/dags/alpha",
  secretsRef: "/run/secrets/alpha.env",
  admission: { maxConcurrentRuns: 2, maxQueuedRuns: 4 },
  eagerPin: false,
  ...overrides,
});

describe("parseTenantConfigBody — happy path", () => {
  it("parses a valid body into an active config (byte-identical shared boundary)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("active");
    expect(r.value.id).toBe(ALPHA);
    expect(r.value.team).toBe("alpha");
    expect(r.value.dagsRoot).toBe("/dags/alpha");
    expect(r.value.secretsRef).toBe("/run/secrets/alpha.env");
    expect(r.value.admission).toEqual({ maxConcurrentRuns: 2, maxQueuedRuns: 4 });
    expect(r.value.keycloakClientMapping.agentClientIdsByDag).toEqual({});
  });

  it("carries a populated agentClientIdsByDag through unchanged (all-string map)", () => {
    const r = parseTenantConfigBody(
      ALPHA,
      validBody({
        keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: { reportgen: "agent-rg", etl: "agent-etl" } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.keycloakClientMapping.agentClientIdsByDag).toEqual({ reportgen: "agent-rg", etl: "agent-etl" });
  });
});

describe("parseTenantConfigBody — body shape", () => {
  it("rejects a non-object body (fail-closed at the trust boundary)", () => {
    for (const bad of [null, 42, "a string", true, undefined]) {
      const r = parseTenantConfigBody(ALPHA, bad);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
    }
  });
});

describe("parseAgentClientIdsByDag — non-string values are rejected, never cast through", () => {
  it("rejects a present map containing a non-string value (number)", () => {
    const r = parseTenantConfigBody(
      ALPHA,
      validBody({ keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: { somedag: 99 } } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The non-string must surface as a parse rejection (→ 400), NEVER as a
    // value cast through into the registry.
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("agentClientIdsByDag");
    expect(r.error.message).toContain("somedag");
  });

  it("rejects EVERY non-string value kind (number, boolean, null, array, object)", () => {
    const nonStrings: readonly unknown[] = [99, true, false, null, [], ["x"], { nested: "y" }, 3.14];
    for (const value of nonStrings) {
      const r = parseTenantConfigBody(
        ALPHA,
        validBody({ keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: { somedag: value } } }),
      );
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
    }
  });

  it("a non-object agentClientIdsByDag fails closed to an empty map (registry is the authority on emptiness)", () => {
    // A non-object (here a string) resolves to an empty map; the registry then
    // accepts an empty map, so the overall parse succeeds with `{}`.
    const r = parseTenantConfigBody(
      ALPHA,
      validBody({ keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: "not-an-object" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.keycloakClientMapping.agentClientIdsByDag).toEqual({});
  });
});

describe("parseAgentClientIdsByDag — prototype-pollution safety (own-enumerable only)", () => {
  it("does not pollute and does not throw for a JSON __proto__ map key (smuggled object value → fail-closed reject)", () => {
    // `JSON.parse` materialises `__proto__` as an OWN enumerable property (not the
    // prototype setter), so `Object.entries` iterates it. Its value here is an
    // object (non-string), so the parser REJECTS it — the smuggled value never
    // becomes a client id.
    const body = JSON.parse('{"team":"alpha","keycloakClientMapping":{"realm":"fugue","clientId":"alpha-c","agentClientIdsByDag":{"__proto__":{"x":"y"}}},"fsRoot":"/srv/alpha","dagsRoot":"/dags/alpha","secretsRef":"/run/secrets/alpha.env","admission":{"maxConcurrentRuns":2,"maxQueuedRuns":4},"eagerPin":false}');

    let r: ReturnType<typeof parseTenantConfigBody> | undefined;
    expect(() => {
      r = parseTenantConfigBody(ALPHA, body);
    }).not.toThrow();

    // No prototype pollution leaked into Object.prototype.
    expect(({} as Record<string, unknown>).x).toBeUndefined();

    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("an object-LITERAL __proto__ map key is a prototype-set (0 own keys) → clean empty map, no pollution", () => {
    // In an object literal, the NON-COMPUTED `__proto__:` sets the map object's
    // prototype rather than creating an own key, so the map has zero own
    // enumerable properties — `Object.entries` iterates none and the parser
    // produces a clean empty map. Nothing is smuggled, and the global
    // `Object.prototype` is untouched.
    const map = { __proto__: { x: "y" } } as Record<string, unknown>;
    expect(Object.keys(map)).toEqual([]); // prototype-set, not an own key
    const body = validBody({
      keycloakClientMapping: { realm: "fugue", clientId: "alpha-c", agentClientIdsByDag: map },
    });
    const r = parseTenantConfigBody(ALPHA, body);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.keycloakClientMapping.agentClientIdsByDag).toEqual({});
  });

  it("a body whose own key is __proto__ does not pollute and is ignored (parser reads only named fields)", () => {
    // JSON `__proto__` on the BODY is an own enumerable key, but the parser only
    // reads the fields it names (team, secretsRef, …) — the stray key is inert.
    const body = JSON.parse('{"__proto__":{"x":"y"},"team":"alpha","keycloakClientMapping":{"realm":"fugue","clientId":"alpha-c","agentClientIdsByDag":{}},"fsRoot":"/srv/alpha","dagsRoot":"/dags/alpha","secretsRef":"/run/secrets/alpha.env","admission":{"maxConcurrentRuns":2,"maxQueuedRuns":4},"eagerPin":false}');

    let r: ReturnType<typeof parseTenantConfigBody> | undefined;
    expect(() => {
      r = parseTenantConfigBody(ALPHA, body);
    }).not.toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();

    expect(r?.ok).toBe(true);
    if (!r || !r.ok) return;
    expect(r.value.team).toBe("alpha");
  });

  it("a JSON __proto__ map key with a STRING value parses cleanly as a (oddly-named) dag mapping, no pollution", () => {
    // Own enumerable, string value → it is a legitimate (if oddly-named)
    // dag→clientId entry. The point of this case: it never touches the real
    // prototype.
    const body = JSON.parse('{"team":"alpha","keycloakClientMapping":{"realm":"fugue","clientId":"alpha-c","agentClientIdsByDag":{"__proto__":"agent-x"}},"fsRoot":"/srv/alpha","dagsRoot":"/dags/alpha","secretsRef":"/run/secrets/alpha.env","admission":{"maxConcurrentRuns":2,"maxQueuedRuns":4},"eagerPin":false}');
    const r = parseTenantConfigBody(ALPHA, body);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.value.keycloakClientMapping.agentClientIdsByDag)).toBe(Object.prototype);
  });
});

describe("parseTenantConfigBody — secretsRef (required, non-blank)", () => {
  it("rejects a missing secretsRef", () => {
    const { secretsRef: _s, ...rest } = validBody();
    const r = parseTenantConfigBody(ALPHA, rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("secretsRef");
  });

  it("rejects a blank / whitespace-only secretsRef", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ secretsRef: blank }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
    }
  });

  it("rejects a non-string secretsRef (treated as absent)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ secretsRef: 123 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("trims a surrounding-whitespace secretsRef before branding", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ secretsRef: "  /run/secrets/alpha.env  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.secretsRef).toBe("/run/secrets/alpha.env");
  });
});

describe("parseTenantConfigBody — dagsRoot (required, confined absolute path)", () => {
  it("rejects a missing dagsRoot", () => {
    const { dagsRoot: _d, ...rest } = validBody();
    const r = parseTenantConfigBody(ALPHA, rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("dagsRoot");
  });

  it("rejects a blank dagsRoot", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ dagsRoot: "   " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("rejects a traversing dagsRoot (registry confined-path check → translated to tenant-config-invalid)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ dagsRoot: "/dags/../etc" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("trims a surrounding-whitespace dagsRoot", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ dagsRoot: "  /dags/alpha  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dagsRoot).toBe("/dags/alpha");
  });
});

describe("parseTenantConfigBody — admission limits (numbers, non-negative integers)", () => {
  it("rejects a missing admission object", () => {
    const { admission: _a, ...rest } = validBody();
    const r = parseTenantConfigBody(ALPHA, rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("admission");
  });

  it("rejects non-number admission limits (never Number()-coerced)", () => {
    const badPairs: ReadonlyArray<readonly [unknown, unknown]> = [
      ["5", 4],
      [2, "4"],
      [true, 4],
      [2, null],
      [[], 4],
      [2, undefined],
    ];
    for (const [maxConcurrentRuns, maxQueuedRuns] of badPairs) {
      const r = parseTenantConfigBody(ALPHA, validBody({ admission: { maxConcurrentRuns, maxQueuedRuns } }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
    }
  });

  it("rejects negative admission limits (registry non-negative-integer check → tenant-config-invalid)", () => {
    for (const adm of [{ maxConcurrentRuns: -1, maxQueuedRuns: 4 }, { maxConcurrentRuns: 2, maxQueuedRuns: -3 }]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ admission: adm }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
    }
  });

  it("rejects non-integer (fractional) admission limits", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ admission: { maxConcurrentRuns: 2.5, maxQueuedRuns: 4 } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("accepts zero limits (a valid non-negative integer)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ admission: { maxConcurrentRuns: 0, maxQueuedRuns: 0 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.admission).toEqual({ maxConcurrentRuns: 0, maxQueuedRuns: 0 });
  });
});

describe("parseTenantConfigBody — team", () => {
  it("rejects a missing team (parse-boundary non-empty-team check → tenant-config-invalid)", () => {
    const { team: _t, ...rest } = validBody();
    const r = parseTenantConfigBody(ALPHA, rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("team");
  });

  it("rejects a non-string team (treated as empty)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ team: 42 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
  });

  it("canonicalizes the team to .trim().toLowerCase() (parity with the admin + token paths)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ team: "  AlPhA  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.team).toBe("alpha");
  });

  it("rejects a whitespace-only team (canonicalizes to empty → tenant-config-invalid)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ team: "   " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("team");
  });
});

describe("parseTenantConfigBody — fsRoot", () => {
  it("rejects a missing fsRoot (parse-boundary non-empty check → tenant-config-invalid)", () => {
    const { fsRoot: _f, ...rest } = validBody();
    const r = parseTenantConfigBody(ALPHA, rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("fsRoot");
  });

  it("rejects a non-string fsRoot (treated as empty)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ fsRoot: 42 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("fsRoot");
  });

  it("rejects a whitespace-only fsRoot (trimmed to empty → tenant-config-invalid)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ fsRoot: "   " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant-config-invalid");
    expect(r.error.message).toContain("fsRoot");
  });

  it("trims surrounding whitespace from a valid fsRoot (symmetry with dagsRoot/secretsRef)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ fsRoot: "  /srv/alpha  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fsRoot).toBe("/srv/alpha");
  });
});

describe("parseTenantConfigBody — keycloak realm/clientId (required, non-blank, parse-boundary)", () => {
  it("rejects a blank / whitespace-only realm at the parse boundary, naming the field", () => {
    for (const realm of ["", "   ", "\t\n"]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ keycloakClientMapping: { realm, clientId: "alpha-c", agentClientIdsByDag: {} } }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
      expect(r.error.message).toContain("realm");
    }
  });

  it("rejects a blank / whitespace-only clientId at the parse boundary, naming the field", () => {
    for (const clientId of ["", "   ", "\t\n"]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ keycloakClientMapping: { realm: "fugue", clientId, agentClientIdsByDag: {} } }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
      expect(r.error.message).toContain("clientId");
    }
  });

  it("rejects a NON-STRING realm at the boundary (not coerced to \"\" and mis-reported by the registry)", () => {
    // The gap this closes: a non-string realm (e.g. `123`) was previously coerced
    // to "" and only rejected later by the registry as "non-empty", which
    // misdescribes the actual fault. It must be rejected HERE, naming realm.
    for (const realm of [123, true, null, [], { x: "y" }]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ keycloakClientMapping: { realm, clientId: "alpha-c", agentClientIdsByDag: {} } }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
      expect(r.error.message).toContain("realm");
    }
  });

  it("rejects a NON-STRING clientId at the boundary, naming clientId", () => {
    for (const clientId of [123, true, null, [], { x: "y" }]) {
      const r = parseTenantConfigBody(ALPHA, validBody({ keycloakClientMapping: { realm: "fugue", clientId, agentClientIdsByDag: {} } }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("tenant-config-invalid");
      expect(r.error.message).toContain("clientId");
    }
  });

  it("trims surrounding whitespace from a valid realm/clientId (symmetry with the other path fields)", () => {
    const r = parseTenantConfigBody(ALPHA, validBody({ keycloakClientMapping: { realm: "  fugue  ", clientId: "  alpha-c  ", agentClientIdsByDag: {} } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.keycloakClientMapping.realm).toBe("fugue");
    expect(r.value.keycloakClientMapping.clientId).toBe("alpha-c");
  });
});

// ── Property invariants (fast-check) ─────────────────────────────────────────

/** A path segment that never contains `/`, `..`, NUL, or whitespace surprises. */
const segment = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,15}$/);

/** An arbitrary VALID tenant-config body wired to the real required shape. */
const validBodyArb = fc.record({
  team: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
  realm: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
  clientId: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
  agentClientIdsByDag: fc.dictionary(segment, segment.filter((s) => s.length > 0), { maxKeys: 4 }),
  fsRoot: segment.map((s) => `/srv/${s}`),
  dagsRoot: segment.map((s) => `/dags/${s}`),
  secretsRef: segment.map((s) => `/run/secrets/${s}.env`),
  maxConcurrentRuns: fc.nat({ max: 1000 }),
  maxQueuedRuns: fc.nat({ max: 1000 }),
  eagerPin: fc.boolean(),
}).map((f) => ({
  team: f.team,
  keycloakClientMapping: { realm: f.realm, clientId: f.clientId, agentClientIdsByDag: f.agentClientIdsByDag },
  fsRoot: f.fsRoot,
  dagsRoot: f.dagsRoot,
  secretsRef: f.secretsRef,
  admission: { maxConcurrentRuns: f.maxConcurrentRuns, maxQueuedRuns: f.maxQueuedRuns },
  eagerPin: f.eagerPin,
}));

describe("parseTenantConfigBody — property: SC-009 idempotent / deterministic parse", () => {
  it("re-parsing the SAME valid body yields a deeply-equal ActiveTenantConfig", () => {
    fc.assert(
      fc.property(validBodyArb, (body) => {
        const a = parseTenantConfigBody(ALPHA, body);
        const b = parseTenantConfigBody(ALPHA, body);
        // A valid body always parses ok…
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        // …and the cross-path / re-parse result is deeply equal (deterministic,
        // no hidden state) — the structural-equality SC-009 idempotency relies on
        // this byte-identical output from the shared parser.
        expect(b.value).toEqual(a.value);
        // The id flows through unchanged regardless of body content.
        expect(a.value.id).toBe(ALPHA);
      }),
    );
  });
});

describe("parseTenantConfigBody — property: team canonicalization is stable", () => {
  // Use the PRODUCTION canonicalization rule (not a re-inlined `.trim().toLowerCase()`),
  // so this property honours the single-source-of-truth invariant it asserts — if the
  // rule ever changes, the test moves with it instead of silently drifting.
  const canonicalize = canonicalizeTeamName;

  it("parse(team) equals parse(canonicalize(team)) for arbitrary casing/whitespace variants", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        fc.array(fc.constantFrom(" ", "\t", "\n"), { maxLength: 4 }),
        fc.array(fc.constantFrom(" ", "\t", "\n"), { maxLength: 4 }),
        (base, leading, trailing) => {
          // Randomly re-case the base team, then pad with whitespace — the parsed
          // canonical team must be identical to parsing the already-canonical form.
          const recased = base
            .split("")
            .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
            .join("");
          const variant = `${leading.join("")}${recased}${trailing.join("")}`;

          const fromVariant = parseTenantConfigBody(ALPHA, validBody({ team: variant }));
          const fromCanonical = parseTenantConfigBody(ALPHA, validBody({ team: canonicalize(variant) }));

          expect(fromVariant.ok).toBe(true);
          expect(fromCanonical.ok).toBe(true);
          if (!fromVariant.ok || !fromCanonical.ok) return;
          expect(fromVariant.value.team).toBe(canonicalize(variant) as typeof fromVariant.value.team);
          expect(fromVariant.value.team).toBe(fromCanonical.value.team);
        },
      ),
    );
  });
});
