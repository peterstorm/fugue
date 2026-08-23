// The file backend's closed factory-options grammar — ONE shared encoding for
// the same-discipline factories (`createFileJournal`,
// `createFileFreshnessIndex`): a plain object with at most the caller's
// declared option keys — always the single `now` option (a function),
// defaulting to `Date.now` — plus any test-only seam keys the CALLER factory
// declares (e.g. `createFileFreshnessIndex`'s `atomicWriteFileHooks`). The
// parser validates the bag ITSELF (prototype check on the original object),
// so callers must pass their raw options through, never a copy.
//
// The parser throws a plain `Error` carrying the bare rejection message; each
// factory re-throws it in its own typed context (its own operation/location),
// so the final rendered messages stay exactly what the hostile-options tests
// pin. `parseFileCheckpointerClock` in `checkpointer.ts` remains a
// deliberately STRICTER descriptor-isolated variant (it reasons about Proxy
// observation counts) and does not share this encoding.

import { safeDiagnosticRender } from "../types/safe-error.js";

export const parseFileFactoryClock = (
  opts: unknown,
  extraOptionKeys: readonly string[] = [],
): (() => number) => {
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    throw new Error(`options must be a plain object, got ${safeDiagnosticRender(opts)}`);
  }
  const prototype = Object.getPrototypeOf(opts);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("options must be a plain object");
  }
  const keys = Reflect.ownKeys(opts);
  const unsupported = keys.find(
    (key) => key !== "now" && !extraOptionKeys.includes(key as string),
  );
  if (unsupported !== undefined) {
    const supported = ["now", ...extraOptionKeys].join(" / ");
    throw new Error(`unsupported option ${safeDiagnosticRender(unsupported)}; supported options are ${supported}`);
  }
  const configuredNow = keys.includes("now")
    ? (opts as Record<string, unknown>).now
    : undefined;
  if (configuredNow !== undefined && typeof configuredNow !== "function") {
    throw new Error(`options.now must be a function, got ${safeDiagnosticRender(configuredNow)}`);
  }
  if (configuredNow === undefined) return Date.now;
  // FR-040 total-guard convention: validating that a caller-supplied callback is
  // CALLABLE proves nothing about what it returns. An unchecked
  // `now: () => "not-a-number"` (or one that drifts to NaN/Infinity) passes the
  // typeof gate and then contaminates every `recordedAtMs` this factory stamps,
  // which is exactly the field resume/freshness ordering is decided on. Guard the
  // return the same way `resume-proof.ts`'s `guardedStateKey` guards its own
  // callback: check on every call, since a clock may be well-behaved once and not
  // thereafter, and fail closed at the call rather than write a poisoned record.
  const supplied = configuredNow as () => unknown;
  return (): number => {
    const value = supplied();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `options.now must return a finite number, got ${safeDiagnosticRender(value)}`,
      );
    }
    return value;
  };
};
