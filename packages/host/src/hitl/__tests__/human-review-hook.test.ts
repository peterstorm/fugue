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

  it("still parks (pending) when notification fails on the first park — non-fatal, no re-notify", async () => {
    // First park succeeds (markPending → true), but delivery fails. The run is
    // already durably parked, so the hook must NOT fail the run: it logs and
    // returns pending. A later re-park (markPending → false) must NOT retry
    // delivery (the notify only fires on the first park).
    let firstPark = true;
    let notifyCalls = 0;
    const decisions = decisionStore({
      async markPending() { const was = firstPark; firstPark = false; return ok(was); },
    });
    const notifier: HumanReviewNotifierPort = {
      async notify() { notifyCalls += 1; return err({ kind: "notification-failed", operation: "notify" }); },
    };
    const hook = makeOnHumanReview({ decisions, notifier, runId: RUN, dagId: DAG });

    expect(await hook(req)).toEqual({ kind: "pending" }); // parked despite delivery failure
    expect(await hook(req)).toEqual({ kind: "pending" }); // re-park
    expect(notifyCalls).toBe(1); // attempted once on first park, never on re-park
  });

  it("fails OPEN when markPending errors — assumes first park and notifies anyway", async () => {
    // A markPending store blip must not silence the review: better a possible
    // duplicate notification on a later re-park than a run parked with no notice
    // at all. The hook treats an errored markPending as the first park.
    const notifier = notifierSpy();
    const decisions = decisionStore({
      async markPending() { return err({ kind: "redis-unavailable", operation: "SET NX pending" }); },
    });
    const hook = makeOnHumanReview({ decisions, notifier: notifier.port, runId: RUN, dagId: DAG });

    expect(await hook(req)).toEqual({ kind: "pending" });
    expect(notifier.sent).toHaveLength(1); // notified despite the marker write failing
    expect(notifier.sent[0]!.nodeId).toBe(NODE);
  });

  it("throwing diagnostics cannot bypass decision, marker, or notification fallbacks", async () => {
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
        async markPending() { return err({ kind: "redis-unavailable", operation: "SET NX" }); },
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

    expect(await lookupFailure(req)).toEqual({ kind: "pending" });
    expect(await markerFailure(req)).toEqual({ kind: "pending" });
    expect(await notificationFailure(req)).toEqual({ kind: "pending" });
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
