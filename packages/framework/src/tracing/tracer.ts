/**
 * Provider-agnostic tracer abstraction. Lives in `tracing/` so any module
 * needing it can import without crossing the `types/` ↔ `llm/` boundary.
 */
export interface Tracer {
  /** Wrap execution in a traced span. Auto-instrumented child calls nest under it. */
  withSpan<T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T>;
}
