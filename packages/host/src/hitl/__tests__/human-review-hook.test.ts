// human-review-hook.test.ts — the host onHumanReview hook (ADR-0060).
//
// The hook is the fail-safe boundary between the kernel's human gate and the
// decision/notification stores. Its load-bearing invariants: an ERRORED decision
// lookup must NEVER be read as approval (re-park); and the hook is READ-ONLY —
// it returns a recorded decision WITHOUT consuming it. Consumption is deferred
// to makeOnDecisionConsumed, which the kernel calls only after the post-gate
// checkpoint is durable, so a crash mid-resume re-reads the decision instead of
// losing the approval. These unit-test those branches directly, which the
// full-loop service test never exercises.

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { RunId, NodeId, DagId, HumanAction } from "@fuguejs/framework";
import type { DecisionStorePort, HumanReviewNotifierPort } from "../ports.js";
import type { ReviewNotification } from "../types.js";
import { makeOnHumanReview, makeOnDecisionConsumed } from "../human-review-hook.js";

const RUN = "run-1" as RunId;
const NODE = "review" as NodeId;
const DAG = "dag-1" as DagId;
const req = { nodeId: NODE, output: { x: 1 }, prompt: "ok?" };

const notifierSpy = () => {
  const sent: ReviewNotification[] = [];
  const port: HumanReviewNotifierPort = { async notify(n) { sent.push(n); return ok(undefined); } };
  return { port, sent };
};

/** A decision store whose operations are individually overridable for the branch under test. */
const decisionStore = (overrides: Partial<DecisionStorePort> = {}): DecisionStorePort => ({
  async preparePending() { return ok({ kind: "notification-required", marker: "marker-1" }); },
  async markNotified() { return ok(true); },
  async resolvePending() { return ok({ kind: "not-pending" }); },
  async getDecision() { return ok(null); },
  async clear() { return ok(undefined); },
  ...overrides,
});

describe("makeOnHumanReview", () => {
  it("retries the hook and does NOT notify when the decision lookup errors", async () => {
    const notifier = notifierSpy();
    const decisions = decisionStore({ async getDecision() { return err({ kind: "redis-unavailable", operation: "GET decision" }); } });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    await expect(hook(req)).rejects.toThrow("decision lookup failed");

    // An errored lookup must never be fabricated into an approval or suspend a
    // run before its actionable pending marker exists.
    expect(notifier.sent).toHaveLength(0);
  });

  it("returns a recorded action WITHOUT consuming it (read-only — clear is deferred)", async () => {
    const action: HumanAction = { kind: "approve", actor: "Alice" };
    let clearCalls = 0;
    const decisions = decisionStore({
      async getDecision() { return ok(action); },
      async clear() { clearCalls += 1; return ok(undefined); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifierSpy().port, runId: RUN, dagId: DAG });

    const outcome = await hook(req);

    expect(outcome).toEqual(action);
    // The hook must NOT clear here — consumption is deferred to onDecisionConsumed
    // so a crash before the durable post-gate checkpoint re-reads the decision.
    expect(clearCalls).toBe(0);
  });

  it("parks and notifies on the FIRST park, then re-parks without re-notifying", async () => {
    const notifier = notifierSpy();
    let delivered = false;
    const decisions = decisionStore({
      async preparePending() {
        return ok(delivered
          ? { kind: "notified" }
          : { kind: "notification-required", marker: "marker-1" });
      },
      async markNotified() { delivered = true; return ok(true); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(notifier.sent).toHaveLength(1); // notified once, not on the re-park
    expect(notifier.sent[0]!.nodeId).toBe(NODE);
  });

  it("retries a failed first notification and parks only after delivery is committed", async () => {
    let notifyCalls = 0;
    let delivered = false;
    const decisions = decisionStore({
      async preparePending() {
        return ok(delivered
          ? { kind: "notified" }
          : { kind: "notification-required", marker: "marker-1" });
      },
      async markNotified() { delivered = true; return ok(true); },
    });
    const notifier: HumanReviewNotifierPort = {
      async notify() {
        notifyCalls += 1;
        return notifyCalls === 1
          ? err({ kind: "notification-failed", operation: "notify" })
          : ok(undefined);
      },
    };
    const hook = makeOnHumanReview({ decisions, notifier, runId: RUN, dagId: DAG });

    await expect(hook(req)).rejects.toThrow("review notification failed");
    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(notifyCalls).toBe(2);
  });

  it("fails closed when preparePending errors — rejects and does not notify", async () => {
    const notifier = notifierSpy();
    const decisions = decisionStore({
      async preparePending() { return err({ kind: "redis-unavailable", operation: "SET NX pending" }); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    await expect(hook(req)).rejects.toThrow("preparePending failed");
    expect(notifier.sent).toHaveLength(0);
  });

  it("throwing diagnostics cannot bypass decision, marker, or notification outcomes", async () => {
    const logger = {
      info: () => {},
      warn: () => { throw new Error("warn transport failed"); },
      error: () => { throw new Error("error transport failed"); },
    };
    const lookupFailure = makeOnHumanReview({
      decisions: decisionStore({
        async getDecision() { return err({ kind: "redis-unavailable", operation: "GET" }); },
      }),
      notifier: notifierSpy().port,
      runId: RUN,
      dagId: DAG,
      logger,
    });
    const markerFailure = makeOnHumanReview({
      decisions: decisionStore({
        async preparePending() { return err({ kind: "redis-unavailable", operation: "SET NX" }); },
      }),
      notifier: notifierSpy().port,
      runId: RUN,
      dagId: DAG,
      logger,
    });
    const notificationFailure = makeOnHumanReview({
      decisions: decisionStore(),
      notifier: {
        async notify() { return err({ kind: "notification-failed", operation: "notify" }); },
      },
      runId: RUN,
      dagId: DAG,
      logger,
    });

    await expect(lookupFailure(req)).rejects.toThrow("decision lookup failed");
    await expect(markerFailure(req)).rejects.toThrow("preparePending failed");
    await expect(notificationFailure(req)).rejects.toThrow("review notification failed");
  });
});

describe("makeOnDecisionConsumed", () => {
  it("clears the decision (and marker) for the resolved gate", async () => {
    const cleared: [RunId, NodeId][] = [];
    const decisions = decisionStore({
      async clear(runId, nodeId) { cleared.push([runId, nodeId]); return ok(undefined); },
    });
    const consume = makeOnDecisionConsumed({ decisions, runId: RUN });

    await consume(NODE);

    expect(cleared).toEqual([[RUN, NODE]]);
  });

  it("is non-fatal when the clear fails (post-gate state is already durable; TTL reaps)", async () => {
    const decisions = decisionStore({
      async clear() { return err({ kind: "redis-unavailable", operation: "DEL" }); },
    });
    const consume = makeOnDecisionConsumed({ decisions, runId: RUN });

    // Must resolve, not reject — a failed consume cannot fail an already-committed run.
    await expect(consume(NODE)).resolves.toBeUndefined();
  });

  it("a throwing clear-failure logger cannot fail an already-committed run", async () => {
    const decisions = decisionStore({
      async clear() { return err({ kind: "redis-unavailable", operation: "DEL" }); },
    });
    const consume = makeOnDecisionConsumed({
      decisions,
      runId: RUN,
      logger: {
        info: () => {},
        warn: () => { throw new Error("logger failed"); },
        error: () => {},
      },
    });

    await expect(consume(NODE)).resolves.toBeUndefined();
  });
});
