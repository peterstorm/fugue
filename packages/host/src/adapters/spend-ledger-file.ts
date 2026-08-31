/** Thin anti-corruption adapter: framework file store errors → HostError. */

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
