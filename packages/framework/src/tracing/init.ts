/**
 * Initialize the OTel tracing pipeline with tail-based sampling.
 *
 * Vendor-neutral: accepts any SpanExporter. Use createMlflowExporter() for MLflow,
 * or any standard OTLPTraceExporter for Jaeger/Tempo/Honeycomb/etc.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TailSamplingProcessor } from "../observer/tail-sampling-processor.js";
import type { PersistencePolicy } from "../observer/policy.js";
import { CompositeSpanExporter } from "./composite-exporter.js";

export interface TracingConfig {
  /**
   * One OTel-compatible span exporter, or a list of them. A list selects
   * multiple trace backends simultaneously (FR-002): the same spans are
   * delivered to every exporter via {@link CompositeSpanExporter}.
   *
   * Normalization (see {@link normalizeExporter}):
   * - a single exporter is used as-is (no wrapping);
   * - a one-element list is unwrapped to its bare exporter — byte-for-byte
   *   identical to passing that exporter directly (SC-006 no-regression);
   * - a list of two or more is wrapped in a CompositeSpanExporter;
   * - an empty list is rejected.
   *
   * The list form is a *non-empty tuple* (`[SpanExporter, ...SpanExporter[]]`),
   * so `exporter: []` is a compile error at literal call sites — the non-empty
   * invariant is unrepresentable, not merely a runtime throw (CLAUDE.md: make
   * illegal states impossible). The runtime check in {@link normalizeExporter}
   * is retained as defense-in-depth for dynamically-built lists that cross an
   * untyped boundary.
   */
  readonly exporter: SpanExporter | readonly [SpanExporter, ...SpanExporter[]];
  /** Persistence policy for tail-based sampling */
  readonly policy: PersistencePolicy;
}

/** Narrowing guard for the array arm of the exporter union. */
const isExporterList = (
  exporter: SpanExporter | readonly SpanExporter[],
): exporter is readonly SpanExporter[] => Array.isArray(exporter);

/**
 * Collapse the (possibly multi-backend) exporter config into the single
 * `SpanExporter` the tail-sampling processor consumes.
 *
 * Pure function (functional core): no I/O, no SDK side effects — trivially
 * unit-testable. The `[1] → bare exporter` path is the critical guarantee for
 * SC-006: with exactly one backend, no Composite wrapper is introduced, so the
 * export pipeline is identical to the pre-multi-backend behaviour.
 */
export const normalizeExporter = (
  exporter: SpanExporter | readonly SpanExporter[],
): SpanExporter => {
  // Clean union narrowing via a typed predicate — no `as SpanExporter` casts.
  if (!isExporterList(exporter)) {
    // Single exporter — as-is, no Composite wrapper.
    return exporter;
  }
  // Defense-in-depth: the public type forbids `[]`, but dynamically-built
  // lists (built by the app bootstrap) cross an untyped boundary, so re-check at runtime.
  if (exporter.length === 0) {
    throw new Error(
      "TracingConfig.exporter: empty exporter list — provide at least one SpanExporter",
    );
  }
  // Unwrap a one-element list to the bare exporter: byte-for-byte identical to
  // passing that exporter directly (no Composite wrapper). Critical for SC-006.
  if (exporter.length === 1) return exporter[0]!;
  // length >= 2 here: the length===0 (throw) and length===1 (unwrap) cases
  // returned above, so this cast from the wide dynamic-boundary array to a
  // non-empty tuple is sound. This is the SINGLE sanctioned widening->narrowing
  // point; the constructor's type otherwise enforces the non-empty invariant.
  return new CompositeSpanExporter(
    exporter as readonly [SpanExporter, ...SpanExporter[]],
  );
};

export interface TracingHandle {
  /** The tail-sampling processor (for monitoring exported/dropped counts) */
  readonly processor: TailSamplingProcessor;
  /**
   * The persistence policy bound to the tail-sampler. Hosts wiring a
   * `BufferedObserver` should pass *this same instance* so events and spans
   * make a single coherent persistence decision per run. Diverging policies
   * mean a run can persist events while dropping spans (or vice versa).
   */
  readonly policy: PersistencePolicy;
  /** Flush all pending traces */
  readonly flush: () => Promise<void>;
  /** Shut down the tracing pipeline */
  readonly shutdown: () => Promise<void>;
}

export async function initTracing(config: TracingConfig): Promise<TracingHandle> {
  // Normalize at the boundary (imperative shell): single → as-is, [1] →
  // unwrapped, [N] → Composite, [] → throw. Everything downstream sees one
  // SpanExporter, so the TailSamplingProcessor lifecycle is unchanged.
  const exporter = normalizeExporter(config.exporter);
  const tailProcessor = new TailSamplingProcessor(exporter, config.policy);

  const sdk = new NodeSDK({ spanProcessors: [tailProcessor] });
  sdk.start();

  return {
    processor: tailProcessor,
    policy: config.policy,
    flush: async () => tailProcessor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
