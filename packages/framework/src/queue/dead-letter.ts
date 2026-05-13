// Dead-letter handler — FR-044, SC-008
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082)

import type { WorkerHandle, DeadLetterNotifier, DeadLetterOpts } from "./types.js";
import { fwLogger } from "../logger.js";

/**
 * Attach a dead-letter handler to a `WorkerHandle`.
 *
 * Fires `notifier.notify` exactly once when a job exhausts its queue-level
 * retry attempts. Routes through `WorkerHandle.onExhausted` — the queue
 * backend tells us directly when the budget is gone, so the prior manual
 * `attempts >= max` check disappears.
 *
 * This is pure imperative-shell wiring: no business logic, no I/O other than
 * delegating to the supplied `notifier`.
 *
 * FR-044, SC-008
 */
export function attachDeadLetterHandler(
  worker: WorkerHandle,
  notifier: DeadLetterNotifier,
  opts: DeadLetterOpts,
): void {
  worker.onExhausted(async (id, err, attempts) => {
    // Defensive validation against malformed adapter inputs. Log and
    // continue rather than silently dropping — the job is dead and
    // notification matters more than a clean attempts count.
    if (
      typeof attempts !== "number" ||
      !Number.isFinite(attempts) ||
      attempts <= 0
    ) {
      fwLogger().error(
        `[dead-letter] malformed attempts=${String(attempts)} for exhausted job ${id} — sending notification anyway`,
      );
    }

    const recipients = opts.getRecipients(id, err);

    // Guard: empty recipient list — log and skip notification.
    if (recipients.length === 0) {
      fwLogger().warn(
        `[dead-letter] no recipients for exhausted job ${id} (attempts=${attempts}) — skipping notify`,
      );
      return;
    }

    // formatMessage receives the raw err so implementations can pick the
    // serialization (Error.message, JSON, a custom shape). The previous
    // signature pre-stringified, throwing away the structured Error object.
    const message = opts.formatMessage(id, err);

    // The job is already dead — notification is the only remaining action.
    // Propagate notifier failure so the worker's onFailed / onError handlers
    // can surface it (escalate to a secondary channel, page operators, etc).
    // Logging the failure and swallowing it would turn this into a silent
    // gap at the exact moment operator visibility matters most.
    try {
      await notifier.notify(recipients, message);
    } catch (notifyErr) {
      fwLogger().error(
        `[dead-letter] notification failed for exhausted job ${id} (attempts=${attempts}):`,
        notifyErr,
      );
      throw notifyErr instanceof Error
        ? notifyErr
        : new Error(`dead-letter notify failed: ${String(notifyErr)}`);
    }
  });
}
