/**
 * Local, opt-in differential on the 10 real source workbooks (FR-043, AS-009,
 * SC-007). The workbooks are business data and are never committed; point
 * `FUGUE_REAL_DATA_DIR` at the folder holding them:
 *
 *   FUGUE_REAL_DATA_DIR=/path/to/fugue-dags/data bun test src/__tests__/real-data.local.test.ts
 *
 * Unset (CI), the differential reports as skipped. Set, a missing workbook is a
 * failure — never a silent skip. A production read that is not marked optional
 * must parse to at least one row: both readers failing (or reading nothing) the
 * same way means the catalogue is wrong, and fails the gate. Each workbook is compared on the reads
 * production performs AND on every sheet with the header on row 1, in this
 * process and again in child processes with TZ pinned to UTC and
 * Europe/Copenhagen.
 */
import { describe, expect, it } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
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

/**
 * One production read of a real workbook (sheet + header row as fugue-dags reads it).
 * `required` (the default) reads must parse: both readers failing identically on
 * one means the catalogue (sheet name, header row) is wrong, not that parity
 * holds. `optional` reads mirror production reads that tolerate a missing sheet.
 */
type ReadPresence = "required" | "optional";
type ProductionRead = {
  readonly label: string;
  readonly opts: ParseWorkbookOpts;
  readonly presence?: ReadPresence;
};
type RealWorkbook = { readonly file: string; readonly reads: readonly ProductionRead[] };

/** The 10 source workbooks the direct-sales DAGs read (fugue-dags `lib/sources.ts`). */
const REAL_SOURCE_WORKBOOKS: readonly RealWorkbook[] = [
  { file: "Brancheliste.xlsx", reads: [{ label: "master list", opts: {} }] },
  {
    file: "Scoringsmodel_v0_udkast.xlsx",
    reads: [
      { label: "weights", opts: { sheet: "1. Signaler & vægte", headerRow: 4 } },
      { label: "scaling (optional sheet)", opts: { sheet: "2. Skalering" }, presence: "optional" },
    ],
  },
  { file: "Gamle_kunder.xlsx", reads: [{ label: "previous customers", opts: {} }] },
  { file: "Tabte_salgsmuligheder.xlsx", reads: [{ label: "lost opportunities", opts: { sheet: "Salgsmuligheder" } }] },
  { file: "Dansk_Erhverv.xlsx", reads: [{ label: "members", opts: {} }] },
  { file: "Leverandørliste.xlsx", reads: [{ label: "suppliers", opts: { sheet: "Ark1" } }] },
  { file: "Tivoli Erhvervsklub.xlsx", reads: [{ label: "members", opts: { sheet: "Ark1" } }] },
  { file: "FCK.xlsx", reads: [{ label: "partners", opts: { sheet: "Sheet1" } }] },
  { file: "IT-Branchen.xlsx", reads: [{ label: "members", opts: { sheet: "Medlemmer" } }] },
  {
    file: "GlobalConnect_kunder.xlsx",
    reads: [{ label: "customers", opts: { sheet: "QUERY_FOR_COPY OF KUNDELISTE SM" } }],
  },
];

/** Whether the real-data differential runs, decided once from the environment. */
type RealDataPlan = { readonly kind: "skip" } | { readonly kind: "run"; readonly dir: string };

const realDataPlan = (env: Readonly<Record<string, string | undefined>>, cwd: string): RealDataPlan => {
  const raw = env.FUGUE_REAL_DATA_DIR?.trim();
  if (raw === undefined || raw === "") return { kind: "skip" };
  return { kind: "run", dir: isAbsolute(raw) ? raw : resolve(cwd, raw) };
};

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
 * Every read of one workbook → its findings. Production reads are `required`
 * unless marked otherwise; the sweep of each sheet at header row 1 is
 * exploratory (a sheet need not be tabular there), so it only checks parity.
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
    const finding = findingOf(read.presence ?? "required", expected, divergence);
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
    expect(realDataPlan({}, "/w")).toEqual({ kind: "skip" });
    expect(realDataPlan({ FUGUE_REAL_DATA_DIR: "  " }, "/w")).toEqual({ kind: "skip" });
    expect(realDataPlan({ FUGUE_REAL_DATA_DIR: "/data" }, "/w")).toEqual({ kind: "run", dir: "/data" });
    expect(realDataPlan({ FUGUE_REAL_DATA_DIR: "data" }, "/w")).toEqual({ kind: "run", dir: "/w/data" });
  });

  it("AS-009: a required production read that errors or reads nothing on both readers is a finding, an optional one is not", async () => {
    const bytes = await syntheticBrancheliste(20, 7);
    const [firstSheet] = oracleSheetNames(bytes);
    const typo = "Ark-that-does-not-exist";
    const workbookWith = (reads: readonly ProductionRead[]): RealWorkbook => ({ file: "synthetic.xlsx", reads });

    const requiredTypo = await divergencesOf(bytes, workbookWith([{ label: "typo'd sheet", opts: { sheet: typo } }]));
    expect(requiredTypo.map((f) => [f.read, f.finding.kind])).toEqual([["typo'd sheet", "required-read-failed"]]);

    const optionalTypo = await divergencesOf(
      bytes,
      workbookWith([{ label: "optional sheet", opts: { sheet: typo }, presence: "optional" }]),
    );
    expect(optionalTypo).toEqual([]);

    const requiredBadHeaderRow = await divergencesOf(
      bytes,
      workbookWith([{ label: "header past the data", opts: { sheet: firstSheet, headerRow: 100_000 } }]),
    );
    expect(requiredBadHeaderRow.map((f) => [f.read, f.finding.kind])).toEqual([
      ["header past the data", "required-read-empty"],
    ]);

    expect(await divergencesOf(bytes, workbookWith([{ label: "master list", opts: {} }]))).toEqual([]);
  });
});

const plan = realDataPlan(process.env, process.cwd());
const childZone = timeZoneOfChild(process.env);

describe.skipIf(plan.kind === "skip")("AS-009: real source workbooks ≡ SheetJS oracle", () => {
  const dir = plan.kind === "run" ? plan.dir : "";

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
          if (run.kind !== "passed") throw new Error(`real-data suite under TZ=${zone.tz} ${run.kind}:\n${run.output}`);
          expect(run.passed).toBeGreaterThanOrEqual(REAL_SOURCE_WORKBOOKS.length);
        },
        1_800_000,
      );
    }
  }
});
