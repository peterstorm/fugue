/**
 * File-backed spend ledger — the single-host durable adapter.
 *
 * A thin anti-corruption layer over `createFileSpendStore`: this module owns no
 * durability mechanism of its own, it maps framework file-store errors onto
 * `HostError`. The semantics its two siblings spell out, stated here so the
 * three can be compared without opening a fourth file:
 *
 * - **Atomicity.** Each append is a read-modify-write of one per-run record
 *   under a per-run file lock (`withFileLock`), committed with
 *   `atomicWriteFile` (write-temp-then-rename), so a crash mid-write leaves the
 *   previous record intact rather than a truncated one. There is no partial
 *   append.
 * - **Concurrency.** The file lock serializes appends within AND across
 *   processes on the same filesystem — unlike `spend-ledger-memory.ts`, which is
 *   single-process only. It does not coordinate across hosts that do not share
 *   that filesystem; that is what `spend-ledger-redis.ts` is for.
 * - **Durability.** Survives process death, to the durability the underlying
 *   filesystem gives a renamed file. As with the Redis adapter, an append that
 *   fails or is interrupted before acknowledgement returns one typed failure and
 *   never claims the delta committed.
 *
 * @satisfies FR-B-006 — spend is durable per runId
 */

import {
  err,
  formatFrameworkError,
  isFrameworkError,
  mapErr,
  ok,
  safeErrorMessage,
  type Result,
} from "@fuguejs/framework";
import { createFileSpendStore } from "@fuguejs/framework/file";
import type { HostError } from "../domain/host-error.js";
import { spendLedgerUnavailable } from "../domain/host-error.js";
import type { SpendLedgerPort } from "../ports.js";

const messageOf = (error: unknown): string =>
  isFrameworkError(error) ? formatFrameworkError(error) : safeErrorMessage(error);

export const createFileSpendLedger = (
  root: string,
): Result<SpendLedgerPort, HostError> => {
  let store: ReturnType<typeof createFileSpendStore>;
  try {
    store = createFileSpendStore(root);
  } catch (error) {
    return err(spendLedgerUnavailable("create", messageOf(error)));
  }

  return ok(Object.freeze({
    metadata: Object.freeze({
      role: "authoritative",
      backend: "file",
      durability: "restart",
    }),
    read: async (runId) =>
      mapErr(
        await store.read(runId),
        (error) => spendLedgerUnavailable("read", formatFrameworkError(error)),
      ),
    add: async (runId, delta) =>
      mapErr(
        await store.add(runId, delta),
        (error) => spendLedgerUnavailable("add", formatFrameworkError(error)),
      ),
  }));
};
