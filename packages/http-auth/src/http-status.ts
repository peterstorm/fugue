/** HTTP response statuses that are safe to retry across auth package paths. */
const RETRIABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/** A response is retriable when it is 5xx, rate-limited, or timed out upstream. */
export const isRetriableHttpStatus = (status: number): boolean =>
  status >= 500 || RETRIABLE_HTTP_STATUSES.has(status);
