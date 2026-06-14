// human-review-hook.test.ts — the host onHumanReview hook (ADR-0060).
//
// The hook is the fail-safe boundary between the kernel's human gate and the
// decision/notification stores. Its load-bearing invariant: an ERRORED decision
// lookup must NEVER be read as approval — it must re-park. These unit-test that
// branch (and the non-fatal clear failure) directly, which the full-loop
// service test never exercises (it only drives ok(null)/ok(action)).

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { RunId, NodeId, DagId, HumanAction } from "@fuguejs/framework";
import type { DecisionStorePort, HumanReviewNotifierPort } from "../ports.js";
import type { ReviewNotification } from "../types.js";
import { makeOnHumanReview } from "../human-review-hook.js";

const RUN = "run-1" as RunId;
const NODE = "review" as NodeId;
const DAG = "dag-1" as DagId;
const req = { nodeId: NODE, output: { x: 1 }, prompt: "ok?" };

const notifierSpy = () => {
  const sent: ReviewNotification[] = [];
  const port: HumanReviewNotifierPort = { async notify(n) { sent.push(n); return ok(undefined); } };
  return { port, sent };
};

/** A decision store whose four ops are individually overridable for the branch under test. */
const decisionStore = (overrides: Partial<DecisionStorePort> = {}): DecisionStorePort => ({
  async markPending() { return ok(true); },
  async isPending() { return ok(false); },
  async putDecision() { return ok(undefined); },
  async getDecision() { return ok(null); },
  async clear() { return ok(undefined); },
  ...overrides,
});

describe("makeOnHumanReview", () => {
  it("re-parks (pending) and does NOT notify when the decision lookup errors", async () => {
    const notifier = notifierSpy();
    const decisions = decisionStore({ async getDecision() { return err({ kind: "redis-unavailable", operation: "GET decision" }); } });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    const outcome = await hook(req);

    expect(outcome).toEqual({ kind: "pending" });
    // An errored lookup must never be fabricated into an approval, and must not
    // re-notify (the run is already parked).
    expect(notifier.sent).toHaveLength(0);
  });

  it("returns the recorded action even if clearing the marker fails (non-fatal)", async () => {
    const action: HumanAction = { kind: "approve", actor: "Alice" };
    const decisions = decisionStore({
      async getDecision() { return ok(action); },
      async clear() { return err({ kind: "redis-unavailable", operation: "DEL" }); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifierSpy().port, runId: RUN, dagId: DAG });

    const outcome = await hook(req);

    expect(outcome).toEqual(action);
  });

  it("parks and notifies on the FIRST park, then re-parks without re-notifying", async () => {
    const notifier = notifierSpy();
    let firstPark = true;
    const decisions = decisionStore({
      async markPending() { const was = firstPark; firstPark = false; return ok(was); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(notifier.sent).toHaveLength(1); // notified once, not on the re-park
    expect(notifier.sent[0]!.nodeId).toBe(NODE);
  });
});
