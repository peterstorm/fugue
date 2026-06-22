/**
 * Regression: real-world exports (Dynamics 365, BI tools) save date-grouped
 * table autofilters as `<dateGroupItem/>` nodes that ExcelJS's FULL-LOAD table
 * parser crashes on ("Unexpected xml node in parseOpen"). parseWorkbook now uses
 * the STREAMING reader, which never parses `xl/tables/*.xml`, so it reads these
 * workbooks natively — the nodes only describe a UI filter, never cell data.
 *
 * The fixture is built by writing a normal workbook with an Excel table, then
 * injecting a dateGroupItem filter into the table XML at the zip level —
 * byte-faithful to what Dynamics emits. The first test still asserts the raw
 * full-load crash (the motivation for streaming); the second asserts parseWorkbook
 * reads it cleanly.
 */

import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { z } from "zod";
import { parseWorkbook } from "../index.js";

const RowSchema = z.object({
  Topic: z.string(),
  CloseDate: z.union([z.string(), z.number(), z.date()]).nullable(),
});

/**
 * Build the fixture, injecting `filtersInner` as the children of `<filters>` on
 * the date column. Defaults to the self-closing `dateGroupItem` nodes Dynamics
 * emits (which `stripDateGroupItems` removes losslessly).
 */
const buildFixture = async (
  filtersInner = '<dateGroupItem year="2023" dateTimeGrouping="year"/>' +
    '<dateGroupItem year="2024" month="2" dateTimeGrouping="month"/>',
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
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());

  // Inject the date-grouped filter Dynamics writes for a filtered date column.
  const zip = await JSZip.loadAsync(bytes);
  const tableFile = zip.file(/^xl\/tables\/.*\.xml$/)[0];
  if (!tableFile) throw new Error("fixture bug: no table XML emitted");
  const xml = await tableFile.async("string");
  const withFilter = xml.replace(
    /<filterColumn colId="1"[^>]*\/>/,
    `<filterColumn colId="1"><filters>${filtersInner}</filters></filterColumn>`,
  );
  if (withFilter === xml) throw new Error("fixture bug: filterColumn not found in table XML");
  zip.file(tableFile.name, withFilter);
  return zip.generateAsync({ type: "uint8array" });
};

describe("dateGroupItem table autofilters", () => {
  test("fixture reproduces the raw ExcelJS crash", async () => {
    const bytes = await buildFixture();
    const wb = new ExcelJS.Workbook();
    await expect(
      wb.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof wb.xlsx.load>[0]),
    ).rejects.toThrow(/dateGroupItem/);
  });

  test("parseWorkbook reads dateGroupItem workbooks natively (streaming skips table XML)", async () => {
    const bytes = await buildFixture();
    const result = await parseWorkbook(bytes, RowSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.rows[0]!.Topic).toBe("Nysalg");
  });

  test("malformed table XML does not affect row extraction (tables are never parsed)", async () => {
    // A broken XML entity (`&nope;`) injected into the table part would crash the
    // old full-load + strip path. The streaming reader never reads `xl/tables`, so
    // row extraction from the worksheet is unaffected — proving the table part is
    // out of the parse path entirely.
    const bytes = await buildFixture(
      '<dateGroupItem year="2023" dateTimeGrouping="year"/>&nope;',
    );
    const result = await parseWorkbook(bytes, RowSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
  });
});
