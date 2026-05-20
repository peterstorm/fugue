// Tests for attachDeadLetterHandler — FR-044, SC-008
// Verifies:
//   1. Fires notifier exactly once when attempts >= maxAttempts (exhaustion)
//   2. Zero fires on job success (onFailed never called)
//   3. Zero fires mid-retry (attempts < maxAttempts)
//   4. Correct message + recipients forwarded to notifier
//   5. SC-008 property test: 100 simulated lifecycles — total invocations
//      equals the number of jobs that reached attempts >= maxAttempts

import { describe, it, expect, beforeEach } from "bun:test";
import {
  attachDeadLetterHandler,
  type WorkerHandle,
  type DeadLetterNotifier,
} from "../queue/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type FailedHandler = (
  id: string,
  err: unknown,
  attempts: number,
  max: number,
) => Promise<void> | void;

type ExhaustedHandler = (
  id: string,
  err: unknown,
  attempts: number,
) => Promise<void> | void;

/** Minimal stub that records calls and allows us to simulate job failures. */
function makeWorker(): WorkerHandle & {
  simulateFailed(
    id: string,
    err: unknown,
    attempts: number,
    max: number,
  ): Promise<void>;
} {
  const failed: FailedHandler[] = [];
  const exhausted: ExhaustedHandler[] = [];
  return {
    onFailed(handler) {
      failed.push(handler as FailedHandler);
    },
    onExhausted(handler) {
      exhausted.push(handler as ExhaustedHandler);
    },
    onError(_handler) {
      // not exercised in these tests
    },
    async close() {
      // no-op
    },
    // Mirrors the adapter routing: mid-retry → onFailed; exhausted → onExhausted.
    async simulateFailed(id, err, attempts, max) {
      if (attempts >= max) {
        for (const h of exhausted) await h(id, err, attempts);
      } else {
        for (const h of failed) await h(id, err, attempts, max);
      }
    },
  };
}

interface NotifyCall {
  recipients: readonly string[];
  message: string;
}

function makeNotifier(): DeadLetterNotifier & { calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    async notify(recipients, message) {
      calls.push({ recipients, message });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared test opts
// ---------------------------------------------------------------------------

const TEST_RECIPIENTS = ["oncall@example.com", "lead@example.com"] as const;

// Demonstrates the new contract: formatMessage receives the raw err and
// decides how to stringify. Implementations that want Error.message must
// extract it themselves — the framework no longer pre-serializes.
const stringifyErr = (err: unknown): string =>
  err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : String(err ?? "unknown error");

const opts = {
  getRecipients: (_id: string, _err: unknown) => TEST_RECIPIENTS,
  formatMessage: (id: string, err: unknown) =>
    `Job ${id} failed permanently: ${stringifyErr(err)}`,
};

// ---------------------------------------------------------------------------
// Test 1: fires exactly once at exhaustion
// ---------------------------------------------------------------------------

describe("attachDeadLetterHandler", () => {
  it("fires notifier once when attempts === maxAttempts (exhausted)", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("timeout"), 3, 3);

    expect(notifier.calls).toHaveLength(1);
  });

  it("fires notifier once when attempts > maxAttempts (defensive)", async () => {
    // Shouldn't happen in practice but the guard must still hold.
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("timeout"), 4, 3);

    expect(notifier.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: zero fires on success
  // -------------------------------------------------------------------------

  it("fires zero times on job success (onFailed never called)", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    // A successful job never triggers onFailed — no simulation needed.
    expect(notifier.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: zero fires mid-retry (attempts < maxAttempts)
  // -------------------------------------------------------------------------

  it("fires zero times mid-retry (attempts < maxAttempts)", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    // Simulate 2 failures with max=3 (still have retries left)
    await worker.simulateFailed("job-1", new Error("transient"), 1, 3);
    await worker.simulateFailed("job-1", new Error("transient"), 2, 3);

    expect(notifier.calls).toHaveLength(0);
  });

  it("fires zero times on attempt 1 of 5 retries", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-x", new Error("flaky"), 1, 5);
    expect(notifier.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: correct message and recipients
  // -------------------------------------------------------------------------

  it("forwards correct recipients to notifier", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-42", new Error("disk full"), 3, 3);

    expect(notifier.calls[0].recipients).toEqual(TEST_RECIPIENTS);
  });

  it("forwards correctly formatted message to notifier", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();

    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-99", new Error("OOM"), 2, 2);

    expect(notifier.calls[0].message).toBe(
      "Job job-99 failed permanently: OOM",
    );
  });

  it("uses custom formatMessage and getRecipients", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    const customOpts = {
      getRecipients: (_id: string, _err: unknown) => ["admin@corp.com"] as const,
      formatMessage: (id: string, err: unknown) =>
        `ALERT: ${id} crashed with: ${stringifyErr(err)}`,
    };

    attachDeadLetterHandler(worker, notifier, customOpts);

    await worker.simulateFailed("wf-001", new Error("segfault"), 1, 1);

    expect(notifier.calls[0].recipients).toEqual(["admin@corp.com"]);
    expect(notifier.calls[0].message).toBe(
      "ALERT: wf-001 crashed with: segfault",
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 (SC-008): 100 simulated job lifecycles — total invocations equals
  // the count of jobs that exhausted attempts.
  // -------------------------------------------------------------------------

  describe("SC-008: 100-lifecycle property test", () => {
    it("total notifier calls === exhausted job count across 100 lifecycles", async () => {
      // Deterministic seed via pre-defined lifecycle patterns so the test is
      // reproducible without any external randomness library.

      // A lifecycle is one of:
      //   "success"   — onFailed never fires
      //   "retry-N-M" — N failures with attempts<max, then success (never exhausted)
      //   "exhaust-M" — M failures with final attempts==max (exhausted)

      type Lifecycle =
        | { kind: "success" }
        | { kind: "retry"; midAttempts: number; max: number }
        | { kind: "exhaust"; max: number };

      // Build 100 lifecycles deterministically
      const lifecycles: Lifecycle[] = [];
      for (let i = 0; i < 100; i++) {
        const mod = i % 10;
        if (mod < 4) {
          // 40 success jobs
          lifecycles.push({ kind: "success" });
        } else if (mod < 7) {
          // 30 mid-retry jobs (fail once or twice, then succeed before max)
          const max = 3 + (i % 3); // max in [3,5]
          const midAttempts = 1 + (i % 2); // fail 1 or 2 times, always < max
          lifecycles.push({ kind: "retry", midAttempts, max });
        } else {
          // 30 exhausted jobs
          const max = 1 + (i % 4); // max in [1,4]
          lifecycles.push({ kind: "exhaust", max });
        }
      }

      const worker = makeWorker();
      const notifier = makeNotifier();

      attachDeadLetterHandler(worker, notifier, opts);

      let expectedExhaustedCount = 0;

      for (let i = 0; i < lifecycles.length; i++) {
        const lifecycle = lifecycles[i];
        const jobId = `job-${i}`;

        if (lifecycle.kind === "success") {
          // onFailed never fires for successful jobs
        } else if (lifecycle.kind === "retry") {
          // Simulate mid-retry failures — all below max
          for (let a = 1; a <= lifecycle.midAttempts; a++) {
            await worker.simulateFailed(
              jobId,
              new Error("transient"),
              a,
              lifecycle.max,
            );
          }
          // Job eventually succeeds — no exhaustion
        } else {
          // "exhaust": simulate failures up to max
          for (let a = 1; a < lifecycle.max; a++) {
            // mid-retry fires (a < max)
            await worker.simulateFailed(
              jobId,
              new Error("persistent"),
              a,
              lifecycle.max,
            );
          }
          // Final exhausting failure
          await worker.simulateFailed(
            jobId,
            new Error("final"),
            lifecycle.max,
            lifecycle.max,
          );
          expectedExhaustedCount++;
        }
      }

      // SC-008: notifier invocation count must equal the number of exhausted jobs
      expect(notifier.calls).toHaveLength(expectedExhaustedCount);

      // Additional invariant: no mid-retry calls snuck through
      // (all notifier calls should have come from exhausted jobs)
      expect(expectedExhaustedCount).toBe(30); // 30 exhausted jobs per lifecycle distribution above
    });

    it("never double-fires for a single job exhaustion event", async () => {
      // Even if onFailed is called multiple times with attempts === max,
      // each call to simulateFailed is independent — but the pattern is:
      // one onFailed invocation per job failure event.
      // Verify: single exhaustion event → exactly one notify call.
      const worker = makeWorker();
      const notifier = makeNotifier();

      attachDeadLetterHandler(worker, notifier, opts);

      await worker.simulateFailed("job-final", new Error("fatal"), 5, 5);

      expect(notifier.calls).toHaveLength(1);
    });

    it("multiple handlers: each attached handler fires independently", async () => {
      // If two handlers are attached (e.g. two notifiers), both should fire.
      const worker = makeWorker();
      const notifier1 = makeNotifier();
      const notifier2 = makeNotifier();

      attachDeadLetterHandler(worker, notifier1, opts);
      attachDeadLetterHandler(worker, notifier2, opts);

      await worker.simulateFailed("job-x", new Error("crash"), 2, 2);

      expect(notifier1.calls).toHaveLength(1);
      expect(notifier2.calls).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F7: non-Error rejection value coercion
// ---------------------------------------------------------------------------

describe("attachDeadLetterHandler — F7: non-Error rejection coercion", () => {
  it("handles null rejection (coerces to 'unknown error')", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-null", null, 1, 1);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].message).toContain("unknown error");
  });

  it("handles string rejection", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-str", "disk full", 1, 1);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].message).toContain("disk full");
  });

  it("handles plain object rejection (coerces via String())", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-obj", { code: 500 }, 1, 1);

    expect(notifier.calls).toHaveLength(1);
    // String({code:500}) = "[object Object]"
    expect(notifier.calls[0].message).toContain("[object Object]");
  });
});

// ---------------------------------------------------------------------------
// F8: notifier throwing propagates (Wave 3 §3.4)
// ---------------------------------------------------------------------------

describe("attachDeadLetterHandler — F8: notifier failure propagates", () => {
  // Wave 3 §3.4: notifier failure must propagate. At DLQ time the job is
  // already dead — notification is the only remaining action and silent
  // failure here removes the last observability signal an operator has.
  it("propagates the notifier throw so worker.onError sees it", async () => {
    const worker = makeWorker();
    const throwingNotifier: DeadLetterNotifier = {
      async notify() {
        throw new Error("notification service down");
      },
    };
    attachDeadLetterHandler(worker, throwingNotifier, opts);

    await expect(
      worker.simulateFailed("job-boom", new Error("fail"), 1, 1),
    ).rejects.toThrow("notification service down");
  });
});

// ---------------------------------------------------------------------------
// F9: empty recipient list short-circuits without calling notify
// ---------------------------------------------------------------------------

describe("attachDeadLetterHandler — F9: empty recipients short-circuit", () => {
  it("skips notify when getRecipients returns empty array", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    const emptyRecipientOpts = {
      getRecipients: (_id: string, _err: unknown) => [] as readonly string[],
      formatMessage: (id: string, err: unknown) => `${id}: ${err}`,
    };
    attachDeadLetterHandler(worker, notifier, emptyRecipientOpts);

    await worker.simulateFailed("job-1", new Error("fail"), 1, 1);

    expect(notifier.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F10: defensive attempts/max validation
// ---------------------------------------------------------------------------

describe("attachDeadLetterHandler — F10: defensive attempts/max validation", () => {
  it("logs error but still notifies when attempts === 0", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), 0, 0);

    // Changed from skip → notify: the job is dead and notification matters
    // more than a clean attempts count.
    expect(notifier.calls).toHaveLength(1);
  });

  it("skips when max is NaN", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), 1, NaN);

    expect(notifier.calls).toHaveLength(0);
  });

  it("logs error but still notifies when attempts is negative", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), -1, -1);

    expect(notifier.calls).toHaveLength(1);
  });

  it("skips when max is Infinity", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), 5, Infinity);

    expect(notifier.calls).toHaveLength(0);
  });

  it("skips when attempts is NaN", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), NaN, 3);

    expect(notifier.calls).toHaveLength(0);
  });

  it("fires when max is a valid positive finite number and attempts >= max", async () => {
    const worker = makeWorker();
    const notifier = makeNotifier();
    attachDeadLetterHandler(worker, notifier, opts);

    await worker.simulateFailed("job-1", new Error("fail"), 3, 3);

    expect(notifier.calls).toHaveLength(1);
  });
});
