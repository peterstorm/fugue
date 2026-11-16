/**
 * The bytes the host persists for one node output (ADR-0091).
 *
 * A node checkpoint must restore exactly what the node returned:
 * `fromJson(bytes)` is deep-strictly-equal to the output. That is proved by
 * one allocation-free walk (`assertExactRoundTrip`) before `toJson`, not by
 * parsing the bytes back into a second copy of the output to compare. A
 * route's output can be the whole response, so that copy was a per-request
 * memory cost proportional to the response.
 *
 * Pure, and exported, so a DAG repository can run its DAGs under exactly the
 * encoding its host applies (tests, benchmarks).
 */

import { err, ok, safeErrorMessage, toJson } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { assertExactRoundTrip } from "@fuguejs/framework/file";

/** Labels the refusal names: the writer's operation and the output's root. */
const LABELS = { operation: "checkpointWriter.write", root: "nodeOutput" } as const;

/**
 * Encode a node output for persistence, or say why it cannot be restored
 * exactly. The refusal is diagnostic text for server-side logs; it names the
 * offending path and must not be shown to API callers.
 */
export const encodeNodeCheckpoint = (output: unknown): Result<string, string> => {
  try {
    assertExactRoundTrip(output, LABELS);
    return ok(toJson(output));
  } catch (error) {
    return err(safeErrorMessage(error));
  }
};
