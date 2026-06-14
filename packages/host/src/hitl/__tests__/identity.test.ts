// identity.test.ts — identity (de)projection for durable runs (ADR-0060).
//
// `toPersistedIdentity` drops the live `user` identity's `canRunDag` closure (it
// can't survive JSON); `toExecIdentity` reconstructs the identity the WORKER uses
// to derive the run origin. SECURITY: a reconstructed `user` MUST get a
// fail-CLOSED `canRunDag` (always `false`) — execution never authorizes, so if
// any path ever consults it (it must not), it denies rather than silently grants.

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { canAccessDag } from "../../domain/auth.js";
import type { AuthIdentity } from "../../domain/auth.js";
import type { PersistedIdentity } from "../types.js";
import { toPersistedIdentity, toExecIdentity } from "../identity.js";

describe("toPersistedIdentity", () => {
  it("drops the canRunDag closure from a user identity, preserving sub/azp", () => {
    const live: AuthIdentity = { kind: "user", sub: "u-1", azp: "frontend", canRunDag: () => true };
    const persisted = toPersistedIdentity(live);
    expect(persisted).toEqual({ kind: "user", sub: "u-1", azp: "frontend" });
    // The persisted shape carries no closure — it round-trips through JSON.
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
  });

  it("preserves admin and team identities verbatim", () => {
    expect(toPersistedIdentity({ kind: "admin" })).toEqual({ kind: "admin" });
    expect(toPersistedIdentity({ kind: "team", team: "eng", label: "Eng" })).toEqual({
      kind: "team",
      team: "eng",
      label: "Eng",
    });
  });
});

describe("toExecIdentity — fail-closed reconstruction (SECURITY)", () => {
  it("reconstructs a user with a canRunDag that ALWAYS returns false", () => {
    const exec = toExecIdentity({ kind: "user", sub: "u-1", azp: "frontend" });
    expect(exec.kind).toBe("user");
    if (exec.kind !== "user") throw new Error("expected user");
    // Fail closed for ANY team — a regression flipping this to fail-open breaks here.
    fc.assert(
      fc.property(fc.string(), (dagTeam) => {
        expect(exec.canRunDag(dagTeam)).toBe(false);
      }),
    );
    // …and through the real authorization predicate the worker would consult.
    expect(canAccessDag(exec, "eng")).toBe(false);
    expect(canAccessDag(exec, exec.sub)).toBe(false); // not even "their own" team
  });

  it("restores the data fields (sub/azp) unchanged across the round-trip", () => {
    const persisted: PersistedIdentity = { kind: "user", sub: "u-42", azp: "console" };
    const exec = toExecIdentity(persisted);
    if (exec.kind !== "user") throw new Error("expected user");
    expect(exec.sub).toBe("u-42");
    expect(exec.azp).toBe("console");
  });

  it("admin and team round-trip data-identically (admin can run; team is team-scoped)", () => {
    const admin = toExecIdentity({ kind: "admin" });
    expect(admin).toEqual({ kind: "admin" });
    expect(canAccessDag(admin, "any-team")).toBe(true);

    const team = toExecIdentity({ kind: "team", team: "eng", label: "Eng" });
    expect(team).toEqual({ kind: "team", team: "eng", label: "Eng" });
    expect(canAccessDag(team, "eng")).toBe(true);
    expect(canAccessDag(team, "ops")).toBe(false);
  });
});

describe("identity round-trip — toPersisted ∘ toExec drops only the closure", () => {
  const liveArb: fc.Arbitrary<AuthIdentity> = fc.oneof(
    fc.constant<AuthIdentity>({ kind: "admin" }),
    fc.record({
      kind: fc.constant("team" as const),
      team: fc.string({ minLength: 1 }),
      label: fc.string(),
    }),
    fc.record({
      kind: fc.constant("user" as const),
      sub: fc.string({ minLength: 1 }),
      azp: fc.string({ minLength: 1 }),
      // Live closure value is irrelevant — it must be dropped, never persisted.
      canRunDag: fc.constant(() => true),
    }),
  );

  it("a live identity → persisted → exec preserves every DATA field", () => {
    fc.assert(
      fc.property(liveArb, (live) => {
        const persisted = toPersistedIdentity(live);
        const exec = toExecIdentity(persisted);
        // The exec identity's persisted projection equals the original's — i.e.
        // only the closure differs between live and reconstructed.
        expect(toPersistedIdentity(exec)).toEqual(persisted);
      }),
    );
  });

  it("a reconstructed user NEVER inherits a fail-open closure from the live one", () => {
    // Even when the original live identity authorized everything, the reconstruction
    // denies everything — proving the closure is severed, not carried.
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (sub, dagTeam) => {
        const live: AuthIdentity = { kind: "user", sub, azp: "x", canRunDag: () => true };
        const exec = toExecIdentity(toPersistedIdentity(live));
        expect(canAccessDag(exec, dagTeam)).toBe(false);
      }),
    );
  });
});
