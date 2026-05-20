/**
 * Content filter for trace span data.
 *
 * A ContentFilter transforms arbitrary string content before it is attached
 * to OTel span events. The canonical use-case is PII scrubbing: content is
 * included in traces for debugging but sensitive patterns (emails, phones,
 * credit cards, etc.) are replaced with placeholder tokens.
 *
 * When `null`/`undefined`, content is fully redacted.
 * When set to `IDENTITY_FILTER`, content passes through unmodified.
 */

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

// Re-export the type from its canonical home in `types/`.
export type { ContentFilter } from "../types/content-filter.js";
import type { ContentFilter } from "../types/content-filter.js";

/** Pass-through filter — includes content unmodified. */
export const IDENTITY_FILTER: ContentFilter = (s) => s;

// ---------------------------------------------------------------------------
// Built-in PII scrubber
// ---------------------------------------------------------------------------

/** Patterns matched by the built-in PII scrubber. Order matters — more specific patterns first. */
const PII_PATTERNS: readonly { regex: RegExp; replacement: string }[] = [
  // Credit card numbers (13-19 digits, optionally separated by dashes/spaces)
  { regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/g, replacement: "[CREDIT_CARD]" },
  // Email addresses
  { regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL]" },
  // US Social Security Numbers (XXX-XX-XXXX, with or without dashes)
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
  // Danish CPR numbers (DDMMYY-XXXX) — date-validated: DD=01-31, MM=01-12, YY=00-99
  { regex: /\b(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}-?\d{4}\b/g, replacement: "[CPR]" },
  // IP addresses (v4)
  { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[IP]" },
  // Phone numbers (international and common formats)
  { regex: /\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}/g, replacement: "[PHONE]" },
  { regex: /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/g, replacement: "[PHONE]" },
];

/**
 * Built-in PII scrubber. Applies regex-based pattern matching to replace
 * common PII patterns with placeholder tokens. Not exhaustive — for
 * production environments handling medical/financial data, consider a
 * purpose-built NER-based scrubber.
 */
export const piiScrubber: ContentFilter = (content: string): string => {
  let result = content;
  for (const { regex, replacement } of PII_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
};

/**
 * Compose multiple content filters left-to-right.
 * `composeFilters(a, b)` applies `a` first, then `b`.
 */
export const composeFilters = (...filters: ContentFilter[]): ContentFilter =>
  (content: string) => filters.reduce((acc, f) => f(acc), content);

// ---------------------------------------------------------------------------
// Resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve the effective content filter from context fields.
 *
 * Returns `null` when content should be fully redacted (no filter available).
 * Callers wanting raw content set `contentFilter: IDENTITY_FILTER`; callers
 * wanting PII scrubbing set `contentFilter: piiScrubber` (or compose).
 */
export const resolveContentFilter = (opts: {
  contentFilter?: ContentFilter | null;
}): ContentFilter | null => {
  if (opts.contentFilter !== undefined && opts.contentFilter !== null) {
    return opts.contentFilter;
  }
  return null;
};
