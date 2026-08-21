/**
 * Capability tracing — automatic OTel span wrapping for capability method calls.
 *
 * Wraps a capability client's methods in traced spans that capture:
 * - Capability name and method name as span attributes
 * - Duration (via span timing)
 * - Error status on Result.Err or thrown exceptions
 * - Custom attributes from an optional extractor function
 *
 * This is opt-in: callers wrap their CapabilityHandle with `withTracedCapability`
 * before registering it. The framework does NOT auto-wrap — the caller controls
 * which capabilities get trace instrumentation.
 *
 * @satisfies ADR-0051 Phase 4 — Automatic OTel span wrapping at capability boundary
 */

import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Tracer as OtelTracer } from "@opentelemetry/api";
import type { CapabilityHandle } from "../types/capability-handle.js";
import type { Capability } from "../types/node.js";

// ---------------------------------------------------------------------------
// Semantic conventions for capability spans
// ---------------------------------------------------------------------------

const FUGUE_CAPABILITY_NAME = "fugue.capability.name";
const FUGUE_CAPABILITY_METHOD = "fugue.capability.method";
const FUGUE_CAPABILITY_ERROR_KIND = "fugue.capability.error_kind";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for capability tracing.
 */
const finalizeThrownSpan = (span: Span, error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.recordException(error instanceof Error ? error : new Error(message));
  span.end();
  throw error;
};

export interface TracedCapabilityOpts {
  /**
   * OTel tracer name used for span creation.
   * Defaults to "fugue.capability".
   */
  readonly tracerName?: string;

  /**
   * Explicit OTel tracer. When provided, `tracerName` is ignored and spans
   * are created on this tracer instead of the global registry — useful for
   * tests (in-memory exporters) and multi-provider setups.
   */
  readonly tracer?: OtelTracer;

  /**
   * Optional function to extract extra span attributes from method arguments.
   * Called before each method invocation.
   */
  readonly extractAttributes?: (
    method: string,
    args: unknown[],
  ) => Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Core wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a capability client's methods in OTel spans.
 *
 * Every function-valued property is wrapped; non-function properties pass
 * through unchanged. Promise returns are awaited for `Result`-error tagging;
 * synchronous returns end the span immediately (with the same `Result`
 * inspection).
 *
 * Each wrapped call creates a span named `{capabilityName}.{methodName}`.
 * If the returned value is a `Result` with `ok: false`, the span is marked
 * as errored with the error kind as an attribute. Failure detection is
 * structural (`{ ok: false }`) — capability methods that signal failure by
 * any other convention trace as OK; return the framework `Result` shape to
 * get error tagging.
 *
 * Contract: wrapped methods are invoked with `this` bound to the *unwrapped*
 * client. Closure-based clients (every built-in adapter) are unaffected;
 * class-based clients whose methods call siblings via `this` will bypass
 * tracing for those inner calls.
 *
 * @example
 * ```ts
 * const pgHandle = createPgAdapter({ connectionString: "..." });
 * const tracedPg = withTracedCapability(pgHandle);
 * // tracedPg.client.query() now creates a "db.query" span
 * ```
 */
export const withTracedCapability = <K extends Capability>(
  handle: CapabilityHandle<K>,
  opts: TracedCapabilityOpts = {},
): CapabilityHandle<K> => {
  const tracerName = opts.tracerName ?? "fugue.capability";
  const otelTracer = opts.tracer ?? trace.getTracer(tracerName);
  const capName = handle.name as string;

  const tracedClient = new Proxy(handle.client as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      const methodName = String(prop);

      return (...args: unknown[]) => {
        const spanName = `${capName}.${methodName}`;
        return otelTracer.startActiveSpan(spanName, (span) => {
          span.setAttribute(FUGUE_CAPABILITY_NAME, capName);
          span.setAttribute(FUGUE_CAPABILITY_METHOD, methodName);

          // Extract custom attributes if configured
          if (opts.extractAttributes) {
            try {
              const attrs = opts.extractAttributes(methodName, args);
              for (const [k, v] of Object.entries(attrs)) {
                span.setAttribute(k, v);
              }
            } catch (extractError) {
              // Best-effort — don't crash the actual call for attribute
              // extraction, but leave a trace of the failure on the span so
              // a buggy extractor is diagnosable.
              span.addEvent("fugue.capability.attribute_extraction_failed", {
                message: extractError instanceof Error ? extractError.message : String(extractError),
              });
            }
          }

          try {
            const result = (value as Function).apply(target, args);

            // If the result is a Promise, await it and check for Result errors
            if (result && typeof result === "object" && "then" in result) {
              return (result as Promise<unknown>).then(
                (resolved) => {
                  // Check if it's a Result with ok: false
                  if (isErrResult(resolved)) {
                    const errKind = (resolved as { error: { kind?: string } }).error?.kind ?? "unknown";
                    span.setAttribute(FUGUE_CAPABILITY_ERROR_KIND, errKind);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: errKind });
                  }
                  span.end();
                  return resolved;
                },
                (error) => finalizeThrownSpan(span, error),
              );
            }

            // Synchronous return (unlikely for capabilities but handle
            // gracefully) — a sync `Result` Err still errors the span.
            if (isErrResult(result)) {
              const errKind = (result as { error: { kind?: string } }).error?.kind ?? "unknown";
              span.setAttribute(FUGUE_CAPABILITY_ERROR_KIND, errKind);
              span.setStatus({ code: SpanStatusCode.ERROR, message: errKind });
            }
            span.end();
            return result;
          } catch (error) {
            return finalizeThrownSpan(span, error);
          }
        });
      };
    },
  }) as typeof handle.client;

  return {
    ...handle,
    client: tracedClient,
  };
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Check if a value looks like a Result with ok: false.
 */
const isErrResult = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  (value as { ok: unknown }).ok === false;
