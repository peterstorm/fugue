/**
 * Cell-value semantics of the streaming reader, proven against SheetJS 0.18.5
 * (`XLSX.read(buf, { type: "buffer", cellDates: true })`), the frozen reference:
 *
 * - `serialToDate` is the SheetJS `numdate` port (local time zone, the 1900
 *   leap-year off-by-one for serials ≤ 60, and — like SheetJS — no 1904 shift).
 * - `decodeXmlEscapes` round-trips `_xHHHH_` escapes.
 * - `isDateFormat` agrees with `SSF.is_date`, and the built-in date ids table.
 * - `decodeCell` per cell type, and AS-014 end to end through `parseWorkbook`.
 *
 * Workbooks here are hand-built XML zipped with fflate, so each raw cell shape is
 * exactly what the test says it is.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { z } from "zod";
import { decodeCell, decodeXmlEscapes, serialToDate } from "../cell-value.js";
import { builtinNumberFormat, isDateFormat } from "../styles.js";
import { parseWorkbook } from "../index.js";

// ── tiny hand-built workbook ────────────────────────────────────────────────

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

interface RawBook {
  readonly sheetData: string; // inner XML of <sheetData>
  readonly dimension?: string;
  readonly afterSheetData?: string;
  readonly sharedStrings?: readonly string[]; // inner XML of each <si>
  readonly numFmts?: Readonly<Record<number, string>>;
  readonly cellXfs?: readonly number[]; // numFmtId per xf index
  readonly date1904?: boolean;
}

const xmlAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const buildBook = (b: RawBook): Uint8Array => {
  const sst = b.sharedStrings;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        (sst ? `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` : "") +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS} ${RNS}>` +
        (b.date1904 ? `<workbookPr date1904="1"/>` : `<workbookPr/>`) +
        `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        (sst ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : "") +
        `</Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}>` +
        (b.numFmts
          ? `<numFmts count="${Object.keys(b.numFmts).length}">` +
            Object.entries(b.numFmts)
              .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlAttr(code)}"/>`)
              .join("") +
            `</numFmts>`
          : "") +
        `<cellXfs count="${(b.cellXfs ?? [0]).length}">` +
        (b.cellXfs ?? [0]).map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`).join("") +
        `</cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS} ${RNS}>` +
        (b.dimension ? `<dimension ref="${b.dimension}"/>` : "") +
        `<sheetData>${b.sheetData}</sheetData>${b.afterSheetData ?? ""}</worksheet>`,
    ),
  };
  if (sst) {
    files["xl/sharedStrings.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="${sst.length}" uniqueCount="${sst.length}">` +
        sst.map((si) => `<si>${si}</si>`).join("") +
        `</sst>`,
    );
  }
  return zipSync(files);
};

/** SheetJS cell at A<row> of the first sheet, read exactly as the old parser did. */
const sheetjsCells = (bytes: Uint8Array): Record<string, XLSX.CellObject> => {
  const wb = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  return wb.Sheets[wb.SheetNames[0]!] as unknown as Record<string, XLSX.CellObject>;
};

const serialColumn = (serials: readonly number[], numFmtId: number, date1904 = false): Uint8Array =>
  buildBook({
    date1904,
    cellXfs: [0, numFmtId],
    sharedStrings: ["<t>d</t>"],
    sheetData:
      `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
      serials.map((s, i) => `<row r="${i + 2}"><c r="A${i + 2}" s="1"><v>${s}</v></c></row>`).join(""),
  });

// ── serialToDate ≡ SheetJS numdate ───────────────────────────────────────────

describe("serialToDate — SheetJS numdate port", () => {
  const serials = fc.oneof(
    fc.integer({ min: -100, max: 100 }), // the ≤ 60 leap-year-bug region and below zero
    fc.integer({ min: 0, max: 2958465 }),
    fc.double({ min: 0, max: 2958465, noNaN: true, noDefaultInfinity: true }),
  );

  it("matches SheetJS for random serials in the 1900 date system", () => {
    fc.assert(
      fc.property(fc.array(serials, { minLength: 1, maxLength: 40 }), (xs) => {
        const cells = sheetjsCells(serialColumn(xs, 14));
        xs.forEach((serial, i) => {
          const ref = cells[`A${i + 2}`];
          expect(ref?.t).toBe("d");
          expect(serialToDate(serial).getTime()).toBe((ref!.v as Date).getTime());
        });
      }),
      { numRuns: 30 },
    );
  });

  it("matches SheetJS for date1904 workbooks too (SheetJS applies no 1904 shift to Date values)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(serials, { minLength: 1, maxLength: 20 }), async (xs) => {
        const bytes = serialColumn(xs, 22, true);
        const cells = sheetjsCells(bytes);
        const parsed = await parseWorkbook(bytes, z.object({ d: z.date() }));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
        expect(parsed.value.rows.map((r) => r.d.getTime())).toEqual(
          xs.map((_, i) => (cells[`A${i + 2}`]!.v as Date).getTime()),
        );
      }),
      { numRuns: 15 },
    );
  });

  it("keeps the 1900 leap-year off-by-one for serials ≤ 60 exactly as SheetJS does", () => {
    const xs = [0, 1, 59, 60, 61];
    const cells = sheetjsCells(serialColumn(xs, 14));
    xs.forEach((s, i) => expect(serialToDate(s).getTime()).toBe((cells[`A${i + 2}`]!.v as Date).getTime()));
  });
});

// ── _xHHHH_ escapes ──────────────────────────────────────────────────────────

const escapeAll = (s: string): string =>
  Array.from({ length: s.length }, (_, i) => `_x${s.charCodeAt(i).toString(16).padStart(4, "0")}_`).join("");

describe("decodeXmlEscapes", () => {
  it("round-trips any string encoded entirely as _xHHHH_ code units", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => decodeXmlEscapes(escapeAll(s)) === s));
  });

  it("leaves strings without an _xHHHH_ sequence unchanged", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/_x[\da-f]{4}_/i.test(s)),
        (s) => decodeXmlEscapes(s) === s,
      ),
    );
  });

  it("decodes left to right without re-scanning decoded output, case-insensitively like SheetJS", () => {
    expect(decodeXmlEscapes("_x005F_x0041_")).toBe("_x0041_");
    expect(decodeXmlEscapes("a_x000d_b_X0041_")).toBe("a\rbA");
    expect(decodeXmlEscapes("_x00e6_")).toBe("æ");
    expect(decodeXmlEscapes("_x12_ _xZZZZ_")).toBe("_x12_ _xZZZZ_");
  });
});

// ── number-format date detection ─────────────────────────────────────────────

describe("isDateFormat — SSF.is_date port and built-in id table", () => {
  const DATE_IDS = new Set([
    ...[14, 15, 16, 17, 18, 19, 20, 21, 22],
    ...[27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
    ...[45, 46, 47],
    ...[50, 51, 52, 53, 54, 55, 56, 57, 58],
    ...[71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81],
  ]);

  it("classifies every built-in number format id 0..163 like SheetJS", () => {
    for (let id = 0; id < 164; id++) {
      expect([id, isDateFormat(builtinNumberFormat(id))]).toEqual([id, DATE_IDS.has(id)]);
    }
  });

  it("agrees with SheetJS SSF.is_date on arbitrary format strings", () => {
    const chars = fc.constantFrom(..."0#?.,;E+-%@*_\\\"[]()/: GgeneralAaMmDdYyHhSsBb12$€Red".split(""));
    fc.assert(
      fc.property(fc.array(chars, { maxLength: 24 }), (cs) => {
        const fmt = cs.join("");
        expect([fmt, isDateFormat(fmt)]).toEqual([fmt, XLSX.SSF.is_date(fmt)]);
      }),
      { numRuns: 2000 },
    );
  });

  it("recognizes common custom date formats and rejects number formats", () => {
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("[h]:mm")).toBe(true);
    expect(isDateFormat("dd/mm/yyyy hh:mm")).toBe(true);
    expect(isDateFormat("General")).toBe(false);
    expect(isDateFormat("#,##0.00")).toBe(false);
    expect(isDateFormat('"d"0')).toBe(false);
    expect(isDateFormat("[Red]0.0")).toBe(false);
  });
});

// ── decodeCell per type ──────────────────────────────────────────────────────

describe("decodeCell", () => {
  const ctx = {
    sst: ["zero", "one", null] as const,
    isDateStyle: (s: string | undefined) => s === "1",
  };
  const raw = (over: Partial<Parameters<typeof decodeCell>[0]>) =>
    decodeCell({ t: undefined, v: undefined, inline: undefined, style: undefined, ...over }, ctx);

  it("skips a cell with neither type nor value (an empty styled cell)", () => {
    expect(raw({ style: "1" })).toEqual({ kind: "skip" });
  });

  it("numbers parse with parseFloat; an empty explicit number cell is skipped", () => {
    expect(raw({ v: "2.5" })).toEqual({ kind: "value", value: 2.5 });
    expect(raw({ t: "n" })).toEqual({ kind: "skip" });
  });

  it("date-styled numbers become Date via serialToDate", () => {
    expect(raw({ v: "45000", style: "1" })).toEqual({ kind: "value", value: serialToDate(45000) });
  });

  it("shared strings resolve by index; a null entry is null; an out-of-range index is a failure", () => {
    expect(raw({ t: "s", v: "1" })).toEqual({ kind: "value", value: "one" });
    expect(raw({ t: "s", v: "2" })).toEqual({ kind: "value", value: null });
    expect(raw({ t: "s", v: "9" })).toEqual({ kind: "bad-shared-string", index: "9" });
    expect(raw({ t: "s" })).toEqual({ kind: "skip" });
  });

  it("formula strings, inline strings, booleans and errors", () => {
    expect(raw({ t: "str", v: "a_x0041_" })).toEqual({ kind: "value", value: "aA" });
    expect(raw({ t: "str" })).toEqual({ kind: "value", value: "" });
    expect(raw({ t: "inlineStr", inline: "inl" })).toEqual({ kind: "value", value: "inl" });
    expect(raw({ t: "inlineStr" })).toEqual({ kind: "value", value: "" });
    expect(raw({ t: "b", v: "1" })).toEqual({ kind: "value", value: true });
    expect(raw({ t: "b", v: "0" })).toEqual({ kind: "value", value: false });
    expect(raw({ t: "b" })).toEqual({ kind: "value", value: false });
    expect(raw({ t: "e", v: "#REF!" })).toEqual({ kind: "value", value: null });
  });
});

// ── worksheet addressing (SheetJS's cell-keyed map, streamed) ───────────────

describe("worksheet addressing", () => {
  const Loose = z.record(z.string(), z.unknown());
  const header = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`;
  const book = (sheetData: string, dimension?: string): Uint8Array =>
    buildBook({ sharedStrings: ["<t>a</t>", "<t>b</t>"], sheetData: header + sheetData, ...(dimension ? { dimension } : {}) });

  /** The old parser's view: the SheetJS value at an address (error → null, missing → null). */
  const sheetjsRows = (bytes: Uint8Array, rows: readonly number[]) => {
    const cells = sheetjsCells(bytes);
    const at = (addr: string): unknown => {
      const c = cells[addr];
      return c === undefined || c.t === "e" ? null : (c.v ?? null);
    };
    return rows.map((r) => ({ a: at(`A${r}`), b: at(`B${r}`) }));
  };

  it("places a cell under its own r even when the enclosing <row> is numbered differently", async () => {
    // SheetJS skips the self-closing <row/> without counting it, so the next
    // implicit row element is row 2 — but its cells say they are row 3.
    const bytes = book(`<row/><row><c r="A3"><v>7</v></c><c r="B3"><v>8</v></c></row><row r="4"><c r="A4"><v>9</v></c></row>`, "A1:B4");
    const r = await parseWorkbook(bytes, Loose);
    expect(r).toEqual({ ok: true, value: { rows: sheetjsRows(bytes, [3, 4]) } });
    expect(r.ok && r.value.rows).toEqual([{ a: 7, b: 8 }, { a: 9, b: null }]);
  });

  it("drops a cell with a non-canonical r, which SheetJS stores under a key it never reads", async () => {
    const bytes = book(`<row r="2"><c r="a2"><v>1</v></c><c r="B2"><v>2</v></c></row>`, "A1:B2");
    const r = await parseWorkbook(bytes, Loose);
    expect(r).toEqual({ ok: true, value: { rows: [{ a: null, b: 2 }] } });
    expect(r.ok && r.value.rows).toEqual(sheetjsRows(bytes, [2]));
  });

  it("without a dimension, drops cells addressed beyond the last row element", async () => {
    const bytes = book(`<row r="2"><c r="A2"><v>1</v></c><c r="B9"><v>2</v></c></row>`);
    const r = await parseWorkbook(bytes, Loose);
    expect(r).toEqual({ ok: true, value: { rows: [{ a: 1, b: null }] } });
    expect(r.ok && r.value.rows).toEqual(sheetjsRows(bytes, [2]));
  });

  it("with a dimension, reads only its columns for headers and its rows for data", async () => {
    const bytes = buildBook({
      sharedStrings: ["<t>a</t>", "<t>b</t>", "<t>c</t>"],
      dimension: "A1:B3",
      sheetData:
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
        `<row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>3</v></c></row>` +
        `<row r="3"><c r="B3"><v>2</v></c></row><row r="4"><c r="A4"><v>4</v></c></row>`,
    });
    expect(await parseWorkbook(bytes, Loose)).toEqual({ ok: true, value: { rows: [{ a: 1, b: null }, { a: null, b: 2 }] } });
  });

  it("merges a repeated row element into the same row, later cells winning", async () => {
    const bytes = book(`<row r="2"><c r="A2"><v>1</v></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>6</v></c></row>`, "A1:B2");
    const r = await parseWorkbook(bytes, Loose);
    expect(r).toEqual({ ok: true, value: { rows: [{ a: 5, b: 6 }] } });
    expect(r.ok && r.value.rows).toEqual(sheetjsRows(bytes, [2]));
  });

  it("a cell addressing a row that was already streamed is a non-retriable node-crash, not a silent difference", async () => {
    const bytes = book(`<row r="5"><c r="A5"><v>1</v></c></row><row r="6"><c r="A2"><v>2</v></c></row>`, "A1:B6");
    const r = await parseWorkbook(bytes, Loose);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "node-crash") {
      expect(r.error.retriability).toBe("non-retriable");
      expect(r.error.message).toContain("unsupported cell order");
    } else throw new Error("expected node-crash");
  });

  it("a shared-string index with no entry is a node-crash", async () => {
    const bytes = book(`<row r="2"><c r="A2" t="s"><v>42</v></c></row>`, "A1:B2");
    const r = await parseWorkbook(bytes, Loose);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("node-crash");
  });
});

// ── AS-014 end to end ────────────────────────────────────────────────────────

describe("AS-014 cell normalization through parseWorkbook", () => {
  const book = buildBook({
    dimension: "A1:I5",
    cellXfs: [0, 14, 164],
    numFmts: { 164: "dd/mm/yyyy" },
    sharedStrings: [
      "<t>num</t>", "<t>formula</t>", "<t>rich</t>", "<t>link</t>", "<t>date</t>",
      "<t>err</t>", "<t>inline</t>", "<t>fstr</t>", "<t>bool</t>",
      '<r><t>Hel</t></r><r><rPr><b/></rPr><t xml:space="preserve">lo</t></r><rPh sb="0" eb="1"><t>ハ</t></rPh><phoneticPr fontId="1"/>',
      "<t>https://example.test</t>",
      "<t>tab_x0009_here</t>",
    ],
    sheetData:
      `<row r="1">${["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((c, i) => `<c r="${c}1" t="s"><v>${i}</v></c>`).join("")}</row>` +
      `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>A2*2</f><v>2</v></c><c r="C2" t="s"><v>9</v></c>` +
      `<c r="D2" t="s"><v>10</v></c><c r="E2" s="1"><v>45000</v></c><c r="F2" t="e"><v>#REF!</v></c>` +
      `<c r="G2" t="inlineStr"><is><t>inl_x0041_</t></is></c><c r="H2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="I2" t="b"><v>1</v></c></row>` +
      `<row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c><c r="B3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>` +
      `<row r="4"><c r="A4" t="s"><v>11</v></c><c r="E4" s="2"><v>45001.5</v></c></row>` +
      `<row r="5"><c r="A5" s="1"/><c r="B5"><f>A1</f></c></row>`,
    afterSheetData: `<hyperlinks><hyperlink ref="D2" location="Sheet1!A1" display="x"/></hyperlinks>`,
  });

  const Row = z.object({
    num: z.union([z.number(), z.string()]).nullable(),
    formula: z.number().nullable(),
    rich: z.string().nullable(),
    link: z.string().nullable(),
    date: z.date().nullable(),
    err: z.null(),
    inline: z.string().nullable(),
    fstr: z.string().nullable(),
    bool: z.boolean().nullable(),
  });

  it("AS-014: formulas give the cached result, rich text and hyperlinks give text, dates stay Date, errors are null, all-error rows are skipped", async () => {
    const r = await parseWorkbook(book, Row);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.rows).toHaveLength(2); // row 3 (only error cells) and row 5 (no values) are skipped
    const [two, four] = r.value.rows;
    expect(two).toEqual({
      num: 1,
      formula: 2,
      rich: "Hello",
      link: "https://example.test",
      date: serialToDate(45000),
      err: null,
      inline: "inlA",
      fstr: "ab",
      bool: true,
    });
    expect(four!.num).toBe("tab\there");
    expect(four!.date).toEqual(serialToDate(45001.5));
  });

  it("AS-014: every decoded value equals the SheetJS 0.18.5 cell value", async () => {
    const cells = sheetjsCells(book);
    const r = await parseWorkbook(book, z.record(z.string(), z.unknown()));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const sheetjs = (addr: string): unknown => {
      const c = cells[addr];
      return c === undefined || c.t === "e" ? null : (c.v ?? null);
    };
    const cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const headers = cols.map((c) => sheetjs(`${c}1`) as string);
    expect(r.value.rows[0]).toEqual(Object.fromEntries(cols.map((c, i) => [headers[i], sheetjs(`${c}2`)])));
    expect(r.value.rows[1]).toEqual(Object.fromEntries(cols.map((c, i) => [headers[i], sheetjs(`${c}4`)])));
  });
});
