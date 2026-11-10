/**
 * Peak-RSS benchmark for the streaming Brancheliste parse (AS-015, NFR-002,
 * SC-002, SC-013).
 *
 *   bun bench/parse-memory.ts [--json] [--budget-mb <n>]
 *   FUGUE_REAL_DATA_DIR=/path/to/fugue-dags/data bun bench/parse-memory.ts
 *
 * Always measures the deterministic synthetic Brancheliste (25.6k rows, the
 * real file's shape). When `FUGUE_REAL_DATA_DIR` names a directory it also
 * measures `<dir>/Brancheliste.xlsx`; a set variable with the file missing is
 * an error, never a silent skip.
 *
 * ## What is measured
 *
 * Each workbook is parsed in a fresh child process (`--measure`) that loads the
 * modules, collects garbage, records its RSS (the baseline), then reads the
 * bytes, `openWorkbook`s and `foldRows` with a counting step. No row is
 * retained, so the rows reach the consumer one at a time. The budgeted value is
 * the parse's own peak: the highest RSS while parsing minus that baseline.
 *
 * The baseline is excluded because it is not parse memory. `@fuguejs/xlsx`
 * imports `ok`/`err` from the `@fuguejs/framework` barrel, which pulls in about
 * 70 MB of module graph; a host has already paid that before any parse. The
 * JSON report keeps the absolute numbers (`baselineRssMb`, `processPeakRssMb`)
 * next to the budgeted one. The parse runs in its own process so that the
 * fixture generator (ExcelJS, JSZip) and the parent are never counted.
 *
 * ## Output
 *
 * One verdict line per workbook, `brancheliste-parse (<workbook>): 73.2 MB /
 * 100 MB OK` (or `BREACH`), each followed by its absolute numbers; or a JSON
 * report with `--json`. "MB" is 2^20 bytes. Exit codes: 0 every measurement
 * within budget, 1 a budget breached, 2 bad arguments, a missing real workbook,
 * a failed parse or an unreadable child report.
 *
 * `src/__tests__/memory-budget.test.ts` runs this in CI against the synthetic
 * workbook; the real-data run is the local acceptance bar.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { err, formatFrameworkError, ok, type Result } from "@fuguejs/framework";
import { foldRows, openWorkbook } from "../src/index.js";

// ════════════════════════════════════════════════════════════════════════════
// Functional core
// ════════════════════════════════════════════════════════════════════════════

/** The Brancheliste parse budget (NFR-002, AS-015). */
const BRANCHELISTE_PARSE_BUDGET_MB = 100;

/** Rows in the real master list; the synthetic workbook mirrors it. */
const SYNTHETIC_ROWS = 25_600;
const SYNTHETIC_SEED = 20_261_109;
const REAL_FILE = "Brancheliste.xlsx";
const BYTES_PER_MB = 1024 * 1024;

const USAGE = "usage: bun bench/parse-memory.ts [--json] [--budget-mb <positive number>]";

type BenchArgs =
  | { readonly kind: "bench"; readonly json: boolean; readonly budgetMb: number }
  | { readonly kind: "measure"; readonly file: string };

/** What one child process observed, in bytes. */
type RssSample = {
  /** Rows delivered to the fold step. */
  readonly rows: number;
  /** Process RSS after module load and a full GC, just before the parse. */
  readonly baselineRssBytes: number;
  /** Highest process RSS while parsing. */
  readonly processPeakRssBytes: number;
};

type ParseMeasurement = {
  readonly source: "synthetic" | "real";
  /** The workbook measured: the synthetic description or the real file's path. */
  readonly label: string;
  readonly rows: number;
  /** The budgeted value: the parse's peak above the baseline. */
  readonly peakRssMb: number;
  readonly baselineRssMb: number;
  readonly processPeakRssMb: number;
};

type BudgetVerdict = { readonly ok: boolean; readonly lines: readonly string[] };

/** Parse the command line. `--measure <file>` is the internal child mode. */
const parseBenchArgs = (argv: readonly string[]): Result<BenchArgs, string> => {
  if (argv[0] === "--measure") {
    const [, file] = argv;
    return file !== undefined && argv.length === 2 ? ok({ kind: "measure", file }) : err(`--measure takes <file>\n${USAGE}`);
  }
  const go = (rest: readonly string[], acc: { readonly json: boolean; readonly budgetMb: number }): Result<BenchArgs, string> => {
    const [flag, value] = rest;
    if (flag === undefined) return ok({ kind: "bench", ...acc });
    if (flag === "--json") return go(rest.slice(1), { ...acc, json: true });
    if (flag === "--budget-mb") {
      const budgetMb = Number(value);
      return value !== undefined && value.trim() !== "" && Number.isFinite(budgetMb) && budgetMb > 0
        ? go(rest.slice(2), { ...acc, budgetMb })
        : err(`--budget-mb needs a positive number, got ${value ?? "nothing"}\n${USAGE}`);
    }
    return err(`unknown argument: ${flag}\n${USAGE}`);
  };
  return go(argv, { json: false, budgetMb: BRANCHELISTE_PARSE_BUDGET_MB });
};

/**
 * `process.resourceUsage().maxRSS` is kilobytes under Node and under Bun on
 * Linux (`ru_maxrss`), but bytes under Bun on macOS. The lifetime peak can
 * never be below the current RSS, so a value that reads below it as bytes is
 * kilobytes.
 */
export const maxRssBytes = (maxRss: number, currentRssBytes: number): number =>
  maxRss >= currentRssBytes ? maxRss : maxRss * 1024;

/**
 * The highest RSS while parsing. The kernel's lifetime peak catches spikes
 * between samples, but only counts if the parse set it: if it did not grow
 * during the parse, the peak was set earlier (module load) and the per-row
 * samples are the parse's peak.
 *
 * That fallback can undercount: the samples are taken once per delivered row,
 * so a transient spike between two rows (inflating a ZIP entry, a large
 * shared-strings table) that frees before the next sample and stays below the
 * module-load peak is missed. The kernel peak is used whenever the parse
 * raised it, so only a parse peak below the module-load peak is sampled.
 */
export const parsePeakBytes = (lifetimePeakBefore: number, lifetimePeakAfter: number, sampledPeak: number): number =>
  lifetimePeakAfter > lifetimePeakBefore ? lifetimePeakAfter : sampledPeak;

const toMeasurement = (source: ParseMeasurement["source"], label: string, sample: RssSample): ParseMeasurement => ({
  source,
  label,
  rows: sample.rows,
  peakRssMb: Math.max(0, sample.processPeakRssBytes - sample.baselineRssBytes) / BYTES_PER_MB,
  baselineRssMb: sample.baselineRssBytes / BYTES_PER_MB,
  processPeakRssMb: sample.processPeakRssBytes / BYTES_PER_MB,
});

/** `<dir>/Brancheliste.xlsx` when `FUGUE_REAL_DATA_DIR` names a directory (relative → against `cwd`), else `null`. */
const realBranchelistePath = (env: Readonly<Record<string, string | undefined>>, cwd: string): string | null => {
  const raw = env.FUGUE_REAL_DATA_DIR?.trim();
  if (raw === undefined || raw === "") return null;
  return join(isAbsolute(raw) ? raw : resolve(cwd, raw), REAL_FILE);
};

/** One verdict line per measurement (the synthetic one is always present); the budget holds when none exceeds it. */
const evaluateParseBudget = (measurements: readonly ParseMeasurement[], budgetMb: number): BudgetVerdict => ({
  ok: measurements.every((m) => m.peakRssMb <= budgetMb),
  lines: measurements.map(
    (m) => `brancheliste-parse (${m.label}): ${m.peakRssMb.toFixed(1)} MB / ${budgetMb} MB ${m.peakRssMb <= budgetMb ? "OK" : "BREACH"}`,
  ),
});

const detailLine = (m: ParseMeasurement): string =>
  `  ${m.rows} rows; process RSS ${m.baselineRssMb.toFixed(1)} MB before the parse (modules loaded), ${m.processPeakRssMb.toFixed(1)} MB at peak`;

// ════════════════════════════════════════════════════════════════════════════
// Imperative shell
// ════════════════════════════════════════════════════════════════════════════

/** Child report: what `--measure` prints on stdout. */
const RssSampleSchema = z.object({
  rows: z.number().int().nonnegative(),
  baselineRssBytes: z.number().positive(),
  processPeakRssBytes: z.number().positive(),
});

/** Child mode: stream one workbook, counting rows, sampling RSS as rows arrive. */
const measure = async (file: string): Promise<Result<RssSample, string>> => {
  Bun.gc(true);
  const baselineRssBytes = process.memoryUsage.rss();
  const lifetimePeakBefore = maxRssBytes(process.resourceUsage().maxRSS, baselineRssBytes);

  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const workbook = openWorkbook(bytes);
  if (!workbook.ok) return err(`${file}: ${formatFrameworkError(workbook.error)}`);
  let sampledPeak = process.memoryUsage.rss();
  const rows = await foldRows(workbook.value, z.unknown(), {}, 0, (count) => {
    sampledPeak = Math.max(sampledPeak, process.memoryUsage.rss());
    return count + 1;
  });
  if (!rows.ok) return err(`${file}: ${formatFrameworkError(rows.error)}`);

  const current = process.memoryUsage.rss();
  const lifetimePeakAfter = maxRssBytes(process.resourceUsage().maxRSS, current);
  return ok({
    rows: rows.value,
    baselineRssBytes,
    processPeakRssBytes: parsePeakBytes(lifetimePeakBefore, lifetimePeakAfter, Math.max(sampledPeak, current)),
  });
};

/** Run the parse in a fresh process so its peak RSS is the parse's alone. */
const measureInChild = (source: ParseMeasurement["source"], file: string, label: string): Result<ParseMeasurement, string> => {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--measure", file], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) return err(`measuring ${label} failed (exit ${child.exitCode}): ${child.stderr.toString().trim()}`);
  const sample = parseChildReport(child.stdout.toString());
  return sample.ok ? ok(toMeasurement(source, label, sample.value)) : err(`measuring ${label}: ${sample.error}`);
};

/**
 * Parse the child's stdout at the boundary: anything but one JSON `RssSample`
 * is a failed measurement (exit 2), never a thrown error that would exit 1 and
 * read as a budget breach.
 */
const parseChildReport = (stdout: string): Result<RssSample, string> => {
  const unreadable = (why: string): Result<RssSample, string> =>
    err(`unreadable child report (${why}): ${JSON.stringify(stdout.trim())}`);
  const json = ((): Result<unknown, string> => {
    try {
      return ok(JSON.parse(stdout));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  })();
  if (!json.ok) return unreadable(`not JSON: ${json.error}`);
  const sample = RssSampleSchema.safeParse(json.value);
  return sample.success ? ok(sample.data) : unreadable(sample.error.message);
};

const measureSynthetic = async (): Promise<Result<ParseMeasurement, string>> => {
  // Loaded here, not at the top: the child (`--measure`) must not pay for ExcelJS/JSZip.
  const { syntheticBrancheliste } = await import("../src/__tests__/support/fixtures.js");
  const dir = await mkdtemp(join(tmpdir(), "fugue-parse-memory-"));
  try {
    const file = join(dir, REAL_FILE);
    await writeFile(file, await syntheticBrancheliste(SYNTHETIC_ROWS, SYNTHETIC_SEED));
    return measureInChild("synthetic", file, `synthetic Brancheliste, ${SYNTHETIC_ROWS} rows`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const bench = async (json: boolean, budgetMb: number): Promise<number> => {
  const realPath = realBranchelistePath(process.env, process.cwd());
  if (realPath !== null && !existsSync(realPath)) {
    console.error(`FUGUE_REAL_DATA_DIR is set but ${realPath} is missing`);
    return 2;
  }
  const measured = [await measureSynthetic(), ...(realPath === null ? [] : [measureInChild("real", realPath, realPath)])];
  const failures = measured.flatMap((m) => (m.ok ? [] : [m.error]));
  if (failures.length > 0) {
    failures.forEach((f) => console.error(f));
    return 2;
  }
  const measurements = measured.flatMap((m) => (m.ok ? [m.value] : []));
  const verdict = evaluateParseBudget(measurements, budgetMb);
  console.log(
    json
      ? JSON.stringify({ ok: verdict.ok, budgetMb, measurements, lines: verdict.lines })
      : verdict.lines.flatMap((line, i) => [line, detailLine(measurements[i]!)]).join("\n"),
  );
  return verdict.ok ? 0 : 1;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const args = parseBenchArgs(argv);
  if (!args.ok) {
    console.error(args.error);
    return 2;
  }
  if (args.value.kind === "bench") return bench(args.value.json, args.value.budgetMb);
  const sample = await measure(args.value.file);
  if (!sample.ok) {
    console.error(sample.error);
    return 2;
  }
  console.log(JSON.stringify(sample.value));
  return 0;
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
