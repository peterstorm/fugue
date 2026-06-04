/**
 * End-to-end: fetch a real .xlsx from disk via the @fugue/fs `documents`
 * adapter, then parse it with parseWorkbook. Exercises the full
 * `getContent → parseWorkbook` path against actual disk I/O (no injection),
 * mirroring what a `createFetchNode` does at runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { isOk } from "@fugue/framework";
import { createFsAdapter, localPathRef } from "@fugue/fs";
import { parseWorkbook } from "../index.js";

const RowSchema = z.object({ customerId: z.string(), revenue: z.number() });

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fugue-xlsx-e2e-"));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["customerId", "revenue"]);
  ws.addRow(["c-1", 1000]);
  ws.addRow(["c-2", 2500]);
  const buf = await wb.xlsx.writeBuffer();
  await writeFile(join(root, "2026-Q2.xlsx"), Buffer.from(buf as ArrayBuffer));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("fetch (fs) → parse (xlsx) end-to-end", () => {
  it("reads bytes from real disk and parses validated rows", async () => {
    const documents = createFsAdapter({ rootDir: root }).client;

    // 1. fetch bytes — exactly what a createFetchNode does with ctx.documents
    const bytes = await documents.getContent(localPathRef("2026-Q2.xlsx"));
    expect(isOk(bytes)).toBe(true);
    if (!bytes.ok) return;

    // 2. parse — the pure transform step
    const parsed = await parseWorkbook(bytes.value, RowSchema);
    expect(isOk(parsed)).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rows).toEqual([
        { customerId: "c-1", revenue: 1000 },
        { customerId: "c-2", revenue: 2500 },
      ]);
    }
  });

  it("propagates a non-retriable error when the file is absent", async () => {
    const documents = createFsAdapter({ rootDir: root }).client;
    const bytes = await documents.getContent(localPathRef("nope.xlsx"));
    expect(bytes.ok).toBe(false);
    if (!bytes.ok && bytes.error.kind === "node-crash") {
      expect(bytes.error.retriability).toBe("non-retriable");
    }
  });
});
