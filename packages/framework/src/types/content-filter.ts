/**
 * A function that scrubs/transforms content before it is written to a span.
 * Must be pure and side-effect free (called in hot path).
 *
 * Lives in `types/` so the type layer is self-contained.
 * Runtime helpers (`piiScrubber`, `IDENTITY_FILTER`, etc.) live in
 * `tracing/content-filter.ts`.
 */
export type ContentFilter = (content: string) => string;
