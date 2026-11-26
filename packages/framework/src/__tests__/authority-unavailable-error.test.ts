/**
 * `authority-unavailable` (AD-8, FR-015): the framework kind an identity
 * subsystem fails a capability acquisition with when the agent's authority for
 * a scope cannot be had — a missing federation grant, an unconfigured
 * authority leg, a federation rejection, a re-authorization the initiator
 * owes, a capability the run was never admitted for, or an admitted authority
 * the host no longer matches.
 *
 * Pinned here, through the public barrel where the surface is public:
 *   - the kinds list and the standalone kind marker know the kind;
 *   - every cause round-trips through the persisted wire schema, and the parse
 *     re-establishes the cause's own domain (closed reasons, a non-empty change
 *     list, `scope` = the first change's capability for `authority-changed`);
 *   - it is non-retriable for every cause;
 *   - the formatted text names the scope, agent client and cause, and never
 *     carries an injected sentinel or a credential field name (INV-3);
 *   - the framework barrel exports `runtimeNodeInventory`.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  asFrameworkError,
  authorityChangedError,
  formatFrameworkError,
  isFrameworkError,
  isFrameworkErrorKind,
  PersistedFrameworkErrorSchema,
  runtimeNodeInventory,
  type AuthorityChangedCapability,
  type AuthorityUnavailableCause,
  type AuthorityUnavailableError,
  type FrameworkError,
} from "../index.js";
import { FRAMEWORK_ERROR_KINDS, messageOf, retriabilityOf } from "../types/errors.js";
import { runtimeNodeInventory as sharedRuntimeNodeInventory } from "../shared/runtime-node-inventory.js";

// ---------------------------------------------------------------------------
// Generators — valid domain values only (property-testing.md).
// ---------------------------------------------------------------------------

/**
 * Capability, grant, key and client names. The alphabet has no upper case and
 * no underscore, so a name can never spell the sentinel or a credential field
 * name below: an occurrence in the formatted text can only be a leak.
 */
const nameArb = fc.stringMatching(/^[a-z][a-z0-9.:-]{0,23}$/);
/** A non-empty list: a cause naming nothing is unrepresentable. */
const nonEmptyArb = <T,>(item: fc.Arbitrary<T>): fc.Arbitrary<readonly [T, ...T[]]> =>
  fc.tuple(item, fc.array(item, { maxLength: 3 })).map(([first, rest]): readonly [T, ...T[]] => [first, ...rest]);
const namesArb = nonEmptyArb(nameArb);

const changeArb: fc.Arbitrary<AuthorityChangedCapability> = fc.record({
  capability: nameArb,
  change: fc.constantFrom("mode-changed", "removed", "newly-brokered", "resource-changed"),
});
const changesArb = nonEmptyArb(changeArb);

const causeArb: fc.Arbitrary<AuthorityUnavailableCause> = fc.oneof(
  namesArb.map((grants) => ({ kind: "federation-grant-missing" as const, grants })),
  namesArb.map((missing) => ({ kind: "authority-unconfigured" as const, missing })),
  fc
    .constantFrom("issuer", "subject", "audience", "unknown")
    .map((reason) => ({ kind: "federation-rejected" as const, reason })),
  fc
    .constantFrom("refused", "custody-expired", "custody-absent")
    .map((reason) => ({ kind: "reauthorization-required" as const, reason })),
  fc.constant({ kind: "capability-not-admitted" as const }),
  changesArb.map((changes) => ({ kind: "authority-changed" as const, changes })),
);

/** A well-formed error: an `authority-changed` cause is built through its owner. */
const errorArb: fc.Arbitrary<AuthorityUnavailableError> = fc
  .tuple(nameArb, nameArb, causeArb)
  .map(([scope, agentClientId, cause]) =>
    cause.kind === "authority-changed"
      ? authorityChangedError(agentClientId, cause.changes)
      : { kind: "authority-unavailable", scope, agentClientId, cause });

const SENTINEL = "SENTINEL-CREDENTIAL-7f3a";
const CREDENTIAL_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_assertion",
  "client_secret",
  "accessToken",
  "refreshToken",
  "clientAssertion",
] as const;

const viaWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** One example per cause, in declaration order. */
const examples: readonly AuthorityUnavailableError[] = [
  { kind: "authority-unavailable", scope: "graph:mail.send", agentClientId: "agent-a", cause: { kind: "federation-grant-missing", grants: ["entra-exchange", "graph:mail.send"] } },
  { kind: "authority-unavailable", scope: "graph:mail.send", agentClientId: "agent-a", cause: { kind: "authority-unconfigured", missing: ["ENTRA_TENANT_ID", "ENTRA_AGENT_IDENTITIES"] } },
  { kind: "authority-unavailable", scope: "graph:mail.send", agentClientId: "agent-a", cause: { kind: "federation-rejected", reason: "subject" } },
  { kind: "authority-unavailable", scope: "graph:mail.send", agentClientId: "agent-a", cause: { kind: "reauthorization-required", reason: "custody-expired" } },
  { kind: "authority-unavailable", scope: "graph:mail.send", agentClientId: "agent-a", cause: { kind: "capability-not-admitted" } },
  authorityChangedError("agent-a", [
    { capability: "graph:mail.send", change: "mode-changed" },
    { capability: "dynamics:accounts.read", change: "removed" },
  ]),
];

describe("authority-unavailable: the kinds list", () => {
  it("is a kind of the compiler-checked taxonomy and a valid standalone kind marker", () => {
    expect(FRAMEWORK_ERROR_KINDS).toContain("authority-unavailable");
    expect(isFrameworkErrorKind("authority-unavailable")).toBe(true);
  });

  it("the examples cover every cause kind exactly once", () => {
    expect(examples.map((e) => e.cause.kind)).toEqual([
      "federation-grant-missing",
      "authority-unconfigured",
      "federation-rejected",
      "reauthorization-required",
      "capability-not-admitted",
      "authority-changed",
    ]);
  });
});

describe("authority-unavailable: retriability", () => {
  it("is non-retriable for every cause (a settled authority answer; replay re-derives it)", () => {
    fc.assert(fc.property(errorArb, (e) => retriabilityOf(e) === "non-retriable"));
  });
});

describe("authority-unavailable: persisted wire schema", () => {
  it("every cause round-trips through JSON and the persisted schema unchanged", () => {
    fc.assert(
      fc.property(errorArb, (e) => {
        const parsed = PersistedFrameworkErrorSchema.safeParse(viaWire(e));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(e);
        // The in-hand value is already a FrameworkError, and recovery from the
        // wire gives back the same data.
        expect(isFrameworkError(e)).toBe(true);
        expect(asFrameworkError(viaWire(e))).toEqual(e);
      }),
    );
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown cause kind", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "made-up" } }],
    ["a federation-rejected reason outside the closed set", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "federation-rejected", reason: "expired" } }],
    ["a reauthorization-required reason outside the closed set", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "reauthorization-required", reason: "timeout" } }],
    ["an authority-changed cause with no change", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "authority-changed", changes: [] } }],
    ["an authority-changed change outside the closed set", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "authority-changed", changes: [{ capability: "s", change: "renamed" }] } }],
    ["an authority-changed scope that is not the first change's capability", { kind: "authority-unavailable", scope: "other", agentClientId: "a", cause: { kind: "authority-changed", changes: [{ capability: "s", change: "removed" }] } }],
    ["a missing agent client", { kind: "authority-unavailable", scope: "s", cause: { kind: "capability-not-admitted" } }],
    ["a missing scope", { kind: "authority-unavailable", agentClientId: "a", cause: { kind: "capability-not-admitted" } }],
    ["a missing cause", { kind: "authority-unavailable", scope: "s", agentClientId: "a" }],
    ["a federation-grant-missing cause naming no grant", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "federation-grant-missing", grants: [] } }],
    ["an authority-unconfigured cause naming no key", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "authority-unconfigured", missing: [] } }],
    ["a non-string grant", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "federation-grant-missing", grants: [1] } }],
    ["a non-string missing key", { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "authority-unconfigured", missing: [null] } }],
  ];
  for (const [label, record] of refused) {
    it(`refuses ${label}`, () => {
      expect(PersistedFrameworkErrorSchema.safeParse(record).success).toBe(false);
      expect(isFrameworkError(record)).toBe(false);
    });
  }

  it("drops a credential field smuggled onto a cause, so recovery never carries it forward", () => {
    fc.assert(
      fc.property(errorArb, fc.constantFrom(...CREDENTIAL_FIELDS), (e, field) => {
        const smuggled = { ...e, cause: Object.assign({}, e.cause, { [field]: SENTINEL }) };
        const recovered = asFrameworkError(viaWire(smuggled));
        expect(recovered).toEqual(e);
        expect(JSON.stringify(recovered)).not.toContain(SENTINEL);
        // The source is not the canonical value, so it does not narrow.
        expect(isFrameworkError(smuggled)).toBe(false);
      }),
    );
  });
});

describe("authority-unavailable: formatFrameworkError", () => {
  it("renders one distinct line per cause, naming the scope, the agent client and the cause's facts", () => {
    const lines = examples.map(formatFrameworkError);
    expect(new Set(lines).size).toBe(examples.length);
    for (const line of lines) {
      expect(line).toContain("'graph:mail.send'");
      expect(line).toContain("'agent-a'");
      expect(line).not.toContain("\n");
    }
    const [grant, unconfigured, rejected, reauth, notAdmitted, changed] = lines;
    expect(grant).toContain("entra-exchange, graph:mail.send");
    expect(unconfigured).toContain("ENTRA_TENANT_ID, ENTRA_AGENT_IDENTITIES");
    expect(rejected).toContain("subject");
    expect(reauth).toContain("custody-expired");
    expect(notAdmitted).toContain("not admitted");
    expect(changed).toContain("graph:mail.send (mode-changed)");
    expect(changed).toContain("dynamics:accounts.read (removed)");
  });

  it("never renders an injected sentinel or a credential field name, whatever the cause (INV-3)", () => {
    fc.assert(
      fc.property(errorArb, fc.constantFrom(...CREDENTIAL_FIELDS), (e, field) => {
        const smuggled: FrameworkError = Object.assign({}, e, {
          [field]: SENTINEL,
          cause: Object.assign({}, e.cause, { [field]: SENTINEL }),
        });
        const line = formatFrameworkError(smuggled);
        expect(line).not.toContain(SENTINEL);
        for (const name of CREDENTIAL_FIELDS) expect(line).not.toContain(name);
        expect(line).toContain(`'${e.scope}'`);
        expect(line).toContain(`'${e.agentClientId}'`);
      }),
    );
  });

  it("messageOf keeps the whole structured payload (retry-exhausted lastError)", () => {
    for (const e of examples) expect(messageOf(e)).toBe(JSON.stringify(e));
  });
});

describe("the types make a malformed failure unrepresentable", () => {
  it("an empty grant or key list, and an authority-changed scope written by hand, do not compile and do not parse", () => {
    // @ts-expect-error a federation-grant-missing cause names at least one grant
    const noGrant: AuthorityUnavailableCause = { kind: "federation-grant-missing", grants: [] };
    // @ts-expect-error an authority-unconfigured cause names at least one key
    const noKey: AuthorityUnavailableCause = { kind: "authority-unconfigured", missing: [] };
    // @ts-expect-error an authority-changed scope is derived from the first change, never written
    const mismatched: AuthorityUnavailableError = { kind: "authority-unavailable", scope: "other", agentClientId: "a", cause: { kind: "authority-changed", changes: [{ capability: "s", change: "removed" }] } };
    // @ts-expect-error even a matching literal is refused: only authorityChangedError mints the scope
    const handWritten: AuthorityUnavailableError = { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause: { kind: "authority-changed", changes: [{ capability: "s", change: "removed" }] } };

    for (const cause of [noGrant, noKey]) {
      const record = { kind: "authority-unavailable", scope: "s", agentClientId: "a", cause };
      expect(PersistedFrameworkErrorSchema.safeParse(record).success).toBe(false);
    }
    expect(PersistedFrameworkErrorSchema.safeParse(mismatched).success).toBe(false);
    // A matching record read from the wire is recovered as the one construction builds it.
    expect(asFrameworkError(viaWire(handWritten))).toEqual(authorityChangedError("a", [{ capability: "s", change: "removed" }]));
  });
});

describe("authorityChangedError — the one construction of an authority-changed failure", () => {
  it("takes its scope from the first change, and is a well-formed FrameworkError", () => {
    fc.assert(
      fc.property(nameArb, changesArb, (agent, changes) => {
        const e = authorityChangedError(agent, changes);
        expect(e.scope).toBe(changes[0].capability);
        expect(e.agentClientId).toBe(agent);
        expect(e.cause).toEqual({ kind: "authority-changed", changes });
        expect(isFrameworkError(e)).toBe(true);
      }),
    );
  });
});

describe("framework barrel", () => {
  it("exports runtimeNodeInventory, the same function the runtime preflight uses", () => {
    expect(runtimeNodeInventory).toBe(sharedRuntimeNodeInventory);
  });
});
