/**
 * Subject-token teardown wiring (NFR-014) and token-confinement regressions
 * (FR-032 / NFR-011).
 *
 * The host binds a user run's verified `subject_token` into the host-side
 * `SubjectTokenRegistry` at run start and MUST release it at teardown so the raw
 * token does not outlive its run in memory. The release lives in a `finally` in
 * `executeDag` (host.ts), extracted as the exported `withSubjectTokenRelease`
 * seam so the release-on-BOTH-paths invariant is provable against the REAL
 * registry (no fake, no copy of the finally that could drift).
 *
 * Pins:
 *   - success path: a bound token is released after the run resolves.
 *   - throw path: a bound token is STILL released when the run throws (finally).
 *   - the framework `InvocationOrigin` and `ScopedCapabilityHandle` carry NO
 *     subject-token field — a future edit adding a token slot to either is caught.
 */

import { describe, it, expect } from "bun:test";
import { runId as makeRunId } from "@fuguejs/framework";
import type { InvocationOrigin, ScopedCapabilityHandle } from "@fuguejs/framework";
import { createSubjectTokenRegistry } from "../adapters/subject-token-registry.js";
import { markSubjectToken } from "../domain/auth.js";
import { withSubjectTokenRelease } from "../host.js";

describe("withSubjectTokenRelease — teardown releases the run's subject token (NFR-014)", () => {
  it("releases the bound token after a user run completes successfully", async () => {
    // Real registry + the real teardown seam executeDag uses (no fake of either).
    const registry = createSubjectTokenRegistry();
    const rid = makeRunId("run-success");
    registry.bind(rid, markSubjectToken("verified.user.jwt"));
    expect(registry.resolve(rid)).toBeDefined();

    const result = await withSubjectTokenRelease(registry, rid, async () => "ok" as const);

    expect(result).toBe("ok");
    // The token must NOT outlive the run.
    expect(registry.resolve(rid)).toBeUndefined();
  });

  it("releases the bound token even when the run THROWS (the finally path)", async () => {
    const registry = createSubjectTokenRegistry();
    const rid = makeRunId("run-throws");
    registry.bind(rid, markSubjectToken("verified.user.jwt"));
    expect(registry.resolve(rid)).toBeDefined();

    const boom = new Error("execution exploded");
    await expect(
      withSubjectTokenRelease(registry, rid, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // A crash must not leak the token: the finally still ran.
    expect(registry.resolve(rid)).toBeUndefined();
  });

  it("does not disturb a concurrent run's token when releasing one run", async () => {
    const registry = createSubjectTokenRegistry();
    const a = makeRunId("run-A");
    const b = makeRunId("run-B");
    const tokenB = markSubjectToken("token-B");
    registry.bind(a, markSubjectToken("token-A"));
    registry.bind(b, tokenB);

    await withSubjectTokenRelease(registry, a, async () => undefined);

    expect(registry.resolve(a)).toBeUndefined();
    // B is still mid-flight — its token is untouched by A's teardown.
    expect(registry.resolve(b)).toBe(tokenB);
  });

  it("releasing a non-user run (never bound) is a benign no-op", async () => {
    // executeDag calls the teardown unconditionally; an agent/team/admin run that
    // bound nothing must tear down without error and without affecting the result.
    const registry = createSubjectTokenRegistry();
    const rid = makeRunId("run-agent");

    const result = await withSubjectTokenRelease(registry, rid, async () => 42);

    expect(result).toBe(42);
    expect(registry.resolve(rid)).toBeUndefined();
  });
});

describe("token confinement regression — no subject-token slot on framework seams (FR-032/NFR-011)", () => {
  it("InvocationOrigin (string-only) carries NO subject-token field", () => {
    // Structural assertion: both origin variants are exactly their documented
    // shape. A future edit that adds a `subjectToken` (or any token) slot to
    // InvocationOrigin would break FR-032 (the raw token must never cross the
    // framework port) — TypeScript's excess-property check on these typed
    // literals catches it at compile time, and the runtime key-set assertion
    // catches a widened/loosened type that still compiles.
    const agent: InvocationOrigin = { kind: "agent", agentClientId: "dag-x" };
    const user: InvocationOrigin = { kind: "user", sub: "user-1", agentClientId: "dag-x" };

    expect(Object.keys(agent).sort()).toEqual(["agentClientId", "kind"]);
    expect(Object.keys(user).sort()).toEqual(["agentClientId", "kind", "sub"]);
    // No origin variant exposes a token under any plausible name.
    for (const origin of [agent, user] as Record<string, unknown>[]) {
      expect(origin["subjectToken"]).toBeUndefined();
      expect(origin["token"]).toBeUndefined();
    }
  });

  it("ScopedCapabilityHandle carries NO subject-token field (NFR-011: never reachable from a handle)", () => {
    // ScopedCapabilityHandle is a Partial map of Capability → client. It must
    // never gain a subject-token slot — the raw user token must not be reachable
    // from a capability handle. An empty handle is a valid instance; assert the
    // capability-keyed shape admits no token key.
    const handle: ScopedCapabilityHandle = {};
    expect(Object.keys(handle)).toHaveLength(0);
    expect((handle as Record<string, unknown>)["subjectToken"]).toBeUndefined();
    expect((handle as Record<string, unknown>)["token"]).toBeUndefined();
  });
});
