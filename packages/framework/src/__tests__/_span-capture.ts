/**
 * Shared capture harness for tests that drive `enrichLlmSpan` (or any
 * `trace.getActiveSpan()` consumer) against a recording OTel span.
 *
 * Used by `span-enrich.test.ts` and `pr53-repair-regression.test.ts` — one
 * copy so the two suites cannot drift apart on what "everything the helper
 * set" means.
 */

import { context, trace, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { enrichLlmSpan } from "../tracing/span-enrich.js";

export interface RecordedEvent {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
}

// Without a real context manager the API default is a no-op that does not
// propagate, so `trace.getActiveSpan()` inside the helper would never see the
// recording span. Same registration the tool-call span tests use.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/**
 * Run `enrichLlmSpan` against a recording span installed as the active OTel
 * span, and return everything it set.
 */
export const captureEnrichment = (
  opts: Parameters<typeof enrichLlmSpan>[0],
): { attributes: Record<string, unknown>; events: RecordedEvent[] } => {
  const attributes: Record<string, unknown> = {};
  const events: RecordedEvent[] = [];
  const span = {
    setAttribute: (k: string, v: unknown) => {
      attributes[k] = v;
      return span;
    },
    addEvent: (name: string, attrs: Record<string, unknown>) => {
      events.push({ name, attrs });
      return span;
    },
    setStatus: () => span,
    end: () => {},
  } as unknown as Span;

  const ctx = trace.setSpan(context.active(), span);
  context.with(ctx, () => {
    enrichLlmSpan(opts);
  });
  return { attributes, events };
};
