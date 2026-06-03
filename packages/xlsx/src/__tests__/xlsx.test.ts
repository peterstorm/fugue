import { describe, it, expect } from "bun:test";
import ExcelJS from "exceljs";
import { z } from "zod";
import { isOk, isErr } from "@fugue/framework";
import { parseWorkbook, normalizeCell } from "../index.js";

const RowSchema = z.object({ customerId: z.string(), revenue: z.number() });

/** Build a real .xlsx in memory so tests need no committed binary fixture. */
const makeXlsx = async (
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
  opts: { sheetName?: string; headerRow?: ReadonlyArray<string> } = {},
): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? "Sheet1");
  ws.addRow([...(opts.headerRow ?? ["customerId", "revenue"])]);
  for (const r of rows) ws.addRow([...r]);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
};

describe("parseWorkbook — happy path", () => {
  it("round-trips rows with correct types", async () => {
    const bytes = await makeXlsx([
      ["c-1", 100],
      ["c-2", 250.5],
    ]);
    const r = await parseWorkbook(bytes, RowSchema);
    expect(isOk(r)).toBe(true);
    if (r.ok) {
      expect(r.value.rows).toEqual([
        { customerId: "c-1", revenue: 100 },
        { customerId: "c-2", revenue: 250.5 },
      ]);
    }
  });

  it("skips fully-blank rows", async () => {
    const bytes = await makeXlsx([["c-1", 10], [null, null], ["c-2", 20]]);
    const r = await parseWorkbook(bytes, RowSchema);
    if (r.ok) expect(r.value.rows).toHaveLength(2);
  });

  it("reads a worksheet by name", async () => {
    const bytes = await makeXlsx([["c-9", 9]], { sheetName: "Data" });
    const r = await parseWorkbook(bytes, RowSchema, { sheet: "Data" });
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value.rows[0]).toEqual({ customerId: "c-9", revenue: 9 });
  });
});

describe("parseWorkbook — errors", () => {
  it("returns a validation error (naming the row) when a cell violates the schema", async () => {
    const bytes = await makeXlsx([
      ["c-1", 100],
      ["c-2", "not-a-number"],
    ]);
    const r = await parseWorkbook(bytes, RowSchema);
    expect(isErr(r)).toBe(true);
    if (!r.ok) {
      expect(r.error.kind).toBe("validation");
      if (r.error.kind === "validation") expect(r.error.message).toContain("row 3");
    }
  });

  it("returns a non-retriable node-crash for non-workbook bytes", async () => {
    const r = await parseWorkbook(new Uint8Array([1, 2, 3, 4]), RowSchema);
    expect(isErr(r)).toBe(true);
    if (!r.ok && r.error.kind === "node-crash") expect(r.error.retriability).toBe("non-retriable");
  });

  it("returns a node-crash when the requested worksheet is absent", async () => {
    const bytes = await makeXlsx([["c-1", 1]]);
    const r = await parseWorkbook(bytes, RowSchema, { sheet: "Missing" });
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.kind).toBe("node-crash");
  });
});

describe("normalizeCell", () => {
  it("passes through primitives and Date", () => {
    expect(normalizeCell("x")).toBe("x");
    expect(normalizeCell(42)).toBe(42);
    expect(normalizeCell(true)).toBe(true);
    const d = new Date("2026-01-01T00:00:00Z");
    expect(normalizeCell(d)).toBe(d);
    expect(normalizeCell(null)).toBeNull();
  });

  it("unwraps formula results, rich text, and hyperlinks", () => {
    expect(normalizeCell({ formula: "1+1", result: 2 })).toBe(2);
    expect(normalizeCell({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(normalizeCell({ text: "label", hyperlink: "https://x" })).toBe("label");
    expect(normalizeCell({ error: "#REF!" })).toBeNull();
  });
});
