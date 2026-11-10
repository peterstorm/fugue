/**
 * CI memory budget for the streaming parse (AS-015, SC-013).
 *
 * Spawns `bench/parse-memory.ts` — the same benchmark run locally against the
 * real Brancheliste — on the deterministic synthetic Brancheliste (25.6k rows)
 * and asserts the parse's peak RSS above the loaded-modules baseline stays at
 * or below 100 MB. The baseline (process RSS after module load and a full GC,
 * mostly the `@fuguejs/framework` module graph) is reported but not budgeted.
 * The parse runs in its own child process, so the fixture generator's memory
 * (ExcelJS, JSZip) is never counted against the budget.
 *
 * The bench's pure core (`support/bench-core.ts`) is imported with real types
 * and tested directly; the bench itself is driven through its CLI. The real
 * workbook is local-only (`FUGUE_REAL_DATA_DIR`); the real-data path is
 * exercised here against a small synthetic workbook in a temporary directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchReport,
  BenchReportSchema,
  BRANCHELISTE_PARSE_BUDGET_MB,
  BRANCHELISTE_ROWS,
  maxRssBytes,
  parseBenchArgs,
  parseChildReport,
  parsePeak,
  realBranchelistePath,
  SYNTHETIC_LABEL,
  toMeasurement,
  verdictLine,
  type ParseMeasurement,
  type RssSample,
} from "./support/bench-core.js";
import { startRssSampler } from "./support/rss-sampler.js";
import { syntheticBrancheliste } from "./support/fixtures.js";

const BENCH = join(import.meta.dir, "..", "..", "bench", "parse-memory.ts");

type BenchRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

type BenchEnv = { readonly realDataDir?: string; readonly cwd?: string; readonly extraEnv?: Readonly<Record<string, string>> };

const runBench = (args: readonly string[], options: BenchEnv = {}): BenchRun => {
  const { FUGUE_REAL_DATA_DIR: _inherited, ...env } = process.env;
  const proc = Bun.spawnSync([process.execPath, BENCH, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...env,
      ...options.extraEnv,
      ...(options.realDataDir === undefined ? {} : { FUGUE_REAL_DATA_DIR: options.realDataDir }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

const KB = 1024;
const MB = 1024 * 1024;

const sample = (overrides: Partial<RssSample> = {}): RssSample => ({
  rows: 10,
  baselineRssBytes: 70 * MB,
  processPeakRssBytes: 90 * MB,
  peakSource: "timer-samples",
  samples: 5,
  ...overrides,
});

const measurement = (label: string, peakRssMb: number): ParseMeasurement => ({
  source: "synthetic",
  label,
  rows: 1,
  peakRssMb,
  baselineRssMb: 70,
  processPeakRssMb: 70 + peakRssMb,
  peakSource: "timer-samples",
  samples: 1,
});

describe("bench core: RSS rules", () => {
  it.each([
    // [label, maxRSS as reported, current RSS in bytes, expected bytes]
    ["bytes (Bun on macOS): a peak above the current RSS is taken as is", 120 * MB, 80 * MB, 120 * MB],
    ["bytes: a peak equal to the current RSS is taken as is", 80 * MB, 80 * MB, 80 * MB],
    ["kilobytes (Node, Bun on Linux): a peak reading below the current RSS is scaled by 1024", 120 * KB, 80 * MB, 120 * MB],
    ["kilobytes: a peak equal to the current RSS once scaled", 80 * KB, 80 * MB, 80 * MB],
    ["kilobytes: one below the current RSS still reads as kilobytes", 80 * MB - 1, 80 * MB, (80 * MB - 1) * KB],
  ] as const)("maxRssBytes: %s", (_label, maxRss, current, expected) => {
    expect(maxRssBytes(maxRss, current)).toBe(expected);
  });

  it.each([
    // [label, lifetime peak before, lifetime peak after, sampled peak, expected bytes, expected source]
    ["kernel: the parse raised the lifetime peak, so it wins over the samples", 90 * MB, 110 * MB, 100 * MB, 110 * MB, "kernel-lifetime-peak"],
    ["kernel: the lifetime peak catches a spike the samples missed", 90 * MB, 95 * MB, 91 * MB, 95 * MB, "kernel-lifetime-peak"],
    ["samples: an unchanged lifetime peak was set before the parse", 90 * MB, 90 * MB, 60 * MB, 60 * MB, "timer-samples"],
    ["samples: a sample equal to the unchanged lifetime peak is reported", 90 * MB, 90 * MB, 90 * MB, 90 * MB, "timer-samples"],
    ["samples: a lifetime peak that reads lower afterwards is not trusted", 90 * MB, 85 * MB, 70 * MB, 70 * MB, "timer-samples"],
  ] as const)("parsePeak: %s", (_label, before, after, sampled, bytes, source) => {
    expect(parsePeak(before, after, sampled)).toEqual({ bytes, source });
  });

  it("toMeasurement budgets the peak above the baseline, in MB, and keeps the absolute numbers", () => {
    const m = toMeasurement("real", "/data/Brancheliste.xlsx", sample({ peakSource: "kernel-lifetime-peak" }));
    expect(m).toEqual({
      ok: true,
      value: {
        source: "real",
        label: "/data/Brancheliste.xlsx",
        rows: 10,
        peakRssMb: 20,
        baselineRssMb: 70,
        processPeakRssMb: 90,
        peakSource: "kernel-lifetime-peak",
        samples: 5,
      },
    });
  });

  it("toMeasurement: a peak equal to the baseline is a 0 MB parse", () => {
    const m = toMeasurement("synthetic", "x", sample({ processPeakRssBytes: 70 * MB }));
    expect(m.ok && m.value.peakRssMb).toBe(0);
  });

  it("toMeasurement: a peak below the baseline is an inconsistent measurement, never a 0 MB pass", () => {
    const m = toMeasurement("synthetic", "x", sample({ processPeakRssBytes: 69 * MB }));
    expect(m).toEqual({
      ok: false,
      error: "inconsistent measurement of x: parse peak 69.0 MB is below the 70.0 MB baseline",
    });
  });
});

describe("bench core: arguments, child report, verdict", () => {
  it("parseBenchArgs reads the bench flags, the child mode, and rejects anything else", () => {
    expect(parseBenchArgs([])).toEqual({ ok: true, value: { kind: "bench", json: false, budgetMb: BRANCHELISTE_PARSE_BUDGET_MB } });
    expect(parseBenchArgs(["--json", "--budget-mb", "2.5"])).toEqual({ ok: true, value: { kind: "bench", json: true, budgetMb: 2.5 } });
    expect(parseBenchArgs(["--measure", "/f.xlsx"])).toEqual({ ok: true, value: { kind: "measure", file: "/f.xlsx" } });
    for (const bad of [["--measure"], ["--measure", "a", "b"], ["--budget-mb", " "], ["--budget-mb", "Infinity"], ["-j"]]) {
      expect(parseBenchArgs(bad).ok).toBe(false);
    }
  });

  it("parseChildReport accepts exactly one RssSample and names anything else as unreadable", () => {
    expect(parseChildReport(`${JSON.stringify(sample())}\n`)).toEqual({ ok: true, value: sample() });
    for (const bad of ["noise\n{}", JSON.stringify({ ...sample(), peakSource: "guess" }), JSON.stringify({ rows: 1 })]) {
      const parsed = parseChildReport(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toStartWith("unreadable child report");
    }
  });

  it("benchReport holds only when no measurement exceeds the budget, with one verdict line each", () => {
    const within = benchReport([measurement("a", 100), measurement("b", 3.25)], 100);
    expect(within.ok).toBe(true);
    expect(within.lines).toEqual(["brancheliste-parse (a): 100.0 MB / 100 MB OK", "brancheliste-parse (b): 3.3 MB / 100 MB OK"]);
    const breached = benchReport([measurement("a", 1), measurement("b", 100.01)], 100);
    expect(breached.ok).toBe(false);
    expect(breached.lines[1]).toBe("brancheliste-parse (b): 100.0 MB / 100 MB BREACH");
  });

  it("realBranchelistePath names <dir>/Brancheliste.xlsx only when the directory is set", () => {
    expect(realBranchelistePath({ kind: "unset" })).toBeNull();
    expect(realBranchelistePath({ kind: "set", dir: "/data" })).toBe("/data/Brancheliste.xlsx");
  });
});

describe("RSS sampler thread", () => {
  it("samples while the main thread is blocked in synchronous work", async () => {
    const sampler = await startRssSampler();
    const before = process.memoryUsage.rss();
    sampler.start();
    // Commit 64 MiB and hold it, synchronously, for 50 ms: no main-thread timer can run.
    const held = new Uint8Array(64 * MB).fill(1);
    const until = performance.now() + 50;
    while (performance.now() < until) held[0] = (held[0]! + 1) % 255;
    const report = await sampler.stop();
    expect(report.samples).toBeGreaterThan(0);
    expect(report.peakRssBytes).toBeGreaterThanOrEqual(before + 48 * MB);
  });
});

describe("parse memory budget (bench/parse-memory.ts)", () => {
  it(
    "AS-015: streaming the synthetic Brancheliste row by row peaks at or below 100 MB RSS above the loaded-modules baseline",
    () => {
      const run = runBench(["--json"]);
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(0);

      const report = BenchReportSchema.parse(JSON.parse(run.stdout));
      expect(report.ok).toBe(true);
      expect(report.budgetMb).toBe(100);
      // Without FUGUE_REAL_DATA_DIR only the synthetic workbook is measured.
      expect(report.measurements.map((m) => m.source)).toEqual(["synthetic"]);

      const synthetic = report.measurements[0]!;
      // Every data row reached the consumer (~0.5% of generated rows are blank and skipped).
      expect(synthetic.rows).toBeGreaterThanOrEqual(Math.floor(BRANCHELISTE_ROWS * 0.98));
      expect(synthetic.rows).toBeLessThanOrEqual(BRANCHELISTE_ROWS);
      expect(synthetic.samples).toBeGreaterThan(0);
      expect(synthetic.peakRssMb).toBeGreaterThan(0);
      expect(synthetic.peakRssMb).toBeLessThanOrEqual(100);
      expect(synthetic.processPeakRssMb - synthetic.baselineRssMb).toBeCloseTo(synthetic.peakRssMb, 6);
      expect(report.lines).toEqual([verdictLine(synthetic, 100)]);
      expect(synthetic.label).toBe(SYNTHETIC_LABEL);
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

  it(
    "a fixture or temp-file failure is a measurement failure (exit 2), never a budget breach (exit 1)",
    () => {
      const run = runBench(["--json"], { extraEnv: { TMPDIR: join(tmpdir(), "fugue-parse-memory-does-not-exist", "nested") } });
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain("creating a temporary directory");
      expect(run.stdout).toBe("");
    },
    120_000,
  );

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
        const run = runBench(["--json"], { cwd });
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
        const run = runBench(["--json"], { realDataDir: dir });
        expect(run.stderr).toBe("");
        expect(run.exitCode).toBe(0);

        const report = BenchReportSchema.parse(JSON.parse(run.stdout));
        expect(report.measurements.map((m) => m.source)).toEqual(["synthetic", "real"]);
        const real = report.measurements[1]!;
        const realPath = join(dir, "Brancheliste.xlsx");
        expect(real.label).toBe(realPath);
        expect(real.rows).toBeGreaterThanOrEqual(Math.floor(500 * 0.98));
        expect(real.peakRssMb).toBeLessThanOrEqual(100);
        expect(report.lines[1]).toBe(verdictLine(real, 100));
      },
      120_000,
    );

    it("a set FUGUE_REAL_DATA_DIR without Brancheliste.xlsx is an error, never a silent skip", () => {
      const run = runBench([], { realDataDir: empty });
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(`FUGUE_REAL_DATA_DIR is set but ${join(empty, "Brancheliste.xlsx")} is missing`);
    });
  });
});
