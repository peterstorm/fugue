/**
 * CI memory budget for the streaming parse (AS-015, SC-013).
 *
 * Spawns `bench/parse-memory.ts` — the same benchmark run locally against the
 * real Brancheliste — on the deterministic synthetic Brancheliste (25.6k rows)
 * and asserts the parse process's peak RSS stays at or below 100 MB. The parse
 * runs in its own child process, so the fixture generator's memory (ExcelJS,
 * JSZip) is never counted against the budget.
 *
 * The bench is driven through its CLI. It lives outside this package's
 * `rootDir`, so a static import would break `tsc`; its two pure RSS helpers are
 * reached through a dynamic import of a computed path (which `tsc` does not
 * resolve) and checked at that boundary. The real workbook is local-only
 * (`FUGUE_REAL_DATA_DIR`); the real-data path is exercised here against a small
 * synthetic workbook written to a temporary directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticBrancheliste } from "./support/fixtures.js";

const BENCH = join(import.meta.dir, "..", "..", "bench", "parse-memory.ts");
const SYNTHETIC_ROWS = 25_600;

type Measurement = {
  readonly source: "synthetic" | "real";
  readonly label: string;
  readonly rows: number;
  readonly peakRssMb: number;
};

type BenchReport = {
  readonly ok: boolean;
  readonly budgetMb: number;
  readonly measurements: readonly Measurement[];
  readonly lines: readonly string[];
};

type BenchRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const runBench = (args: readonly string[], realDataDir?: string, cwd?: string): BenchRun => {
  const { FUGUE_REAL_DATA_DIR: _inherited, ...env } = process.env;
  const proc = Bun.spawnSync([process.execPath, BENCH, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: realDataDir === undefined ? env : { ...env, FUGUE_REAL_DATA_DIR: realDataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

const line = (label: string, m: Measurement, budgetMb: number, verdict: "OK" | "BREACH"): string =>
  `brancheliste-parse (${label}): ${m.peakRssMb.toFixed(1)} MB / ${budgetMb} MB ${verdict}`;

/** The bench's pure helpers, as the dynamic import must expose them. */
type RssHelpers = {
  readonly maxRssBytes: (maxRss: number, currentRssBytes: number) => number;
  readonly parsePeakBytes: (lifetimePeakBefore: number, lifetimePeakAfter: number, sampledPeak: number) => number;
};

const loadRssHelpers = async (): Promise<RssHelpers> => {
  // A computed specifier: `tsc` leaves it unresolved, so the bench stays out of `rootDir`.
  const mod: Record<string, unknown> = await import(BENCH);
  const { maxRssBytes, parsePeakBytes } = mod;
  if (typeof maxRssBytes !== "function" || typeof parsePeakBytes !== "function") {
    throw new Error(`${BENCH} must export maxRssBytes and parsePeakBytes`);
  }
  return { maxRssBytes, parsePeakBytes } as RssHelpers;
};

const KB = 1024;
const MB = 1024 * 1024;

describe("bench RSS helpers (pure core)", () => {
  it.each([
    // [label, maxRSS as reported, current RSS in bytes, expected bytes]
    ["bytes (Bun on macOS): a peak above the current RSS is taken as is", 120 * MB, 80 * MB, 120 * MB],
    ["bytes: a peak equal to the current RSS is taken as is", 80 * MB, 80 * MB, 80 * MB],
    ["kilobytes (Node, Bun on Linux): a peak reading below the current RSS is scaled by 1024", 120 * KB, 80 * MB, 120 * MB],
    ["kilobytes: a peak equal to the current RSS once scaled", 80 * KB, 80 * MB, 80 * MB],
    ["kilobytes: one below the current RSS still reads as kilobytes", 80 * MB - 1, 80 * MB, (80 * MB - 1) * KB],
  ] as const)("maxRssBytes: %s", async (_label, maxRss, current, expected) => {
    const { maxRssBytes } = await loadRssHelpers();
    expect(maxRssBytes(maxRss, current)).toBe(expected);
  });

  it.each([
    // [label, lifetime peak before, lifetime peak after, sampled peak, expected]
    ["kernel: the parse raised the lifetime peak, so it wins over the samples", 90 * MB, 110 * MB, 100 * MB, 110 * MB],
    ["kernel: the lifetime peak catches a spike the samples missed", 90 * MB, 95 * MB, 91 * MB, 95 * MB],
    ["fallback: an unchanged lifetime peak was set before the parse, so the samples are used", 90 * MB, 90 * MB, 60 * MB, 60 * MB],
    ["fallback: a sample equal to the unchanged lifetime peak is reported", 90 * MB, 90 * MB, 90 * MB, 90 * MB],
    ["fallback: a lifetime peak that reads lower afterwards is not trusted", 90 * MB, 85 * MB, 70 * MB, 70 * MB],
  ] as const)("parsePeakBytes: %s", async (_label, before, after, sampled, expected) => {
    const { parsePeakBytes } = await loadRssHelpers();
    expect(parsePeakBytes(before, after, sampled)).toBe(expected);
  });
});

describe("parse memory budget (bench/parse-memory.ts)", () => {
  it(
    "AS-015: streaming the synthetic Brancheliste row by row peaks at or below 100 MB RSS",
    () => {
      const run = runBench(["--json"]);
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(0);

      const report = JSON.parse(run.stdout) as BenchReport;
      expect(report.ok).toBe(true);
      expect(report.budgetMb).toBe(100);
      // Without FUGUE_REAL_DATA_DIR only the synthetic workbook is measured.
      expect(report.measurements.map((m) => m.source)).toEqual(["synthetic"]);

      const synthetic = report.measurements[0]!;
      // Every data row reached the consumer (~0.5% of generated rows are blank and skipped).
      expect(synthetic.rows).toBeGreaterThanOrEqual(Math.floor(SYNTHETIC_ROWS * 0.98));
      expect(synthetic.rows).toBeLessThanOrEqual(SYNTHETIC_ROWS);
      expect(synthetic.peakRssMb).toBeGreaterThan(0);
      expect(synthetic.peakRssMb).toBeLessThanOrEqual(100);
      expect(report.lines).toEqual([line(`synthetic Brancheliste, ${SYNTHETIC_ROWS} rows`, synthetic, 100, "OK")]);
    },
    120_000,
  );

  it(
    "AS-015: a breached budget is named with its value and the bench exits non-zero",
    () => {
      const run = runBench(["--budget-mb", "1"]);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toMatch(
        /^brancheliste-parse \(synthetic Brancheliste, 25600 rows\): \d+\.\d MB \/ 1 MB BREACH$/m,
      );
    },
    120_000,
  );

  it("rejects unknown flags and non-positive budgets with exit code 2", () => {
    for (const args of [["--budget-mb", "0"], ["--budget-mb", "-3"], ["--budget-mb", "abc"], ["--budget-mb"], ["--nope"]]) {
      const run = runBench(args);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain("usage: bun bench/parse-memory.ts");
    }
  });

  describe("a malformed child report", () => {
    let cwd = "";

    beforeAll(async () => {
      // A cwd bunfig preload prints a line before the child's JSON report, so
      // the report the parent reads is not JSON.
      cwd = await mkdtemp(join(tmpdir(), "fugue-parse-memory-noise-"));
      await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./noise.ts"]\n');
      await writeFile(join(cwd, "noise.ts"), 'console.log("preload noise");\n');
    });

    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    it(
      "is a measurement failure (exit 2) naming the unreadable report, never a budget breach (exit 1)",
      () => {
        const run = runBench(["--json"], undefined, cwd);
        expect(run.exitCode).toBe(2);
        expect(run.stderr).toContain("unreadable child report");
        expect(run.stderr).toContain("preload noise");
      },
      120_000,
    );
  });

  describe("with FUGUE_REAL_DATA_DIR", () => {
    let dir = "";
    let empty = "";

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "fugue-parse-memory-"));
      empty = await mkdtemp(join(tmpdir(), "fugue-parse-memory-empty-"));
      await writeFile(join(dir, "Brancheliste.xlsx"), await syntheticBrancheliste(500, 11));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    });

    it(
      "also measures <dir>/Brancheliste.xlsx against the same budget",
      () => {
        const run = runBench(["--json"], dir);
        expect(run.stderr).toBe("");
        expect(run.exitCode).toBe(0);

        const report = JSON.parse(run.stdout) as BenchReport;
        expect(report.measurements.map((m) => m.source)).toEqual(["synthetic", "real"]);
        const real = report.measurements[1]!;
        const realPath = join(dir, "Brancheliste.xlsx");
        expect(real.label).toBe(realPath);
        expect(real.rows).toBeGreaterThanOrEqual(Math.floor(500 * 0.98));
        expect(real.peakRssMb).toBeLessThanOrEqual(100);
        expect(report.lines[1]).toBe(line(realPath, real, 100, "OK"));
      },
      120_000,
    );

    it("a set FUGUE_REAL_DATA_DIR without Brancheliste.xlsx is an error, never a silent skip", () => {
      const run = runBench([], empty);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(`FUGUE_REAL_DATA_DIR is set but ${join(empty, "Brancheliste.xlsx")} is missing`);
    });
  });
});
