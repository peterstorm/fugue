/**
 * In-process spend ledger — the single-process adapter.
 *
 * Not a test fake: it is the correct backend for a deployment that runs one
 * host process, in the same way the in-memory checkpointer is a real backend
 * rather than a stand-in. It closes the park/resume hole for every run whose
 * slices execute in one process, which is the whole HITL suspend/resume path in
 * a single-process deployment.
 *
 * What it does NOT survive is process death. That is the honest boundary
 * between this adapter and the Redis one, and it is stated here rather than
 * discovered: an operator running a single process with a per-run budget gets
 * durability across parks and not across restarts.
 *
 * The store is keyed by `runId` and never evicted. A `Spend` carries token and
 * call counters plus a priced micro-USD value or known floor with an optional
 * unpriced-model set; a host process's lifetime bounds the number of
 * runs it can have seen — the Redis adapter, which outlives any one process,
 * is the one that needs a TTL.
 */

import type { RunId, Spend } from "@fuguejs/framework";
import { NO_SPEND, addSpend, snapshotSpend } from "@fuguejs/framework";
import { ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { SpendLedgerPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";

/**
 * Build an in-process ledger.
 *
 * `seed` exists for tests that need a ledger already carrying spend — the
 * park/resume case, where the assertion is about what a SECOND slice reads.
 */
export const createInMemorySpendLedger = (
  seed: ReadonlyMap<RunId, Spend> = new Map(),
): SpendLedgerPort => {
  const spendByRun = new Map<RunId, Spend>(
    Array.from(seed, ([runId, spend]) => [runId, snapshotSpend(spend)] as const),
  );
  return {
    metadata: Object.freeze({
      role: "redis-fallback",
      backend: "memory",
      durability: "process",
    }),
    read: async (runId: RunId): Promise<Result<Spend, HostError>> =>
      ok(snapshotSpend(spendByRun.get(runId) ?? NO_SPEND)),
    add: async (runId: RunId, delta: Spend): Promise<Result<void, HostError>> => {
      // The same monoid the meter folds with, so this adapter cannot disagree
      // with the in-process figure it is mirroring.
      spendByRun.set(
        runId,
        snapshotSpend(addSpend(spendByRun.get(runId) ?? NO_SPEND, delta)),
      );
      return ok(undefined);
    },
  };
};
