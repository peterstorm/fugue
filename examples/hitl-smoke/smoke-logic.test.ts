// Unit tests for the smoke driver's pure decision logic. These run in `bun test`
// with NO host — they pin the approve/reject contract (incl. the reject → failed
// path the live `smoke` run only exercises when SMOKE_DECISION=reject).

import { describe, expect, it } from "bun:test";
import { decisionBody, expectedTerminal, isPollDone, parseDecision } from "./smoke-logic.js";

describe("parseDecision", () => {
  it("parses the explicit decisions", () => {
    expect(parseDecision("approve")).toEqual({ ok: true, decision: "approve" });
    expect(parseDecision("reject")).toEqual({ ok: true, decision: "reject" });
  });

  it("treats unset/empty as the default approve (not an error)", () => {
    expect(parseDecision(undefined)).toEqual({ ok: true, decision: "approve" });
    expect(parseDecision("")).toEqual({ ok: true, decision: "approve" });
  });

  it("rejects an unrecognised value loudly instead of coercing to approve", () => {
    // A typo must fail the harness, not silently run the (untested) happy path.
    expect(parseDecision("REJECT")).toEqual({ ok: false, raw: "REJECT" }); // case-sensitive
    expect(parseDecision("approev")).toEqual({ ok: false, raw: "approev" });
    expect(parseDecision("garbage")).toEqual({ ok: false, raw: "garbage" });
  });
});

describe("expectedTerminal", () => {
  it("approve → completed, reject → failed", () => {
    expect(expectedTerminal("approve")).toBe("completed");
    expect(expectedTerminal("reject")).toBe("failed");
  });
});

describe("decisionBody", () => {
  it("approve body carries the actor and no reason", () => {
    expect(decisionBody("approve", "smoke-script")).toEqual({
      decision: "approve",
      actor: "smoke-script",
    });
  });

  it("reject body carries a reason (the host requires one to reject)", () => {
    const body = decisionBody("reject", "smoke-script");
    expect(body.decision).toBe("reject");
    expect(body.actor).toBe("smoke-script");
    expect(typeof body.reason).toBe("string");
    expect((body.reason as string).length).toBeGreaterThan(0);
  });
});

describe("isPollDone", () => {
  it("is done when the status matches the wanted state", () => {
    expect(isPollDone("suspended", "suspended")).toBe(true);
    expect(isPollDone("completed", "completed")).toBe(true);
  });

  it("is also done on ANY terminal status regardless of what was wanted", () => {
    expect(isPollDone("failed", "suspended")).toBe(true);
    expect(isPollDone("failed", "completed")).toBe(true);
    // The load-bearing case: a run that reached `completed` WITHOUT ever parking
    // at the gate is terminal, so the caller surfaces "run did not park" instead
    // of spinning to an opaque timeout (the dropped-gate regression).
    expect(isPollDone("completed", "suspended")).toBe(true);
  });

  it("keeps polling on non-terminal, non-matching states", () => {
    expect(isPollDone("queued", "suspended")).toBe(false);
    expect(isPollDone("running", "completed")).toBe(false);
    expect(isPollDone("suspended", "completed")).toBe(false); // suspended is not terminal
    expect(isPollDone(undefined, "suspended")).toBe(false);
  });
});
