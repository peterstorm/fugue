/**
 * Functional core of the parse-memory benchmark (`bench/parse-memory.ts`,
 * AS-015, NFR-002, SC-013) — dev-only bench support.
 *
 * Everything here is pure: argument parsing, the RSS unit and peak rules, the
 * child-report boundary parse, the budget verdict and the report shape. The
 * bench script is the imperative shell around it; `memory-budget.test.ts`
 * imports this module directly, with real types.
 */
import { join } from "node:path";
import { z } from "zod";
import type { Result } from "@fuguejs/framework";
import { err, ok } from "@fuguejs/framework";
import type { RealDataDir } from "./real-data-dir.js";

/** The Brancheliste parse budget (NFR-002, AS-015), in MB (2^20 bytes) above the loaded-modules baseline. */
export const BRANCHELISTE_PARSE_BUDGET_MB = 100;

/** Rows in the real master list; the synthetic Brancheliste mirrors it. */
export const BRANCHELISTE_ROWS = 25_600;

/** Seed of the synthetic Brancheliste the bench measures. */
export const SYNTHETIC_SEED = 20_261_109;

/** The real master list's file name inside `FUGUE_REAL_DATA_DIR`. */
export const REAL_BRANCHELISTE_FILE = "Brancheliste.xlsx";

/** The synthetic workbook's label in verdict lines and reports. */
export const SYNTHETIC_LABEL = `synthetic Brancheliste, ${BRANCHELISTE_ROWS} rows`;

const BYTES_PER_MB = 1024 * 1024;

const USAGE = "usage: bun bench/parse-memory.ts [--json] [--budget-mb <positive number>]";

export type BenchArgs =
  | { readonly kind: "bench"; readonly json: boolean; readonly budgetMb: number }
  | { readonly kind: "measure"; readonly file: string };

/**
 * Which reading decided the parse's peak: the kernel's lifetime peak (when the
 * parse raised it), or the timer samples taken while parsing.
 */
const PeakSourceSchema = z.enum(["kernel-lifetime-peak", "timer-samples"]);
type PeakSource = z.infer<typeof PeakSourceSchema>;

/** What one child process observed, in bytes: the `--measure` report on stdout. */
const RssSampleSchema = z
  .object({
    /** Rows delivered to the fold step. */
    rows: z.number().int().nonnegative(),
    /** Process RSS after module load and a full GC, just before the parse. */
    baselineRssBytes: z.number().positive(),
    /** Highest process RSS while parsing. */
    processPeakRssBytes: z.number().positive(),
    peakSource: PeakSourceSchema,
    /** RSS samples the timer took while parsing. */
    samples: z.number().int().nonnegative(),
  })
  .readonly();
export type RssSample = z.infer<typeof RssSampleSchema>;

const ParseMeasurementSchema = z
  .object({
    source: z.enum(["synthetic", "real"]),
    /** The workbook measured: the synthetic description or the real file's path. */
    label: z.string(),
    rows: z.number().int().nonnegative(),
    /** The budgeted value: the parse's peak RSS above the loaded-modules baseline. */
    peakRssMb: z.number().nonnegative(),
    baselineRssMb: z.number().positive(),
    processPeakRssMb: z.number().positive(),
    peakSource: PeakSourceSchema,
    samples: z.number().int().nonnegative(),
  })
  .readonly();
export type ParseMeasurement = z.infer<typeof ParseMeasurementSchema>;

/** The `--json` report. */
export const BenchReportSchema = z
  .object({
    ok: z.boolean(),
    budgetMb: z.number().positive(),
    measurements: z.array(ParseMeasurementSchema).readonly(),
    lines: z.array(z.string()).readonly(),
  })
  .readonly();
export type BenchReport = z.infer<typeof BenchReportSchema>;

/** The highest RSS while parsing, and which reading it came from. */
export type PeakReading = { readonly bytes: number; readonly source: PeakSource };

/** Parse the command line. `--measure <file>` is the internal child mode. */
export const parseBenchArgs = (argv: readonly string[]): Result<BenchArgs, string> => {
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
 * The highest RSS while parsing. The kernel's lifetime peak catches every
 * spike, but only counts if the parse set it: if it did not grow during the
 * parse, the peak was set earlier (module load) and the timer samples are the
 * parse's peak.
 *
 * The samples come from a worker thread on a 1 ms timer that runs through the
 * whole parse, including the synchronous `openWorkbook` (shared strings and
 * styles load) and the fold. A spike that rises and frees within one interval
 * can still be missed, but only when it also stays below the module-load peak.
 */
export const parsePeak = (lifetimePeakBefore: number, lifetimePeakAfter: number, sampledPeak: number): PeakReading =>
  lifetimePeakAfter > lifetimePeakBefore
    ? { bytes: lifetimePeakAfter, source: "kernel-lifetime-peak" }
    : { bytes: sampledPeak, source: "timer-samples" };

/**
 * One child's sample as a measurement. A peak below the baseline is an
 * inconsistent sample, never a 0 MB pass, so it is an error (exit 2).
 */
export const toMeasurement = (
  source: ParseMeasurement["source"],
  label: string,
  sample: RssSample,
): Result<ParseMeasurement, string> => {
  const delta = sample.processPeakRssBytes - sample.baselineRssBytes;
  const mb = (bytes: number): number => bytes / BYTES_PER_MB;
  if (delta < 0) {
    return err(
      `inconsistent measurement of ${label}: parse peak ${mb(sample.processPeakRssBytes).toFixed(1)} MB is below the ` +
        `${mb(sample.baselineRssBytes).toFixed(1)} MB baseline`,
    );
  }
  return ok({
    source,
    label,
    rows: sample.rows,
    peakRssMb: mb(delta),
    baselineRssMb: mb(sample.baselineRssBytes),
    processPeakRssMb: mb(sample.processPeakRssBytes),
    peakSource: sample.peakSource,
    samples: sample.samples,
  });
};

/** `<dir>/Brancheliste.xlsx` when `FUGUE_REAL_DATA_DIR` names a directory, else `null`. */
export const realBranchelistePath = (dir: RealDataDir): string | null =>
  dir.kind === "set" ? join(dir.dir, REAL_BRANCHELISTE_FILE) : null;

/** The verdict line for one measurement. */
export const verdictLine = (m: ParseMeasurement, budgetMb: number): string =>
  `brancheliste-parse (${m.label}): ${m.peakRssMb.toFixed(1)} MB / ${budgetMb} MB ${m.peakRssMb <= budgetMb ? "OK" : "BREACH"}`;

/** The report over every measurement (the synthetic one is always present); the budget holds when none exceeds it. */
export const benchReport = (measurements: readonly ParseMeasurement[], budgetMb: number): BenchReport => ({
  ok: measurements.every((m) => m.peakRssMb <= budgetMb),
  budgetMb,
  measurements,
  lines: measurements.map((m) => verdictLine(m, budgetMb)),
});

/** The absolute numbers printed under each verdict line. */
export const detailLine = (m: ParseMeasurement): string =>
  `  ${m.rows} rows; process RSS ${m.baselineRssMb.toFixed(1)} MB before the parse (modules loaded), ` +
  `${m.processPeakRssMb.toFixed(1)} MB at peak (${m.peakSource}, ${m.samples} timer samples)`;

/**
 * Parse the child's stdout at the boundary: anything but one JSON `RssSample`
 * is a failed measurement (exit 2), never a thrown error that would exit 1 and
 * read as a budget breach.
 */
export const parseChildReport = (stdout: string): Result<RssSample, string> => {
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
