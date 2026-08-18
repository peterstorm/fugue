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
  return configuredNow === undefined ? Date.now : configuredNow as () => number;
};
