// Always-present defaults for NodeContext fields.
//
// `logger`, `tracer`, and `observer` are NOT in the capability set — they
// can't be required, only injected. The runtime wraps caller-supplied
// contexts with these defaults so node bodies never have to null-check them.

import type { Logger } from "../types/node.js";
import type { Tracer } from "../types/tracer.js";
import type { Observer } from "../types/observer.js";
import { NoopObserver } from "../types/observer.js";

/** Console-backed logger — methods route to `console.warn`/`console.error`. */
export const consoleLogger: Logger = {
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

/** Tracer that invokes the wrapped function without opening a span. */
export const noopTracer: Tracer = {
  withSpan: async (_name, _spanType, fn) => fn(),
};

/** Reuse the existing NoopObserver — `observe` is a no-op. */
export const noopObserver: Observer = new NoopObserver();
