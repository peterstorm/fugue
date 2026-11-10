/**
 * The streaming public surface: `openWorkbook` (one load, many sheets),
 * `foldRows` (row streaming with cooperative yielding), `parseWorkbook` as a
 * collecting fold, and `xlsxErrorRow`. Contract scenarios AS-010..AS-013 and
 * AS-017 are pinned here through the real entry points.
 */
import { describe, expect, it } from "bun:test";
import ExcelJS from "exceljs";
import fc from "fast-check";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { FrameworkError } from "@fuguejs/framework";
import { nodeId } from "@fuguejs/framework";
import { foldRows, openWorkbook, parseWorkbook, xlsxErrorRow, type WorkbookHandle } from "../index.js";
import { buildHeaderMap, projectRow } from "../rows.js";
import type { CellValue, DecodeContext } from "../cell-value.js";
import { createSheetReader, parseDimensionRef, rowNumberOf, targetRow, type RowCells, type SheetBounds } from "../sheet-stream.js";
import { parseXml } from "../xml.js";

type Cell = string | number | Date | null;

const makeBook = async (
  sheets: Readonly<Record<string, ReadonlyArray<ReadonlyArray<Cell>>>>,
): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow([...r]);
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
};

const Row = z.object({ id: z.string(), n: z.number() });
type Row = z.infer<typeof Row>;

const open = (bytes: Uint8Array): WorkbookHandle => {
  const r = openWorkbook(bytes);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const collect = <T>(acc: T[], row: T): T[] => {
  acc.push(row);
  return acc;
};

const expectCrash = (r: { ok: boolean; error?: FrameworkError }, fragment?: string): void => {
  expect(r.ok).toBe(false);
  if (r.ok || r.error === undefined) return;
  expect(r.error.kind).toBe("node-crash");
  if (r.error.kind === "node-crash") {
    expect(r.error.retriability).toBe("non-retriable");
    if (fragment !== undefined) expect(r.error.message).toContain(fragment);
  }
};

describe("openWorkbook", () => {
  it("exposes sheet names in workbook order on an opaque, frozen handle", async () => {
    const h = open(await makeBook({ Zeta: [["id", "n"]], Alpha: [["id", "n"]], Mid: [] }));
    expect(h.sheetNames).toEqual(["Zeta", "Alpha", "Mid"]);
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.sheetNames)).toBe(true);
  });

  it("AS-010: non-ZIP bytes give a non-retriable node-crash from openWorkbook and parseWorkbook", async () => {
    const bytes = new TextEncoder().encode("customerId,revenue\nc-1,100\n");
    expectCrash(openWorkbook(bytes));
    expectCrash(await parseWorkbook(bytes, Row));
  });
});

describe("foldRows — one load, many sheets", () => {
  it("one handle serves two sheets without reloading the workbook", async () => {
    const h = open(
      await makeBook({
        Weights: [["id", "n"], ["w-1", 1], ["w-2", 2]],
        Scaling: [["id", "n"], ["s-1", 10]],
      }),
    );
    const weights = await foldRows(h, Row, { sheet: "Weights" }, [] as Row[], collect);
    const scaling = await foldRows(h, Row, { sheet: 2 }, [] as Row[], collect);
    const again = await foldRows(h, Row, { sheet: "Weights" }, [] as Row[], collect);
    expect(weights).toEqual({ ok: true, value: [{ id: "w-1", n: 1 }, { id: "w-2", n: 2 }] });
    expect(scaling).toEqual({ ok: true, value: [{ id: "s-1", n: 10 }] });
    expect(again).toEqual(weights);
  });

  it("an optional sheet can be probed through sheetNames before folding", async () => {
    const h = open(await makeBook({ Weights: [["id", "n"], ["w-1", 1]] }));
    expect(h.sheetNames.includes("Scaling")).toBe(false);
    expectCrash(await foldRows(h, Row, { sheet: "Scaling" }, [] as Row[], collect), "worksheet not found");
  });

  it("folds rows in worksheet order, passing 1-based worksheet row numbers and skipping blank rows", async () => {
    const h = open(
      await makeBook({ S: [["title"], ["id", "n"], ["a", 1], [null, null], ["b", 2], ["c", 3]] }),
    );
    const seen = await foldRows(
      h,
      Row,
      { headerRow: 2 },
      [] as Array<readonly [number, string]>,
      (acc, row, rowNumber) => {
        acc.push([rowNumber, row.id]);
        return acc;
      },
    );
    expect(seen).toEqual({ ok: true, value: [[3, "a"], [5, "b"], [6, "c"]] });
  });

  it("hands the step prototype-free row objects (FR-034)", async () => {
    const h = open(await makeBook({ S: [["id", "n"], ["a", 1]] }));
    const protos = await foldRows(h, z.unknown(), {}, [] as unknown[], (acc, row) => {
      acc.push(Object.getPrototypeOf(row));
      return acc;
    });
    expect(protos).toEqual({ ok: true, value: [null] });
  });

  it("yields to the event loop while folding a large sheet", async () => {
    const rows: Cell[][] = [["id", "n"]];
    for (let i = 0; i < 3000; i++) rows.push([`row-${i}-${"x".repeat(i % 17)}`, i]);
    const h = open(await makeBook({ S: rows }));

    let macrotaskRan = false;
    setImmediate(() => {
      macrotaskRan = true;
    });
    const r = await foldRows(h, Row, { yieldEveryBytes: 1024 }, { count: 0, sawMacrotask: false }, (acc) => ({
      count: acc.count + 1,
      sawMacrotask: acc.sawMacrotask || macrotaskRan,
    }));
    expect(r).toEqual({ ok: true, value: { count: 3000, sawMacrotask: true } });
  });

  it("rejects a non-positive yieldEveryBytes with a node-crash", async () => {
    const h = open(await makeBook({ S: [["id", "n"], ["a", 1]] }));
    expectCrash(await foldRows(h, Row, { yieldEveryBytes: 0 }, [] as Row[], collect), "yieldEveryBytes");
  });

  it("rejects a forged handle with a node-crash", async () => {
    const forged = Object.freeze({ sheetNames: ["S"] }) as unknown as WorkbookHandle;
    expectCrash(await foldRows(forged, Row, {}, [] as Row[], collect));
  });
});

describe("contract errors", () => {
  it("AS-011: a missing sheet by name or by 1-based index is a node-crash", async () => {
    const bytes = await makeBook({ First: [["id", "n"], ["a", 1]], Second: [["id", "n"]] });
    const h = open(bytes);
    for (const sheet of ["Missing", "first", 3, 0, -1] as const) {
      expectCrash(await foldRows(h, Row, { sheet }, [] as Row[], collect), "worksheet not found");
      expectCrash(await parseWorkbook(bytes, Row, { sheet }), "worksheet not found");
    }
  });

  it("AS-012: duplicate headers are a node-crash naming the header; blank header columns are skipped", async () => {
    const dup = await makeBook({ S: [["id", "n", "id"], ["a", 1, "b"]] });
    expectCrash(await parseWorkbook(dup, Row), "duplicate header column: 'id'");

    const blanks = await makeBook({ S: [["id", null, "n", "  ", null], ["a", "x", 1, "y", "z"]] });
    const r = await parseWorkbook(blanks, z.object({ id: z.string(), n: z.number() }).strict());
    expect(r).toEqual({ ok: true, value: { rows: [{ id: "a", n: 1 }] } });
  });

  it("AS-013: a row failing validation gives a validation error naming the row, recoverable with xlsxErrorRow", async () => {
    const bytes = await makeBook({ S: [["id", "n"], ["a", 1], ["b", 2], ["c", "three"]] });
    const r = await parseWorkbook(bytes, Row);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation");
    if (r.error.kind !== "validation") return;
    expect(r.error.message.startsWith("row 4: ")).toBe(true);
    expect(r.error.path).toBe("n");
    expect(xlsxErrorRow(r.error)).toBe(4);

    const folded = await foldRows(open(bytes), Row, {}, 0, (n) => n + 1);
    expect(folded).toEqual(r);
  });

  it("xlsxErrorRow returns null for errors this module did not mint", () => {
    expect(xlsxErrorRow({ kind: "validation", nodeId: nodeId("other"), message: "row 4: nope" })).toBeNull();
    expect(
      xlsxErrorRow({ kind: "node-crash", nodeId: nodeId("xlsx-parse"), message: "row 4: x", retriability: "non-retriable" }),
    ).toBeNull();
  });
});

describe("documented node-crash causes, through the public API", () => {
  /** A one-sheet workbook whose sheet XML is exactly `sheetXml`; shared strings `sst`. */
  const rawBook = (sheetXml: string, sst: readonly string[] = []): Uint8Array =>
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
          `</Types>`,
      ),
      "xl/workbook.xml": strToU8(
        `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`,
      ),
      "xl/sharedStrings.xml": strToU8(`<sst>${sst.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    });

  const header = '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>n</t></is></c></row>';
  const crashes: ReadonlyArray<readonly [string, string, readonly string[], string]> = [
    ["malformed worksheet XML", `<worksheet><sheetData>${header}<row r="2"><c r="A2"></row></sheetData></worksheet>`, [], "failed to parse worksheet 'S'"],
    ["truncated worksheet XML", `<worksheet><sheetData>${header}<row r="2"><c r="A2"><v>1</v></c>`, [], "failed to parse worksheet 'S'"],
    ["a shared-string index past the table", `<worksheet><sheetData>${header}<row r="2"><c r="A2" t="s"><v>3</v></c></row></sheetData></worksheet>`, ["only"], "shared string 3"],
    ["rows out of ascending order", `<worksheet><sheetData>${header}<row r="5"><c r="A5"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c></row></sheetData></worksheet>`, [], "precedes row 5"],
  ];

  for (const [cause, sheetXml, sst, fragment] of crashes) {
    it(`${cause} is a non-retriable node-crash from foldRows and parseWorkbook`, async () => {
      const bytes = rawBook(sheetXml, sst);
      expectCrash(await foldRows(open(bytes), Row, {}, [] as Row[], collect), fragment);
      expectCrash(await parseWorkbook(bytes, Row), fragment);
    });
  }

  it("a non-integer yieldEveryBytes is a node-crash, like a non-positive one", async () => {
    const h = open(await makeBook({ S: [["id", "n"], ["a", 1]] }));
    for (const yieldEveryBytes of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCrash(await foldRows(h, Row, { yieldEveryBytes }, [] as Row[], collect), "yieldEveryBytes");
    }
  });
});

describe("row core (pure)", () => {
  it("buildHeaderMap keys columns in ascending order, trims, skips blanks, and crashes on a duplicate", () => {
    const headers = buildHeaderMap(new Map<number, CellValue>([[3, " n "], [0, "id"], [1, null], [2, ""]]), 1);
    expect(headers.ok && [...headers.value]).toEqual([[0, "id"], [3, "n"]]);
    const dup = buildHeaderMap(new Map<number, CellValue>([[0, "id"], [4, "id "]]), 7);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatchObject({ kind: "node-crash", message: "duplicate header column: 'id' (header row 7)" });
  });

  it("projectRow builds prototype-free rows and returns null when every header cell is empty", () => {
    const headers = new Map([[0, "__proto__"], [2, "n"]]);
    const row = projectRow(new Map<number, CellValue>([[0, "x"], [1, "ignored"], [2, 5]]), headers);
    expect(row === null ? null : Object.getPrototypeOf(row)).toBeNull();
    expect(row === null ? null : Object.entries(row)).toEqual([["__proto__", "x"], ["n", 5]]);
    expect(projectRow(new Map<number, CellValue>([[0, ""], [1, "ignored"]]), headers)).toBeNull();
  });
});

describe("worksheet row assembler (SheetJS parse_ws_xml_data addressing)", () => {
  type Event =
    | { readonly kind: "dimension"; readonly bounds: SheetBounds }
    | { readonly kind: "row"; readonly rowIndex: number; readonly cells: ReadonlyArray<readonly [number, CellValue]> }
    | { readonly kind: "fail"; readonly message: string };

  const ctx: DecodeContext = { sst: ["s0", "s1"], isDateStyle: () => false };

  const assemble = (sheetData: string, prelude = ""): Event[] => {
    const events: Event[] = [];
    const reader = createSheetReader(ctx, {
      dimension: (bounds) => events.push({ kind: "dimension", bounds }),
      row: (rowIndex, cells: RowCells) => events.push({ kind: "row", rowIndex, cells: [...cells] }),
      fail: (message) => events.push({ kind: "fail", message }),
    });
    const parsed = parseXml(`<worksheet>${prelude}<sheetData>${sheetData}</sheetData></worksheet>`, reader);
    expect(parsed.ok).toBe(true);
    return events;
  };

  it("advances implicit row and column addresses from the previous element", () => {
    expect(assemble('<row><c><v>1</v></c><c t="s"><v>1</v></c></row><row r="4"><c r="C4"><v>2</v></c><c><v>3</v></c></row><row><c><v>4</v></c></row>')).toEqual([
      { kind: "row", rowIndex: 0, cells: [[0, 1], [1, "s1"]] },
      { kind: "row", rowIndex: 3, cells: [[2, 2], [3, 3]] },
      { kind: "row", rowIndex: 4, cells: [[0, 4]] },
    ]);
  });

  it("stores a cell under its own r address and emits rows in ascending order", () => {
    expect(assemble('<row r="1"><c r="A3"><v>9</v></c><c r="B1"><v>1</v></c></row><row r="5"><c r="A5"><v>5</v></c></row>')).toEqual([
      { kind: "row", rowIndex: 0, cells: [[1, 1]] },
      { kind: "row", rowIndex: 2, cells: [[0, 9]] },
      { kind: "row", rowIndex: 4, cells: [[0, 5]] },
    ]);
  });

  it("drops non-canonical addresses and, without a dimension, cells beyond the last row element", () => {
    expect(assemble('<row r="1"><c r="a1"><v>1</v></c><c r="$B$1"><v>2</v></c><c r="C1"><v>3</v></c><c r="A9"><v>4</v></c></row>')).toEqual([
      { kind: "row", rowIndex: 0, cells: [[2, 3]] },
    ]);
  });

  it("a valid dimension is reported first and lifts the last-row clamp; a trailing self-closing row extends it", () => {
    expect(assemble('<row r="1"><c r="A9"><v>4</v></c></row>', '<dimension ref="A1:B9"/>')).toEqual([
      { kind: "dimension", bounds: { firstCol: 0, lastCol: 1, lastRow: 8 } },
      { kind: "row", rowIndex: 8, cells: [[0, 4]] },
    ]);
    expect(assemble('<row r="1"><c r="A9"><v>4</v></c></row><row r="9"/>')).toEqual([
      { kind: "row", rowIndex: 8, cells: [[0, 4]] },
    ]);
  });

  it("reads the first <v> and inline strings, and fails on a missing shared string or a backwards cell", () => {
    expect(assemble('<row><c><v>1</v><v>2</v></c><c t="inlineStr"><is><t>hi</t></is></c></row>')).toEqual([
      { kind: "row", rowIndex: 0, cells: [[0, 1], [1, "hi"]] },
    ]);
    expect(assemble('<row><c t="s"><v>7</v></c></row>')).toEqual([
      { kind: "fail", message: "cell A1 references shared string 7, which does not exist" },
    ]);
    expect(assemble('<row r="3"><c r="A3"><v>1</v></c></row><row r="4"><c r="A2"><v>2</v></c></row>')).toEqual([
      { kind: "row", rowIndex: 2, cells: [[0, 1]] },
      { kind: "fail", message: "cell A2 addresses a row that precedes row 4 (unsupported cell order)" },
    ]);
    expect(assemble('<row r="x"><c><v>1</v></c></row>')).toEqual([
      { kind: "fail", message: 'row "x" has no row number' },
    ]);
  });

  it("parseDimensionRef accepts only \\w*:\\w* ranges that decode non-empty", () => {
    expect(parseDimensionRef("B2:D10")).toEqual({ firstCol: 1, lastCol: 3, lastRow: 9 });
    expect(parseDimensionRef("A1")).toBeNull();
    expect(parseDimensionRef("$A$1:$B$2")).toBeNull();
    expect(parseDimensionRef("C5:A1")).toBeNull();
    expect(parseDimensionRef("")).toBeNull();
  });

  it("targetRow follows the canonical r address, else the enclosing row element", () => {
    expect(targetRow(undefined, 3, 0)).toBe(3);
    expect(targetRow(undefined, 3, -1)).toBeNull();
    expect(targetRow("B7", 0, 1)).toBe(6);
    expect(targetRow("a1", 0, 0)).toBeNull();
    expect(targetRow("A0", 0, 0)).toBeNull();
  });

  it("rowNumberOf reads r, else advances the previous row number", () => {
    expect(rowNumberOf(undefined, 4)).toBe(5);
    expect(rowNumberOf("7", 4)).toBe(7);
    expect(rowNumberOf("x", 4)).toBeNaN();
  });
});

describe("determinism", () => {
  it("AS-017: 20 workbooks parsed concurrently give exactly the sequential results", async () => {
    const Mixed = z.object({ id: z.string(), n: z.number(), when: z.date().nullable() });
    const books = await Promise.all(
      Array.from({ length: 20 }, (_, b) =>
        makeBook({
          S: [
            ["id", "n", "when"],
            ...Array.from({ length: 200 + b * 7 }, (_, i): Cell[] => [
              `b${b}-r${i}`,
              i * (b + 1) + 0.25,
              i % 3 === 0 ? null : new Date(Date.UTC(2020, b % 12, 1 + (i % 28))),
            ]),
          ],
        }),
      ),
    );
    const sequential = [];
    for (const bytes of books) sequential.push(await parseWorkbook(bytes, Mixed));
    const concurrent = await Promise.all(books.map((bytes) => parseWorkbook(bytes, Mixed)));
    expect(concurrent).toEqual(sequential);
    expect(concurrent.every((r) => r.ok)).toBe(true);
  });

  it("parseWorkbook ≡ a collecting foldRows over random sheets", async () => {
    const cell = fc.oneof(fc.constant(null), fc.integer({ min: -1000, max: 1000 }), fc.string({ maxLength: 6 }));
    const Loose = z.object({ a: z.unknown(), b: z.unknown() }).passthrough();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(cell, cell), { maxLength: 30 }), async (rows) => {
        const bytes = await makeBook({ S: [["a", "b"], ...rows] });
        const viaParse = await parseWorkbook(bytes, Loose);
        const viaFold = await foldRows(open(bytes), Loose, {}, [] as Array<z.infer<typeof Loose>>, collect);
        expect(viaParse).toEqual(viaFold.ok ? { ok: true, value: { rows: viaFold.value } } : viaFold);
      }),
      { numRuns: 20 },
    );
  });
});
