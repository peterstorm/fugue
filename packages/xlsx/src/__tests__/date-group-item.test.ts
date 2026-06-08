/**
 * Regression: real-world exports (Dynamics 365, BI tools) save date-grouped
 * table autofilters as `<dateGroupItem/>` nodes that ExcelJS's table parser
 * crashes on ("Unexpected xml node in parseOpen"). parseWorkbook must strip
 * the UI-only nodes and retry — they never carry cell data.
 *
 * The fixture is built by writing a normal workbook with an Excel table, then
 * injecting a dateGroupItem filter into the table XML at the zip level —
 * byte-faithful to what Dynamics emits.
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

  test("parseWorkbook strips the filter nodes and returns the rows", async () => {
    const bytes = await buildFixture();
    const result = await parseWorkbook(bytes, RowSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.rows[0]!.Topic).toBe("Nysalg");
  });

  test("returns node-crash when the workbook still fails to load after stripping", async () => {
    // First load crashes on the self-closing dateGroupItem (triggering the strip
    // + retry path); the strip removes only that node, leaving an undefined XML
    // entity (`&nope;`) that makes the retry load itself fail — exercising the
    // `catch (e2)` branch that returns a fresh node-crash. The entity is a
    // parser-level well-formedness error, so this does not depend on ExcelJS's
    // tolerance of any particular element.
    const bytes = await buildFixture(
      '<dateGroupItem year="2023" dateTimeGrouping="year"/>&nope;',
    );
    const result = await parseWorkbook(bytes, RowSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("node-crash");
    if (result.error.kind === "node-crash") {
      expect(result.error.message).toContain("failed to parse workbook");
      expect(result.error.retriability).toBe("non-retriable");
    }
  });
});
