// Subordinate-failure handling for the DAG runtime: logging and telemetry are
// diagnostics ABOUT a run, never part of its outcome, so a broken logger or a
// throwing exporter must never replace the primary node/run result.
//
// ONE encoding of that rule (round-38 cs-10). It was previously reimplemented
// three times — `freshness-emission.ts`'s `warnWithoutThrowing`,
// `node-span.ts`'s `bestEffortLog`/`bestEffortTelemetry`, and
// `run-telemetry.ts`'s `bestEffortLog`/`bestEffortRootTelemetry` — where a
// change to the rule (say, counting suppressed diagnostics) would have had to
// be remembered in each.

import { fwLogger } from "../logger.js";
import { safeErrorMessage } from "../types/safe-error.js";

/** Log at `level`, swallowing a logger that itself throws. */
export const bestEffortLog = (
  level: "debug" | "warn" | "error",
  message: string,
): void => {
  try {
    fwLogger()[level](message);
  } catch {
    // The modeled outcome remains authoritative.
  }
};

/**
 * Run a subordinate effect (a span attribute, an event emission, an exporter
 * call), reporting a failure as a `debug` diagnostic prefixed with `scope` and
 * naming `operation` — never propagating it.
 */
export const bestEffort = (
  scope: string,
  operation: string,
  effect: () => void,
): void => {
  try {
    effect();
  } catch (error) {
    bestEffortLog("debug", `${scope} ${operation} failed: ${safeErrorMessage(error)}`);
  }
};
