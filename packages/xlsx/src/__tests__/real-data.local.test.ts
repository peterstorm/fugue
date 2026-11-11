/**
 * Local, opt-in differential on the 10 real source workbooks (FR-043, AS-009,
 * SC-007). The workbooks are business data and are never committed; point
 * `FUGUE_REAL_DATA_DIR` at the folder holding them:
 *
 *   FUGUE_REAL_DATA_DIR=/path/to/fugue-dags/data bun test src/__tests__/real-data.local.test.ts
 *
 * Unset (CI), the differential reports as skipped. Set, a missing workbook is a
 * failure — never a silent skip. Every read states its presence: a `required`
 * read must parse to at least one row, because both readers failing (or reading
 * nothing) the same way means the catalogue is wrong, and fails the gate. Each
 * workbook is compared on the reads production performs AND on every sheet with
 * the header on row 1, in this process and again in child processes with TZ
 * pinned to UTC and Europe/Copenhagen (a relative `FUGUE_REAL_DATA_DIR` is
 * resolved against this process's cwd before it is handed to them).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ParseWorkbookOpts } from "../index.js";
import {
  differential,
  oracleSheetNames,
  PARITY_TIME_ZONES,
  type CanonicalError,
  type CanonicalOutcome,
  runSuiteUnderTimeZone,
  timeZoneOfChild,
  type Divergence,
} from "./support/sheetjs-oracle.js";
import { anyRow, syntheticBrancheliste } from "./support/fixtures.js";
import { realDataDir } from "./support/real-data-dir.js";

/**
 * One read of a real workbook (sheet + header row as fugue-dags reads it), with
 * its presence stated at every catalogue entry. `required` reads must parse:
 * both readers failing identically on one means the catalogue (sheet name,
 * header row) is wrong, not that parity holds. `optional` reads mirror
 * production reads that tolerate a missing sheet, and the exploratory sheet sweep.
 */
type ReadPresence = "required" | "optional";
type ProductionRead = {
  readonly label: string;
  readonly opts: ParseWorkbookOpts;
  readonly presence: ReadPresence;
};
type RealWorkbook = { readonly file: string; readonly reads: readonly ProductionRead[] };

/** The 10 source workbooks the direct-sales DAGs read (fugue-dags `lib/sources.ts`). */
const REAL_SOURCE_WORKBOOKS: readonly RealWorkbook[] = [
  { file: "Brancheliste.xlsx", reads: [{ label: "master list", opts: {}, presence: "required" }] },
  {
    file: "Scoringsmodel_v0_udkast.xlsx",
    reads: [
      { label: "weights", opts: { sheet: "1. Signaler & vægte", headerRow: 4 }, presence: "required" },
      { label: "scaling (optional sheet)", opts: { sheet: "2. Skalering" }, presence: "optional" },
    ],
  },
  { file: "Gamle_kunder.xlsx", reads: [{ label: "previous customers", opts: {}, presence: "required" }] },
  { file: "Tabte_salgsmuligheder.xlsx", reads: [{ label: "lost opportunities", opts: { sheet: "Salgsmuligheder" }, presence: "required" }] },
  { file: "Dansk_Erhverv.xlsx", reads: [{ label: "members", opts: {}, presence: "required" }] },
  { file: "Leverandørliste.xlsx", reads: [{ label: "suppliers", opts: { sheet: "Ark1" }, presence: "required" }] },
  { file: "Tivoli Erhvervsklub.xlsx", reads: [{ label: "members", opts: { sheet: "Ark1" }, presence: "required" }] },
  { file: "FCK.xlsx", reads: [{ label: "partners", opts: { sheet: "Sheet1" }, presence: "required" }] },
  { file: "IT-Branchen.xlsx", reads: [{ label: "members", opts: { sheet: "Medlemmer" }, presence: "required" }] },
  {
    file: "GlobalConnect_kunder.xlsx",
    reads: [{ label: "customers", opts: { sheet: "QUERY_FOR_COPY OF KUNDELISTE SM" }, presence: "required" }],
  },
];

/** Why one read of a real workbook fails the gate. */
type ReadFinding =
  | { readonly kind: "divergence"; readonly divergence: Divergence }
  | { readonly kind: "required-read-failed"; readonly error: CanonicalError }
  | { readonly kind: "required-read-empty" };

type ReadDivergence = { readonly read: string; readonly finding: ReadFinding };

/**
 * The gate's verdict on one read, from the oracle outcome and the divergence
 * (pure). Both readers erroring, or both returning no rows, on a required read
 * is agreement about nothing — a typo'd sheet name or header row — not parity.
 */
const findingOf = (
  presence: ReadPresence,
  expected: CanonicalOutcome,
  divergence: Divergence | null,
): ReadFinding | null => {
  if (divergence !== null) return { kind: "divergence", divergence };
  if (presence === "optional") return null;
  if (expected.kind === "error") return { kind: "required-read-failed", error: expected.error };
  return expected.rows.length === 0 ? { kind: "required-read-empty" } : null;
};

/**
 * Every read of one workbook → its findings. The sweep of each sheet at header
 * row 1 is exploratory (a sheet need not be tabular there), so it is `optional`
 * and only checks parity.
 */
const divergencesOf = async (bytes: Uint8Array, workbook: RealWorkbook): Promise<readonly ReadDivergence[]> => {
  const sheetReads: readonly ProductionRead[] = oracleSheetNames(bytes).map((sheet) => ({
    label: `sheet "${sheet}" @ header row 1`,
    opts: { sheet },
    presence: "optional",
  }));
  const found: ReadDivergence[] = [];
  for (const read of [...workbook.reads, ...sheetReads]) {
    const { expected, divergence } = await differential(bytes, anyRow, read.opts);
    const finding = findingOf(read.presence, expected, divergence);
    if (finding !== null) found.push({ read: read.label, finding });
  }
  return found;
};

describe("real-data differential gate", () => {
  it("catalogues exactly the 10 real source workbooks, each once, each with a read", () => {
    const files = REAL_SOURCE_WORKBOOKS.map((w) => w.file);
    expect(files).toHaveLength(10);
    expect(new Set(files).size).toBe(10);
    for (const w of REAL_SOURCE_WORKBOOKS) expect(w.reads.length).toBeGreaterThan(0);
  });

  it("skips unless FUGUE_REAL_DATA_DIR names a directory; relative paths resolve against the cwd", () => {
    expect(realDataDir({}, "/w")).toEqual({ kind: "unset" });
    expect(realDataDir({ FUGUE_REAL_DATA_DIR: "  " }, "/w")).toEqual({ kind: "unset" });
    expect(realDataDir({ FUGUE_REAL_DATA_DIR: "/data" }, "/w")).toEqual({ kind: "set", dir: "/data" });
    expect(realDataDir({ FUGUE_REAL_DATA_DIR: " data " }, "/w")).toEqual({ kind: "set", dir: "/w/data" });
  });

  it("AS-009: a required production read that errors or reads nothing on both readers is a finding, an optional one is not", async () => {
    const bytes = await syntheticBrancheliste(20, 7);
    const [firstSheet] = oracleSheetNames(bytes);
    const typo = "Ark-that-does-not-exist";
    const workbookWith = (reads: readonly ProductionRead[]): RealWorkbook => ({ file: "synthetic.xlsx", reads });

    const requiredTypo = await divergencesOf(bytes, workbookWith([{ label: "typo'd sheet", opts: { sheet: typo }, presence: "required" }]));
    expect(requiredTypo.map((f) => [f.read, f.finding.kind])).toEqual([["typo'd sheet", "required-read-failed"]]);

    const optionalTypo = await divergencesOf(
      bytes,
      workbookWith([{ label: "optional sheet", opts: { sheet: typo }, presence: "optional" }]),
    );
    expect(optionalTypo).toEqual([]);

    const requiredBadHeaderRow = await divergencesOf(
      bytes,
      workbookWith([{ label: "header past the data", opts: { sheet: firstSheet, headerRow: 100_000 }, presence: "required" }]),
    );
    expect(requiredBadHeaderRow.map((f) => [f.read, f.finding.kind])).toEqual([
      ["header past the data", "required-read-empty"],
    ]);

    expect(await divergencesOf(bytes, workbookWith([{ label: "master list", opts: {}, presence: "required" }]))).toEqual([]);
  });
});

const plan = realDataDir(process.env, process.cwd());
const childZone = timeZoneOfChild(process.env);

describe.skipIf(plan.kind === "unset")("AS-009: real source workbooks ≡ SheetJS oracle", () => {
  const dir = plan.kind === "set" ? plan.dir : "";

  for (const workbook of REAL_SOURCE_WORKBOOKS) {
    it(
      `AS-009: ${workbook.file} parses identically to the oracle on every read`,
      async () => {
        const file = Bun.file(join(dir, workbook.file));
        if (!(await file.exists())) throw new Error(`FUGUE_REAL_DATA_DIR is set but ${workbook.file} is missing in ${dir}`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        expect(await divergencesOf(bytes, workbook)).toEqual([]);
      },
      600_000,
    );
  }

  if (childZone.kind === "parent") {
    for (const zone of PARITY_TIME_ZONES) {
      it(
        `AS-009: the real-data differential passes under TZ=${zone.tz}`,
        async () => {
          const run = await runSuiteUnderTimeZone(import.meta.path, zone);
          if (run.kind !== "passed") throw new Error(`real-data suite under TZ=${zone.tz} failed (${run.reason}):\n${run.output}`);
          expect(run.passed).toBeGreaterThanOrEqual(REAL_SOURCE_WORKBOOKS.length);
        },
        1_800_000,
      );
    }
  }
});
