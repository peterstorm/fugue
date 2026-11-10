/**
 * Worksheet row assembler: saxes events over a worksheet part → one
 * `(rowIndex, cells)` call per worksheet row holding cells, in ascending row
 * order, plus the `<dimension>` bounds.
 *
 * Addressing follows SheetJS 0.18.5 `parse_ws_xml_data`, whose cell map this
 * reproduces without ever holding it:
 * - A `<row>` element's number is its `r` attribute, else the previous row
 *   element's plus one; a self-closing `<row/>` is skipped and does not advance
 *   the count (except as the very last row, see `trailingRow`).
 * - A cell's column is the letters of its `r` attribute, else the previous
 *   cell's column plus one.
 * - A cell is stored under its own `r` address, which may name a different row
 *   than the enclosing `<row>` element. Cells are therefore buffered per
 *   TARGET row, and a row is emitted once a later `<row>` element starts. A cell
 *   that targets a row already emitted cannot be streamed and is a failure.
 * - A non-canonical `r` (`a1`, `$A$1`) is stored under a key SheetJS never
 *   looks up, so the cell is dropped.
 * - The first `<v>` holds the value (formulas are never evaluated: a formula
 *   cell's cached `<v>` is its value); the first `<is>` holds an inline string.
 * - Without a valid `<dimension>`, the sheet's last row is the last `<row>`
 *   ELEMENT's number (SheetJS's observed range), so cells addressed beyond it
 *   are dropped.
 */

import { decodeCell, type CellValue, type DecodeContext } from "./cell-value.js";
import { createRichTextReader, type RichTextReader, type SharedString } from "./shared-strings.js";
import type { XmlAttrs, XmlHandler } from "./xml.js";

/** 0-based column → stored value, for the cells SheetJS would store. */
export type RowCells = ReadonlyMap<number, CellValue>;

/** The sheet's declared range (0-based), from a valid `<dimension ref>`. */
export interface SheetBounds {
  readonly firstCol: number;
  readonly lastCol: number;
  readonly lastRow: number;
}

export interface SheetSink {
  /** At most once, before any row, when the sheet declares a valid dimension. */
  readonly dimension: (bounds: SheetBounds) => void;
  /** Once per worksheet row holding stored cells, in strictly ascending row order. */
  readonly row: (rowIndex: number, cells: RowCells) => void;
  /** The sheet cannot be read; no further events follow. */
  readonly fail: (message: string) => void;
}

// ── A1 addressing (SheetJS ports) ────────────────────────────────────────────

/** SheetJS `safe_decode_range`: lenient, stops at the first unexpected character. */
const safeDecodeRange = (range: string): { sc: number; sr: number; ec: number; er: number } => {
  let i = 0;
  let cc = 0;
  const letters = (): number => {
    let idx = 0;
    for (; i < range.length; ++i) {
      if ((cc = range.charCodeAt(i) - 64) < 1 || cc > 26) break;
      idx = 26 * idx + cc;
    }
    return idx - 1;
  };
  const digits = (): number => {
    let idx = 0;
    for (; i < range.length; ++i) {
      if ((cc = range.charCodeAt(i) - 48) < 0 || cc > 9) break;
      idx = 10 * idx + cc;
    }
    return idx - 1;
  };
  const sc = letters();
  const sr = digits();
  if (i === range.length || cc !== 10) return { sc, sr, ec: sc, er: sr };
  ++i;
  const ec = letters();
  const er = digits();
  return { sc, sr, ec, er };
};

/**
 * A `<dimension ref>` SheetJS accepts: it must look like `\w*:\w*` (SheetJS's
 * `dimregex`; a single-cell `A1` is ignored) and decode to a non-empty range.
 */
export const parseDimensionRef = (ref: string): SheetBounds | null => {
  if (!/^\w*:\w*$/.test(ref)) return null;
  const d = safeDecodeRange(ref);
  return d.sr <= d.er && d.sc <= d.ec && d.sr >= 0 && d.sc >= 0
    ? Object.freeze({ firstCol: d.sc, lastCol: d.ec, lastRow: d.er })
    : null;
};

/** SheetJS's column parse of a cell `r`: the leading A–Z letters, 0-based. */
const columnOf = (ref: string): number => {
  let idx = 0;
  for (let i = 0; i < ref.length; ++i) {
    const cc = ref.charCodeAt(i) - 64;
    if (cc < 1 || cc > 26) break;
    idx = 26 * idx + cc;
  }
  return idx - 1;
};

const encodeColumn = (col: number): string => {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(((n - 1) % 26) + 65) + s;
  return s;
};

const encodeCell = (rowIndex: number, col: number): string => `${encodeColumn(col)}${rowIndex + 1}`;

/** A `<row>` element's 1-based number: its `r`, else the previous row's plus one (NaN when `r` is not numeric). */
export const rowNumberOf = (r: string | undefined, lastRowNumber: number): number =>
  r === undefined ? lastRowNumber + 1 : parseInt(r, 10);

const CANONICAL_CELL = /^([A-Z]+)([1-9]\d*)$/;

/**
 * The 0-based row a cell is stored in, or `null` when SheetJS stores it under a
 * key it never reads back.
 */
export const targetRow = (r: string | undefined, elementRow: number, col: number): number | null => {
  if (r === undefined) return col >= 0 ? elementRow : null;
  const m = CANONICAL_CELL.exec(r);
  return m === null ? null : Number(m[2]) - 1;
};

// ── the assembler ────────────────────────────────────────────────────────────

/** The first `<v>` of a cell: not met yet, being read, or read. */
type CellText =
  | { readonly kind: "unseen" }
  | { readonly kind: "reading"; readonly text: string }
  | { readonly kind: "read"; readonly text: string };

const UNSEEN: CellText = Object.freeze({ kind: "unseen" });

interface OpenCell {
  readonly t: string | undefined;
  readonly style: string | undefined;
  readonly col: number;
  readonly address: string;
  /** Row the cell is stored in; `null` = dropped. */
  readonly row: number | null;
  readonly depth: number;
  /** Replaced (never edited) as the first `<v>` is read. */
  value: CellText;
  /** The first `<is>`'s value; `undefined` until one has been read. */
  inline: SharedString | undefined;
}

interface OpenInline {
  readonly reader: RichTextReader;
  readonly depth: number;
}

/** The open `<sheetData>` and `<row>` elements' depths. */
interface RowFrame {
  readonly sheetDataDepth: number;
  readonly rowDepth: number;
}

/** A self-closing `<row/>`: only its `r` matters, and only if it is the last row. */
interface TrailingRow {
  readonly r: string | undefined;
}

/**
 * Where the SAX stream stands. Each phase carries exactly the open elements it
 * needs, so a cell outside a row, or an inline string outside a cell, cannot be
 * represented. `finished` and `failed` are terminal: every later event is ignored.
 */
type Phase =
  | { readonly kind: "before-sheet-data" }
  | { readonly kind: "between-rows"; readonly sheetDataDepth: number; readonly trailingRow: TrailingRow | null }
  | { readonly kind: "in-row"; readonly frame: RowFrame }
  | { readonly kind: "in-cell"; readonly frame: RowFrame; readonly cell: OpenCell }
  | { readonly kind: "in-inline"; readonly frame: RowFrame; readonly cell: OpenCell; readonly inline: OpenInline }
  | { readonly kind: "finished" }
  | { readonly kind: "failed" };

type PhaseOf<K extends Phase["kind"]> = Extract<Phase, { readonly kind: K }>;

const BEFORE_SHEET_DATA: Phase = Object.freeze({ kind: "before-sheet-data" });
const FINISHED: Phase = Object.freeze({ kind: "finished" });
const FAILED: Phase = Object.freeze({ kind: "failed" });

/** Compile-time exhaustiveness: a `Phase` kind a dispatcher forgot fails to type-check here. */
const exhausted = (_phase: never): void => undefined;

/**
 * One worksheet's parse progress. It is mutated in place as SAX events arrive
 * (the phase is replaced on each transition) and never escapes
 * `createSheetReader` — every emitted row is a map the sink owns from then on.
 */
interface Assembly {
  readonly ctx: DecodeContext;
  readonly sink: SheetSink;
  /** Target row → its cells, for rows not yet emitted. */
  readonly pending: Map<number, Map<number, CellValue>>;
  depth: number;
  phase: Phase;
  /** The first `<dimension>`: not met, met but not a range SheetJS accepts, or a declared range. */
  dimension: "unseen" | "ignored" | "declared";
  elementRow: number;
  lastRowNumber: number;
  maxElementRow: number;
  lastCol: number;
  /** Rows below this index have been emitted. */
  emittedBelow: number;
}

const newAssembly = (ctx: DecodeContext, sink: SheetSink): Assembly => ({
  ctx,
  sink,
  pending: new Map(),
  depth: 0,
  phase: BEFORE_SHEET_DATA,
  dimension: "unseen",
  elementRow: -1,
  lastRowNumber: 0,
  maxElementRow: -1,
  lastCol: -1,
  emittedBelow: 0,
});

const isTerminal = (p: Phase): boolean => p.kind === "finished" || p.kind === "failed";

const fail = (a: Assembly, message: string): void => {
  a.phase = FAILED;
  a.sink.fail(message);
};

/** Emit, in ascending order, every pending row below `limit` (and drop those beyond `keepUpTo`). */
const emitBelow = (a: Assembly, limit: number, keepUpTo = Number.POSITIVE_INFINITY): void => {
  const ready = [...a.pending.keys()].filter((r) => r < limit).sort((x, y) => x - y);
  for (const r of ready) {
    const cells = a.pending.get(r);
    a.pending.delete(r);
    if (cells !== undefined && r <= keepUpTo && !isTerminal(a.phase)) a.sink.row(r, cells);
  }
  a.emittedBelow = Math.max(a.emittedBelow, limit);
};

const openRow = (a: Assembly, attrs: XmlAttrs, frame: RowFrame): void => {
  const r = attrs["r"];
  const rowNumber = rowNumberOf(r, a.lastRowNumber);
  if (!Number.isFinite(rowNumber)) return fail(a, `row ${JSON.stringify(r)} has no row number`);
  a.phase = { kind: "in-row", frame };
  a.lastRowNumber = rowNumber;
  a.elementRow = rowNumber - 1;
  a.maxElementRow = Math.max(a.maxElementRow, a.elementRow);
  a.lastCol = -1;
  emitBelow(a, a.elementRow);
};

const openCell = (a: Assembly, frame: RowFrame, attrs: XmlAttrs, at: number): void => {
  const r = attrs["r"];
  const col = r === undefined ? a.lastCol + 1 : columnOf(r);
  a.lastCol = col;
  const cell: OpenCell = {
    t: attrs["t"],
    style: attrs["s"],
    col,
    address: r ?? encodeCell(a.elementRow, col),
    row: targetRow(r, a.elementRow, col),
    depth: at,
    value: UNSEEN,
    inline: undefined,
  };
  a.phase = { kind: "in-cell", frame, cell };
};

const closeCell = (a: Assembly, c: OpenCell): void => {
  const v = c.value.kind === "unseen" || c.value.text === "" ? undefined : c.value.text;
  const decoded = decodeCell({ t: c.t, v, inline: c.inline, style: c.style }, a.ctx);
  if (decoded.kind === "bad-shared-string") {
    return fail(a, `cell ${c.address} references shared string ${decoded.index}, which does not exist`);
  }
  if (decoded.kind === "skip" || c.row === null) return;
  if (c.row < a.emittedBelow) {
    // Rows 1..emittedBelow (1-based) have already been handed to the sink, so
    // name the emission frontier (row emittedBelow + 1). The enclosing row
    // element can be the cell's own row, which would read "row 3 precedes row 3".
    return fail(a, `cell ${c.address} addresses a row that precedes row ${a.emittedBelow + 1} (unsupported cell order)`);
  }
  const cells = a.pending.get(c.row) ?? new Map<number, CellValue>();
  cells.set(c.col, decoded.value);
  a.pending.set(c.row, cells);
};

/** End of `<sheetData>`: SheetJS's last row is the dimension's, else the last row element's. */
const closeSheetData = (a: Assembly, trailingRow: TrailingRow | null): void => {
  if (trailingRow !== null) {
    const n = rowNumberOf(trailingRow.r, a.lastRowNumber);
    if (Number.isFinite(n)) a.maxElementRow = Math.max(a.maxElementRow, n - 1);
  }
  emitBelow(a, Number.POSITIVE_INFINITY, a.dimension === "declared" ? Number.POSITIVE_INFINITY : a.maxElementRow);
  a.phase = FINISHED;
};

// ── SAX phases: before <sheetData>, between rows, inside a row, inside a cell ──

const openBeforeSheetData = (a: Assembly, name: string, attrs: XmlAttrs, selfClosing: boolean, at: number): void => {
  if (name === "dimension" && a.dimension === "unseen") {
    const bounds = parseDimensionRef(attrs["ref"] ?? "");
    a.dimension = bounds === null ? "ignored" : "declared";
    if (bounds !== null) a.sink.dimension(bounds);
  } else if (name === "sheetData" && !selfClosing) a.phase = { kind: "between-rows", sheetDataDepth: at, trailingRow: null };
};

const openBetweenRows = (
  a: Assembly,
  p: PhaseOf<"between-rows">,
  name: string,
  attrs: XmlAttrs,
  selfClosing: boolean,
  at: number,
): void => {
  if (name !== "row" || at !== p.sheetDataDepth + 1) return;
  if (selfClosing) {
    a.phase = { ...p, trailingRow: { r: attrs["r"] } };
    return;
  }
  openRow(a, attrs, { sheetDataDepth: p.sheetDataDepth, rowDepth: at });
};

const openInCell = (a: Assembly, p: PhaseOf<"in-cell">, name: string, attrs: XmlAttrs, selfClosing: boolean, at: number): void => {
  const { cell } = p;
  if (name === "v" && cell.value.kind === "unseen") {
    cell.value = { kind: "reading", text: "" };
  } else if (name === "is" && cell.inline === undefined && !selfClosing && Object.keys(attrs).length === 0) {
    a.phase = { kind: "in-inline", frame: p.frame, cell, inline: { reader: createRichTextReader("inline"), depth: at } };
  }
};

const onOpen = (a: Assembly, name: string, attrs: XmlAttrs, selfClosing: boolean): void => {
  const at = a.depth++;
  const p = a.phase;
  if (p.kind === "in-inline") return p.inline.reader.open(name, attrs, selfClosing);
  if (p.kind === "in-cell") return openInCell(a, p, name, attrs, selfClosing, at);
  if (p.kind === "in-row") {
    if (name === "c" && at === p.frame.rowDepth + 1) openCell(a, p.frame, attrs, at);
    return;
  }
  if (p.kind === "between-rows") return openBetweenRows(a, p, name, attrs, selfClosing, at);
  if (p.kind === "before-sheet-data") return openBeforeSheetData(a, name, attrs, selfClosing, at);
  if (p.kind === "finished" || p.kind === "failed") return;
  exhausted(p);
};

const closeInline = (a: Assembly, p: PhaseOf<"in-inline">, name: string, at: number): void => {
  if (at !== p.inline.depth) return p.inline.reader.close(name);
  p.cell.inline = p.inline.reader.result();
  a.phase = { kind: "in-cell", frame: p.frame, cell: p.cell };
};

const closeInCell = (a: Assembly, p: PhaseOf<"in-cell">, name: string, at: number): void => {
  const { cell } = p;
  if (at === cell.depth) {
    a.phase = { kind: "in-row", frame: p.frame };
    closeCell(a, cell);
  } else if (name === "v" && cell.value.kind === "reading") cell.value = { kind: "read", text: cell.value.text };
};

const onClose = (a: Assembly, name: string): void => {
  const at = --a.depth;
  const p = a.phase;
  if (p.kind === "in-inline") return closeInline(a, p, name, at);
  if (p.kind === "in-cell") return closeInCell(a, p, name, at);
  if (p.kind === "in-row") {
    if (at === p.frame.rowDepth) a.phase = { kind: "between-rows", sheetDataDepth: p.frame.sheetDataDepth, trailingRow: null };
    return;
  }
  if (p.kind === "between-rows") {
    if (at === p.sheetDataDepth) closeSheetData(a, p.trailingRow);
    return;
  }
  if (p.kind === "before-sheet-data" || p.kind === "finished" || p.kind === "failed") return;
  exhausted(p);
};

const onText = (a: Assembly, text: string): void => {
  const p = a.phase;
  if (p.kind === "in-inline") p.inline.reader.text(text);
  else if (p.kind === "in-cell" && p.cell.value.kind === "reading") {
    p.cell.value = { kind: "reading", text: p.cell.value.text + text };
  }
};

/** A SAX handler for one worksheet, reporting rows to `sink` as they complete. */
export const createSheetReader = (ctx: DecodeContext, sink: SheetSink): XmlHandler => {
  const assembly = newAssembly(ctx, sink);
  return {
    open: (name, attrs, selfClosing) => onOpen(assembly, name, attrs, selfClosing),
    close: (name) => onClose(assembly, name),
    text: (text) => onText(assembly, text),
  };
};
