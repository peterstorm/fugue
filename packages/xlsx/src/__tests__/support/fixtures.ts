/**
 * Deterministic synthetic workbook fixtures for the differential parity gate
 * (FR-043, AS-009) — dev-only test support.
 *
 * Two writers produce the bytes, on purpose:
 * - A raw OOXML writer (`renderWorkbook` → `zipParts`) that controls every byte
 *   SheetJS semantics depend on: shared vs inline vs formula strings, rich runs
 *   and phonetic `rPh` runs, `_xHHHH_` escapes, built-in and custom number
 *   formats, `date1904`, error cells, cached and uncached formulas, missing `r`
 *   attributes, row/column gaps and wrong `<dimension>` refs.
 * - ExcelJS, for the shapes real exports have and for every fixture the existing
 *   xlsx tests build, so writer-specific output is covered too.
 *
 * Everything is a pure function of its seed: the PRNG is seeded, and document
 * properties carry a fixed timestamp. The archives `zipParts` writes — every raw
 * OOXML workbook and the ExcelJS output re-zipped by `excelBytes` — are
 * byte-identical for the same seed: every entry carries a fixed date and no
 * implicit folder entry (which JSZip would stamp with wall-clock time) is
 * written. The rebuilt fixtures of the existing xlsx tests are the exception:
 * they are written exactly as those tests write them, so only their content is
 * deterministic, not their bytes.
 */

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { match } from "ts-pattern";
import { z } from "zod";
import type { ParseWorkbookOpts } from "../../index.js";
import { BRANCHELISTE_ROWS } from "./bench-core.js";

// ════════════════════════════════════════════════════════════════════════════
// Fixture model
// ════════════════════════════════════════════════════════════════════════════

/** A row schema that accepts any row as-is, so parity compares the raw projected rows. */
export const anyRow: z.ZodType<unknown> = z.unknown();

/** One way to read a fixture: the options and schema both readers are given. */
export type ParityRead = {
  readonly label: string;
  readonly opts: ParseWorkbookOpts;
  readonly schema: z.ZodType<unknown>;
};

/** What the oracle is meant to produce for a read — guards against vacuous parity (both sides empty). */
export type FixtureExpectation =
  | { readonly kind: "rows"; readonly min: number }
  | { readonly kind: "error"; readonly errorKind: "validation" | "node-crash" };

export type FixtureRead = ParityRead & { readonly expectation: FixtureExpectation };

export type FixtureCase = { readonly name: string; readonly bytes: Uint8Array; readonly reads: readonly FixtureRead[] };

/** A randomly generated workbook: any outcome is fine as long as both readers agree. */
export type RandomCase = { readonly name: string; readonly bytes: Uint8Array; readonly reads: readonly ParityRead[] };

const rows = (min: number): FixtureExpectation => ({ kind: "rows", min });
const crash: FixtureExpectation = { kind: "error", errorKind: "node-crash" };
const invalid: FixtureExpectation = { kind: "error", errorKind: "validation" };

const read = (
  label: string,
  opts: ParseWorkbookOpts,
  expectation: FixtureExpectation,
  schema: z.ZodType<unknown> = anyRow,
): FixtureRead => ({ label, opts, schema, expectation });

// ════════════════════════════════════════════════════════════════════════════
// Seeded PRNG (mulberry32). Its internal counter is the only mutable state.
// ════════════════════════════════════════════════════════════════════════════

type Rng = {
  readonly float: () => number;
  readonly int: (lo: number, hi: number) => number; // inclusive
  readonly chance: (p: number) => boolean;
  readonly pick: <A>(xs: readonly A[]) => A;
};

const seededRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const float = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(float() * (hi - lo + 1));
  return {
    float,
    int,
    chance: (p) => float() < p,
    pick: <A>(xs: readonly A[]): A => xs[int(0, xs.length - 1)]!,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// Raw OOXML model
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cell styles (index in `STYLES` = `cellXfs` index). Built-in ids and custom
 * format codes are chosen to exercise SheetJS date detection both ways.
 */
const STYLES = [
  { name: "general", numFmtId: 0 },
  { name: "date-14", numFmtId: 14 },
  { name: "datetime-22", numFmtId: 22 },
  { name: "time-21", numFmtId: 21 },
  { name: "elapsed-46", numFmtId: 46 },
  { name: "money-4", numFmtId: 4 },
  { name: "percent-10", numFmtId: 10 },
  { name: "text-49", numFmtId: 49 },
  { name: "date-dmy", numFmtId: 164, code: "dd/mm/yyyy" },
  { name: "datetime-iso", numFmtId: 165, code: "yyyy-mm-dd hh:mm:ss" },
  { name: "date-da-long", numFmtId: 166, code: "[$-406]d. mmmm yyyy;@" },
  { name: "kroner", numFmtId: 167, code: '#,##0.00 "kr."' },
  { name: "colored", numFmtId: 168, code: "[Red]0.00;[Blue]-0.00" },
  { name: "quoted-day", numFmtId: 169, code: '"Day "0' },
  { name: "month-year", numFmtId: 170, code: "mmm-yy" },
  { name: "elapsed-hours", numFmtId: 171, code: "[h]:mm" },
  { name: "scientific", numFmtId: 172, code: "0.00E+00" },
] as const;

type StyleName = (typeof STYLES)[number]["name"];

const styleIndex = (name: StyleName): number => STYLES.findIndex((s) => s.name === name);

type ErrorCode = "#NULL!" | "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#NUM!" | "#N/A" | "#GETTING_DATA";
const ERROR_CODES: readonly ErrorCode[] = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA"];

type Formula =
  | { readonly kind: "normal"; readonly text: string }
  | { readonly kind: "shared-master"; readonly si: number; readonly ref: string; readonly text: string }
  | { readonly kind: "shared-child"; readonly si: number }
  | { readonly kind: "array"; readonly ref: string; readonly text: string };

/** One cell's content, by how it is stored in the sheet XML. */
type RawCell =
  | { readonly kind: "shared"; readonly text: string; readonly style?: StyleName }
  | { readonly kind: "shared-rich"; readonly runs: readonly string[]; readonly phonetic?: string }
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "inline-rich"; readonly runs: readonly string[] }
  | { readonly kind: "number"; readonly value: number; readonly literal?: string; readonly style?: StyleName; readonly formula?: Formula }
  | { readonly kind: "bool"; readonly value: boolean; readonly formula?: Formula }
  | { readonly kind: "error"; readonly code: ErrorCode; readonly formula?: Formula }
  | { readonly kind: "formula-str"; readonly formula: Formula; readonly cached: string }
  | { readonly kind: "formula-uncached"; readonly formula: Formula }
  | { readonly kind: "styled-blank"; readonly style: StyleName };

/** A cell at a 0-based column, or with no `r` attribute (the reader advances implicitly). */
type PlacedCell = { readonly col: number | "implicit"; readonly cell: RawCell };

/** A row at a 1-based row number, or with no `r` attribute. */
type RawRow = { readonly r: number | "implicit"; readonly cells: readonly PlacedCell[] };

type Dimension = { readonly kind: "auto" } | { readonly kind: "none" } | { readonly kind: "fixed"; readonly ref: string };

type RawSheet = {
  readonly name: string;
  readonly hidden?: boolean;
  readonly dimension: Dimension;
  readonly rows: readonly RawRow[];
  readonly hyperlinks?: readonly { readonly ref: string; readonly target: string }[];
  readonly merges?: readonly string[];
};

type RawWorkbook = {
  readonly sheets: readonly RawSheet[];
  readonly date1904?: boolean;
  readonly compression?: "DEFLATE" | "STORE";
};

// ── cell constructors ───────────────────────────────────────────────────────

const s = (text: string, style?: StyleName): RawCell => (style === undefined ? { kind: "shared", text } : { kind: "shared", text, style });
const n = (value: number, style?: StyleName): RawCell => (style === undefined ? { kind: "number", value } : { kind: "number", value, style });
const f = (text: string): Formula => ({ kind: "normal", text });

/** Cells at consecutive explicit columns starting at A; `null` leaves a gap. */
const at = (...cells: readonly (RawCell | null)[]): readonly PlacedCell[] =>
  cells.flatMap((cell, col) => (cell === null ? [] : [{ col, cell }]));

/** Rows at consecutive explicit row numbers starting at `from`. */
const rowsFrom = (from: number, cellRows: readonly (readonly (RawCell | null)[])[]): readonly RawRow[] =>
  cellRows.map((cells, i) => ({ r: from + i, cells: at(...cells) }));

// ════════════════════════════════════════════════════════════════════════════
// Raw OOXML renderer — pure: workbook model → { part path → XML }.
// ════════════════════════════════════════════════════════════════════════════

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const escapeXml = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textEl = (t: string): string =>
  /^\s|\s$/.test(t) ? `<t xml:space="preserve">${escapeXml(t)}</t>` : `<t>${escapeXml(t)}</t>`;

const runsXml = (runs: readonly string[]): string =>
  runs.map((r, i) => (i % 2 === 0 ? `<r><rPr><b/></rPr>${textEl(r)}</r>` : `<r>${textEl(r)}</r>`)).join("");

const colLetters = (col: number): string => {
  let out = "";
  for (let c = col + 1; c > 0; c = Math.floor((c - 1) / 26)) out = String.fromCharCode(65 + ((c - 1) % 26)) + out;
  return out;
};

const formulaXml = (fm: Formula | undefined): string =>
  fm === undefined
    ? ""
    : match(fm)
        .with({ kind: "normal" }, (x) => `<f>${escapeXml(x.text)}</f>`)
        .with({ kind: "shared-master" }, (x) => `<f t="shared" ref="${x.ref}" si="${x.si}">${escapeXml(x.text)}</f>`)
        .with({ kind: "shared-child" }, (x) => `<f t="shared" si="${x.si}"/>`)
        .with({ kind: "array" }, (x) => `<f t="array" ref="${x.ref}">${escapeXml(x.text)}</f>`)
        .exhaustive();

/**
 * Shared-string table under construction. Interning is order-dependent, so the
 * table is accumulated while the sheets render; it never escapes `renderWorkbook`.
 */
type SharedStrings = { readonly index: Map<string, number>; readonly items: string[] };

const intern = (sst: SharedStrings, key: string, itemXml: string): number => {
  const known = sst.index.get(key);
  if (known !== undefined) return known;
  sst.items.push(itemXml);
  sst.index.set(key, sst.items.length - 1);
  return sst.items.length - 1;
};

const cellXml = (ref: string | null, cell: RawCell, sst: SharedStrings): string => {
  const r = ref === null ? "" : ` r="${ref}"`;
  const st = (style: StyleName | undefined): string =>
    style === undefined || style === "general" ? "" : ` s="${styleIndex(style)}"`;
  return match(cell)
    .with({ kind: "shared" }, (c) => `<c${r}${st(c.style)} t="s"><v>${intern(sst, `p:${c.text}`, `<si>${textEl(c.text)}</si>`)}</v></c>`)
    .with({ kind: "shared-rich" }, (c) => {
      const ph =
        c.phonetic === undefined ? "" : `<rPh sb="0" eb="1">${textEl(c.phonetic)}</rPh><phoneticPr fontId="0" type="noConversion"/>`;
      const idx = intern(sst, `r:${JSON.stringify([c.runs, c.phonetic ?? null])}`, `<si>${runsXml(c.runs)}${ph}</si>`);
      return `<c${r} t="s"><v>${idx}</v></c>`;
    })
    .with({ kind: "inline" }, (c) => `<c${r} t="inlineStr"><is>${textEl(c.text)}</is></c>`)
    .with({ kind: "inline-rich" }, (c) => `<c${r} t="inlineStr"><is>${runsXml(c.runs)}</is></c>`)
    .with({ kind: "number" }, (c) => `<c${r}${st(c.style)}>${formulaXml(c.formula)}<v>${c.literal ?? String(c.value)}</v></c>`)
    .with({ kind: "bool" }, (c) => `<c${r} t="b">${formulaXml(c.formula)}<v>${c.value ? 1 : 0}</v></c>`)
    .with({ kind: "error" }, (c) => `<c${r} t="e">${formulaXml(c.formula)}<v>${escapeXml(c.code)}</v></c>`)
    .with({ kind: "formula-str" }, (c) => `<c${r} t="str">${formulaXml(c.formula)}<v>${escapeXml(c.cached)}</v></c>`)
    .with({ kind: "formula-uncached" }, (c) => `<c${r}>${formulaXml(c.formula)}</c>`)
    .with({ kind: "styled-blank" }, (c) => `<c${r}${st(c.style)}/>`)
    .exhaustive();
};

/** A cell with the 0-based column a reader assigns it (an implicit cell follows the previous one). */
type AddressedCell = { readonly placed: PlacedCell; readonly col: number };

/** A row with the 1-based row number a reader assigns it (an implicit row follows the previous one). */
type AddressedRow = { readonly raw: RawRow; readonly row: number; readonly cells: readonly AddressedCell[] };

/** Resolve every row and cell to the address a reader assigns it: the one addressing rule. */
const addressed = (sheet: RawSheet): readonly AddressedRow[] => {
  let row = 0; // the cursors are local: each call resolves from scratch
  return sheet.rows.map((raw) => {
    row = raw.r === "implicit" ? row + 1 : raw.r;
    let col = -1;
    const cells = raw.cells.map((placed): AddressedCell => {
      col = placed.col === "implicit" ? col + 1 : placed.col;
      return { placed, col };
    });
    return { raw, row, cells };
  });
};

/** The bounding ref of every explicitly or implicitly addressed cell (for `dimension: auto`). */
const boundingRef = (rows: readonly AddressedRow[]): string => {
  const max = rows.reduce(
    (acc, r) => r.cells.reduce((m, c) => ({ row: Math.max(m.row, r.row), col: Math.max(m.col, c.col) }), acc),
    { row: 1, col: 0 },
  );
  return `A1:${colLetters(max.col)}${max.row}`;
};

const sheetXml = (sheet: RawSheet, sst: SharedStrings): string => {
  const rows = addressed(sheet);
  const body = rows
    .map(({ raw, row, cells }) => {
      const cellsXml = cells
        .map(({ placed, col }) => cellXml(placed.col === "implicit" ? null : `${colLetters(col)}${row}`, placed.cell, sst))
        .join("");
      const rAttr = raw.r === "implicit" ? "" : ` r="${raw.r}"`;
      return cellsXml === "" ? `<row${rAttr}/>` : `<row${rAttr}>${cellsXml}</row>`;
    })
    .join("");
  const dim =
    sheet.dimension.kind === "none"
      ? ""
      : `<dimension ref="${sheet.dimension.kind === "auto" ? boundingRef(rows) : sheet.dimension.ref}"/>`;
  const merges =
    sheet.merges === undefined || sheet.merges.length === 0
      ? ""
      : `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`;
  const links =
    sheet.hyperlinks === undefined || sheet.hyperlinks.length === 0
      ? ""
      : `<hyperlinks>${sheet.hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rIdH${i + 1}"/>`).join("")}</hyperlinks>`;
  return (
    `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${dim}` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${body}</sheetData>${merges}${links}</worksheet>`
  );
};

const stylesXml = (): string => {
  const custom = STYLES.filter((st): st is Extract<(typeof STYLES)[number], { code: string }> => "code" in st);
  return (
    `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="${custom.length}">${custom.map((c) => `<numFmt numFmtId="${c.numFmtId}" formatCode="${escapeXml(c.code)}"/>`).join("")}</numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${STYLES.length}">${STYLES.map(
      (st) => `<xf numFmtId="${st.numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0"${st.numFmtId === 0 ? "" : ' applyNumberFormat="1"'}/>`,
    ).join("")}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  );
};

/** Render every package part of a raw workbook. Pure. */
const renderWorkbook = (wb: RawWorkbook): Readonly<Record<string, string>> => {
  const sst: SharedStrings = { index: new Map(), items: [] };
  const sheetParts = wb.sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh, sst)] as const);
  const sheetRels = wb.sheets.flatMap((sh, i) =>
    sh.hyperlinks === undefined || sh.hyperlinks.length === 0
      ? []
      : [
          [
            `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
            `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${sh.hyperlinks
              .map(
                (h, j) =>
                  `<Relationship Id="rIdH${j + 1}" Type="${NS_REL}/hyperlink" Target="${escapeXml(h.target)}" TargetMode="External"/>`,
              )
              .join("")}</Relationships>`,
          ] as const,
        ],
  );
  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    wb.sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;
  const rootRels =
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<workbookPr${wb.date1904 === true ? ' date1904="1"' : ""} defaultThemeVersion="164011"/>` +
    `<sheets>${wb.sheets
      .map((sh, i) => `<sheet name="${escapeXml(sh.name)}" sheetId="${i + 1}"${sh.hidden === true ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`;
  const n = wb.sheets.length;
  const workbookRels =
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  // Rendered last: interning happened while the sheets rendered above.
  const sharedStrings = `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${sst.items.length}" uniqueCount="${sst.items.length}">${sst.items.join("")}</sst>`;
  return Object.fromEntries([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ...sheetParts,
    ...sheetRels,
    ["xl/styles.xml", stylesXml()],
    ["xl/sharedStrings.xml", sharedStrings],
  ]);
};

// ════════════════════════════════════════════════════════════════════════════
// Packaging (the I/O-ish edge: zip encoding)
// ════════════════════════════════════════════════════════════════════════════

/** Fixed entry timestamp, so archives are byte-identical run to run. */
export const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

/**
 * Zip the parts with a fixed date on every entry. `createFolders: false` keeps
 * JSZip from adding implicit folder entries (`xl/`, `xl/worksheets/`), which it
 * would stamp with wall-clock time; readers never need them.
 */
const zipParts = (parts: Readonly<Record<string, string | Uint8Array>>, compression: "DEFLATE" | "STORE"): Promise<Uint8Array> => {
  const zip = new JSZip();
  for (const [path, data] of Object.entries(parts)) zip.file(path, data, { date: FIXED_DATE, createFolders: false });
  return zip.generateAsync({ type: "uint8array", compression, compressionOptions: { level: 6 } });
};

const buildRaw = (wb: RawWorkbook): Promise<Uint8Array> => zipParts(renderWorkbook(wb), wb.compression ?? "DEFLATE");

/** Re-zip an archive with fixed entry dates (ExcelJS stamps wall-clock time). Entry order is preserved. */
const restamp = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const src = await JSZip.loadAsync(bytes);
  const entries = Object.values(src.files).filter((e) => !e.dir);
  const parts = await Promise.all(entries.map(async (e) => [e.name, await e.async("uint8array")] as const));
  return zipParts(Object.fromEntries(parts), "DEFLATE");
};

const newExcelWorkbook = (): ExcelJS.Workbook => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "fugue-fixtures";
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;
  return wb;
};

/** ExcelJS's own archive, as it writes it (wall-clock entry dates included). */
const writeExcel = async (wb: ExcelJS.Workbook): Promise<Uint8Array> =>
  new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

/** ExcelJS output re-zipped with fixed dates, so the same workbook gives the same bytes. */
const excelBytes = async (wb: ExcelJS.Workbook): Promise<Uint8Array> => restamp(await writeExcel(wb));

// ════════════════════════════════════════════════════════════════════════════
// Value pools (Danish-shaped, with the characters real exports carry)
// ════════════════════════════════════════════════════════════════════════════

const CITIES = [
  "København K", "Aarhus C", "Odense C", "Aalborg", "Esbjerg", "Randers", "Kolding", "Horsens", "Vejle", "Roskilde",
  "Herning", "Hørsholm", "Helsingør", "Silkeborg", "Næstved", "Frederikshavn", "Viborg", "Køge", "Holstebro", "Taastrup",
  "Slagelse", "Hillerød", "Sønderborg", "Svendborg", "Hjørring", "Nørresundby", "Ringsted", "Ølstykke", "Fredericia", "Åbyhøj",
];
const WORDS = ["Nordisk", "Dansk", "Grøn", "Blå", "Fjord", "Kyst", "Byg", "Data", "Søndergaard", "Møller", "Æble", "Hav", "Skov", "Lys", "Kraft"];
const SUFFIXES = ["ApS", "A/S", "I/S", "K/S", "& Søn", "Holding ApS", "IVS"];
const SEGMENTS = ["SoHo", "Small", "Medium", "Large", "Public"];
const MANAGERS = ["Anne Jensen", "Bo Nielsen", "Camilla Hansen", "Dennis Pedersen", "Eva Andersen", "Frederik Christensen", "Gitte Larsen", "Henrik Sørensen", "Ida Rasmussen", "Jens Jørgensen", "Karen Petersen", "Lars Madsen"];
const TITLES = ["Direktør", "CFO", "IT-chef", "Indkøbschef", "Adm. direktør; CFO", "Ejer"];

const companyName = (rng: Rng): string => `${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.pick(SUFFIXES)}`;
const cvrNumber = (rng: Rng): number => rng.int(10_000_000, 99_999_999);

/** A serial with a random time of day, at whole-second resolution. */
const serialWithTime = (rng: Rng, lo: number, hi: number): number => rng.int(lo, hi) + rng.int(0, 86_399) / 86_400;

// ════════════════════════════════════════════════════════════════════════════
// Brancheliste-shaped master list
// ════════════════════════════════════════════════════════════════════════════

const BRANCHELISTE_HEADERS = [
  "CVR", "Firmanavn", "TOT_ACTV_SUBS_CNT", "PostNr", "By", "Business_Segment", "ACCOUNT_MANAGER", "Titler",
  "Oprettet", "Opdateret", "Omsætning", "Aktiv", "Note",
] as const;

// Each cell builder draws from the RNG in a fixed order; the row builder calls them
// in column order, so a given seed always yields the same workbook content.

/** CVR: mostly numeric, some padded/prefixed text, a few inline strings. */
const branchelisteCvr = (rng: Rng): RawCell => {
  if (rng.chance(0.9)) return n(cvrNumber(rng));
  if (!rng.chance(0.7)) return { kind: "inline", text: String(cvrNumber(rng)) };
  return s(rng.chance(0.5) ? ` ${cvrNumber(rng)}` : `DK${cvrNumber(rng)}`);
};

/** Company name: mostly plain, with rich text, `_xHHHH_` escapes and XML specials mixed in. */
const branchelisteName = (rng: Rng): RawCell => {
  const roll = rng.float();
  if (roll < 0.03) return { kind: "shared-rich", runs: [rng.pick(WORDS), ` ${rng.pick(WORDS)} `, rng.pick(SUFFIXES)] };
  if (roll < 0.04) return s(`${companyName(rng)}_x000D_\nafdeling`);
  if (roll < 0.05) return s(`${rng.pick(WORDS)} & <${rng.pick(WORDS)}> "${rng.pick(SUFFIXES)}"`);
  return s(companyName(rng));
};

/** Subscription count: mostly a number, some cached formulas, some formula errors, some blank. */
const branchelisteSubs = (rng: Rng, rowNum: number): RawCell | null => {
  const roll = rng.float();
  if (roll < 0.85) return n(rng.int(0, 400));
  if (roll < 0.9) return { kind: "number", value: rng.int(0, 400), formula: f(`SUM(X${rowNum}:Z${rowNum})`) };
  if (roll < 0.93) return { kind: "error", code: "#N/A", formula: f(`VLOOKUP(A${rowNum},Sheet2!A:B,2,FALSE)`) };
  return null;
};

/** Account-manager titles: 60% shared string, 20% inline string, 20% empty. */
const branchelisteTitles = (rng: Rng): RawCell | null => {
  const roll = rng.float();
  if (roll < 0.6) return s(rng.pick(TITLES));
  if (roll < 0.8) return { kind: "inline", text: rng.pick(TITLES) };
  return null;
};

const branchelisteRow = (rng: Rng, rowNum: number): readonly (RawCell | null)[] => {
  // ~0.5% fully blank / all-error rows: both readers must skip them.
  if (rng.chance(0.003)) return [null, { kind: "styled-blank", style: "date-14" }, null, s("")];
  if (rng.chance(0.002)) return [{ kind: "error", code: "#N/A" }, { kind: "error", code: "#REF!" }];

  const cvr = branchelisteCvr(rng);
  const name = branchelisteName(rng);
  const subs = branchelisteSubs(rng, rowNum);
  const postNr: RawCell = rng.chance(0.9) ? n(rng.int(1000, 9990)) : s(String(rng.int(1000, 9990)).padStart(5, "0"));
  const am: RawCell | null = rng.chance(0.8) ? s(rng.pick(MANAGERS)) : null;
  const titles = branchelisteTitles(rng);
  const created: RawCell | null = rng.chance(0.95) ? n(rng.int(36_000, 46_000), "date-14") : null;
  const updated: RawCell = { kind: "number", value: serialWithTime(rng, 44_000, 46_000), style: "datetime-iso" };
  const revenue: RawCell = n(Math.round(rng.float() * 1e9) / 100, rng.chance(0.5) ? "kroner" : "money-4");
  const active: RawCell = { kind: "bool", value: rng.chance(0.7) };
  const note: RawCell | null = rng.chance(0.02)
    ? { kind: "formula-str", formula: f(`B${rowNum}&" (note)"`), cached: "_x0041_ note" }
    : null;
  return [cvr, name, subs, postNr, s(rng.pick(CITIES)), s(rng.pick(SEGMENTS)), am, titles, created, updated, revenue, active, note];
};

/**
 * A Brancheliste-shaped workbook: one sheet, `rowCount` data rows under a header
 * row, with shared strings, styles, built-in and custom date formats, formulas,
 * errors, rich text and `_xHHHH_` escapes. ~25.6k rows mirrors the real file.
 */
export const syntheticBrancheliste = (rowCount: number, seed: number): Promise<Uint8Array> => {
  const rng = seededRng(seed);
  const data = Array.from({ length: rowCount }, (_, i) => branchelisteRow(rng, i + 2));
  return buildRaw({
    sheets: [{ name: "Brancheliste", dimension: { kind: "auto" }, rows: rowsFrom(1, [BRANCHELISTE_HEADERS.map((h) => s(h)), ...data]) }],
  });
};

// ════════════════════════════════════════════════════════════════════════════
// The nine other source shapes
// ════════════════════════════════════════════════════════════════════════════

export const SOURCE_SHAPES = [
  "scoringsmodel",
  "gamleKunder",
  "tabte",
  "danskErhverv",
  "leverandoer",
  "tivoli",
  "fck",
  "itBranchen",
  "globalConnect",
] as const;

export type SourceShape = (typeof SOURCE_SHAPES)[number];

const scoringsmodel = (rng: Rng): Promise<Uint8Array> => {
  const signals = Array.from({ length: 15 }, (_, i) => {
    const grey = [5, 8, 10, 11, 12, 13].includes(i + 1);
    return [
      n(i + 1),
      s(`Signal ${i + 1}: ${rng.pick(WORDS)}`),
      grey ? null : n(rng.int(1, 20) / 100, "percent-10"),
      grey ? s("") : { kind: "number", value: rng.int(0, 30), formula: f(`C${i + 5}*100`) } satisfies RawCell,
    ];
  });
  return buildRaw({
    sheets: [
      {
        name: "1. Signaler & vægte",
        dimension: { kind: "auto" },
        merges: ["A1:D1"],
        rows: [
          ...rowsFrom(1, [[s("Scoringsmodel v0 — udkast")], [], [{ kind: "inline", text: "Justér kolonne D" }]]),
          ...rowsFrom(4, [[s("#"), s("Signal"), s("Foreslået vægt"), s("Din vægt (juster)")], ...signals]),
          ...rowsFrom(21, [[null, s("I alt"), { kind: "number", value: 1, formula: f("SUM(C5:C19)"), style: "percent-10" }, { kind: "error", code: "#DIV/0!", formula: f("D5/0") }]]),
        ],
      },
      {
        name: "2. Skalering",
        dimension: { kind: "auto" },
        rows: rowsFrom(1, [
          [s("Parameter"), s("Værdi")],
          [s("ccvCap"), n(rng.int(100_000, 900_000))],
          [s("recencyMonths"), n(rng.int(6, 36))],
          [s(" "), null],
          [s("halfLife"), s("12")],
        ]),
      },
    ],
  });
};

const gamleKunder = async (rng: Rng): Promise<Uint8Array> => {
  const wb = newExcelWorkbook();
  const ws = wb.addWorksheet("Gamle kunder");
  ws.addRow(["TAXPAYER_ID", "CUSTOMER_NAME", "ACCT_MGR_NAME", "SUBS_COUNT", "CHURN_DATE"]);
  for (let i = 0; i < 300; i++) {
    ws.addRow([
      rng.chance(0.9) ? cvrNumber(rng) : String(cvrNumber(rng)),
      companyName(rng),
      rng.chance(0.85) ? rng.pick(MANAGERS) : null,
      rng.chance(0.9) ? rng.int(1, 250) : "n/a",
      rng.chance(0.8) ? new Date(Date.UTC(rng.int(2015, 2025), rng.int(0, 11), rng.int(1, 28))) : null,
    ]);
  }
  return excelBytes(wb);
};

/** Actual Close Date: mostly a date serial (two date formats), some date-looking text, some blank. */
const tabteCloseDate = (rng: Rng): RawCell | null => {
  if (rng.chance(0.85)) {
    return { kind: "number", value: serialWithTime(rng, 43_000, 46_000), style: rng.chance(0.5) ? "date-dmy" : "datetime-22" };
  }
  return rng.chance(0.5) ? s("01-02-2024") : null;
};

const tabte = (rng: Rng): Promise<Uint8Array> => {
  const data = Array.from({ length: 400 }, (): readonly (RawCell | null)[] => [
    s(rng.pick(["Nysalg", "Delesag", "Genforhandling", "Fornyelse"])),
    rng.chance(0.9) ? n(cvrNumber(rng)) : s(`${cvrNumber(rng)}`),
    s(companyName(rng)),
    tabteCloseDate(rng),
    rng.chance(0.9) ? n(rng.int(0, 5_000_000) / 10, "kroner") : { kind: "error", code: "#VALUE!" },
  ]);
  return buildRaw({
    sheets: [
      {
        name: "hiddenSheet",
        hidden: true,
        dimension: { kind: "auto" },
        rows: rowsFrom(1, [[s("ProcessId"), s("Version")], [s("b2c1-77"), n(3)]]),
      },
      {
        name: "Salgsmuligheder",
        dimension: { kind: "auto" },
        rows: rowsFrom(1, [
          [s("Topic"), s("CVR-nummer (Account) (Account)"), s("Potential Customer"), s("Actual Close Date"), s("Anslået CCV")],
          ...data,
        ]),
      },
    ],
  });
};

const danskErhverv = (rng: Rng): Promise<Uint8Array> => {
  const branches = ["Detailhandel", "Engroshandel", "Rådgivning", "IT & Tele", "Transport", "Bygge & anlæg", "Fødevarer"];
  const data = Array.from({ length: 1000 }, (): readonly (RawCell | null)[] => [
    rng.chance(0.95) ? n(cvrNumber(rng)) : s(String(cvrNumber(rng))),
    rng.chance(0.97) ? s(`${companyName(rng)} - ${cvrNumber(rng)}`) : { kind: "shared-rich", runs: [companyName(rng), " (ny)"], phonetic: "ニ" },
    rng.chance(0.9) ? s(rng.pick(branches)) : null,
  ]);
  return buildRaw({
    sheets: [{ name: "Medlemsliste", dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("TAXPAYER_ID"), s("FIRMANAVN_CVR"), s("branchetekst")], ...data]) }],
  });
};

/** A supplier CVR as exported: 60% number, 20% `DK-` prefixed text, 20% numeric text. */
const leverandoerCvr = (rng: Rng, cvr: number): number | string => {
  if (rng.chance(0.6)) return cvr;
  return rng.chance(0.5) ? `DK-${cvr}` : `${cvr}`;
};

const leverandoer = async (rng: Rng): Promise<Uint8Array> => {
  const wb = newExcelWorkbook();
  const ws = wb.addWorksheet("Ark1");
  ws.addRow(["Leverandør", "CVR. nr.", "Kontakt"]);
  for (let i = 0; i < 120; i++) {
    const cvr = cvrNumber(rng);
    ws.addRow([companyName(rng), leverandoerCvr(rng, cvr), rng.chance(0.5) ? rng.pick(MANAGERS) : null]);
  }
  ws.addRow([]);
  ws.addRow([null, null, null]);
  return excelBytes(wb);
};

const tivoli = async (rng: Rng): Promise<Uint8Array> => {
  const wb = newExcelWorkbook();
  const ws = wb.addWorksheet("Ark1");
  ws.addRow(["Virksomhed", "Medlemstype", "Indmeldt"]);
  for (let i = 0; i < 200; i++) {
    const nameCell: ExcelJS.CellValue = rng.chance(0.1)
      ? { richText: [{ text: rng.pick(WORDS), font: { bold: true } }, { text: ` ${rng.pick(SUFFIXES)}` }] }
      : companyName(rng);
    const row = ws.addRow([nameCell, rng.pick(["Guld", "Sølv", "Bronze"]), new Date(Date.UTC(rng.int(2010, 2025), rng.int(0, 11), rng.int(1, 28)))]);
    row.getCell(3).numFmt = "dd-mm-yyyy";
  }
  return excelBytes(wb);
};

const fck = (rng: Rng): Promise<Uint8Array> => {
  const data = Array.from({ length: 80 }, (): readonly (RawCell | null)[] => [
    s(companyName(rng)),
    s(rng.pick(["Partner", "Hovedpartner", "Leverandør"])),
    rng.chance(0.3) ? n(rng.int(2018, 2026)) : null,
  ]);
  return buildRaw({
    compression: "STORE",
    sheets: [{ name: "Sheet1", dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("Virksomhed"), s("Kategori"), s("Siden")], ...data]) }],
  });
};

const itBranchen = (rng: Rng): Promise<Uint8Array> => {
  const data = Array.from({ length: 150 }, (): readonly (RawCell | null)[] => [s(companyName(rng)), s(`https://www.example-${rng.int(1, 999)}.dk`)]);
  return buildRaw({
    sheets: [
      { name: "Forside", dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("IT-Branchen medlemsliste")]]) },
      {
        name: "Medlemmer",
        dimension: { kind: "auto" },
        rows: rowsFrom(1, [[s("Virksomhed"), s("Hjemmeside")], ...data]),
        hyperlinks: Array.from({ length: 10 }, (_, i) => ({ ref: `B${i + 2}`, target: `https://www.example-${i}.dk/` })),
      },
    ],
  });
};

const globalConnect = async (rng: Rng): Promise<Uint8Array> => {
  const wb = newExcelWorkbook();
  const ws = wb.addWorksheet("QUERY_FOR_COPY OF KUNDELISTE SM");
  ws.addTable({
    name: "Kundeliste",
    ref: "A1",
    headerRow: true,
    columns: [{ name: "Legal Account Name" }, { name: "CVR" }, { name: "AM hos 3Business" }],
    rows: Array.from({ length: 250 }, () => [
      companyName(rng),
      rng.chance(0.85) ? cvrNumber(rng) : String(cvrNumber(rng)),
      rng.chance(0.8) ? rng.pick(MANAGERS) : "",
    ]),
  });
  return excelBytes(wb);
};

const SOURCE_BUILDERS: Readonly<Record<SourceShape, (rng: Rng) => Promise<Uint8Array>>> = {
  scoringsmodel,
  gamleKunder,
  tabte,
  danskErhverv,
  leverandoer,
  tivoli,
  fck,
  itBranchen,
  globalConnect,
};

/** The nine non-master source workbooks, each built from its own seed-derived stream. */
export const syntheticSources = async (seed: number): Promise<Readonly<Record<SourceShape, Uint8Array>>> => {
  const built = await Promise.all(
    SOURCE_SHAPES.map(async (shape, i) => [shape, await SOURCE_BUILDERS[shape](seededRng(seed * 31 + i))] as const),
  );
  return Object.fromEntries(built) as Record<SourceShape, Uint8Array>;
};

const cellText = z.string().nullable();
const cellTextOrNumber = z.union([z.string(), z.number()]).nullable();

/** How production reads each source (fugue-dags `lib/sources.ts`), plus sweep reads. */
const SOURCE_READS: Readonly<Record<SourceShape, readonly FixtureRead[]>> = {
  scoringsmodel: [
    read("weights", { sheet: "1. Signaler & vægte", headerRow: 4 }, rows(15)),
    read(
      "weights schema",
      { sheet: "1. Signaler & vægte", headerRow: 4 },
      rows(15),
      z.object({ "#": cellTextOrNumber, Signal: cellText, "Foreslået vægt": cellTextOrNumber, "Din vægt (juster)": cellTextOrNumber }),
    ),
    read("scaling", { sheet: "2. Skalering" }, rows(3)),
    read("title row as header", { sheet: 1 }, rows(15)),
  ],
  gamleKunder: [read("first sheet", {}, rows(250))],
  tabte: [
    read("named data sheet", { sheet: "Salgsmuligheder" }, rows(400)),
    read("hidden first sheet", { sheet: 1 }, rows(1)),
    read(
      "lost-opportunity schema",
      { sheet: "Salgsmuligheder" },
      rows(400),
      z.object({
        Topic: cellText,
        "CVR-nummer (Account) (Account)": cellTextOrNumber,
        "Potential Customer": cellText,
        "Actual Close Date": z.union([z.string(), z.number(), z.date()]).nullable(),
        "Anslået CCV": cellTextOrNumber,
      }),
    ),
  ],
  danskErhverv: [read("first sheet", {}, rows(1000))],
  leverandoer: [read("Ark1", { sheet: "Ark1" }, rows(120))],
  tivoli: [read("Ark1", { sheet: "Ark1" }, rows(200))],
  fck: [read("Sheet1 (stored, uncompressed)", { sheet: "Sheet1" }, rows(80))],
  itBranchen: [read("Medlemmer", { sheet: "Medlemmer" }, rows(150)), read("cover sheet", { sheet: "Forside" }, rows(0))],
  globalConnect: [read("Power Query table sheet", { sheet: "QUERY_FOR_COPY OF KUNDELISTE SM" }, rows(250))],
};

// ════════════════════════════════════════════════════════════════════════════
// Edge-case matrix
// ════════════════════════════════════════════════════════════════════════════

/** One matrix row per edge case: a label in A, the case's cell in B, an optional extra cell in C. */
const MATRIX: readonly (readonly [string, RawCell, RawCell?])[] = [
  ["integer", n(42)],
  ["float", n(250.5)],
  ["negative", n(-17.25)],
  ["exponent literal", { kind: "number", value: 0.0015, literal: "1.5E-3" }],
  ["negative zero", { kind: "number", value: -0, literal: "-0" }],
  ["huge", { kind: "number", value: 1e21, literal: "1E+21" }],
  ["long fraction", { kind: "number", value: 0.1 + 0.2, literal: "0.30000000000000004" }],
  ["leading-zero text", s("00123")],
  ["bool true", { kind: "bool", value: true }],
  ["bool false", { kind: "bool", value: false }],
  ["xml entities", s(`a & b < c > d "q" 'a'`)],
  ["padded text", s("  padded  ")],
  ["empty shared string", s(""), s("keeps row")],
  ["danish", s("æøå ÆØÅ — Søndergård")],
  ["rich text", { kind: "shared-rich", runs: ["Rich", " ", "Text"] }],
  ["rich text + phonetic", { kind: "shared-rich", runs: ["漢", "字"], phonetic: "かんじ" }],
  ["escape CR", s("line_x000D_break")],
  ["escape letter", s("_x0041_BC")],
  ["escaped underscore", s("_x005F_x0041_")],
  ["lowercase hex escape", s("caf_x00e9_")],
  ["not an escape", s("_x12_ and _xZZZZ_")],
  ["inline string", { kind: "inline", text: "inline value" }],
  ["inline rich", { kind: "inline-rich", runs: ["in", "line"] }],
  ["inline escape", { kind: "inline", text: "tab_x0009_here" }],
  ["formula number", { kind: "number", value: 2, formula: f("1+1") }],
  ["formula string", { kind: "formula-str", formula: f(`"a"&"b"`), cached: "ab" }],
  ["formula string escape", { kind: "formula-str", formula: f(`CHAR(13)`), cached: "x_x000D_y" }],
  ["formula bool", { kind: "bool", value: true, formula: f("1=1") }],
  ["formula error", { kind: "error", code: "#DIV/0!", formula: f("1/0") }],
  ["formula uncached", { kind: "formula-uncached", formula: f("NOW()") }],
  ["shared formula master", { kind: "number", value: 84, formula: { kind: "shared-master", si: 0, ref: "B44:B45", text: "B25*42" } }],
  ["shared formula child", { kind: "number", value: 85, formula: { kind: "shared-child", si: 0 } }],
  ["array formula", { kind: "number", value: 9, formula: { kind: "array", ref: "B46", text: "SUM(B1:B3*1)" } }],
  ...ERROR_CODES.map((code): readonly [string, RawCell] => [`error ${code}`, { kind: "error", code }]),
  ["date serial 0", n(0, "date-14")],
  ["date serial 1", n(1, "date-14")],
  ["date serial 59", n(59, "date-14")],
  ["date serial 60 (phantom 1900-02-29)", n(60, "date-14")],
  ["date serial 61", n(61, "date-14")],
  ["date 2025-02-12", n(45700, "date-14")],
  ["datetime builtin 22", n(45700.75, "datetime-22")],
  ["DST gap Copenhagen 2024-03-31 02:30", n(45382.104166666664, "datetime-22")],
  ["DST overlap Copenhagen 2024-10-27 02:30", n(45592.104166666664, "datetime-22")],
  ["time only builtin 21", n(0.5, "time-21")],
  ["elapsed builtin 46", n(1.75, "elapsed-46")],
  ["max date", n(2958465.999988426, "datetime-iso")],
  ["custom dd/mm/yyyy", n(44197, "date-dmy")],
  ["custom iso datetime", n(44197.123456, "datetime-iso")],
  ["custom locale long date", n(44561, "date-da-long")],
  ["custom mmm-yy", n(44561, "month-year")],
  ["custom [h]:mm", n(1.25, "elapsed-hours")],
  ["non-date kroner", n(1234.5, "kroner")],
  ["non-date colored", n(-3.5, "colored")],
  ["non-date quoted Day", n(7, "quoted-day")],
  ["non-date scientific", n(12345.678, "scientific")],
  ["non-date percent", n(0.25, "percent-10")],
  ["non-date money", n(99.99, "money-4")],
  ["text format number", n(5, "text-49")],
  ["date-styled text", s("not a date", "date-14")],
  ["styled blank", { kind: "styled-blank", style: "date-14" }],
  ["hyperlink text", s("Fugue docs")],
];

const MATRIX_FIRST_ROW = 2;

const matrixSheet = (): RawSheet => ({
  name: "Matrix",
  dimension: { kind: "auto" },
  rows: [
    ...rowsFrom(1, [[s("Case"), s("Value"), s("Extra")]]),
    ...rowsFrom(
      MATRIX_FIRST_ROW,
      MATRIX.map(([label, value, extra]) => [s(label), value, extra ?? null]),
    ),
  ],
  hyperlinks: [{ ref: `B${MATRIX_FIRST_ROW + MATRIX.length - 1}`, target: "https://example.com/fugue?a=1&b=2" }],
});

/**
 * Missing `r` attributes, row/column gaps, empty and all-error rows. Under a
 * too-small `<dimension>` SheetJS truncates to the declared range; with no
 * `<dimension>` every observed cell counts — both variants are compared.
 */
const sparseSheet = (name: string, dimension: Dimension): RawSheet => ({
  name,
  dimension,
  rows: [
    { r: 1, cells: at(s("Id"), s("Name"), null, s("Score"), s("Tail")) },
    { r: "implicit", cells: [{ col: "implicit", cell: n(1) }, { col: "implicit", cell: s("implicit cols") }] },
    { r: "implicit", cells: [{ col: 0, cell: n(2) }, { col: "implicit", cell: s("after explicit") }, { col: 3, cell: n(9) }] },
    { r: 5, cells: [] },
    { r: 6, cells: at({ kind: "error", code: "#REF!" }, { kind: "error", code: "#N/A" }) },
    { r: 7, cells: at(s(""), { kind: "inline", text: "" }) },
    { r: 9, cells: [{ col: 3, cell: n(4) }, { col: "implicit", cell: s("tail implicit") }] },
    { r: "implicit", cells: at(n(10), null, null, null, s("far right")) },
    { r: 12, cells: [{ col: 4, cell: s("E12 beyond dimension") }, { col: 0, cell: n(12) }] },
  ],
});

const headersSheet = (): RawSheet => ({
  name: "Headers",
  dimension: { kind: "auto" },
  rows: rowsFrom(1, [
    [
      s("  Name  "),
      null,
      n(2024),
      n(45292, "date-14"),
      { kind: "bool", value: true },
      { kind: "shared-rich", runs: ["Rich", "Head"] },
      { kind: "error", code: "#N/A" },
      s("__proto__"),
      s("constructor"),
      s("hasOwnProperty"),
      s("   "),
      { kind: "inline", text: "Inline head" },
    ],
    [s("a"), s("hidden"), n(1), n(2), n(3), n(4), n(5), s("p"), s("c"), s("h"), s("blank head"), s("i")],
    [s("b"), null, null, null, null, null, s("only under error header")],
  ]),
});

const titleSheet = (): RawSheet => ({
  name: "Title",
  dimension: { kind: "auto" },
  merges: ["A1:C1"],
  rows: rowsFrom(1, [[s("Quarterly report")], [], [s("customerId"), s("revenue")], [s("c-1"), n(100)], [s("c-2"), n(250.5)]]),
});

const edgeSheets = (): readonly RawSheet[] => [
  matrixSheet(),
  sparseSheet("Sparse", { kind: "fixed", ref: "A1:B2" }),
  headersSheet(),
  { name: "DupHeaders", dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("A"), s("B"), s("A")], [n(1), n(2), n(3)]]) },
  { name: "Empty", dimension: { kind: "fixed", ref: "A1" }, rows: [] },
  { name: "HeaderOnly", dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("x"), s("y")]]) },
  {
    name: "Oversized",
    dimension: { kind: "fixed", ref: "A1:Z500" },
    rows: rowsFrom(1, [[s("k"), s("v")], [s("one"), n(1)], [s("two"), n(2)]]),
  },
  { name: "NoDimension", dimension: { kind: "none" }, rows: rowsFrom(1, [[s("k"), s("v")], [s("a"), n(1)], [], [s("b"), n(2)]]) },
  { name: "Hidden", hidden: true, dimension: { kind: "auto" }, rows: rowsFrom(1, [[s("secret")], [s("value")]]) },
  titleSheet(),
  sparseSheet("SparseNoDimension", { kind: "none" }),
];

/**
 * The edge-case matrix workbook: formulas, rich text, hyperlinks, dates (built-in
 * and custom formats, serial ≤ 60), errors, `_xHHHH_`, inline and formula strings,
 * sparse `r` attributes, wrong `<dimension>`, blank and duplicate headers, many
 * sheets. `date1904: true` gives the 1904-date-system variant of the same cells.
 */
export const edgeCaseWorkbook = (opts: { readonly date1904?: boolean } = {}): Promise<Uint8Array> =>
  buildRaw({ sheets: edgeSheets(), date1904: opts.date1904 ?? false });

const MatrixStrict = z.object({ Case: z.string(), Value: z.number() });

const edgeReads = (): readonly FixtureRead[] => [
  read("Matrix", { sheet: "Matrix" }, rows(MATRIX.length - 2)),
  read("default first sheet", {}, rows(MATRIX.length - 2)),
  read("Matrix by index", { sheet: 1 }, rows(MATRIX.length - 2)),
  read("Matrix strict schema → validation error", { sheet: "Matrix" }, invalid, MatrixStrict),
  read("Matrix passthrough schema", { sheet: "Matrix" }, rows(MATRIX.length - 2), z.object({ Case: z.string() }).passthrough()),
  read("Matrix value column as header row", { sheet: "Matrix", headerRow: 2 }, rows(10)),
  read("Sparse", { sheet: "Sparse" }, rows(1)),
  read("Sparse by index", { sheet: 2 }, rows(1)),
  read("Sparse without dimension", { sheet: "SparseNoDimension" }, rows(5)),
  read("Headers", { sheet: "Headers" }, rows(2)),
  read("DupHeaders", { sheet: "DupHeaders" }, crash),
  read("Empty", { sheet: "Empty" }, rows(0)),
  read("HeaderOnly", { sheet: "HeaderOnly" }, rows(0)),
  read("Oversized dimension", { sheet: "Oversized" }, rows(2)),
  read("NoDimension", { sheet: "NoDimension" }, rows(2)),
  read("Hidden", { sheet: "Hidden" }, rows(1)),
  read("Title @ header row 3", { sheet: "Title", headerRow: 3 }, rows(2)),
  read("Title @ header row 1", { sheet: "Title" }, rows(1)),
  read("header row past the data", { sheet: "Title", headerRow: 40 }, rows(0)),
  read("missing sheet name", { sheet: "Nope" }, crash),
  read("index past the last sheet", { sheet: 99 }, crash),
  read("index 0", { sheet: 0 }, crash),
];

// ════════════════════════════════════════════════════════════════════════════
// The fixtures the existing xlsx tests build (xlsx.test.ts, date-group-item.test.ts,
// end-to-end.test.ts), rebuilt the same way: ExcelJS's own archive, not re-zipped,
// so their content is deterministic but their entry dates are wall-clock.
// ════════════════════════════════════════════════════════════════════════════

const RowSchema = z.object({ customerId: z.string(), revenue: z.number() });

const makeXlsx = async (
  data: ReadonlyArray<ReadonlyArray<string | number | null>>,
  opts: { readonly sheetName?: string; readonly headerRow?: ReadonlyArray<string> } = {},
): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? "Sheet1");
  ws.addRow([...(opts.headerRow ?? ["customerId", "revenue"])]);
  for (const r of data) ws.addRow([...r]);
  return writeExcel(wb);
};

const excelRows = async (sheets: readonly { readonly name: string; readonly rows: readonly (readonly ExcelJS.CellValue[])[] }[]): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    for (const r of sh.rows) ws.addRow([...r]);
  }
  return writeExcel(wb);
};

const dateGroupFixture = async (
  filtersInner = '<dateGroupItem year="2023" dateTimeGrouping="year"/><dateGroupItem year="2024" month="2" dateTimeGrouping="month"/>',
): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  ws.addTable({
    name: "Export",
    ref: "A1",
    headerRow: true,
    columns: [{ name: "Topic", filterButton: true }, { name: "CloseDate", filterButton: true }],
    rows: [
      ["Nysalg", 45700],
      ["Delesag", 45800],
    ],
  });
  const zip = await JSZip.loadAsync(await writeExcel(wb));
  const tableFile = zip.file(/^xl\/tables\/.*\.xml$/)[0];
  if (tableFile === undefined) throw new Error("fixture bug: no table XML emitted");
  const xml = await tableFile.async("string");
  const withFilter = xml.replace(/<filterColumn colId="1"[^>]*\/>/, `<filterColumn colId="1"><filters>${filtersInner}</filters></filterColumn>`);
  if (withFilter === xml) throw new Error("fixture bug: filterColumn not found in table XML");
  zip.file(tableFile.name, withFilter);
  return zip.generateAsync({ type: "uint8array" });
};

const errorCellFixture = async (): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["customerId", "revenue"]);
  const row = ws.addRow(["c-1", null]);
  row.getCell(2).value = { error: "#REF!" } as unknown as ExcelJS.CellValue;
  return writeExcel(wb);
};

/** Existing fixtures for row reading, sheet selection and failure outcomes. */
const existingReadFixtures = async (): Promise<readonly FixtureCase[]> => [
  {
    name: "existing: happy path",
    bytes: await makeXlsx([["c-1", 100], ["c-2", 250.5]]),
    reads: [read("any row", {}, rows(2)), read("RowSchema", {}, rows(2), RowSchema)],
  },
  {
    name: "existing: fully-blank row skipped",
    bytes: await makeXlsx([["c-1", 10], [null, null], ["c-2", 20]]),
    reads: [read("any row", {}, rows(2)), read("RowSchema", {}, rows(2), RowSchema)],
  },
  {
    name: "existing: sheet by name",
    bytes: await makeXlsx([["c-9", 9]], { sheetName: "Data" }),
    reads: [read("by name", { sheet: "Data" }, rows(1), RowSchema), read("by index", { sheet: 1 }, rows(1)), read("default", {}, rows(1))],
  },
  {
    name: "existing: schema violation",
    bytes: await makeXlsx([["c-1", 100], ["c-2", "not-a-number"]]),
    reads: [read("RowSchema", {}, invalid, RowSchema), read("any row", {}, rows(2))],
  },
  {
    name: "existing: non-workbook bytes",
    bytes: new Uint8Array([1, 2, 3, 4]),
    reads: [read("any row", {}, crash)],
  },
  {
    name: "existing: absent worksheet",
    bytes: await makeXlsx([["c-1", 1]]),
    reads: [read("missing name", { sheet: "Missing" }, crash, RowSchema)],
  },
];

/** Existing fixtures for error cells and header handling (hostile, offset, duplicate, blank). */
const existingHeaderFixtures = async (): Promise<readonly FixtureCase[]> => [
  {
    name: "existing: error cell mixed with values",
    bytes: await errorCellFixture(),
    reads: [
      read("strict", {}, invalid, RowSchema),
      read("nullable", {}, rows(1), z.object({ customerId: z.string(), revenue: z.number().nullable() })),
      read("any row", {}, rows(1)),
    ],
  },
  {
    name: "existing: hostile __proto__/constructor headers",
    bytes: await makeXlsx([["c-1", 100, "EVIL", "EVIL2"]], { headerRow: ["customerId", "revenue", "__proto__", "constructor"] }),
    reads: [read("passthrough", {}, rows(1), RowSchema.passthrough()), read("any row", {}, rows(1))],
  },
  {
    name: "existing: custom header row",
    bytes: await excelRows([{ name: "Sheet1", rows: [["Quarterly Revenue Report"], ["customerId", "revenue"], ["c-1", 100]] }]),
    reads: [read("headerRow 2", { headerRow: 2 }, rows(1), RowSchema), read("headerRow 1", {}, rows(2))],
  },
  {
    name: "existing: sheet by numeric index",
    bytes: await excelRows([
      { name: "First", rows: [["customerId", "revenue"], ["wrong", 1]] },
      { name: "Second", rows: [["customerId", "revenue"], ["c-2", 22]] },
    ]),
    reads: [read("index 2", { sheet: 2 }, rows(1), RowSchema), read("index 1", { sheet: 1 }, rows(1), RowSchema)],
  },
  {
    name: "existing: duplicate header",
    bytes: await excelRows([{ name: "Sheet1", rows: [["customerId", "customerId"], ["a", "b"]] }]),
    reads: [read("duplicate", {}, crash, z.object({ customerId: z.string() }))],
  },
  {
    name: "existing: multiple blank headers",
    bytes: await excelRows([{ name: "Sheet1", rows: [["customerId", "revenue", null, null], ["c-1", 5, "ignored", "ignored"]] }]),
    reads: [read("RowSchema", {}, rows(1), RowSchema), read("any row", {}, rows(1))],
  },
];

const DateGroupSchema = z.object({ Topic: z.string(), CloseDate: z.union([z.string(), z.number(), z.date()]).nullable() });

/** Existing fixtures for table autofilter XML and the end-to-end disk workbook. */
const existingTableFixtures = async (): Promise<readonly FixtureCase[]> => [
  {
    name: "existing: dateGroupItem table autofilter",
    bytes: await dateGroupFixture(),
    reads: [read("schema", {}, rows(2), DateGroupSchema), read("any row", {}, rows(2))],
  },
  {
    name: "existing: malformed table XML",
    bytes: await dateGroupFixture('<dateGroupItem year="2023" dateTimeGrouping="year"/>&nope;'),
    reads: [read("schema", {}, rows(2), DateGroupSchema)],
  },
  {
    name: "existing: end-to-end disk workbook",
    bytes: await excelRows([{ name: "Sheet1", rows: [["customerId", "revenue"], ["c-1", 1000], ["c-2", 2500]] }]),
    reads: [read("RowSchema", {}, rows(2), RowSchema)],
  },
];

/** The xlsx package's existing test fixtures, in their original order (built sequentially). */
const existingFixtures = async (): Promise<readonly FixtureCase[]> => [
  ...(await existingReadFixtures()),
  ...(await existingHeaderFixtures()),
  ...(await existingTableFixtures()),
];

/** ExcelJS's own output for every value kind it can write (formula, rich text, hyperlink, error, dates). */
const excelWriterFixture = async (): Promise<Uint8Array> => {
  const wb = newExcelWorkbook();
  const ws = wb.addWorksheet("Writer");
  ws.addRow(["Kind", "Value"]);
  const values: readonly (readonly [string, ExcelJS.CellValue])[] = [
    ["number", 3.14],
    ["string", "plain"],
    ["bool", false],
    ["date", new Date(Date.UTC(2024, 1, 29, 13, 45, 30))],
    ["date midnight", new Date(Date.UTC(1999, 11, 31))],
    ["formula", { formula: "1+2", result: 3 }],
    ["formula string", { formula: `"x"&"y"`, result: "xy" }],
    ["formula date", { formula: "TODAY()", result: new Date(Date.UTC(2026, 10, 9)) }],
    ["rich text", { richText: [{ text: "bold", font: { bold: true } }, { text: " plain" }] }],
    ["hyperlink", { text: "Example", hyperlink: "https://example.com" }],
    ["error", { error: "#N/A" } as unknown as ExcelJS.CellValue],
    ["escape-like", "_x000D_ literal"],
  ];
  for (const [kind, value] of values) ws.addRow([kind, value]);
  const custom = ws.addRow(["custom date fmt", new Date(Date.UTC(2023, 6, 1, 6, 30))]);
  custom.getCell(2).numFmt = "dd.mm.yyyy hh:mm";
  const pct = ws.addRow(["percent", 0.125]);
  pct.getCell(2).numFmt = "0.0%";
  return excelBytes(wb);
};

/**
 * Every fixture the parity gate runs: the existing xlsx test fixtures, the edge
 * matrix (both date systems), ExcelJS writer output, the nine source shapes and
 * the full-size Brancheliste.
 */
export const fixtureCases = async (): Promise<readonly FixtureCase[]> => {
  const SEED = 20261109;
  const [existing, edge, edge1904, writer, sources, master] = await Promise.all([
    existingFixtures(),
    edgeCaseWorkbook(),
    edgeCaseWorkbook({ date1904: true }),
    excelWriterFixture(),
    syntheticSources(SEED),
    syntheticBrancheliste(BRANCHELISTE_ROWS, SEED),
  ]);
  return [
    ...existing,
    { name: "edge-case matrix", bytes: edge, reads: edgeReads() },
    { name: "edge-case matrix (date1904)", bytes: edge1904, reads: edgeReads() },
    { name: "ExcelJS writer output", bytes: writer, reads: [read("Writer", { sheet: "Writer" }, rows(14))] },
    ...SOURCE_SHAPES.map((shape): FixtureCase => ({ name: `source: ${shape}`, bytes: sources[shape], reads: SOURCE_READS[shape] })),
    {
      name: `synthetic Brancheliste (${BRANCHELISTE_ROWS} rows)`,
      bytes: master,
      reads: [
        read("master list", {}, rows(Math.floor(BRANCHELISTE_ROWS * 0.98))),
        read(
          "master schema",
          {},
          rows(Math.floor(BRANCHELISTE_ROWS * 0.98)),
          z.object({
            CVR: z.union([z.string(), z.number()]),
            Firmanavn: cellText,
            TOT_ACTV_SUBS_CNT: cellTextOrNumber,
            PostNr: cellTextOrNumber,
            By: cellText,
            Business_Segment: cellText,
            ACCOUNT_MANAGER: cellText,
            Titler: cellText,
          }),
        ),
      ],
    },
  ];
};

// ════════════════════════════════════════════════════════════════════════════
// Random workbooks — the property: any cell-type mix and addressing agrees.
// ════════════════════════════════════════════════════════════════════════════

const RANDOM_HEADERS = ["id", "name", "amount", "when", "flag", "note", "Id", "näme", "x y", "__proto__", "42"];
const RANDOM_STYLES: readonly StyleName[] = STYLES.map((st) => st.name);

/** Generators for one random cell, picked uniformly; blanks appear twice to keep sheets sparse. */
const RANDOM_CELLS: readonly ((rng: Rng) => RawCell | null)[] = [
  () => null,
  () => null,
  (rng) => n(rng.int(-1000, 100_000) / rng.pick([1, 4, 100])),
  (rng) => n(rng.chance(0.3) ? rng.int(0, 61) : serialWithTime(rng, 0, 60_000), rng.pick(RANDOM_STYLES)),
  (rng) => s(rng.pick([...CITIES, "", " ", "x_x000D_y", "a&b"])),
  (rng) => ({ kind: "inline", text: rng.pick([...WORDS, "", "_x0041_"]) }),
  (rng) => ({ kind: "shared-rich", runs: [rng.pick(WORDS), rng.pick(WORDS)], ...(rng.chance(0.3) ? { phonetic: "ふ" } : {}) }),
  (rng) => ({ kind: "bool", value: rng.chance(0.5) }),
  (rng) => ({ kind: "error", code: rng.pick(ERROR_CODES) }),
  (rng) => ({ kind: "number", value: rng.int(0, 99), formula: f("A1+1"), ...(rng.chance(0.5) ? { style: rng.pick(RANDOM_STYLES) } : {}) }),
  (rng) => ({ kind: "formula-str", formula: f(`"s"`), cached: rng.pick(WORDS) }),
  () => ({ kind: "formula-uncached", formula: f("RAND()") }),
  (rng) => ({ kind: "styled-blank", style: rng.pick(RANDOM_STYLES) }),
  (rng) => ({ kind: "inline-rich", runs: [rng.pick(WORDS), "-", rng.pick(WORDS)] }),
];

const randomCell = (rng: Rng): RawCell | null => rng.pick(RANDOM_CELLS)(rng);

const randomRow = (rng: Rng, cols: number, r: number | "implicit"): RawRow => {
  const cells: PlacedCell[] = [];
  let col = -1;
  for (let c = 0; c < cols; c++) {
    const cell = randomCell(rng);
    if (cell === null) continue;
    // Implicit addressing only when it lands on the intended column; otherwise explicit.
    const implicit = rng.chance(0.2) && c === col + 1;
    cells.push({ col: implicit ? "implicit" : c, cell });
    col = c;
  }
  return { r, cells };
};

/** A header cell: 10% numeric, otherwise a name (6% of them the duplicate `dup`). */
const randomHeaderCell = (rng: Rng, c: number): RawCell => {
  if (rng.chance(0.1)) return n(rng.int(1, 9));
  return s(rng.chance(0.06) ? "dup" : `${rng.pick(RANDOM_HEADERS)}${c}`);
};

/** `<dimension>` variants, picked uniformly: computed, absent, too small, too large. */
const RANDOM_DIMENSIONS: readonly Dimension[] = [
  { kind: "auto" },
  { kind: "none" },
  { kind: "fixed", ref: "A1:B2" },
  { kind: "fixed", ref: "A1:K80" },
];

const randomSheet = (rng: Rng, name: string): { readonly sheet: RawSheet; readonly headerRow: number } => {
  const cols = rng.int(1, 7);
  const headerRow = rng.int(1, 3);
  const header: PlacedCell[] = Array.from({ length: cols }, (_, c) => c).flatMap((c) =>
    rng.chance(0.1) ? [] : [{ col: c, cell: randomHeaderCell(rng, c) }],
  );
  const bodyRows: RawRow[] = [];
  let r = headerRow;
  for (let i = 0, count = rng.int(0, 25); i < count; i++) {
    const gap = rng.chance(0.15) ? rng.int(2, 4) : 1;
    r += gap;
    // Draw order matters for byte stability: overhang roll first, then the implicit-row roll.
    const width = cols + (rng.chance(0.1) ? 2 : 0);
    const rowRef: number | "implicit" = gap === 1 && rng.chance(0.2) ? "implicit" : r;
    bodyRows.push(randomRow(rng, width, rowRef));
  }
  const preamble: RawRow[] = Array.from({ length: headerRow - 1 }, (_, i) => ({ r: i + 1, cells: rng.chance(0.5) ? at(s("title")) : [] }));
  // `pick` over four entries draws `int(0, 3)`: the same single RNG step as a direct roll.
  const dimension = rng.pick(RANDOM_DIMENSIONS);
  return { sheet: { name, dimension, rows: [...preamble, { r: headerRow, cells: header }, ...bodyRows] }, headerRow };
};

/** A random workbook (1–3 sheets, random date system and compression) with reads covering every sheet. */
export const randomWorkbook = async (seed: number): Promise<RandomCase> => {
  const rng = seededRng(seed);
  const generated = Array.from({ length: rng.int(1, 3) }, (_, i) => randomSheet(rng, `S${i + 1}${rng.chance(0.3) ? " æ" : ""}`));
  const bytes = await buildRaw({
    sheets: generated.map((g) => g.sheet),
    date1904: rng.chance(0.3),
    compression: rng.chance(0.2) ? "STORE" : "DEFLATE",
  });
  const reads: readonly ParityRead[] = generated.flatMap((g, i) => [
    { label: `${g.sheet.name} @ header ${g.headerRow}`, opts: { sheet: g.sheet.name, headerRow: g.headerRow }, schema: anyRow },
    { label: `index ${i + 1} @ header 1`, opts: { sheet: i + 1 }, schema: anyRow },
  ]);
  return { name: `random-${seed}`, bytes, reads };
};
