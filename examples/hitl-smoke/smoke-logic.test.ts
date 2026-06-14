// Unit tests for the smoke driver's pure decision logic. These run in `bun test`
// with NO host — they pin the approve/reject contract (incl. the reject → failed
// path the live `smoke` run only exercises when SMOKE_DECISION=reject).

import { describe, expect, it } from "bun:test";
import { decisionBody, expectedTerminal, isPollDone, parseDecision } from "./smoke-logic.js";

describe("parseDecision", () => {
  it("maps the explicit 'reject' to reject", () => {
    expect(parseDecision("reject")).toBe("reject");
  });

  it("defaults everything else (incl. undefined) to approve", () => {
    expect(parseDecision("approve")).toBe("approve");
    expect(parseDecision(undefined)).toBe("approve");
    expect(parseDecision("REJECT")).toBe("approve"); // case-sensitive, not "reject"
    expect(parseDecision("garbage")).toBe("approve");
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

  it("is also done on terminal 'failed' regardless of what was wanted", () => {
    expect(isPollDone("failed", "suspended")).toBe(true);
    expect(isPollDone("failed", "completed")).toBe(true);
  });

  it("keeps polling on non-terminal, non-matching states", () => {
    expect(isPollDone("queued", "suspended")).toBe(false);
    expect(isPollDone("running", "completed")).toBe(false);
    expect(isPollDone(undefined, "suspended")).toBe(false);
  });
});
