/**
 * @fugue/xlsx — pure workbook parsing for Fugue DAGs.
 *
 * `parseWorkbook` turns `.xlsx` bytes into Zod-validated typed rows. It is a
 * pure function (deterministic, no I/O) — the byte fetching is a `documents`
 * capability concern (`@fugue/ms-graph`, `@fugue/fs`), and parsing stays here
 * so it is fixture-testable and provider-agnostic. See ADR-0052.
 *
 * ## Usage
 *
 * ```ts
 * import { z } from "zod";
 * import { parseWorkbook } from "@fugue/xlsx";
 *
 * const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });
 *
 * // inside a createFetchNode `fetch`, after ctx.documents.getContent(ref):
 * const parsed = await parseWorkbook(bytes, RowSchema);   // Result<{ rows }, FrameworkError>
 * ```
 *
 * Rows are objects keyed by the header-row cells. Cells are normalised to
 * primitives (formula → result, rich text / hyperlink → text, dates kept as
 * `Date`); pair numeric or date columns with `z.coerce.*` if your source stores
 * them as text.
 */

import ExcelJS from "exceljs";
import type { z } from "zod";
import type { Result, FrameworkError } from "@fugue/framework";
import { ok, err, nodeId } from "@fugue/framework";

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
 * Normalise an ExcelJS cell value to a primitive (or `null`). Handles formulas
 * (`{ formula, result }`), rich text (`{ richText }`), hyperlinks
 * (`{ text, hyperlink }`), and error cells; passes through string/number/
 * boolean/Date unchanged.
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
 * Parse `.xlsx` bytes into rows validated against `rowSchema`.
 *
 * Returns:
 * - `node-crash` (non-retriable) when the bytes aren't a readable workbook or
 *   the requested worksheet is absent — deterministic, so not retried.
 * - `validation` when a row does not match `rowSchema` (message names the row).
 * - `ok({ rows })` otherwise. Fully-blank rows are skipped.
 */
export const parseWorkbook = async <T>(
  bytes: Uint8Array,
  rowSchema: z.ZodType<T>,
  opts: ParseWorkbookOpts = {},
): Promise<Result<{ rows: T[] }, FrameworkError>> => {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs types `load` as the global Buffer; recent @types/node makes
    // Buffer.from return Buffer<ArrayBuffer> — cast to exceljs's exact param.
    await wb.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch (e) {
    return err(crashErr(`failed to parse workbook: ${msg(e)}`));
  }

  const ws =
    typeof opts.sheet === "string"
      ? wb.getWorksheet(opts.sheet)
      : wb.worksheets[(typeof opts.sheet === "number" ? opts.sheet : 1) - 1];
  if (!ws) {
    const which = opts.sheet ?? "(first)";
    return err(crashErr(`worksheet not found: ${which}`));
  }

  const headerRowNum = opts.headerRow ?? 1;
  const colCount = ws.columnCount;
  const headerRow = ws.getRow(headerRowNum);
  const headers: string[] = [];
  const seenHeaders = new Set<string>();
  for (let c = 1; c <= colCount; c++) {
    const h = normalizeCell(headerRow.getCell(c).value);
    const key = h === null ? "" : String(h).trim();
    // A duplicate non-empty header would silently overwrite the earlier
    // column when rows are keyed by header (`obj[key] = val`), dropping a whole
    // column of data. Fail loudly instead. Blank headers are legitimately
    // skipped (multiple empty columns are fine), so they're exempt.
    if (key !== "" && seenHeaders.has(key)) {
      return err(crashErr(`duplicate header column: '${key}' (header row ${headerRowNum})`));
    }
    if (key !== "") seenHeaders.add(key);
    headers[c] = key;
  }

  const rows: T[] = [];
  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    for (let c = 1; c <= colCount; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = normalizeCell(row.getCell(c).value);
      if (val !== null && val !== "") hasValue = true;
      obj[key] = val;
    }
    if (!hasValue) continue; // skip fully-blank rows

    const parsed = rowSchema.safeParse(obj);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(validationErr(`row ${r}: ${parsed.error.message}`, issue?.path.join(".")));
    }
    rows.push(parsed.data);
  }

  return ok({ rows });
};
