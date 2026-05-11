// Dead-letter handler — FR-044, SC-008
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082)

import type { WorkerHandle, DeadLetterNotifier, DeadLetterOpts } from "./types.js";

/**
 * Attach a dead-letter handler to a `WorkerHandle`.
 *
 * Fires `notifier.notify` exactly once when a job exhausts its queue-level retry
 * attempts (`attempts >= max`). Does NOT fire for jobs that:
 *   - succeed
 *   - fail but have remaining retry attempts (`attempts < max`)
 *
 * This is pure imperative-shell wiring: no business logic, no I/O other than
 * delegating to the supplied `notifier`. All decisions are based on the
 * `attempts` / `max` values the queue backend delivers to `onFailed`.
 *
 * FR-044, SC-008
 */
export function attachDeadLetterHandler(
  worker: WorkerHandle,
  notifier: DeadLetterNotifier,
  opts: DeadLetterOpts,
): void {
  worker.onFailed(async (id, err, attempts, max) => {
    // Defensive validation: guard against non-numeric or non-finite values.
    // Also short-circuit mid-retry failures (attempts < max).
    if (
      typeof attempts !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(attempts) ||
      !Number.isFinite(max) ||
      max <= 0 ||
      attempts < max
    ) {
      return;
    }

    const recipients = opts.getRecipients(id, err);

    // Guard: empty recipient list — log and skip notification.
    if (recipients.length === 0) {
      console.warn(
        "[dead-letter] no recipients for job %s (attempts=%d/%d) — skipping notify",
        id,
        attempts,
        max,
      );
      return;
    }

    // Coerce non-Error rejection values to a string.
    const errMessage =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err ?? "unknown error");

    const message = opts.formatMessage(id, errMessage);

    // Wave 3 §3.4: the job is already dead — notification is the only
    // remaining action. Propagate notifier failure so the worker's onFailed
    // / onError handlers can surface it (escalate to a secondary channel,
    // page operators, etc). Logging the failure and swallowing it as before
    // turned this into a silent gap right at the moment operator visibility
    // matters most.
    try {
      await notifier.notify(recipients, message);
    } catch (notifyErr) {
      console.error(
        "[dead-letter] notification failed for job %s (attempts=%d/%d): %o",
        id,
        attempts,
        max,
        notifyErr,
      );
      throw notifyErr instanceof Error
        ? notifyErr
        : new Error(`dead-letter notify failed: ${String(notifyErr)}`);
    }
  });
}
