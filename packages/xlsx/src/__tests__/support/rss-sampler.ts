/**
 * A concurrent RSS sampler for the parse-memory benchmark — dev-only bench
 * support.
 *
 * The sampler runs in a worker thread on a 1 ms timer, so it keeps sampling
 * while the main thread is blocked in synchronous work: `openWorkbook` inflates
 * and decodes the shared strings and styles without ever yielding. RSS is
 * process-wide, so the worker sees the parse's memory. The worker is started
 * before the baseline is taken, so its own footprint is part of the baseline.
 *
 * This module is both sides: imported on the main thread it exports
 * `startRssSampler`; loaded as the worker (marked by its `workerData`) it runs
 * the sampling loop. Phases are handed over through one shared `Int32Array`
 * slot, which the blocked main thread can write without a message round trip.
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** Sampling interval of the worker's timer. */
const SAMPLE_INTERVAL_MS = 1;

/** Phase slot values; the slot starts at 0 (idle). */
const SAMPLING = 1;
const STOPPING = 2;

const ROLE = "fugue-rss-sampler";

type SamplerData = { readonly role: typeof ROLE; readonly phase: Int32Array };

/** What the worker saw between `start` and `stop`. */
export type SamplerReport = { readonly peakRssBytes: number; readonly samples: number };

export type RssSampler = {
  /** Begin sampling (the measured window opens). Never blocks. */
  readonly start: () => void;
  /** Take a last sample, end the worker and report the window's peak. Rejects if the worker failed. */
  readonly stop: () => Promise<SamplerReport>;
};

const isSamplerData = (data: unknown): data is SamplerData =>
  typeof data === "object" && data !== null && (data as { role?: unknown }).role === ROLE;

const isReport = (m: unknown): m is SamplerReport =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as { peakRssBytes?: unknown }).peakRssBytes === "number" &&
  typeof (m as { samples?: unknown }).samples === "number";

/** The next message from `worker`; rejects if the worker errors or exits first. */
const nextMessage = (worker: Worker): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const onMessage = (m: unknown): void => {
      cleanup();
      resolve(m);
    };
    const onError = (e: unknown): void => {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`RSS sampler worker exited (code ${code}) before reporting`));
    };
    const cleanup = (): void => {
      worker.off("message", onMessage).off("error", onError).off("exit", onExit);
    };
    worker.on("message", onMessage).on("error", onError).on("exit", onExit);
  });

/** Start the sampler worker and wait until its timer runs. The window opens with `start`. */
export const startRssSampler = async (): Promise<RssSampler> => {
  const phase = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const data: SamplerData = { role: ROLE, phase };
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  const ready = await nextMessage(worker);
  if (ready !== "ready") throw new Error(`RSS sampler worker sent ${JSON.stringify(ready)} instead of "ready"`);
  return {
    start: () => {
      Atomics.store(phase, 0, SAMPLING);
    },
    stop: async () => {
      const report = nextMessage(worker);
      Atomics.store(phase, 0, STOPPING);
      const message = await report;
      await worker.terminate();
      if (!isReport(message)) throw new Error(`RSS sampler worker sent an unreadable report: ${JSON.stringify(message)}`);
      return message;
    },
  };
};

/** Worker side: sample on every tick while the window is open; report and stop when asked. */
const runSampler = (phase: Int32Array, port: NonNullable<typeof parentPort>): void => {
  let peakRssBytes = 0;
  let samples = 0;
  const sample = (): void => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    samples += 1;
  };
  const tick = setInterval(() => {
    const now = Atomics.load(phase, 0);
    if (now === SAMPLING) sample();
    if (now === STOPPING) {
      clearInterval(tick);
      sample();
      port.postMessage({ peakRssBytes, samples } satisfies SamplerReport);
    }
  }, SAMPLE_INTERVAL_MS);
  port.postMessage("ready");
};

if (!isMainThread && parentPort !== null && isSamplerData(workerData)) runSampler(workerData.phase, parentPort);
