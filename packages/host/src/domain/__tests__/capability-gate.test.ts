/**
 * Tests for the pure capability gate (domain/capability-gate.ts): the broker's
 * fail-closed policy decision, checked as properties over arbitrary capability
 * names, assigned-scope sets and Dynamics org-host configuration.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { decideGate } from "../capability-gate.js";
import { audienceForScope, parseScope, scopeName } from "../capability-scope.js";

const KNOWN = ["msgraph:mail.send", "msgraph:sites.read", "dynamics:read"] as const;

/** Recognised scope names mixed with arbitrary (mostly unrecognised) capability names. */
const capabilityArb = fc.oneof(
  fc.constantFrom(...KNOWN),
  fc.string(),
  fc.tuple(fc.constantFrom("msgraph", "dynamics", "mycorp"), fc.string()).map(([p, o]) => `${p}:${o}`),
);
const assignedArb = fc
  .array(fc.oneof(fc.constantFrom(...KNOWN), fc.string()), { maxLength: 6 })
  .map((names) => new Set(names));
const orgHostArb = fc.option(fc.domain(), { nil: undefined });

describe("decideGate — properties", () => {
  it("passes through EXACTLY the names parseScope does not recognise (agrees with provides())", () => {
    fc.assert(
      fc.property(capabilityArb, assignedArb, orgHostArb, (capability, assigned, host) => {
        const isPassThrough = decideGate(capability, assigned, host).kind === "pass-through";
        expect(isPassThrough).toBe(parseScope(capability) === undefined);
      }),
    );
  });

  it("fails closed: a recognised scope missing from the assigned set is never gated, whatever the host", () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN), assignedArb, orgHostArb, (capability, assigned, host) => {
        const withoutIt = new Set([...assigned].filter((s) => s !== capability));
        const decision = decideGate(capability, withoutIt, host);
        expect(decision.kind === "refused" && decision.reason).toBe("scope-not-assigned");
        expect(decision.kind === "refused" && scopeName(decision.scope)).toBe(capability);
      }),
    );
  });

  it("a gated scope was assigned, round-trips its name and carries a defined audience", () => {
    fc.assert(
      fc.property(capabilityArb, assignedArb, orgHostArb, (capability, assigned, host) => {
        const decision = decideGate(capability, assigned, host);
        if (decision.kind !== "gated") return;
        expect(assigned.has(capability)).toBe(true);
        expect(scopeName(decision.scope)).toBe(capability);
        expect(audienceForScope(decision.scope, host)).toBe(decision.audience);
      }),
    );
  });

  it("granting more scopes never turns a gated capability into a refusal (monotone)", () => {
    fc.assert(
      fc.property(capabilityArb, assignedArb, assignedArb, orgHostArb, (capability, assigned, extra, host) => {
        if (decideGate(capability, assigned, host).kind !== "gated") return;
        const widened = new Set([...assigned, ...extra]);
        expect(decideGate(capability, widened, host).kind).toBe("gated");
      }),
    );
  });

  it("msgraph scopes never depend on the Dynamics org host", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("msgraph:mail.send", "msgraph:sites.read"),
        assignedArb,
        orgHostArb,
        (capability, assigned, host) => {
          expect(decideGate(capability, assigned, host)).toEqual(decideGate(capability, assigned, undefined));
        },
      ),
    );
  });
});

describe("decideGate — the refusal reasons and their order", () => {
  it("an assigned dynamics:read with no org host is refused as dynamics-org-host-unset (FR-042)", () => {
    expect(decideGate("dynamics:read", new Set(["dynamics:read"]), undefined)).toEqual({
      kind: "refused",
      scope: { provider: "dynamics", operation: "read" },
      reason: "dynamics-org-host-unset",
    });
  });

  it("an UNASSIGNED dynamics:read with no org host reports scope-not-assigned — the assignment check comes first", () => {
    const decision = decideGate("dynamics:read", new Set<string>(), undefined);
    expect(decision.kind === "refused" && decision.reason).toBe("scope-not-assigned");
  });

  it("an assigned dynamics:read with an org host is gated to that host", () => {
    expect(decideGate("dynamics:read", new Set(["dynamics:read"]), "org.crm4.dynamics.com")).toEqual({
      kind: "gated",
      scope: { provider: "dynamics", operation: "read" },
      audience: "https://org.crm4.dynamics.com",
    });
  });
});
