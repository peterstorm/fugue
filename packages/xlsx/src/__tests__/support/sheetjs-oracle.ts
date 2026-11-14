/**
 * SheetJS differential oracle (FR-043, AS-009) — dev-only test support.
 *
 * `oracleParse` is the pre-change `parseWorkbook` (SheetJS 0.18.5 full load,
 * `cellDates: true`) copied VERBATIM from `packages/xlsx/src/index.ts` at
 * commit cc26615; only the exported name changed. It is the reference that
 * decides parity for the streaming reader. Do not "fix" it: its quirks (local
 * time-zone date conversion, the 1900 leap-year bug, `!ref` handling) ARE the
 * contract the new reader replicates.
 *
 * The one exception to "verbatim": `normalizeCell` is imported from production
 * (`../../normalize-cell.js`) instead of re-copied. It was an identical copy of a
 * pure public helper the streaming reader never calls, so sharing it cannot
 * change what the oracle decides.
 *
 * Inherited comments are verbatim too. In particular, the "`dense: false` keeps
 * address-keyed access" note inside `oracleParse` does not refer to an option
 * this call passes: it describes SheetJS's DEFAULT (sparse, address-keyed) sheet
 * mode, which the `XLSX.read` call gets by omitting `dense`.
 *
 * This file is the ONLY non-`*.test.ts` file allowed to import `xlsx` (INV-1).
 *
 * The oracle's local `ParseWorkbookOpts` stays verbatim, but a compile-time
 * assertion below binds it to the production type: if the production options
 * gain or change a field, this file stops compiling instead of the oracle
 * silently ignoring the field.
 *
 * Besides the oracle it owns the parity decision itself: a canonical, fully
 * comparable form of a parse outcome (`canonicalOutcome`), the first divergence
 * between two outcomes (`firstDivergence`), the one-call `differential`, and the
 * pinned-time-zone child-process runner (`runSuiteUnderTimeZone`), whose verdict
 * comes from the child's exit code and its JUnit report.
 */

import * as XLSX from "xlsx";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";
import { parseWorkbook, type ParseWorkbookOpts as ProductionParseWorkbookOpts } from "../../index.js";
import { normalizeCell } from "../../normalize-cell.js";
import { parseJUnitTotals, type JUnitTotals } from "./junit-report.js";
import { REAL_DATA_DIR_ENV, realDataDir } from "./real-data-dir.js";

// ════════════════════════════════════════════════════════════════════════════
// The oracle — verbatim copy of the pre-change SheetJS implementation.
// ════════════════════════════════════════════════════════════════════════════

/** Sentinel node ID for parse errors (parsing is a lib, not a DAG node). */
const XLSX_NODE_ID = nodeId("xlsx-parse");

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const crashErr = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: XLSX_NODE_ID,
  message,
  retriability: "non-retriable",
});

const validationErr = (message: string, path?: string): FrameworkError => ({
  kind: "validation",
  nodeId: XLSX_NODE_ID,
  message,
  ...(path !== undefined ? { path } : {}),
});

/** Options for `parseWorkbook`. */
interface ParseWorkbookOpts {
  /** Worksheet to read: name (string) or 1-based index (number). Default: first sheet. */
  readonly sheet?: string | number;
  /** 1-based row holding the column headers. Default: 1. */
  readonly headerRow?: number;
}

// ── Not part of the verbatim copy: the oracle's options must BE the production options. ──
/** `true` only when A and B are the same type (mutually assignable, modifiers included). */
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
true satisfies Equal<ParseWorkbookOpts, ProductionParseWorkbookOpts>;

/**
 * The raw value of a SheetJS cell, mapped for `normalizeCell`. An error cell
 * (`t === "e"`, e.g. `#REF!`/`#DIV/0!`) carries its code in `.v`; map it to `null`
 * so it normalises like ExcelJS error cells did. Formula cells expose the cached
 * result in `.v` (we never evaluate formulas). A missing cell → `null`.
 */
const cellValue = (cell: XLSX.CellObject | undefined): unknown =>
  cell === undefined ? null : cell.t === "e" ? null : cell.v ?? null;

/**
 * Select the target worksheet by name, 1-based index, or default (first), or
 * `undefined` when the requested sheet is absent (→ caller emits node-crash).
 */
const selectSheet = (wb: XLSX.WorkBook, sheet: string | number | undefined): XLSX.WorkSheet | undefined => {
  if (typeof sheet === "string") return wb.Sheets[sheet];
  const name = wb.SheetNames[(typeof sheet === "number" ? sheet : 1) - 1];
  return name === undefined ? undefined : wb.Sheets[name];
};

/**
 * Parse `.xlsx` bytes into rows validated against `rowSchema`.
 *
 * Returns:
 * - `node-crash` (non-retriable) when the bytes aren't a readable workbook or
 *   the requested worksheet is absent — deterministic, so not retried.
 * - `validation` when a row does not match `rowSchema` (message names the row).
 * - `ok({ rows })` otherwise. Rows are skipped when every cell normalises to
 *   empty — this includes rows whose cells are all error cells (`#REF!`,
 *   `#DIV/0!`, …), since those map to `null`. A row mixing an error cell with
 *   real values is kept and fails `rowSchema` validation unless the offending
 *   column is nullable.
 */
export const oracleParse = async <T>(
  bytes: Uint8Array,
  rowSchema: z.ZodType<T>,
  opts: ParseWorkbookOpts = {},
): Promise<Result<{ rows: readonly T[] }, FrameworkError>> => {
  // An .xlsx is a ZIP, so it MUST start with the PK local-file-header magic
  // (`50 4B 03 04`). SheetJS is lenient and would coerce arbitrary bytes into an
  // empty sheet rather than throw, so guard the magic up front to keep the
  // "non-workbook bytes → node-crash" contract (deterministic, non-retriable).
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04
  ) {
    return err(crashErr("failed to parse workbook: not a valid .xlsx file (missing ZIP signature)"));
  }

  let wb: XLSX.WorkBook;
  try {
    // `cellDates` surfaces date cells as `Date` (preserving the contract); SheetJS
    // reads into a compact cell map. `dense: false` keeps address-keyed access.
    wb = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  } catch (e) {
    return err(crashErr(`failed to parse workbook: ${msg(e)}`));
  }

  const ws = selectSheet(wb, opts.sheet);
  if (ws === undefined) {
    return err(crashErr(`worksheet not found: ${opts.sheet ?? "(first)"}`));
  }

  // An empty sheet has no `!ref` range → zero rows (mirrors the old empty result).
  const ref = ws["!ref"];
  if (typeof ref !== "string" || ref.length === 0) return ok({ rows: [] });
  const range = XLSX.utils.decode_range(ref);

  // ── Header row (0-based = headerRow - 1) → column → key map ────────────────
  const headerRowNum = opts.headerRow ?? 1;
  const headerR = headerRowNum - 1;
  const headers = new Map<number, string>();
  const seen = new Set<string>();
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerR, c })] as XLSX.CellObject | undefined;
    const h = normalizeCell(cellValue(cell));
    const key = h === null ? "" : String(h).trim();
    if (key === "") continue; // blank header column — legitimately skipped
    // A duplicate non-empty header would silently overwrite the earlier column
    // when rows are keyed by header — fail loudly instead.
    if (seen.has(key)) {
      return err(crashErr(`duplicate header column: '${key}' (header row ${headerRowNum})`));
    }
    seen.add(key);
    headers.set(c, key);
  }

  // ── Data rows (rows after the header row) ──────────────────────────────────
  const rows: T[] = [];
  for (let r = headerR + 1; r <= range.e.r; r++) {
    // Prototype-free: row keys come from the file's header cells, so a header
    // literally named `__proto__`/`constructor` would otherwise mutate the object
    // prototype instead of setting an own property. `Object.create(null)` makes
    // every assignment an own property regardless of the key (Zod validation that
    // follows reads declared fields either way, but this keeps the row a plain
    // data bag and is consistent with the codebase's null-prototype boundaries).
    const obj: Record<string, unknown> = Object.create(null);
    let hasValue = false;
    for (const [c, key] of headers) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      const val = normalizeCell(cellValue(cell));
      if (val !== null && val !== "") hasValue = true;
      obj[key] = val;
    }
    if (!hasValue) continue; // skip fully-blank rows

    const parsed = rowSchema.safeParse(obj);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // Row number reported 1-based, matching the worksheet row (r is 0-based).
      return err(validationErr(`row ${r + 1}: ${parsed.error.message}`, issue?.path.join(".")));
    }
    rows.push(parsed.data);
  }

  return ok({ rows });
};

// ════════════════════════════════════════════════════════════════════════════
// Oracle-side workbook inspection (SheetJS stays confined to this file).
// ════════════════════════════════════════════════════════════════════════════

/** Sheet names in workbook order, as SheetJS lists them (used to sweep every sheet). */
export const oracleSheetNames = (bytes: Uint8Array): readonly string[] =>
  XLSX.read(Buffer.from(bytes), { type: "buffer", bookSheets: true }).SheetNames;

// ════════════════════════════════════════════════════════════════════════════
// Canonical outcome — everything parity compares, in plain comparable data.
// ════════════════════════════════════════════════════════════════════════════

/** One cell value with its runtime type made explicit (Dates by epoch ms, -0/NaN spelled out). */
export type CanonicalValue =
  | { readonly type: "null" }
  | { readonly type: "undefined" }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: number | "-0" | "NaN" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "date"; readonly epochMs: number | "invalid" }
  | { readonly type: "other"; readonly repr: string };

/** One row: its prototype kind and its own entries in insertion order. */
export type CanonicalRow =
  | {
      readonly type: "object";
      readonly prototype: "null" | "Object.prototype" | "other";
      readonly entries: readonly (readonly [string, CanonicalValue])[];
    }
  | { readonly type: "non-object"; readonly value: CanonicalValue };

/**
 * A `FrameworkError` with its message made comparable. Only an unreadable
 * workbook's crash detail is reader-specific (it quotes the underlying parser's
 * exception), so that tail is masked. Every other message is compared exactly,
 * including the fixed non-ZIP message, which both readers publish verbatim.
 */
export type CanonicalError = { readonly kind: FrameworkError["kind"]; readonly fields: Readonly<Record<string, unknown>> };

export type CanonicalOutcome =
  | { readonly kind: "rows"; readonly rows: readonly CanonicalRow[] }
  | { readonly kind: "error"; readonly error: CanonicalError };

/** Where the reader under test first departs from the oracle. */
export type Divergence =
  | { readonly kind: "outcome"; readonly actual: OutcomeSummary; readonly expected: OutcomeSummary }
  | { readonly kind: "error"; readonly actual: CanonicalError; readonly expected: CanonicalError }
  | { readonly kind: "row"; readonly index: number; readonly actual: CanonicalRow; readonly expected: CanonicalRow }
  | { readonly kind: "row-count"; readonly actual: number; readonly expected: number };

type OutcomeSummary =
  | { readonly kind: "rows"; readonly count: number }
  | { readonly kind: "error"; readonly error: CanonicalError };

const UNREADABLE_PREFIX = "failed to parse workbook: ";

/** The signature guard's fixed message (see `oracleParse`): a published contract, not reader-specific detail. */
export const NOT_A_ZIP_MESSAGE = `${UNREADABLE_PREFIX}not a valid .xlsx file (missing ZIP signature)`;

/** NaN and -0 are not JSON-distinguishable, so they get explicit tags. */
const canonicalNumber = (v: number): number | "NaN" | "-0" => {
  if (Number.isNaN(v)) return "NaN";
  if (Object.is(v, -0)) return "-0";
  return v;
};

const canonicalValue = (v: unknown): CanonicalValue => {
  if (v === null) return { type: "null" };
  if (v === undefined) return { type: "undefined" };
  if (v instanceof Date) {
    const ms = v.getTime();
    return { type: "date", epochMs: Number.isNaN(ms) ? "invalid" : ms };
  }
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "boolean") return { type: "boolean", value: v };
  if (typeof v === "number") return { type: "number", value: canonicalNumber(v) };
  return { type: "other", repr: `${typeof v}:${String(v)}` };
};

const prototypeOf = (o: object): "null" | "Object.prototype" | "other" => {
  const p: unknown = Object.getPrototypeOf(o);
  if (p === null) return "null";
  if (p === Object.prototype) return "Object.prototype";
  return "other";
};

const canonicalRow = (row: unknown): CanonicalRow =>
  typeof row === "object" && row !== null && !(row instanceof Date)
    ? {
        type: "object",
        prototype: prototypeOf(row),
        entries: Reflect.ownKeys(row).map((k) => [String(k), canonicalValue((row as Record<PropertyKey, unknown>)[k])] as const),
      }
    : { type: "non-object", value: canonicalValue(row) };

const canonicalError = (e: FrameworkError): CanonicalError => {
  const fields: Record<string, unknown> = { ...e };
  const message = fields.message;
  const readerSpecific =
    e.kind === "node-crash" &&
    typeof message === "string" &&
    message.startsWith(UNREADABLE_PREFIX) &&
    message !== NOT_A_ZIP_MESSAGE;
  if (readerSpecific) {
    fields.message = `${UNREADABLE_PREFIX}<reader-specific detail>`;
  }
  return { kind: e.kind, fields };
};

const canonicalOutcome = <T>(r: Result<{ rows: readonly T[] }, FrameworkError>): CanonicalOutcome =>
  r.ok ? { kind: "rows", rows: r.value.rows.map(canonicalRow) } : { kind: "error", error: canonicalError(r.error) };

const summary = (o: CanonicalOutcome): OutcomeSummary =>
  o.kind === "rows" ? { kind: "rows", count: o.rows.length } : { kind: "error", error: o.error };

const same = (a: unknown, b: unknown): boolean => Bun.deepEquals(a, b, true);

/** `null` when `actual` equals `expected` exactly; otherwise the first point where they differ. */
const firstDivergence = (actual: CanonicalOutcome, expected: CanonicalOutcome): Divergence | null => {
  if (actual.kind === "error" && expected.kind === "error") {
    return same(actual.error, expected.error) ? null : { kind: "error", actual: actual.error, expected: expected.error };
  }
  if (actual.kind !== "rows" || expected.kind !== "rows") {
    return { kind: "outcome", actual: summary(actual), expected: summary(expected) };
  }
  const shared = Math.min(actual.rows.length, expected.rows.length);
  for (let i = 0; i < shared; i++) {
    const a = actual.rows[i]!;
    const e = expected.rows[i]!;
    if (!same(a, e)) return { kind: "row", index: i, actual: a, expected: e };
  }
  return actual.rows.length === expected.rows.length
    ? null
    : { kind: "row-count", actual: actual.rows.length, expected: expected.rows.length };
};

/** Parse the same bytes with the reader under test and with the oracle; report the oracle outcome and any divergence. */
export const differential = async <T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  opts: ParseWorkbookOpts = {},
): Promise<{ readonly expected: CanonicalOutcome; readonly divergence: Divergence | null }> => {
  const expected = canonicalOutcome(await oracleParse(bytes, schema, opts));
  const actual = canonicalOutcome(await parseWorkbook(bytes, schema, opts));
  return { expected, divergence: firstDivergence(actual, expected) };
};

// ════════════════════════════════════════════════════════════════════════════
// Pinned time zones — each parity suite re-runs itself in a child process
// whose TZ is fixed before any module (SheetJS caches its date base) loads.
// ════════════════════════════════════════════════════════════════════════════

export type ParityTimeZone = { readonly tz: "UTC" | "Europe/Copenhagen"; readonly julyOffsetMinutes: number };

export const PARITY_TIME_ZONES: readonly ParityTimeZone[] = [
  { tz: "UTC", julyOffsetMinutes: 0 },
  { tz: "Europe/Copenhagen", julyOffsetMinutes: -120 },
];

/** Set on a child run to the zone it was pinned to; absent in the parent run. */
const PARITY_CHILD_ENV = "FUGUE_PARITY_CHILD_TZ";

export type SuiteRole = { readonly kind: "parent" } | { readonly kind: "child"; readonly zone: ParityTimeZone };

/** Parse the run's role from its environment. An unknown pinned zone is a harness bug, so it throws. */
export const timeZoneOfChild = (env: Readonly<Record<string, string | undefined>>): SuiteRole => {
  const pinned = env[PARITY_CHILD_ENV];
  if (pinned === undefined) return { kind: "parent" };
  const zone = PARITY_TIME_ZONES.find((z) => z.tz === pinned);
  if (zone === undefined) throw new Error(`${PARITY_CHILD_ENV}=${pinned} is not one of the parity time zones`);
  return { kind: "child", zone };
};

export type SuiteRun =
  | { readonly kind: "passed"; readonly passed: number; readonly output: string }
  | { readonly kind: "failed"; readonly reason: string; readonly output: string };

const PACKAGE_ROOT = resolve(dirname(import.meta.path), "../../..");

/**
 * The child's environment: `TZ` pinned, and `FUGUE_REAL_DATA_DIR` made absolute.
 * The child runs from the package root, so a relative directory must be
 * resolved against the parent's `cwd` before it is handed over.
 */
export const childEnv = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  zone: ParityTimeZone,
): Readonly<Record<string, string | undefined>> => {
  const dir = realDataDir(env, cwd);
  return { ...env, TZ: zone.tz, [PARITY_CHILD_ENV]: zone.tz, ...(dir.kind === "set" ? { [REAL_DATA_DIR_ENV]: dir.dir } : {}) };
};

/**
 * The child run's verdict. The exit code decides first; a zero exit then needs
 * a readable JUnit report with no failures and at least one passed test.
 */
export const suiteVerdict = (exitCode: number, report: Result<JUnitTotals, string>, output: string): SuiteRun => {
  const failed = (reason: string): SuiteRun => ({ kind: "failed", reason, output });
  if (exitCode !== 0) return failed(`exit code ${exitCode}`);
  if (!report.ok) return failed(`unreadable JUnit report: ${report.error}`);
  if (report.value.failures > 0) return failed(`${report.value.failures} failed despite exit code 0`);
  if (report.value.passed === 0) return failed("no test passed");
  return { kind: "passed", passed: report.value.passed, output };
};

const readReport = async (file: string): Promise<Result<JUnitTotals, string>> => {
  try {
    return parseJUnitTotals(await Bun.file(file).text());
  } catch (e) {
    return err(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** Run one test file in a fresh `bun test` process with TZ pinned to `zone`; it writes a JUnit report. */
export const runSuiteUnderTimeZone = async (testFile: string, zone: ParityTimeZone): Promise<SuiteRun> => {
  const dir = await mkdtemp(join(tmpdir(), "fugue-parity-junit-"));
  try {
    const reportFile = join(dir, "report.xml");
    const child = Bun.spawn([process.execPath, "test", testFile, "--reporter=junit", `--reporter-outfile=${reportFile}`], {
      cwd: PACKAGE_ROOT,
      env: childEnv(process.env, process.cwd(), zone),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return suiteVerdict(exitCode, await readReport(reportFile), `${stdout}${stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
