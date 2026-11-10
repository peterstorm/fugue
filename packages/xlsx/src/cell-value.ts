/**
 * Pure cell decoding: one raw `<c>` element → the value SheetJS 0.18.5 yields
 * for it under `XLSX.read(buf, { type: "buffer", cellDates: true })`, mapped the
 * way the pre-streaming `parseWorkbook` mapped it (error cells → `null`).
 *
 * These are FROZEN semantics, decided by the SheetJS differential suite, not by
 * taste. Two of them look like bugs and are deliberately kept:
 * - `serialToDate` depends on the process time zone and keeps Excel's 1900
 *   leap-year off-by-one for serials ≤ 60 (it is SheetJS `numdate`).
 * - `workbookPr date1904` does NOT shift Date values: SheetJS applies it only to
 *   formatted text (`.w`), never to `.v`.
 */

import type { SharedString, SharedStrings } from "./shared-strings.js";

export type CellValue = string | number | boolean | Date | null;

/**
 * A `<c>` element as read off the worksheet XML.
 * - `t`, `style`: the raw `t` / `s` attributes.
 * - `v`: text of the first `<v>` (entities already decoded); `undefined` when
 *   absent or empty, as SheetJS's `match_v` + `!== ''` check does.
 * - `inline`: the `<is>` rich-text value; `undefined` when there is no `<is>`.
 */
export interface RawCell {
  readonly t: string | undefined;
  readonly v: string | undefined;
  readonly inline: SharedString | undefined;
  readonly style: string | undefined;
}

export interface DecodeContext {
  readonly sst: SharedStrings;
  readonly isDateStyle: (style: string | undefined) => boolean;
}

/**
 * - `skip`: SheetJS stores no cell (an empty styled cell, an empty number) — it
 *   neither shows a value nor overwrites an earlier cell at the same address.
 * - `value`: the stored cell's value.
 * - `bad-shared-string`: a shared-string index with no entry. SheetJS throws
 *   while parsing the sheet; the reader turns it into a node-crash.
 */
export type DecodedCell =
  | { readonly kind: "skip" }
  | { readonly kind: "value"; readonly value: CellValue }
  | { readonly kind: "bad-shared-string"; readonly index: string };

const SKIP: DecodedCell = Object.freeze({ kind: "skip" });
const value = (v: CellValue): DecodedCell => ({ kind: "value", value: v });

// ── SheetJS numdate port ─────────────────────────────────────────────────────
// SheetJS captures these at module load; so does this port, so both agree for
// the lifetime of a process even if `TZ` changes underneath them.
const BASE_DATE = new Date(1899, 11, 30, 0, 0, 0);
const REF_DATE = new Date();
const DN_THRESH = BASE_DATE.getTime() + (REF_DATE.getTimezoneOffset() - BASE_DATE.getTimezoneOffset()) * 60_000;
const REF_OFFSET = REF_DATE.getTimezoneOffset();

/**
 * Excel serial → `Date`, exactly as SheetJS 0.18.5 `numdate`. The product is
 * evaluated left to right as SheetJS writes it (`v * 24 * 60 * 60 * 1000`):
 * folding it into one constant rounds differently and drifts by a millisecond.
 */
export const serialToDate = (serial: number): Date => {
  const out = new Date(serial * 24 * 60 * 60 * 1000 + DN_THRESH);
  const offset = out.getTimezoneOffset();
  return offset === REF_OFFSET ? out : new Date(out.getTime() + (offset - REF_OFFSET) * 60_000);
};

// ── strings ──────────────────────────────────────────────────────────────────

const ESCAPE = /_x([\da-fA-F]{4})_/gi;

/** Decode OOXML `_xHHHH_` escapes (SheetJS `unescapexml`'s second pass), left to right, case-insensitive. */
export const decodeXmlEscapes = (s: string): string =>
  s.indexOf("_") < 0 ? s : s.replace(ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** SheetJS `parsexmlbool`: only `1`/`true`/`TRUE` are true. */
const parseXmlBool = (v: string | undefined): boolean => v === "1" || v === "true" || v === "TRUE";

/** SheetJS `parseDate(str, 1)` for `t="d"` cells: parse, then shift by the local offset. */
const parseIsoDate = (v: string | undefined): Date => {
  const d = new Date(v === undefined ? Number.NaN : v);
  return new Date(d.getTime() + d.getTimezoneOffset() * 60_000);
};

const sharedString = (sst: SharedStrings, v: string): DecodedCell => {
  const index = parseInt(v, 10);
  if (!Number.isInteger(index) || index < 0 || index >= sst.length) return { kind: "bad-shared-string", index: v };
  return value(sst[index] ?? null);
};

type TypedDecoder = (v: string | undefined, raw: RawCell, ctx: DecodeContext) => DecodedCell;

/** The `t` attribute's cell types (ECMA-376 ST_CellType). */
const DECODERS: Readonly<Record<string, TypedDecoder>> = {
  n: (v, raw, ctx) => {
    if (v === undefined) return SKIP;
    const n = parseFloat(v);
    return value(ctx.isDateStyle(raw.style) ? serialToDate(n) : n);
  },
  s: (v, _raw, ctx) => (v === undefined ? SKIP : sharedString(ctx.sst, v)),
  str: (v) => value(v ?? ""),
  inlineStr: (_v, raw) => value(raw.inline === undefined ? "" : raw.inline),
  b: (v) => value(parseXmlBool(v)),
  d: (v) => value(parseIsoDate(v)),
  e: () => value(null),
};

/** An unknown type: SheetJS keeps the raw text. */
const decodeUnknownType: TypedDecoder = (v) => value(v ?? null);

/** Decode one raw cell (SheetJS `parse_ws_xml_data`'s cell-type switch, then `cellValue`). */
export const decodeCell = (raw: RawCell, ctx: DecodeContext): DecodedCell => {
  if (raw.t === undefined && raw.v === undefined) return SKIP;
  const type = raw.t === undefined || raw.t === "" ? "n" : raw.t;
  const decode = Object.hasOwn(DECODERS, type) ? DECODERS[type]! : decodeUnknownType;
  return decode(raw.v === undefined ? undefined : decodeXmlEscapes(raw.v), raw, ctx);
};
