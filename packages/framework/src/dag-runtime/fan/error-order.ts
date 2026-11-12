// error-order — the single error a drained fan returns (AD-6, FR-021, FR-025).
//
// Precedence: child failure > refusal > abort.
//   - failures: the LOWEST index is primary; every other failure is kept as an
//     ascending secondary and the refusal, if any, is attached — nothing
//     observed during the drain is dropped (FR-025).
//   - one failure and no refusal: the bare primary error, exactly as the
//     sequential fan returns it today (FR-004 C=1 error identity).
//   - a refusal with no failure: `fan-budget-refused`.
//   - an abort only: today's `{ kind: "aborted", reason: "signal" }`. An abort
//     during a failure or refusal drain never changes the error (FR-024).
// The fan kinds are built ONLY through their factories (INV-2).
//
// Functional core: pure, no I/O.

import type { FrameworkError } from "../../types/errors.js";
import { frameworkError } from "../../types/error-factories.js";
import type { FanFailureCauses, FanRefusal, IndexedError } from "../../types/fan-scheduling.js";
import type { NodeId } from "../../types/ids.js";

type Failure = IndexedError<FrameworkError>;
type NonEmpty<T> = readonly [T, ...T[]];

/** The lowest-index failure, and every other failure in ascending index order. */
export const orderFailures = (
  failures: NonEmpty<Failure>,
): Readonly<{ primary: Failure; secondary: readonly Failure[] }> => {
  const primary = failures.reduce((lowest, f) => (f.index < lowest.index ? f : lowest), failures[0]);
  const secondary = failures.filter((f) => f !== primary).sort((a, b) => a.index - b.index);
  return Object.freeze({ primary, secondary: Object.freeze(secondary) });
};

/** The causes accompanying a primary failure, or `null` when it stands alone. */
const causesOf = (secondary: readonly Failure[], refusal: FanRefusal | null): FanFailureCauses<FrameworkError> | null => {
  const [first, ...rest] = secondary;
  if (first === undefined) return refusal === null ? null : { kind: "refusal", refusal };
  return refusal === null
    ? { kind: "secondaries", secondary: [first, ...rest] }
    : { kind: "secondaries-and-refusal", secondary: [first, ...rest], refusal };
};

/**
 * The error a drained fan returns, or `null` when the drain had no cause (the
 * fan completed and reduces).
 */
export const finishError = (
  nodeId: NodeId,
  failures: readonly Failure[],
  refusal: FanRefusal | null,
  aborted: boolean,
): FrameworkError | null => {
  const [head, ...tail] = failures;
  if (head !== undefined) {
    const { primary, secondary } = orderFailures([head, ...tail]);
    const causes = causesOf(secondary, refusal);
    return causes === null ? primary.error : frameworkError.fanChildFailed(nodeId, primary, causes);
  }
  if (refusal !== null) return frameworkError.fanBudgetRefused(nodeId, refusal);
  return aborted ? frameworkError.aborted("signal") : null;
};
