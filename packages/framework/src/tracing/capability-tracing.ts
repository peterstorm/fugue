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
import type { CapabilityHandle } from "../types/capability-handle.js";
import type { Capability } from "../types/node.js";
import type { Result } from "../types/result.js";

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
export interface TracedCapabilityOpts {
  /**
   * OTel tracer name used for span creation.
   * Defaults to "fugue.capability".
   */
  readonly tracerName?: string;

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
 * Wrap a capability client's async methods in OTel spans.
 *
 * Only functions returning Promises are wrapped — synchronous properties
 * and non-function values are passed through unchanged.
 *
 * Each wrapped call creates a span named `{capabilityName}.{methodName}`.
 * If the returned value is a `Result` with `ok: false`, the span is marked
 * as errored with the error kind as an attribute.
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
  const otelTracer = trace.getTracer(tracerName);
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
            } catch {
              // Best-effort — don't crash the actual call for attribute extraction
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
                (error) => {
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                  });
                  span.recordException(error instanceof Error ? error : new Error(String(error)));
                  span.end();
                  throw error;
                },
              );
            }

            // Synchronous return (unlikely for capabilities but handle gracefully)
            span.end();
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.end();
            throw error;
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
