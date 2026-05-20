// Framework-level OTel Tracer seam.
//
// The kernel mints spans from `dag-runtime/run-dag-stateful.ts`,
// `dag-runtime/eval-judges.ts`, and `dag-runtime/node-span.ts`. Routing them
// through a single resolved reference lets the host install a replacement
// tracer (typically alongside `initTracing` — or a `RecordingTracer` in
// tests) without each call site touching the global OTel SDK directly.

import { trace, type Tracer } from "@opentelemetry/api";

const defaultTracer = (): Tracer => trace.getTracer("ai-summary-framework");

let _tracer: Tracer | null = null;

/**
 * Install a host-provided OTel tracer for the framework's internal spans.
 * The default (resolved lazily on first access) is
 * `trace.getTracer("ai-summary-framework")`.
 */
export const setFrameworkTracer = (tracer: Tracer): void => {
  _tracer = tracer;
};

/**
 * Reset the global tracer back to the OTel default. Test-only.
 */
export const __resetFrameworkTracer = (): void => {
  _tracer = null;
};

/**
 * Resolve the current framework tracer. Lazy default — does not call into
 * `trace.getTracer` until first read, so module load order remains unchanged
 * relative to host bootstrap.
 */
export const fwTracer = (): Tracer => _tracer ?? defaultTracer();
