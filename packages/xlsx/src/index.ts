/**
 * @fuguejs/xlsx — pure workbook parsing for Fugue DAGs.
 *
 * `parseWorkbook` turns `.xlsx` bytes into Zod-validated typed rows. It is a
 * deterministic, side-effect-free transform: no filesystem or network I/O, and
 * the same bytes always yield the same result. The byte fetching is a `documents`
 * capability concern (`@fuguejs/ms-graph`, `@fuguejs/fs`); parsing stays here so it
 * is fixture-testable and provider-agnostic. See ADR-0052.
 *
 * ## Why SheetJS (not ExcelJS) for reading
 *
 * Reading uses **SheetJS (`xlsx`)**, which parses into a compact address-keyed
 * cell map, NOT ExcelJS's per-cell object model. This is load-bearing for the
 * multi-tenant host's memory budget: ExcelJS full-load explodes on real exports
 * (a 25k-row sheet ≈ 300 MB; a styled/date-grouped export > 1 GB), enough to OOM
 * a worker, and its streaming reader is non-deterministically broken under Bun
 * (sequential reads corrupt shared global state). SheetJS reads the same files in
 * a fraction of the memory (≈150–230 MB for the largest), is deterministic and
 * concurrency-safe under Bun, and parses date-grouped table autofilters natively
 * (it never touches `xl/tables`, so the ExcelJS `dateGroupItem` crash is moot).
 * ExcelJS remains only a TEST/fixture dependency.
 *
 * ## Usage
 *
 * ```ts
 * import { z } from "zod";
 * import { parseWorkbook } from "@fuguejs/xlsx";
 *
 * const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });
 *
 * // inside a createFetchNode `fetch`, after ctx.documents.getContent(ref):
 * const parsed = await parseWorkbook(bytes, RowSchema);   // Result<{ rows }, FrameworkError>
 * ```
 *
 * Rows are objects keyed by the header-row cells. Cells are normalised to
 * primitives (formula → cached result, rich text / hyperlink → text, dates kept
 * as `Date`); pair numeric or date columns with `z.coerce.*` if your source
 * stores them as text.
 */

import * as XLSX from "xlsx";
import type { z } from "zod";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";

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
export interface ParseWorkbookOpts {
  /** Worksheet to read: name (string) or 1-based index (number). Default: first sheet. */
  readonly sheet?: string | number;
  /** 1-based row holding the column headers. Default: 1. */
  readonly headerRow?: number;
}

/**
 * Normalise a cell value to a primitive (or `null`). SheetJS already hands back
 * primitives / `Date` (with `cellDates`), so this mostly passes through — but it
 * ALSO handles the ExcelJS-shaped objects (formula `{ formula, result }`, rich
 * text `{ richText }`, hyperlink `{ text, hyperlink }`, error `{ error }`) so the
 * function stays a self-contained, independently-tested normaliser regardless of
 * the producer. Error cells and unknown objects → `null`.
 */
export const normalizeCell = (value: unknown): string | number | boolean | Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((p) => p.text ?? "").join("");
    }
    if (typeof v.text === "string") return v.text; // hyperlink cell
    if ("result" in v) return normalizeCell(v.result); // formula → its computed result
    if ("error" in v) return null; // error cell (#REF!, #DIV/0!, …)
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
};

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
export const parseWorkbook = async <T>(
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
