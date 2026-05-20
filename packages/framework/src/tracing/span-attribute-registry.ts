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
 * The SDK's behavior is intentional — the OTel semconv treats attributes as
 * a flat primitive bag — so this registry is a sanctioned side-channel, not
 * a workaround for a transient SDK bug. Keep the indirection even on SDK
 * upgrades unless the spec itself changes.
 *
 * This registry stores object-valued attributes keyed by spanId. Our custom
 * OTLP exporter reads from here and injects them onto `ReadableSpan.attributes`
 * before serialization, bypassing the SDK's validation. The otlp-transformer
 * then serializes objects as protobuf `kvlist_value`, which MLflow's server
 * decodes correctly.
 *
 * Lifecycle: entries are cleaned up when the exporter processes them (or on
 * trace discard).
 *
 * Instance ownership: the registry is constructed per `MlflowOtlpExporter`,
 * not as a process-global singleton. Parallel test runs and multi-tenant
 * worker processes therefore cannot cross-corrupt one another's state, and
 * a `clear()` call from one exporter cannot evict entries owned by a peer.
 */

export interface SpanAttributes {
  readonly [key: string]: unknown;
}

/**
 * Registry for object-valued span attributes. Instance-scoped; create one
 * via `createSpanAttributeRegistry()` and hand it to the consumer (typically
 * an exporter constructor).
 */
export interface SpanAttributeRegistry {
  /** Register object attributes for a span. Merges with existing if any. */
  set(spanId: string, attrs: SpanAttributes): void;
  /** Get registered attributes for a span. Returns undefined if none. */
  get(spanId: string): SpanAttributes | undefined;
  /** Remove and return attributes for a span (used during export). */
  pop(spanId: string): SpanAttributes | undefined;
  /** Remove all attributes for spans in a trace (used on discard). */
  deleteAll(spanIds: Iterable<string>): void;
  /** Current entry count (for monitoring/testing). */
  readonly size: number;
  /** Clear all entries (for testing). */
  clear(): void;
}

/**
 * Construct a fresh, isolated `SpanAttributeRegistry`. Each call returns an
 * independent instance — no shared state between registries.
 */
export const createSpanAttributeRegistry = (): SpanAttributeRegistry => {
  const store = new Map<string, SpanAttributes>();

  return {
    set(spanId, attrs) {
      const existing = store.get(spanId);
      store.set(spanId, existing ? { ...existing, ...attrs } : attrs);
    },
    get(spanId) {
      return store.get(spanId);
    },
    pop(spanId) {
      const attrs = store.get(spanId);
      if (attrs) store.delete(spanId);
      return attrs;
    },
    deleteAll(spanIds) {
      for (const id of spanIds) store.delete(id);
    },
    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
};
