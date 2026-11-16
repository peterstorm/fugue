/**
 * @fuguejs/xlsx — streaming workbook parsing for Fugue DAGs.
 *
 * `parseWorkbook` turns `.xlsx` bytes into Zod-validated typed rows. It is a
 * side-effect-free transform with no filesystem or network I/O. It is
 * deterministic within one process: the same bytes always yield the same result,
 * including under concurrent parses. Date cells are the exception across
 * processes. Like SheetJS, `serialToDate` builds them in the process's local time
 * zone, so the same bytes read under a different `TZ` give `Date`s at different
 * instants. The byte fetching is a `documents`
 * capability concern (`@fuguejs/ms-graph`, `@fuguejs/fs`); parsing stays here so it
 * is fixture-testable and provider-agnostic. See ADR-0052.
 *
 * ## Streaming, with SheetJS semantics
 *
 * The reader never materialises a sheet. The bytes are already in memory, so
 * the ZIP central directory gives random access: the workbook, its rels, the
 * styles and the shared strings are inflated first (once per `openWorkbook`),
 * then the selected sheet is inflated in compressed slices and fed through
 * saxes into a row assembler. Each completed row is projected through the
 * header map, validated, and handed to a fold step. Peak memory is the shared
 * strings plus one row, instead of a full cell map. For example, the SheetJS
 * full load peaked at ~570 MB on one measured 25k-row export.
 *
 * Cell semantics are those of SheetJS 0.18.5 (`XLSX.read(buf, { type: "buffer",
 * cellDates: true })`), the previous implementation, and are held to it by a
 * differential test suite: formula → cached result, rich text / hyperlink →
 * text, dates (by number format) → `Date`, error cells → `null`. SheetJS itself
 * is only a development dependency, used as that oracle.
 *
 * ## Usage
 *
 * ```ts
 * import { z } from "zod";
 * import { openWorkbook, foldRows, parseWorkbook } from "@fuguejs/xlsx";
 *
 * const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });
 *
 * // inside a createFetchNode `fetch`, after ctx.documents.getContent(ref):
 * const parsed = await parseWorkbook(bytes, RowSchema);   // Result<{ rows }, FrameworkError>
 *
 * // Large sheets: fold rows without collecting them; one load serves many sheets.
 * const wb = openWorkbook(bytes);
 * if (wb.ok) {
 *   const total = await foldRows(wb.value, RowSchema, { sheet: "Data" }, 0, (sum, row) => sum + row.revenue);
 * }
 * ```
 *
 * Rows are objects keyed by the header-row cells. Pair numeric or date columns
 * with `z.coerce.*` if your source stores them as text.
 */

import type { z } from "zod";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import {
  DEFAULT_MAX_ENTRY_BYTES,
  findEntry,
  inflateEntry,
  inflateSlices,
  readZip,
  type ZipArchive,
  type ZipEntry,
} from "./zip.js";
import { createXmlFeed, decodeUtf8, type XmlFeed } from "./xml.js";
import {
  parseContentTypes,
  parseRelationships,
  parseWorkbookXml,
  resolveSheetParts,
  selectSheet,
  workbookRelsPath,
  type SheetPart,
} from "./workbook-parts.js";
import { parseSharedStrings, type SharedStrings } from "./shared-strings.js";
import { isDateStyle, parseStyles, UNFORMATTED, type DateStyles } from "./styles.js";
import { createSheetReader } from "./sheet-stream.js";
import { foldRow, startFold, xlsxCrash, type RowFold } from "./rows.js";

export { xlsxErrorRow } from "./rows.js";
export { normalizeCell } from "./normalize-cell.js";

/** Options for `parseWorkbook`. */
export interface ParseWorkbookOpts {
  /** Worksheet to read: name (string) or 1-based index (number). Default: first sheet. */
  readonly sheet?: string | number;
  /** 1-based row holding the column headers. Default: 1. */
  readonly headerRow?: number;
}

/** Options for `foldRows`. */
export interface FoldOpts extends ParseWorkbookOpts {
  /**
   * Yield to the event loop after every this many bytes of COMPRESSED sheet
   * input, so a long fold does not stall other work. Default 16 KiB.
   */
  readonly yieldEveryBytes?: number;
}

declare const WorkbookBrand: unique symbol;

/**
 * A loaded workbook: opaque and immutable. Its parts (workbook, rels, styles,
 * shared strings) were read once by `openWorkbook`; every `foldRows` over it,
 * on any sheet, reuses them.
 */
export interface WorkbookHandle {
  readonly [WorkbookBrand]: true;
  /** Sheet names in workbook order. */
  readonly sheetNames: readonly string[];
}

/** What a handle stands for; reachable only through this module. */
interface LoadedWorkbook {
  readonly archive: ZipArchive;
  readonly sheets: readonly SheetPart[];
  readonly sst: SharedStrings;
  readonly styles: DateStyles;
}

/** Handle → its loaded workbook. Written once per `openWorkbook`, never mutated after. */
const loaded = new WeakMap<WorkbookHandle, LoadedWorkbook>();

/**
 * Default yield cadence: 16 KiB of compressed sheet input.
 *
 * Kept small because each yield is also the garbage collector's chance to run.
 * On one real 25k-row export, measured once, yielding every 16 KiB peaked about
 * 13 MB lower than yielding every 64 KiB, at the cost of about 100 extra
 * macrotask hops (well under a millisecond). That is a single measurement, not
 * a guarantee for other workbooks. Callers that prefer fewer hops can pass
 * `yieldEveryBytes`.
 */
const DEFAULT_YIELD_EVERY_BYTES = 16 * 1024;

/**
 * Compressed bytes inflated and parsed per step (at most `yieldEveryBytes`).
 * Small slices keep each step's inflated text, and the parser garbage it
 * produces, small. On the same single export, 16 KiB slices peaked about 20 MB
 * lower than 64 KiB ones (measured once, not a guarantee).
 */
const SLICE_BYTES = 16 * 1024;

// ── loading ──────────────────────────────────────────────────────────────────

const failedToParse = (message: string): FrameworkError => xlsxCrash(`failed to parse workbook: ${message}`);

/** Inflate and decode one XML part, or `null` when it is absent. */
const readPart = (archive: ZipArchive, path: string): Result<string | null, FrameworkError> => {
  const entry = findEntry(archive, path);
  if (entry === undefined) return ok(null);
  const bytes = inflateEntry(archive, entry, DEFAULT_MAX_ENTRY_BYTES);
  return bytes.ok ? ok(decodeUtf8(bytes.value)) : err(failedToParse(bytes.error.message));
};

/** Read and parse an optional part; `fallback` when the part is absent. */
const loadPart = <T>(
  archive: ZipArchive,
  path: string | null,
  parse: (xml: string) => Result<T, string>,
  fallback: T,
): Result<T, FrameworkError> => {
  if (path === null) return ok(fallback);
  const xml = readPart(archive, path);
  if (!xml.ok) return xml;
  if (xml.value === null) return ok(fallback);
  const parsed = parse(xml.value);
  return parsed.ok ? parsed : err(failedToParse(`${path}: ${parsed.error}`));
};

const hasZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const loadWorkbook = (bytes: Uint8Array): Result<LoadedWorkbook, FrameworkError> => {
  // An .xlsx is a ZIP, so it MUST start with the PK local-file-header magic.
  if (!hasZipSignature(bytes)) {
    return err(failedToParse("not a valid .xlsx file (missing ZIP signature)"));
  }
  const zip = readZip(bytes);
  if (!zip.ok) return err(failedToParse(zip.error.message));
  const archive = zip.value;

  const contentTypes = readPart(archive, "[Content_Types].xml");
  if (!contentTypes.ok) return contentTypes;
  if (contentTypes.value === null) return err(failedToParse("Unsupported ZIP file"));
  const locations = parseContentTypes(contentTypes.value);
  if (!locations.ok) return err(failedToParse(`[Content_Types].xml: ${locations.error}`));

  const workbookPath =
    locations.value.workbook ?? (findEntry(archive, "xl/workbook.xml") !== undefined ? "xl/workbook.xml" : null);
  if (workbookPath === null) return err(failedToParse("Could not find workbook"));
  if (workbookPath.toLowerCase().endsWith(".bin")) {
    return err(failedToParse("binary (.xlsb) workbooks are not supported"));
  }

  const sst = loadPart(archive, locations.value.sharedStrings, parseSharedStrings, Object.freeze([]));
  if (!sst.ok) return sst;
  const styles = loadPart(archive, locations.value.styles, parseStyles, UNFORMATTED);
  if (!styles.ok) return styles;

  const workbookXml = readPart(archive, workbookPath);
  if (!workbookXml.ok) return workbookXml;
  if (workbookXml.value === null) return err(failedToParse("Could not find workbook"));
  const sheets = parseWorkbookXml(workbookXml.value);
  if (!sheets.ok) return err(failedToParse(`${workbookPath}: ${sheets.error}`));

  const preferredRels = workbookRelsPath(workbookPath);
  const relsPath = findEntry(archive, preferredRels) !== undefined ? preferredRels : "xl/_rels/workbook.xml.rels";
  const rels = loadPart(archive, relsPath, (xml) => parseRelationships(xml), null);
  if (!rels.ok) return rels;

  return ok(
    Object.freeze({
      archive,
      sheets: resolveSheetParts({
        sheets: sheets.value,
        rels: rels.value,
        relsPath,
        exists: (path) => findEntry(archive, path) !== undefined,
      }),
      sst: sst.value,
      styles: styles.value,
    }),
  );
};

/**
 * Load a workbook once: read the ZIP directory and the workbook-level parts.
 * Bytes that are not a readable `.xlsx` → non-retriable `node-crash`.
 */
export const openWorkbook = (bytes: Uint8Array): Result<WorkbookHandle, FrameworkError> => {
  const workbook = loadWorkbook(bytes);
  if (!workbook.ok) return workbook;
  // The brand is a compile-time fiction; this cast is the handle's only constructor.
  const handle = Object.freeze({
    sheetNames: Object.freeze(workbook.value.sheets.map((s) => s.name)),
  }) as unknown as WorkbookHandle;
  loaded.set(handle, workbook.value);
  return ok(handle);
};

// ── folding ──────────────────────────────────────────────────────────────────

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const worksheetNotFound = (sheet: string | number | undefined): FrameworkError =>
  xlsxCrash(`worksheet not found: ${sheet ?? "(first)"}`);

/**
 * Feed the sheet's compressed slices through `feed`, yielding to the event loop
 * every `yieldEveryBytes`, until the input ends or `stop` says the fold has its
 * answer. Returns the feed's last result: an inflate or XML failure, or the
 * close of a fully read sheet.
 */
const feedSheet = async (
  archive: ZipArchive,
  entry: ZipEntry,
  feed: XmlFeed,
  yieldEveryBytes: number,
  stop: () => boolean,
): Promise<Result<void, string>> => {
  const decoder = new TextDecoder();
  const sliceBytes = Math.min(SLICE_BYTES, yieldEveryBytes);
  let sinceYield = 0;
  for (const slice of inflateSlices(archive, entry, { sliceBytes, maxBytes: DEFAULT_MAX_ENTRY_BYTES })) {
    if (!slice.ok) return err(slice.error.message);
    const written = feed.write(decoder.decode(slice.value, { stream: true }));
    if (!written.ok || stop()) return written;
    sinceYield += sliceBytes;
    if (sinceYield >= yieldEveryBytes) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  const tail = feed.write(decoder.decode());
  return tail.ok ? feed.close() : tail;
};

/**
 * Stream one sheet's rows through `step`, in worksheet order, without
 * materialising the sheet. `rowNumber` is the 1-based worksheet row.
 *
 * Rows reach `step` in strictly ascending worksheet order. A sheet that cannot
 * be streamed in that order is a node-crash (see below).
 *
 * With a valid `<dimension>`, the fold ends at the first row past the
 * dimension's last row and stops reading the sheet: XML in the compressed
 * slices after that row is never parsed, so malformed or truncated XML there
 * goes unreported. Malformed XML in any slice that WAS parsed, including the
 * one that ended the fold, is always a node-crash.
 *
 * Returns:
 * - `node-crash` (non-retriable, deterministic, so never retried) when:
 *   - the handle is not from `openWorkbook`;
 *   - `yieldEveryBytes` is not a positive safe integer;
 *   - the sheet is absent, by name or by 1-based index;
 *   - the sheet part is corrupt or would inflate past the per-entry cap
 *     (512 MiB, the zip-bomb guard);
 *   - the sheet XML is malformed or truncated (within the parsed range above);
 *   - a cell addresses a row that has already been emitted (rows out of
 *     ascending order);
 *   - a cell references a shared string index that is not in the table;
 *   - the header row holds a duplicate non-blank header.
 * - `validation` when a row does not match `rowSchema` (`row <n>: …`; recover
 *   `n` with `xlsxErrorRow`). The fold stops at the first failing row.
 * - `ok(acc)` otherwise.
 *
 * The accumulator belongs to this one call: `step` may push into it rather than
 * copy it, and the caller freezes what it keeps.
 */
export const foldRows = async <T, A>(
  workbook: WorkbookHandle,
  rowSchema: z.ZodType<T>,
  opts: FoldOpts,
  init: A,
  step: (acc: A, row: T, rowNumber: number) => A,
): Promise<Result<A, FrameworkError>> => {
  const wb = loaded.get(workbook);
  if (wb === undefined) return err(xlsxCrash("not a workbook handle: use openWorkbook to obtain one"));
  const yieldEveryBytes = opts.yieldEveryBytes ?? DEFAULT_YIELD_EVERY_BYTES;
  if (!Number.isSafeInteger(yieldEveryBytes) || yieldEveryBytes <= 0) {
    return err(xlsxCrash(`yieldEveryBytes must be a positive integer, got ${yieldEveryBytes}`));
  }

  const part = selectSheet(wb.sheets, opts.sheet);
  if (part === undefined || part.kind === "unreadable") return err(worksheetNotFound(opts.sheet));
  const entry = findEntry(wb.archive, part.path);
  if (entry === undefined) return err(worksheetNotFound(opts.sheet));
  if (part.kind === "cellless") return ok(init);

  // Imperative shell: the SAX callbacks advance a pure fold (`foldRow`); this
  // closure owns the only mutable state and stops at the first failure.
  const malformed = (message: string): FrameworkError => xlsxCrash(`failed to parse worksheet '${part.name}': ${message}`);
  let fold: RowFold<A> = startFold(opts.headerRow ?? 1, init);
  let failure: FrameworkError | null = null;
  let done = false;
  const reader = createSheetReader(
    { sst: wb.sst, isDateStyle: (s) => isDateStyle(wb.styles, s) },
    {
      dimension: (bounds) => {
        fold = { ...fold, bounds };
      },
      row: (rowIndex, cells) => {
        if (failure !== null || done) return;
        const next = foldRow(fold, rowIndex, cells, rowSchema, step);
        if (!next.ok) failure = next.error;
        else {
          fold = next.value.fold;
          done = next.value.kind === "done";
        }
      },
      fail: (message) => {
        failure ??= malformed(message);
      },
    },
  );
  const fed = await feedSheet(wb.archive, entry, createXmlFeed(reader), yieldEveryBytes, () => failure !== null || done);
  // A row or sheet failure precedes the XML error that stopped the parse; an
  // XML error in a parsed slice outranks `done`.
  if (failure !== null) return err(failure);
  return fed.ok ? ok(fold.acc) : err(malformed(fed.error));
};

/**
 * Parse `.xlsx` bytes into rows validated against `rowSchema`: `openWorkbook`
 * followed by a collecting `foldRows`.
 *
 * Returns:
 * - `node-crash` (non-retriable, deterministic, so never retried) when:
 *   - the bytes are not a readable `.xlsx` (no ZIP signature, a corrupt
 *     archive, missing or malformed workbook parts, an `.xlsb` workbook);
 *   - any workbook part or the sheet would inflate past the per-entry cap
 *     (512 MiB, the zip-bomb guard);
 *   - the requested worksheet is absent, by name or by 1-based index;
 *   - the sheet XML is malformed or truncated;
 *   - a cell addresses a row that has already been emitted (rows out of
 *     ascending order);
 *   - a cell references a shared string index that is not in the table;
 *   - the header row holds a duplicate non-blank header.
 *   `yieldEveryBytes` is not a `parseWorkbook` option, so the default always
 *   applies and cannot be invalid here.
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
  const workbook = openWorkbook(bytes);
  if (!workbook.ok) return workbook;
  const rows = await foldRows(workbook.value, rowSchema, opts, [] as T[], (acc, row) => {
    acc.push(row);
    return acc;
  });
  return rows.ok ? ok({ rows: rows.value }) : rows;
};
