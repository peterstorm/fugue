/**
 * Pure row core: header map, row projection, validation, and the per-row fold
 * step that turns assembled worksheet rows into validated, folded rows.
 *
 * Behaviour is the pre-streaming `parseWorkbook` contract, unchanged:
 * - The header row (1-based `headerRow`, default 1) maps columns to keys; a
 *   blank header column is skipped, a duplicate non-empty header is a
 *   non-retriable node-crash.
 * - Data rows are the rows after the header row, up to the sheet's last row.
 * - Row objects are prototype-free; a row whose every header cell is empty
 *   (`null` or `""`, which includes error cells) is skipped.
 * - A row failing the schema is a `validation` error `row <n>: <zod message>`.
 */

import type { z } from "zod";
import type { FrameworkError, Result } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";
import type { RowCells, SheetBounds } from "./sheet-stream.js";

/** Sentinel node ID for parse errors (parsing is a lib, not a DAG node). */
export const XLSX_NODE_ID = nodeId("xlsx-parse");

export const xlsxCrash = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: XLSX_NODE_ID,
  message,
  retriability: "non-retriable",
});

const xlsxValidation = (message: string, path: string | undefined): FrameworkError => ({
  kind: "validation",
  nodeId: XLSX_NODE_ID,
  message,
  ...(path !== undefined ? { path } : {}),
});

const ROW_PREFIX = /^row (\d+): /;

/**
 * The worksheet row a validation error from this module names (`row <n>: …`),
 * or `null` for any error this module did not mint as a row validation failure.
 */
export const xlsxErrorRow = (e: FrameworkError): number | null => {
  if (e.kind !== "validation" || e.nodeId !== XLSX_NODE_ID) return null;
  const m = ROW_PREFIX.exec(e.message);
  return m === null ? null : Number(m[1]);
};

/** Column → header key, in ascending column order. */
export type HeaderMap = ReadonlyMap<number, string>;

const ascending = (cells: RowCells): number[] => [...cells.keys()].sort((a, b) => a - b);

/** Header-row cells → column keys. Blank headers are skipped; a duplicate is a node-crash. */
export const buildHeaderMap = (cells: RowCells, headerRow: number): Result<HeaderMap, FrameworkError> => {
  const headers = new Map<number, string>();
  const seen = new Set<string>();
  for (const col of ascending(cells)) {
    const h = cells.get(col) ?? null;
    const key = h === null ? "" : String(h).trim();
    if (key === "") continue;
    if (seen.has(key)) return err(xlsxCrash(`duplicate header column: '${key}' (header row ${headerRow})`));
    seen.add(key);
    headers.set(col, key);
  }
  return ok(headers);
};

/**
 * A data row keyed by header, prototype-free (a header named `__proto__` is an
 * own property, never a prototype write), or `null` when every cell is empty.
 */
export const projectRow = (cells: RowCells, headers: HeaderMap): Record<string, unknown> | null => {
  const row: Record<string, unknown> = Object.create(null);
  let hasValue = false;
  for (const [col, key] of headers) {
    const value = cells.get(col) ?? null;
    if (value !== null && value !== "") hasValue = true;
    row[key] = value;
  }
  return hasValue ? row : null;
};

const withinColumns = (cells: RowCells, bounds: SheetBounds | null): RowCells =>
  bounds === null ? cells : new Map([...cells].filter(([col]) => col >= bounds.firstCol && col <= bounds.lastCol));

/** Where a fold over one sheet stands. */
export interface RowFold<A> {
  /** 1-based header row. */
  readonly headerRow: number;
  /**
   * From a valid `<dimension>`. `null` when there is none: the sheet reader then
   * only emits rows inside SheetJS's observed range, so every row is in range.
   */
  readonly bounds: SheetBounds | null;
  /** 0-based index of the last row seen, -1 before the first. */
  readonly lastRowIndex: number;
  /** `null` until the header row has been passed. */
  readonly headers: HeaderMap | null;
  readonly acc: A;
}

/** After a row: keep folding, or stop because no later row can be in range. */
export type RowFoldStep<A> =
  | { readonly kind: "continue"; readonly fold: RowFold<A> }
  | { readonly kind: "done"; readonly fold: RowFold<A> };

export const startFold = <A>(headerRow: number, init: A): RowFold<A> => ({
  headerRow,
  bounds: null,
  lastRowIndex: -1,
  headers: null,
  acc: init,
});

const NO_HEADERS: HeaderMap = new Map();

/**
 * Fold one assembled row.
 *
 * Constraint: `rowIndex` MUST be strictly greater than `fold.lastRowIndex`, so
 * rows arrive in strictly ascending worksheet order. A streaming fold cannot go
 * back to a row it has already validated and stepped, so a repeated or earlier
 * row is a non-retriable node-crash, never a silently different result. The
 * sheet reader already emits rows in ascending order (and fails on a cell that
 * addresses a row it has emitted), so this guard holds the precondition for any
 * other caller rather than for real exports.
 */
export const foldRow = <T, A>(
  fold: RowFold<A>,
  rowIndex: number,
  cells: RowCells,
  rowSchema: z.ZodType<T>,
  step: (acc: A, row: T, rowNumber: number) => A,
): Result<RowFoldStep<A>, FrameworkError> => {
  if (rowIndex <= fold.lastRowIndex) {
    return err(xlsxCrash(`worksheet rows out of order: row ${rowIndex + 1} follows row ${fold.lastRowIndex + 1} (unsupported)`));
  }
  const seen: RowFold<A> = { ...fold, lastRowIndex: rowIndex };
  const headerIndex = fold.headerRow - 1;
  if (rowIndex < headerIndex) return ok({ kind: "continue", fold: seen });
  if (rowIndex === headerIndex) {
    const headers = buildHeaderMap(withinColumns(cells, fold.bounds), fold.headerRow);
    return headers.ok ? ok({ kind: "continue", fold: { ...seen, headers: headers.value } }) : headers;
  }
  if (fold.bounds !== null && rowIndex > fold.bounds.lastRow) return ok({ kind: "done", fold: seen });

  const row = projectRow(cells, fold.headers ?? NO_HEADERS);
  if (row === null) return ok({ kind: "continue", fold: seen });
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(xlsxValidation(`row ${rowIndex + 1}: ${parsed.error.message}`, issue?.path.join(".")));
  }
  return ok({ kind: "continue", fold: { ...seen, acc: step(fold.acc, parsed.data, rowIndex + 1) } });
};
