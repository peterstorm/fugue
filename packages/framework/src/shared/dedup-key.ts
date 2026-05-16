// SHA-256 based dedup key — injected into the state-machine kernel by the DAG runtime shell.
// Lives in shared/ (not state-machine/) so the kernel stays runtime-agnostic.

import { createHash } from "node:crypto";

/**
 * Deterministic per-transition key using SHA-256. Stamped on every
 * `appendEvent` call so adapters can dedup if the worker crashes between
 * `appendEvent` and `updateData` (and the same transition gets re-derived
 * on restart).
 *
 * Inputs: the prior `stateKey`, the per-state attempt counter, and the event
 * type tag. These three together uniquely identify a transition slot. 16 hex
 * chars is plenty for collision resistance within a single job's stream.
 */
export const sha256DedupKey = (
  prevStateKey: string,
  attemptNumber: number,
  event: unknown,
): string => {
  const eventType =
    typeof (event as { type?: unknown })?.type === "string"
      ? (event as { type: string }).type
      : "<event>";
  const key = `${prevStateKey}|${attemptNumber}|${eventType}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
};
