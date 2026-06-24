/**
 * Tests for the host-side SubjectTokenRegistry (adapters/subject-token-registry.ts)
 * — the `runId → SubjectToken` side-channel that carries a user run's verified
 * `subject_token` from the run-context factory to the broker WITHOUT it crossing
 * the framework `InvocationOrigin` (FR-032) or reaching a capability handle
 * (NFR-011).
 *
 * Invariants under test:
 *   - bind → resolve round-trips the exact branded token for a runId.
 *   - an unbound runId resolves to `undefined` (the broker then fails closed).
 *   - release drops the entry so a token does not outlive its run (NFR-014).
 *   - entries are keyed per-run: one run's token never leaks to another.
 */

import { describe, it, expect } from "bun:test";
import { runId as makeRunId } from "@fuguejs/framework";
import { createSubjectTokenRegistry } from "../subject-token-registry.js";
import { markSubjectToken } from "../../domain/auth.js";

describe("SubjectTokenRegistry", () => {
  it("bind then resolve round-trips the exact subject token for a runId", () => {
    const reg = createSubjectTokenRegistry();
    const rid = makeRunId("run-1");
    const token = markSubjectToken("verified.user.jwt");

    reg.bind(rid, token);
    expect(reg.resolve(rid)).toBe(token);
  });

  it("resolve returns undefined for a never-bound runId (broker then fails closed, FR-030)", () => {
    const reg = createSubjectTokenRegistry();
    expect(reg.resolve(makeRunId("never-bound"))).toBeUndefined();
  });

  it("release drops the entry so the token does not outlive the run (NFR-014)", () => {
    const reg = createSubjectTokenRegistry();
    const rid = makeRunId("run-2");
    reg.bind(rid, markSubjectToken("verified.user.jwt"));
    expect(reg.resolve(rid)).toBeDefined();

    reg.release(rid);
    // After teardown the token is gone — a later (illegitimate) resolve of the
    // same id gets nothing, so the broker fails closed rather than reusing it.
    expect(reg.resolve(rid)).toBeUndefined();
  });

  it("is keyed per-run: one run's token never resolves for another runId", () => {
    const reg = createSubjectTokenRegistry();
    const a = makeRunId("run-A");
    const b = makeRunId("run-B");
    const tokenA = markSubjectToken("token-A");

    reg.bind(a, tokenA);
    // B was never bound — it must NOT inherit A's token.
    expect(reg.resolve(b)).toBeUndefined();
    expect(reg.resolve(a)).toBe(tokenA);
  });

  it("release of one run does not disturb another run's bound token", () => {
    const reg = createSubjectTokenRegistry();
    const a = makeRunId("run-A");
    const b = makeRunId("run-B");
    reg.bind(a, markSubjectToken("token-A"));
    reg.bind(b, markSubjectToken("token-B"));

    reg.release(a);
    expect(reg.resolve(a)).toBeUndefined();
    expect(reg.resolve(b)).toBe(markSubjectToken("token-B"));
  });

  it("re-binding a runId overwrites the prior token: last-write-wins is the contract", () => {
    // A runId is minted fresh per run (crypto.randomUUID), so a collision is not
    // expected in production. Pin the deterministic semantics anyway so the cell
    // has a defined, greppable contract: the SECOND bind wins, no merge, no throw.
    const reg = createSubjectTokenRegistry();
    const rid = makeRunId("run-rebind");
    const a = markSubjectToken("token-A");
    const b = markSubjectToken("token-B");

    reg.bind(rid, a);
    reg.bind(rid, b);
    expect(reg.resolve(rid)).toBe(b);
  });

  it("release of a never-bound runId is a safe no-op (does not throw)", () => {
    // Teardown calls release(runId) unconditionally in executeDag's finally — for
    // agent/team/admin runs that never bound a token too. That release must be a
    // benign no-op rather than an error that masks the run's real result.
    const reg = createSubjectTokenRegistry();
    expect(() => reg.release(makeRunId("never-bound"))).not.toThrow();
    expect(reg.resolve(makeRunId("never-bound"))).toBeUndefined();
  });
});
