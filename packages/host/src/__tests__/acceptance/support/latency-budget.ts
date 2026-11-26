/**
 * Latency budget harness for the acceptance budgets (NFR-002, NFR-003, SC-011).
 *
 * Every transport is an instantly-resolving fake, so each measured millisecond
 * is host-added. 50 discarded warm-up iterations absorb JIT, the first signing-key
 * fetch (which NFR-003 excludes) and key import; then 500 samples are timed with
 * `performance.now()` around `run` alone, any per-sample `prepare` (a fresh
 * wiring for a cold sample) staying outside the timed region. The p95 is the
 * nearest-rank percentile, printed for the live-verification evidence template.
 */

export const WARM_UP_ITERATIONS = 50;
export const TIMED_SAMPLES = 500;

/** Nearest-rank percentile: the smallest sample with at least `percentile`% of the samples at or below it. */
export const nearestRankPercentile = (samples: readonly number[], percentile: number): number => {
  if (samples.length === 0) throw new RangeError("nearestRankPercentile: no samples");
  if (!(percentile > 0 && percentile <= 100)) throw new RangeError(`nearestRankPercentile: percentile ${percentile} outside (0, 100]`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[rank - 1] as number;
};

export type LatencyReport = {
  readonly label: string;
  readonly budgetMs: number;
  readonly warmUps: number;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

export type LatencyMeasurement<P> = {
  readonly label: string;
  readonly budgetMs: number;
  /** Per-iteration setup, outside the timed region. */
  readonly prepare: () => P | Promise<P>;
  /** The timed operation. */
  readonly run: (prepared: P) => Promise<void>;
  readonly warmUps?: number;
  readonly samples?: number;
};

export const measureLatency = async <P>(measurement: LatencyMeasurement<P>): Promise<LatencyReport> => {
  const warmUps = measurement.warmUps ?? WARM_UP_ITERATIONS;
  const sampleCount = measurement.samples ?? TIMED_SAMPLES;
  for (let i = 0; i < warmUps; i++) {
    await measurement.run(await measurement.prepare());
  }
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const prepared = await measurement.prepare();
    const started = performance.now();
    await measurement.run(prepared);
    samples.push(performance.now() - started);
  }
  const report: LatencyReport = {
    label: measurement.label,
    budgetMs: measurement.budgetMs,
    warmUps,
    samples: samples.length,
    p50Ms: nearestRankPercentile(samples, 50),
    p95Ms: nearestRankPercentile(samples, 95),
    maxMs: nearestRankPercentile(samples, 100),
  };
  console.log(
    `[latency-budget] ${report.label}: p95 ${report.p95Ms.toFixed(3)} ms (budget ${report.budgetMs} ms), ` +
      `p50 ${report.p50Ms.toFixed(3)} ms, max ${report.maxMs.toFixed(3)} ms over ${report.samples} samples after ${report.warmUps} warm-ups`,
  );
  return report;
};
