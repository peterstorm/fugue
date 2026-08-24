/**
 * Lossless JSON serialization for HITL durable records.
 *
 * Every value this module encodes is about to become the DURABLE record a run is
 * later resumed from, so "it stringified without throwing" is not a strong enough
 * guarantee: a value that silently loses a field, a `Date`, or a `Map` on the way
 * to JSON would resume as a different run than the one that was suspended. Each
 * write therefore proves losslessness before it is allowed to reach Redis:
 *
 *   1. `assertLosslessEvent` rejects shapes JSON cannot represent faithfully.
 *   2. Encode.
 *   3. Decode and compare against the original — with the record's own schema
 *      where one exists, so the stored bytes are proven to satisfy the schema the
 *      READER will apply, not merely to round-trip structurally.
 *   4. Any failure becomes a typed `internal-invariant-violated`, never a throw.
 *
 * ONE definition: `serializeHumanAction`, `serializeRunMeta` and
 * `serializeRunCreationIntent` each open-coded this identical four-step protocol.
 * A copy that skipped step 3 would be indistinguishable at the call site while
 * silently removing the proof the whole protocol exists for.
 */

import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { fromJson, ok, err, safeErrorMessage, toJson } from "@fuguejs/framework";
import { assertLosslessEvent } from "@fuguejs/framework/file";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";

export interface LosslessEncodeOpts<T> {
  /** Operation label for `assertLosslessEvent` diagnostics. */
  readonly operation: string;
  /** Root label for `assertLosslessEvent` diagnostics. */
  readonly root: string;
  /** Domain noun used in failure messages, e.g. `"run metadata"`. */
  readonly subject: string;
  /**
   * The reader's schema, when the record has one. Supplying it strengthens the
   * round-trip check from "decodes to an equal value" to "decodes to a value the
   * reader's own parser accepts AND that equals the original".
   */
  readonly schema?: z.ZodType<T>;
}

/**
 * Encode `value` to JSON, proving the round trip is lossless first.
 *
 * Returns the encoded string, or a typed `internal-invariant-violated` naming the
 * subject. Never throws.
 */
export const serializeLossless = <T>(
  value: T,
  opts: LosslessEncodeOpts<T>,
): Result<string, HostError> => {
  try {
    assertLosslessEvent(value, { operation: opts.operation, root: opts.root });
    const encoded = toJson(value);
    const decoded = fromJson(encoded);
    // With a schema, the reader's parse result is what must match; without one,
    // the decoded value itself is compared. `undefined` marks a schema rejection
    // and can never be a legitimate record here (every subject is an object).
    const restored: unknown = opts.schema
      ? (() => {
          const parsed = opts.schema.safeParse(decoded);
          return parsed.success ? parsed.data : undefined;
        })()
      : decoded;
    if (restored === undefined || !isDeepStrictEqual(restored, value)) {
      throw new Error(`${opts.subject} failed losslessness round-trip verification`);
    }
    return ok(encoded);
  } catch (error) {
    return err({
      kind: "internal-invariant-violated",
      message: `${opts.subject} is not losslessly serializable: ${safeErrorMessage(error)}`,
      context: {},
    });
  }
};
