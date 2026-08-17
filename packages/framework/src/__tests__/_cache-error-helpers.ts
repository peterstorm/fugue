// Shared test helper for the file backend's closed `cache-error` boundary.
//
// The `createFile*` factories and the strict readers fail with typed
// `cache-error` values (ADR-0080), and the hostile-options / read-pipeline
// suites each need to narrow that failure to the `cache-error` member for
// property assertions. One helper replaces the per-file copies, which had
// drifted: the event-record copy omitted the message-length check and the
// operation check was not uniform across the three sites. This is the
// strictest common shape — optional `expectedOperation` + non-empty message
// — so adopting it at the two sites that lacked the length check only ADDS
// an assertion.

import { expect } from "bun:test";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";

/** Narrow a boundary failure to the `cache-error` member for property
 * assertions. `expectedOperation` is optional so one helper serves both
 * operation-pinned sites and the operation-unpinned reader suites. */
export const asCacheError = (
  error: unknown,
  expectedOperation?: string,
): Extract<FrameworkError, { readonly kind: "cache-error" }> => {
  expect(isFrameworkError(error)).toBe(true);
  if (!isFrameworkError(error) || error.kind !== "cache-error") {
    throw new Error("expected a typed cache-error");
  }
  expect(error.kind).toBe("cache-error");
  if (expectedOperation !== undefined) expect(error.operation).toBe(expectedOperation);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
};
