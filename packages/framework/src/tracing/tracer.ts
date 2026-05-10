/**
 * Provider-agnostic tracer abstraction. Lives in `tracing/` so neither
 * `types/node.ts` nor `llm/client.ts` need to import the other to share it.
 */
export interface Tracer {
  /** Wrap execution in a traced span. Auto-instrumented child calls nest under it. */
  withSpan<T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T>;
}
