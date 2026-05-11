/**
 * Side-channel registry for span attributes that OTel SDK rejects.
 *
 * The OTel JS SDK (@opentelemetry/sdk-trace-base 1.x / 2.x) silently drops
 * non-primitive attribute values (objects, nested arrays). The accepted
 * shapes are `string | number | boolean | string[] | number[] | boolean[]`
 * — see the `AttributeValue` type and `_isAttributeValueValid()` validation
 * inside the SDK. MLflow's server, in contrast, expects several attributes
 * as structured objects (e.g. `mlflow.llm.cost` as a dict,
 * `mlflow.spanInputs` as a record of input fields) — round-tripped via
 * protobuf `kvlist_value`.
 *
 * Wave 5 §5.5: the SDK's behavior is intentional — the OTel semconv treats
 * attributes as a flat primitive bag — so this registry is a sanctioned
 * side-channel, not a workaround for a transient SDK bug. Keep the
 * indirection even on SDK upgrades unless the spec itself changes.
 *
 * Wave 5 §5.4: moved from `observer/span-attribute-registry.ts` — co-located
 * with the rest of the OTel tracing infrastructure.
 *
 * This registry stores object-valued attributes keyed by spanId. Our custom
 * OTLP exporter reads from here and injects them onto `ReadableSpan.attributes`
 * before serialization, bypassing the SDK's validation. The otlp-transformer
 * then serializes objects as protobuf `kvlist_value`, which MLflow's server
 * decodes correctly.
 *
 * Lifecycle: entries are cleaned up when the exporter processes them (or on
 * trace discard).
 */

export interface SpanAttributes {
  readonly [key: string]: unknown;
}

/**
 * Global registry for object-valued span attributes.
 * Thread-safe in single-threaded JS; no locking needed.
 */
class SpanAttributeRegistryImpl {
  private readonly store = new Map<string, SpanAttributes>();

  /** Register object attributes for a span. Merges with existing if any. */
  set(spanId: string, attrs: SpanAttributes): void {
    const existing = this.store.get(spanId);
    this.store.set(spanId, existing ? { ...existing, ...attrs } : attrs);
  }

  /** Get registered attributes for a span. Returns undefined if none. */
  get(spanId: string): SpanAttributes | undefined {
    return this.store.get(spanId);
  }

  /** Remove and return attributes for a span (used during export). */
  pop(spanId: string): SpanAttributes | undefined {
    const attrs = this.store.get(spanId);
    if (attrs) this.store.delete(spanId);
    return attrs;
  }

  /** Remove all attributes for spans in a trace (used on discard). */
  deleteAll(spanIds: Iterable<string>): void {
    for (const id of spanIds) this.store.delete(id);
  }

  /** Current entry count (for monitoring/testing). */
  get size(): number {
    return this.store.size;
  }

  /** Clear all entries (for testing). */
  clear(): void {
    this.store.clear();
  }
}

/** Singleton instance. */
export const SpanAttributeRegistry = new SpanAttributeRegistryImpl();
