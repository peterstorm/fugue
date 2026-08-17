/**
 * Integration tests for `src/file/job.ts` — the durable `JobLike` adapter
 * (spec FR-001/FR-003/FR-004/FR-005/FR-006/FR-007; US1) driven through the
 * REAL kernel (`runStateMachine`) over REAL file journals:
 *
 * - kernel-driven crash-window dedup (SC-003/FR-004): a run whose
 *   `updateData` throws right after a successful `appendEvent` (the
 *   append-before-checkpoint window, FR-005) leaves one durable event and
 *   no checkpoint; a fresh `createFileJob` over the same directory
 *   re-derives the same dedupKey and lands exactly one record — the event
 *   log is authoritative, the checkpoint is recovered by the re-run.
 * - state survives in a fresh job instance over the same directory (FR-003,
 *   US1): the journal + atomic checkpoint reproduce the terminal state
 *   through the pure `replayEvents` fold, and the fresh instance continues
 *   the log at the next sequence.
 * - the full kernel surface round-trips: checkpoint projection content,
 *   per-transition progress, `RecordedEvent` envelopes with the injected
 *   clock.
 * - typed failure surface (AD-6): fs failures throw `FrameworkError`
 *   (`cache-error`, operation + directory in the message) instead of raw
 *   `Error`s — the shell-boundary conversion stays identity-safe — and a
 *   failed `updateData` never advances the in-memory snapshot.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStateMachine } from "../state-machine/runner.js";
import { replayEvents } from "../state-machine/replay.js";
import type { JobLike, Machine, KernelRunOpts } from "../state-machine/types.js";
import {
  createFileJob,
  createFileJournal,
  readFileEvents,
  readFileEventRecords,
  type CreateFileJobArgs,
} from "../file.js"; // the @fuguejs/framework/file barrel under test
import { CHECKPOINT_FILE, PROGRESS_FILE } from "../file/layout.js";
import { __testDeepFreeze } from "../file/job.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError, retriabilityOf } from "../types/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp directory, removed after the test. */
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "file-job-"));
  cleanup.push(dir);
  return dir;
};

const asCacheError = (
  error: unknown,
  operation: string,
): Extract<FrameworkError, { readonly kind: "cache-error" }> => {
  expect(isFrameworkError(error)).toBe(true);
  if (!isFrameworkError(error) || error.kind !== "cache-error") {
    throw new Error("expected a typed cache-error");
  }
  expect(error.kind).toBe("cache-error");
  expect(error.operation).toBe(operation);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
};

// ---------------------------------------------------------------------------
// Minimal two-transition machine — pending(0) →STEP→ pending(1) →DONE→ succeeded
// ---------------------------------------------------------------------------

type S = { kind: "pending"; count: number } | { kind: "succeeded"; count: number };
type E = { type: "STEP" } | { type: "DONE" };
type C = { value: number };

const machine: Machine<S, E, C> = {
  transition(state, event, context) {
    if (state.kind === "pending" && event.type === "STEP") {
      return { state: { kind: "pending", count: 1 }, context: { value: context.value + 1 } };
    }
    if (state.kind === "pending" && event.type === "DONE") {
      return { state: { kind: "succeeded", count: state.count }, context };
    }
    return { state, context };
  },
  isTerminal: (s) => s.kind === "succeeded",
  isFailed: () => false,
  stateProgress: (s) => (s.kind === "succeeded" ? 100 : 50),
  stateKey: (s) => JSON.stringify(s),
};

const genesis = (): { state: S; context: C } => ({ state: { kind: "pending", count: 0 }, context: { value: 0 } });

/**
 * Deterministic, FR-015-safe dedup keyer — mirrors what the DAG layer injects
 * (`sha256DedupKey`): the same transition re-derives the same key across
 * worker invocations, which is exactly what makes the crash window safe
 * (FR-004). The runner's string-concat fallback is intentionally NOT used
 * here (kernel fallback, documented in AD-2): the default-keyer ×
 * file-adapter path is pinned separately in the "kernel without
 * computeDedupKey" describe below, while real shells inject a digest keyer.
 */
const sha256DedupKey = (prevStateKey: string, attemptNumber: number, event: E): string =>
  `k:${createHash("sha256")
    .update(`${prevStateKey}|${attemptNumber}|${(event as { type: string }).type}`)
    .digest("hex")}`;

const runOpts = (): KernelRunOpts<S, E, C> => ({
  errorEventOf: () => ({ type: "DONE" }),
  computeDedupKey: sha256DedupKey,
});

// ---------------------------------------------------------------------------
// Kernel-driven crash-window dedup (SC-003, FR-004/FR-005)
// ---------------------------------------------------------------------------

describe("createFileJob — kernel-driven crash-window dedup via runStateMachine", () => {
  it("crash between appendEvent and updateData leaves the event durable and no checkpoint; the fresh re-run lands exactly one record", async () => {
    const dir = tempDir();

    // Worker attempt 1: the journal's appendEvent commits, then the process
    // "crashes" before the projection — updateData throws (the kernel
    // surfaces the failure; the transition is NOT advanced).
    const jobA = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const crashed = { fired: false };
    const crashingJob: JobLike<S, E, C> = {
      get data() {
        return jobA.data;
      },
      async updateData(d) {
        if (!crashed.fired) {
          crashed.fired = true;
          throw new Error("simulated crash between appendEvent and updateData");
        }
        await jobA.updateData(d);
      },
      async updateProgress(pct) {
        await jobA.updateProgress(pct);
      },
      async appendEvent(event, dedupKey) {
        await jobA.appendEvent(event, dedupKey);
      },
    };
    const executor = (state: S): Promise<E> =>
      Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "DONE" });

    await expect(runStateMachine(crashingJob, machine, executor, runOpts())).rejects.toThrow(
      /simulated crash/,
    );

    // FR-005 order was preserved: the append committed BEFORE the crash; the
    // checkpoint never advanced past genesis (none exists at all).
    const afterCrash = readFileEvents(dir);
    expect(afterCrash.ok).toBe(true);
    if (!afterCrash.ok) return;
    expect(afterCrash.value).toHaveLength(1);
    expect((afterCrash.value[0].event as E).type).toBe("STEP");
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();

    // Worker attempt 2: a FRESH job instance over the same directory (new
    // process — no in-memory state) re-derives the same transition. The
    // re-derived dedupKey must land as a no-op: the durable listing already
    // names it (SC-003). The run then proceeds and completes; the log has
    // exactly TWO records, never three.
    const jobB = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const result = await runStateMachine(jobB, machine, executor, runOpts());

    expect(result.state).toEqual({ kind: "succeeded", count: 1 });
    const events = readFileEvents(dir);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => (e.event as E).type)).toEqual(["STEP", "DONE"]);
    expect(events.value.map((e) => e.recordedAtMs).every((t) => Number.isFinite(t))).toBe(true);

    // The re-run re-derived the same transition and the durable log
    // contributed a dedup NO-OP (SC-003): the lagging checkpoint was closed
    // by the re-run's own post-transition projection — the transition's
    // post-state is self-committed when the run proceeds (FR-005), not by
    // log replay (no replayEvents fold runs on this path, and the executor
    // re-runs). Genuine log replay with NO executor is resumeFileJob's
    // mechanism (FR-011). The checkpoint now holds the terminal state, and
    // the progress file is the terminal 100 (FR-005/FR-007).
    const checkpoint = JSON.parse(readFileSync(join(dir, CHECKPOINT_FILE), "utf-8"));
    expect(checkpoint.schemaVersion).toBe(1);
    expect(checkpoint.data.state).toEqual({ kind: "succeeded", count: 1 });
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 100 });
  });

  it("a full run through one job instance leaves a journal that reproduces the identical final state by pure replay (US1)", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis(), now: () => 7 });
    const executor = (state: S): Promise<E> =>
      Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "DONE" });
    const result = await runStateMachine(job, machine, executor, runOpts());

    expect(result.state).toEqual({ kind: "succeeded", count: 1 });

    // Replay from the durable log alone — no executor, no in-memory state —
    // must land on the identical terminal state (FR-011/NFR-002).
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    const envelopes = readFileEvents(dir);
    expect(envelopes.ok).toBe(true);
    if (!envelopes.ok) return;
    expect(envelopes.value.every((e) => e.recordedAtMs === 7)).toBe(true); // injected clock
    const replayed = replayEvents(envelopes.value, machine, genesis());
    expect(replayed.state).toEqual(result.state);
    expect(replayed.context).toEqual(result.context);
  });
});

// ---------------------------------------------------------------------------
// State survives in a fresh job instance over the same directory (FR-003)
// ---------------------------------------------------------------------------

describe("createFileJob — durability across fresh instances", () => {
  it("a fresh job over the same directory continues the log at the next sequence and exposes its seed as data", async () => {
    const dir = tempDir();
    const jobA = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const executor = (state: S): Promise<E> =>
      Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "DONE" });
    const result = await runStateMachine(jobA, machine, executor, runOpts());
    expect(result.state.kind).toBe("succeeded");

    // Fresh instance, same directory — a new process continuing the run.
    // `data` is the seed passed in (deliberately NOT auto-resumed — that is
    // resumeFileJob's job); the durable side is what survives.
    const jobB = createFileJob<S, C>({ directory: dir, initial: genesis() });
    expect(jobB.data).toEqual(genesis());

    // The journal round-trips through the fresh process: 2 contiguous
    // records reproducing A's terminal state...
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1]);
    const envelopes = readFileEvents(dir);
    expect(envelopes.ok).toBe(true);
    if (!envelopes.ok) return;
    expect(replayEvents(envelopes.value, machine, genesis()).state).toEqual(result.state);

    // ...and the fresh instance appends at the next sequence (3), with the
    // durable checkpoint still readable through a SECOND fresh journal.
    await jobB.appendEvent({ type: "AFTER" }, "post:1");
    const after = readFileEventRecords(dir);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.map((r) => Number(r.sequence))).toEqual([0, 1, 2]);
    expect(String(after.value[2].dedupKey)).toBe("post:1");
    expect(createFileJournal(dir).readCheckpoint()).toContain('"succeeded"');
  });
});

// ---------------------------------------------------------------------------
// Typed failure surface (AD-6)
// ---------------------------------------------------------------------------

describe("createFileJob — typed FrameworkError on fs failure (AD-6)", () => {
  it("appendEvent/updateData/updateProgress throw cache-error with operation + directory; updateData never advances the snapshot", async () => {
    // A FILE squatting on the run-directory path makes every fs op below it
    // fail deterministically (ENOTDIR on all platforms, incl. as root).
    const blocked = join(tempDir(), "blocked");
    writeFileSync(blocked, "not a directory");

    const job = createFileJob<S, C>({
      directory: blocked,
      initial: genesis(),
    });

    await expect(job.appendEvent({ type: "STEP" }, "k0")).rejects.toMatchObject({
      kind: "cache-error",
      operation: "appendEvent",
    });
    await expect(job.updateData({ state: { kind: "pending", count: 1 }, context: { value: 1 } })).rejects.toMatchObject({
      kind: "cache-error",
      operation: "updateData",
    });
    await expect(job.updateProgress(50)).rejects.toMatchObject({
      kind: "cache-error",
      operation: "updateProgress",
    });

    // The message names the run directory (AD-6) and the typed value is the
    // FrameworkError itself — identity-safe for the shell's error mapping.
    await job.appendEvent({ type: "STEP" }, "k0").catch((error: unknown) => {
      expect(error).toMatchObject({ kind: "cache-error" });
      expect((error as { message: string }).message).toContain(blocked);
    });

    // A failed updateData must not advance the in-memory snapshot: the
    // transition is not committed and the retry re-derives it (FR-004).
    expect(job.data).toEqual(genesis());
  });

  it("readCheckpoint throws a typed cache-error on fs failure", () => {
    const dir = tempDir();
    // A DIRECTORY squatting on checkpoint.json makes the read fail with
    // EISDIR — deterministic on every platform this suite runs on.
    mkdirSync(join(dir, CHECKPOINT_FILE));
    const journal = createFileJournal(dir);
    try {
      journal.readCheckpoint();
      throw new Error("readCheckpoint should have thrown");
    } catch (error) {
      expect(error).toMatchObject({ kind: "cache-error", operation: "readCheckpoint" });
      expect((error as { message: string }).message).toContain(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-009 at the CHECKPOINT write boundary — updateData must never silently
// drop state/context into checkpoint.json (a bare toJson would: functions,
// BigInt and cycles vanish). The closed throwing shell reports
// cache-error(updateData) with checkpoint-path + FR-009 context, never a raw
// engine error and never a persisted mutation.
// ---------------------------------------------------------------------------

describe("createFileJob.updateData — checkpoint losslessness (FR-009)", () => {
  it("rejects function-valued state with typed cache-error(updateData), persisting nothing", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const fnState = { kind: "pending", count: 0, fn: () => 1 };

    const error = await job
      .updateData({ state: fnState as unknown as S, context: { value: 1 } })
      .then(() => null, (e: unknown) => e);
    const typed = asCacheError(error, "updateData");
    expect(typed.message).toContain("updateData");
    expect(typed.message).toContain("FR-009");
    expect(typed.message).toMatch(/function/);
    expect(typed.message).toContain(join(dir, CHECKPOINT_FILE));
    // No checkpoint was written, and the snapshot never advanced.
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
    expect(job.data).toEqual(genesis());
  });

  it("rejects BigInt context with typed cache-error(updateData) naming FR-009", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });

    const error = await job
      .updateData({ state: { kind: "pending", count: 1 }, context: { value: 10n } as unknown as C })
      .then(() => null, (e: unknown) => e);
    const typed = asCacheError(error, "updateData");
    expect(typed.message).toContain("updateData");
    expect(typed.message).toContain("FR-009");
    expect(typed.message).toMatch(/BigInt/);
    expect(typed.message).toContain(join(dir, CHECKPOINT_FILE));
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
    expect(job.data).toEqual(genesis());
  });

  it("rejects cyclic state with typed cache-error(updateData) naming FR-009", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const cyc: Record<string, unknown> = { kind: "pending", count: 1 };
    cyc.self = cyc;

    const error = await job
      .updateData({ state: cyc as unknown as S, context: { value: 1 } })
      .then(() => null, (e: unknown) => e);
    const typed = asCacheError(error, "updateData");
    expect(typed.message).toContain("updateData");
    expect(typed.message).toContain("FR-009");
    expect(typed.message).toMatch(/circular/);
    expect(typed.message).toContain(join(dir, CHECKPOINT_FILE));
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
    expect(job.data).toEqual(genesis());
  });

  it("rejects NaN state via the round-trip backstop (the pre-scan defers non-finite numbers by design)", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });

    const error = await job
      .updateData({ state: { kind: "pending", count: Number.NaN }, context: { value: 1 } })
      .then(() => null, (e: unknown) => e);
    const typed = asCacheError(error, "updateData");
    expect(typed.message).toContain("updateData");
    expect(typed.message).toContain("FR-009");
    expect(typed.message).toMatch(/lossless/);
    // A bare toJson would have persisted `{"state":{"kind":"pending","count":null}}`
    // — the exact silent mutation the backstop exists to refuse.
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
    expect(job.data).toEqual(genesis());
  });

  it("non-lossless checkpoint rejections are classified permanent (deterministic — retriabilityOf fast-fails)", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });

    const error = await job
      .updateData({ state: { kind: "pending", count: 0, fn: () => 1 } as unknown as S, context: { value: 1 } })
      .then(() => null, (e: unknown) => e);
    const typed = asCacheError(error, "updateData");
    // The checkpoint-side twin of the event codec's permanent class: the same
    // payload reproduces every rejection identically, so the retry machinery
    // must not re-execute the transition to budget exhaustion (ADR-0080).
    expect(typed.failureClass).toBe("permanent");
    expect(retriabilityOf(typed)).toBe("non-retriable");
  });

  it("a valid updateData still commits and advances after the losslessness gate", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis(), now: () => 7 });
    await job.updateData({ state: { kind: "pending", count: 1 }, context: { value: 1 } });
    expect(job.data).toEqual({ state: { kind: "pending", count: 1 }, context: { value: 1 } });
    expect(JSON.parse(createFileJournal(dir).readCheckpoint()!)).toEqual({
      schemaVersion: 1,
      data: { state: { kind: "pending", count: 1 }, context: { value: 1 } },
    });
  });
});

// ---------------------------------------------------------------------------
// Snapshot immutability — `data` returns a DEEP-FROZEN CLONE per read:
// caller mutation of a returned snapshot must never diverge the in-memory
// working copy (and therefore never reach the durable journal)
// ---------------------------------------------------------------------------

describe("createFileJob.data — deep-frozen clone snapshot contract", () => {
  it("detaches the initial seed from caller-owned references before the factory returns", () => {
    const dir = tempDir();
    const initial = genesis();
    const job = createFileJob<S, C>({ directory: dir, initial });

    initial.state.count = 99;
    initial.context.value = 99;

    expect(job.data).toEqual(genesis());
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
  });

  it("detaches updateData input before its first await and keeps snapshot equal to committed bytes", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const update = {
      state: { kind: "pending" as const, count: 1 },
      context: { value: 1 },
    };

    const pending = job.updateData(update);
    update.state.count = 99;
    update.context.value = 99;
    await pending;

    const committed: { state: S; context: C } = {
      state: { kind: "pending", count: 1 },
      context: { value: 1 },
    };
    expect(job.data).toEqual(committed);
    expect(JSON.parse(createFileJournal(dir).readCheckpoint()!).data).toEqual(committed);
  });

  it("every read is an independent deep-frozen clone; mutation cannot diverge the snapshot or the journal", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });

    // Each read is a FRESH object — mutating one can never affect another
    // (the old getter returned a fresh wrapper around the SAME nested
    // references, so nested mutation silently diverged the snapshot).
    const first = job.data;
    const second = job.data;
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    // Deeply frozen: wrapper, state and context are all immutable.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.state)).toBe(true);
    expect(Object.isFrozen(first.context)).toBe(true);

    // Mutation attempts on the frozen clone cannot reach the working snapshot.
    try {
      (first.state as { kind: string }).kind = "succeeded";
    } catch {
      /* frozen — throws in strict mode; assertion below is the real check */
    }
    expect(job.data).toEqual(genesis());

    // After a committed updateData, mutating the returned copy neither
    // changes subsequent reads nor the durable checkpoint.
    await job.updateData({ state: { kind: "pending", count: 1 }, context: { value: 1 } });
    const copy = job.data;
    try {
      (copy.state as { count: number }).count = 99;
      (copy.context as { value: number }).value = 99;
    } catch {
      /* frozen */
    }
    expect(job.data).toEqual({ state: { kind: "pending", count: 1 }, context: { value: 1 } });
    expect(JSON.parse(createFileJournal(dir).readCheckpoint()!)).toEqual({
      schemaVersion: 1,
      data: { state: { kind: "pending", count: 1 }, context: { value: 1 } },
    });
  });

  it("rejects an unclonable initial snapshot at the typed factory boundary", () => {
    const dir = tempDir();
    let failure: unknown;
    try {
      createFileJob({
        directory: dir,
        initial: {
          state: { fn: () => 1 },
          context: {},
        },
      });
    } catch (error) {
      failure = error;
    }
    const typed = asCacheError(failure, "createFileJob");
    expect(typed.message).toContain("losslessly serializable");
    expect(typed.message).toContain("FR-009");
  });

  it("deepFreeze freezes objects nested under symbol keys too (fully-immutable contract)", () => {
    // The FR-009 boundary rejects symbol-keyed state at both the factory
    // seed and updateData, so the public `data` getter can never reach a
    // symbol-keyed clone; the primitive is pinned directly so a future
    // snapshot source cannot silently weaken the contract.
    const nestedKey = Symbol("nested");
    const frozen = __testDeepFreeze({
      a: 1,
      [nestedKey]: { inner: { deep: true } },
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    const underSymbol = frozen[nestedKey] as { inner: { deep: boolean } };
    expect(Object.isFrozen(underSymbol)).toBe(true);
    expect(Object.isFrozen(underSymbol.inner)).toBe(true);
    try {
      underSymbol.inner.deep = false;
    } catch {
      /* frozen — throws in strict mode; value check below is the real pin */
    }
    expect(underSymbol.inner.deep).toBe(true);
  });
});

describe("createFileJob — typed factory validation", () => {
  it("throws cache-error(createFileJob) for invalid options without raw leakage", () => {
    for (const args of [
      null,
      { directory: "", initial: genesis() },
      { directory: tempDir(), initial: genesis(), now: 7 },
    ] as const) {
      let failure: unknown;
      try {
        createFileJob(args as unknown as CreateFileJobArgs<S, C>);
      } catch (error) {
        failure = error;
      }
      const typed = asCacheError(failure, "createFileJob");
      expect(typed.message).toContain("factory configuration");
    }
  });
});

// ---------------------------------------------------------------------------
// Default-keyer attribution (FR-015 gate) — the kernel WITHOUT an injected
// computeDedupKey uses the runner's string-concat fallback, which always
// emits "|"-bearing keys; the file adapter's FR-015 gate must reject them
// with a message ATTRIBUTING the cause, not a bare charset rejection
// ---------------------------------------------------------------------------

describe("createFileJob — kernel without computeDedupKey (default fallback keyer)", () => {
  it("fails the FR-015 gate with an attributable message; nothing durable is written", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const executor = (state: S): Promise<E> =>
      Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "DONE" });

    // NO computeDedupKey: the runner's fallback emits
    // `${prevStateKey}|${attemptNumber}|${eventType}` — a "|"-bearing key
    // that FR-015 excludes ("|" is the keyless digest field separator, AD-2).
    const error = await runStateMachine(job, machine, executor, {
      errorEventOf: (): E => ({ type: "DONE" }),
    }).then(() => null, (e: unknown) => e);

    const typed = asCacheError(error, "appendEvent");
    const message = typed.message;
    expect(message).toContain("FR-015");
    // Attributable: names the caller-bug fix, not just the invalid key.
    expect(message).toMatch(/computeDedupKey/);
    expect(message).toContain("fallback");
    // The FR-015 rejection is DETERMINISTIC — every kernel-fallback key
    // contains "|", so no retry can clear the gate. The JobLike boundary must
    // carry the journal's permanent class through the attributable rewrap (a
    // plain-string reason would infer no class at all) so retriabilityOf
    // fast-fails instead of burning the node's retry budget (ADR-0080); the
    // checkpoint-side twin pins the same class at "non-lossless checkpoint
    // rejections are classified permanent".
    expect(typed.failureClass).toBe("permanent");
    expect(retriabilityOf(typed)).toBe("non-retriable");
    // Fail-fast: the append aborted before anything became durable.
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();
    const events = readFileEvents(dir);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toEqual([]);
  });
});
