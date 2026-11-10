/**
 * The totals of a `bun test --reporter=junit` report (dev-only test support).
 *
 * The pinned-time-zone child runs decide pass/fail from this machine-readable
 * report, not from bun's human-readable summary. Only the root `<testsuites>`
 * element is read: bun writes the run's totals there.
 */
import type { Result } from "@fuguejs/framework";
import { err, ok } from "@fuguejs/framework";
import { createXmlFeed, type XmlAttrs } from "../../xml.js";

export type JUnitTotals = {
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  /** `tests - failures - skipped`. */
  readonly passed: number;
};

const count = (attrs: XmlAttrs, name: string, fallback: number | null): Result<number, string> => {
  const raw = attrs[name];
  if (raw === undefined) return fallback === null ? err(`<testsuites> has no ${name} attribute`) : ok(fallback);
  return /^\d+$/.test(raw) ? ok(Number(raw)) : err(`<testsuites ${name}="${raw}"> is not a non-negative integer`);
};

/** Totals from the root element's attributes. `errors` (absent in bun's reports) counts as failures. */
const totalsOf = (attrs: XmlAttrs): Result<JUnitTotals, string> => {
  const tests = count(attrs, "tests", null);
  const failures = count(attrs, "failures", null);
  const errors = count(attrs, "errors", 0);
  const skipped = count(attrs, "skipped", 0);
  if (!tests.ok) return tests;
  if (!failures.ok) return failures;
  if (!errors.ok) return errors;
  if (!skipped.ok) return skipped;
  const failed = failures.value + errors.value;
  const passed = tests.value - failed - skipped.value;
  if (passed < 0) return err(`inconsistent totals: ${tests.value} tests, ${failed} failed, ${skipped.value} skipped`);
  return ok({ tests: tests.value, failures: failed, skipped: skipped.value, passed });
};

/** Parse a JUnit report. Malformed XML, a missing root `<testsuites>` or bad counts are errors. */
export const parseJUnitTotals = (xml: string): Result<JUnitTotals, string> => {
  let root: Result<JUnitTotals, string> | null = null;
  let depth = 0;
  const feed = createXmlFeed({
    open: (name, attrs) => {
      if (depth === 0) root = name === "testsuites" ? totalsOf(attrs) : err(`root element is <${name}>, not <testsuites>`);
      depth += 1;
    },
    close: () => {
      depth -= 1;
    },
    text: () => undefined,
  });
  const written = feed.write(xml);
  const closed = written.ok ? feed.close() : written;
  if (!closed.ok) return err(`malformed JUnit report: ${closed.error}`);
  return root ?? err("empty JUnit report");
};
