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
 * modules, starts an RSS sampler thread, collects garbage and records its RSS
 * (the baseline). It then reads the bytes, `openWorkbook`s and `foldRows` with
 * a counting step. No row is retained, so the rows reach the consumer one at a
 * time. The budgeted value is the parse's own peak: the highest RSS while
 * parsing minus that baseline.
 *
 * The highest RSS is the kernel's lifetime peak when the parse raised it, and
 * otherwise the highest sample from a worker thread polling RSS every 1 ms
 * through the whole parse, including the synchronous `openWorkbook` (shared
 * strings and styles) that a main-thread sampler could not observe.
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
 * a fixture or temp-file failure, a failed parse, an unreadable child report or
 * an inconsistent measurement (peak below baseline).
 *
 * The pure core (argument parsing, peak rules, verdict) lives in
 * `src/__tests__/support/bench-core.ts`; this file is its imperative shell.
 * `src/__tests__/memory-budget.test.ts` runs this in CI against the synthetic
 * workbook; the real-data run is the local acceptance bar.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { err, formatFrameworkError, ok, type Result } from "@fuguejs/framework";
import { foldRows, openWorkbook } from "../src/index.js";
import {
  benchReport,
  BRANCHELISTE_ROWS,
  detailLine,
  maxRssBytes,
  parseBenchArgs,
  parseChildReport,
  parsePeak,
  REAL_BRANCHELISTE_FILE,
  realBranchelistePath,
  SYNTHETIC_LABEL,
  SYNTHETIC_SEED,
  toMeasurement,
  type ParseMeasurement,
  type RssSample,
} from "../src/__tests__/support/bench-core.js";
import { realDataDir } from "../src/__tests__/support/real-data-dir.js";
import { startRssSampler } from "../src/__tests__/support/rss-sampler.js";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run an effect, turning a rejection into a described error instead of an unhandled one. */
const attempt = async <A>(what: string, effect: () => Promise<A>): Promise<Result<A, string>> => {
  try {
    return ok(await effect());
  } catch (e) {
    return err(`${what}: ${message(e)}`);
  }
};

/** Read, open and fold one workbook with a counting step; no row is retained. */
const countRows = async (file: string): Promise<Result<number, string>> => {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const workbook = openWorkbook(bytes);
  if (!workbook.ok) return err(`${file}: ${formatFrameworkError(workbook.error)}`);
  const rows = await foldRows(workbook.value, z.unknown(), {}, 0, (count) => count + 1);
  return rows.ok ? ok(rows.value) : err(`${file}: ${formatFrameworkError(rows.error)}`);
};

/** Child mode: stream one workbook while the sampler thread polls RSS. */
const measure = async (file: string): Promise<Result<RssSample, string>> => {
  const sampler = await startRssSampler();
  Bun.gc(true);
  const baselineRssBytes = process.memoryUsage.rss();
  const lifetimePeakBefore = maxRssBytes(process.resourceUsage().maxRSS, baselineRssBytes);

  sampler.start();
  const counted = await attempt(`reading ${file}`, () => countRows(file));
  const rows = counted.ok ? counted.value : counted;
  const sampled = await sampler.stop();
  if (!rows.ok) return rows;

  const current = process.memoryUsage.rss();
  const lifetimePeakAfter = maxRssBytes(process.resourceUsage().maxRSS, current);
  const peak = parsePeak(lifetimePeakBefore, lifetimePeakAfter, Math.max(sampled.peakRssBytes, current));
  return ok({
    rows: rows.value,
    baselineRssBytes,
    processPeakRssBytes: peak.bytes,
    peakSource: peak.source,
    samples: sampled.samples,
  });
};

/** Run the parse in a fresh process so its peak RSS is the parse's alone. */
const measureInChild = (source: ParseMeasurement["source"], file: string, label: string): Result<ParseMeasurement, string> => {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--measure", file], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) return err(`measuring ${label} failed (exit ${child.exitCode}): ${child.stderr.toString().trim()}`);
  const sample = parseChildReport(child.stdout.toString());
  return sample.ok ? toMeasurement(source, label, sample.value) : err(`measuring ${label}: ${sample.error}`);
};

/** Build the synthetic Brancheliste into a temporary file and measure it. Fixture and file failures are errors (exit 2). */
const measureSynthetic = async (): Promise<Result<ParseMeasurement, string>> => {
  const fixture = await attempt("building the synthetic Brancheliste", async () => {
    // Loaded here, not at the top: the child (`--measure`) must not pay for ExcelJS/JSZip.
    const { syntheticBrancheliste } = await import("../src/__tests__/support/fixtures.js");
    return syntheticBrancheliste(BRANCHELISTE_ROWS, SYNTHETIC_SEED);
  });
  if (!fixture.ok) return fixture;
  const dir = await attempt("creating a temporary directory", () => mkdtemp(join(tmpdir(), "fugue-parse-memory-")));
  if (!dir.ok) return dir;
  const file = join(dir.value, REAL_BRANCHELISTE_FILE);
  const written = await attempt(`writing ${file}`, () => writeFile(file, fixture.value));
  const measured = written.ok ? measureInChild("synthetic", file, SYNTHETIC_LABEL) : written;
  // A leftover temp directory is not a measurement failure; say so and keep the result.
  await rm(dir.value, { recursive: true, force: true }).catch((e: unknown) =>
    console.error(`warning: could not remove ${dir.value}: ${message(e)}`),
  );
  return measured;
};

const bench = async (json: boolean, budgetMb: number): Promise<number> => {
  const realPath = realBranchelistePath(realDataDir(process.env, process.cwd()));
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
  const report = benchReport(measured.flatMap((m) => (m.ok ? [m.value] : [])), budgetMb);
  console.log(
    json
      ? JSON.stringify(report)
      : report.lines.flatMap((line, i) => [line, detailLine(report.measurements[i]!)]).join("\n"),
  );
  return report.ok ? 0 : 1;
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

// The outermost boundary: anything unexpected is a failed measurement (exit 2), never a breach (exit 1).
if (import.meta.main) {
  process.exit(
    await main(process.argv.slice(2)).catch((e: unknown) => {
      console.error(`parse-memory bench failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return 2;
    }),
  );
}
