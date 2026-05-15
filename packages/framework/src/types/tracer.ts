/**
 * Provider-agnostic tracer abstraction.
 *
 * Lives in `types/` so modules needing the type never cross a layer boundary.
 * Runtime impls that satisfy this interface live in their respective modules.
 */
export interface Tracer {
  /** Wrap execution in a traced span. Auto-instrumented child calls nest under it. */
  withSpan<T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T>;
}
