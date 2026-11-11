/**
 * `xlsxErrorRow` decodes the row number `foldRow` encodes into a validation
 * message (`row <n>: …`). The two halves live apart in rows.ts and meet only
 * through that string, so this pins the round trip: every row number a failing
 * `foldRow` mints is recovered exactly, and errors the module did not mint as
 * row validation failures recover nothing.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import type { FrameworkError } from "@fuguejs/framework";
import { nodeId } from "@fuguejs/framework";
import type { CellValue } from "../cell-value.js";
import { foldRow, startFold, XLSX_NODE_ID, xlsxCrash, xlsxErrorRow } from "../rows.js";

/** A fold past its header row (`headerRow` 1, one header `a`), ready for data rows. */
const withHeader = { ...startFold(1, 0), lastRowIndex: 0, headers: new Map([[0, "a"]]) };

const cellValue: fc.Arbitrary<CellValue> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.double({ noNaN: true }),
  fc.boolean(),
);

/** Fold one data row through a schema that rejects it; the error `foldRow` returns. */
const rejectRow = (rowIndex: number, value: CellValue, message: string): FrameworkError => {
  const rejecting = z.unknown().refine(() => false, { message });
  const r = foldRow(withHeader, rowIndex, new Map([[0, value]]), rejecting, (n) => n + 1);
  if (r.ok) throw new Error("schema rejects every row");
  return r.error;
};

describe("xlsxErrorRow ∘ foldRow", () => {
  it("recovers exactly the 1-based worksheet row any failing data row was minted with", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER - 1 }),
        cellValue,
        fc.string(),
        (rowIndex, value, message) => {
          const e = rejectRow(rowIndex, value, message);
          expect(e.kind).toBe("validation");
          expect(xlsxErrorRow(e)).toBe(rowIndex + 1);
        },
      ),
    );
  });

  it("recovers nothing from an error not minted as an xlsx row validation failure", () => {
    fc.assert(
      fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), fc.string(), (n, rest) => {
        const message = `row ${n}: ${rest}`;
        expect(xlsxErrorRow(xlsxCrash(message))).toBeNull();
        expect(xlsxErrorRow({ kind: "validation", nodeId: nodeId("not-xlsx"), message })).toBeNull();
      }),
    );
    fc.assert(
      fc.property(
        fc.string().filter((m) => !/^row \d+: /.test(m)),
        (message) => {
          expect(xlsxErrorRow({ kind: "validation", nodeId: XLSX_NODE_ID, message })).toBeNull();
        },
      ),
    );
  });
});
