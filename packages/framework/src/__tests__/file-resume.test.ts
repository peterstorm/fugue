/**
 * Integration tests for `src/file/resume.ts` — log-authoritative resume with
 * the AD-3 agreement proof (spec US1, FR-009/FR-010/FR-011/FR-012/FR-014).
 *
 * The event log is authoritative and the checkpoint is a projection that may
 * legitimately lag by the kernel's append-before-checkpoint window; anything
 * else is corruption and MUST fail closed with a typed `checkpoint-corrupt`
 * naming the file/keys. Resume NEVER re-invokes the executor (FR-011) and
 * never writes (side-effect-free).
 *
 * Coverage:
 * - SC-002 both directions: (a) a REAL crash between `appendEvent` and
 *   `updateData` (injected into `runStateMachine`'s job) leaves a lagging
 *   checkpoint that resume recovers by replay — the log's final state wins;
 *   (b) a manufactured checkpoint/log disagreement fails closed with the
 *   typed `checkpoint-corrupt` naming `checkpoint <key> vs replay <key>`.
 * - FR-014: no recoverable state (missing or empty run directory) ⇒
 *   `checkpoint-missing` — never a silent fresh start; resume creates
 *   nothing.
 * - FR-009 fail-closed variants: truncated record, schema-invalid record,
 *   sequence gap, filename-digest mismatch — each a `checkpoint-corrupt`
 *   naming the offending file.
 * - Replay-only resume (no checkpoint.json = benign crash-before-first-
 *   checkpoint) resumes from the pure fold.
 * - FR-012: a terminal-failed run never resumes into the state its own
 *   machine rejected — the failed key appears in no prefix replay, so even a
 *   manufactured failed-state checkpoint fails the agreement proof.
 * - US1: a completed journal resumes to the IDENTICAL final state; events,
 *   checkpoint and progress all round-trip.
 * - AD-3 prefix semantics: empty-prefix (genesis) lag, lag-by-many-prefix,
 *   and checkpoint-only directories (genesis-agreeing ⇒ genesis, disagreeing
 *   ⇒ corrupt).
 * - Checkpoint decode failures (bad JSON, bad schemaVersion, caller
 *   parseCheckpoint rejection) ⇒ `checkpoint-corrupt` naming checkpoint.json.
 * - FR-040 throwing-machine guards: a machine.transition that throws on a
 *   hostile-but-codec-valid event payload (inside the replay fold), a
 *   machine.stateKey that throws on a decoded hostile checkpoint state, and
 *   one that throws only on an intermediate prefix-scan state — each
 *   re-tagged typed `checkpoint-corrupt` naming the step, never a raw
 *   untyped promise rejection.
 * - FR-040 throwing-decoder guard: a caller `parseCheckpoint` that
 *   destructures/derefs BEFORE validating throws raw TypeErrors on
 *   hostile-but-envelope-valid `data` payloads (`{"__undefined__":true}`
 *   deserializes to a REAL `undefined`; `42`; `[1,2,3]`) — every variant
 *   fails as the typed `checkpoint-corrupt` naming checkpoint.json, never
 *   a raw rejection.
 * - Complete raw checkpoint serializer grammar: checkpoint-only and
 *   log+checkpoint cases reject nested ambiguous tags, malformed payloads,
 *   pollution keys, duplicate canonical Map/Set primitives, and excessive
 *   depth before `parseCheckpoint`; canonical nested Map/Set/Date/undefined
 *   tags round-trip in both cases.
 * - AD-6: a directory squatting on checkpoint.json (EISDIR) propagates the
 *   journal's typed `cache-error` unchanged; a directory squatting on an
 *   event-file name is re-tagged `checkpoint-corrupt` with the reader's
 *   message preserved.
 * - Envelope shape gates: non-object checkpoints (array/scalar/null/
 *   string), unknown top-level fields, and a missing data payload all fail
 *   closed naming checkpoint.json.
 * - Pollution-keyed envelope: `constructor`/`prototype`/`__proto__` keys at
 *   the raw-text seam fail the shared grammar gate before `deserializeValue`
 *   could silently erase them.
 * - Prefix-space property (fast-check): a checkpoint equal to the replay of
 *   ANY prefix of the log (genesis … full replay, k ≤ n) resumes from the
 *   replay; a checkpoint the log provably never passed through (k > n) is
 *   `checkpoint-corrupt`.
 * - fast-check property: the same journal always resumes to the same state
 *   (replay determinism).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { runStateMachine } from "../state-machine/runner.js";
import type { JobLike, Machine, KernelRunOpts } from "../state-machine/types.js";
import type { ResumeFileJobArgs } from "../file.js";
import {
  createFileJob,
  createFileJournal,
  readFileEventRecords,
  readFileEvents,
  resumeFileJob,
} from "../file.js"; // the @fuguejs/framework/file barrel under test
import { CHECKPOINT_FILE, EVENTS_DIR, PROGRESS_FILE } from "../file/layout.js";
import { toJson } from "../state-machine/serialize.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import { runId } from "../types/ids.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp directory, removed after the test. */
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "file-resume-"));
  cleanup.push(dir);
  return dir;
};

/** Byte-exact, read-only directory snapshot used to prove failed resume never
 * mutates the journal or checkpoint while handling hostile callbacks. */
const snapshotDirectory = (directory: string, prefix = ""): readonly string[] => {
  if (!existsSync(directory)) return ["<absent>"];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      return entry.isDirectory()
        ? [`directory:${relative}`, ...snapshotDirectory(absolute, relative)]
        : [`file:${relative}:${readFileSync(absolute).toString("base64")}`];
    });
};

interface HostileThrownValue {
  readonly label: string;
  readonly create: () => unknown;
}

/** Every value is legal to throw in JavaScript and breaks at least one common
 * `try/catch` formatter (`instanceof Error`, `.message`, `String`, or tag
 * inspection). Factories keep revoked/stateful values isolated per seam. */
const hostileThrownValueMatrix = (): readonly HostileThrownValue[] => [
  {
    label: "revoked proxy",
    create: () => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      return revoked.proxy;
    },
  },
  {
    label: "null-prototype object",
    create: () => Object.assign(Object.create(null) as object, { message: "null prototype failure" }),
  },
  {
    label: "throwing message getter",
    create: () => Object.defineProperty({}, "message", {
      get: () => { throw new Error("message getter must stay contained"); },
    }),
  },
  {
    label: "Symbol.toPrimitive/toString traps",
    create: () => Object.defineProperties({}, {
      toString: {
        get: () => { throw new Error("toString trap must stay contained"); },
      },
      [Symbol.toPrimitive]: {
        get: () => { throw new Error("Symbol.toPrimitive trap must stay contained"); },
      },
    }),
  },
  {
    label: "hostile instanceof/getPrototypeOf behavior",
    create: () => new Proxy({}, {
      getPrototypeOf: () => { throw new Error("getPrototypeOf trap must stay contained"); },
    }),
  },
];

// ---------------------------------------------------------------------------
// Minimal machine — pending(0) →STEP→ pending(n) →DONE→ succeeded, →FAIL→ failed
// (the failed state is the kernel's terminal-failed rejection target: never
// appended, never checkpointed, and its key appears in no prefix replay)
// ---------------------------------------------------------------------------

type S =
  | { kind: "pending"; count: number }
  | { kind: "succeeded"; count: number }
  | { kind: "failed"; count: number };
type E = { type: "STEP" } | { type: "DONE" } | { type: "FAIL" };
type C = { value: number };

const machine: Machine<S, E, C> = {
  transition(state, event, context) {
    if (state.kind === "pending" && event.type === "STEP") {
      return { state: { kind: "pending", count: state.count + 1 }, context: { value: context.value + 1 } };
    }
    if (state.kind === "pending" && event.type === "DONE") {
      return { state: { kind: "succeeded", count: state.count }, context };
    }
    if (state.kind === "pending" && event.type === "FAIL") {
      return { state: { kind: "failed", count: state.count }, context };
    }
    return { state, context };
  },
  isTerminal: (s) => s.kind === "succeeded" || s.kind === "failed",
  isFailed: (s) => s.kind === "failed",
  stateProgress: (s) => (s.kind === "succeeded" ? 100 : s.kind === "failed" ? 0 : 50),
  stateKey: (s) => JSON.stringify(s),
};

const genesis = (): { state: S; context: C } => ({
  state: { kind: "pending", count: 0 },
  context: { value: 0 },
});

/**
 * Deterministic, FR-015-safe dedup keyer — mirrors the DAG layer's injected
 * keyer (see file-job.test.ts): the same transition re-derives the same key
 * across worker invocations, which is exactly what makes the crash window
 * safe (FR-004). The runner's string-concat fallback is NOT used (it emits
 * "|"-bearing keys FR-015 excludes).
 */
const sha256DedupKey = (prevStateKey: string, attemptNumber: number, event: E): string =>
  `k:${createHash("sha256")
    .update(`${prevStateKey}|${attemptNumber}|${(event as { type: string }).type}`)
    .digest("hex")}`;

const runOpts = (): KernelRunOpts<S, E, C> => ({
  errorEventOf: () => ({ type: "DONE" }),
  computeDedupKey: sha256DedupKey,
});

/** The kernel's normal executor: STEP once, then DONE to succeed. */
const executor = (state: S): Promise<E> =>
  Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "DONE" });

/**
 * The caller's strict checkpoint decoder: the envelope's schemaVersion is
 * resume.ts's gate; the `data` payload shape ({ state, context }) is this
 * decoder's domain. Rejects anything without both fields.
 */
const parseCheckpoint = (data: unknown): Result<{ state: S; context: C }, string> => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return err("checkpoint data must be an object with state and context");
  }
  const record = data as Record<string, unknown>;
  if (!("state" in record) || !("context" in record)) {
    return err("checkpoint data must have state and context fields");
  }
  return ok({ state: record.state as S, context: record.context as C });
};

const resume = (directory: string, rid: string) =>
  resumeFileJob<S, E, C>({
    runId: runId(rid),
    directory,
    machine,
    genesis: genesis(),
    parseCheckpoint,
  });

/** Wrap a real file job so its Nth `updateData` call crashes — the kernel's
 * append-before-checkpoint window (runner FR-005): the event appended, the
 * projection did not. */
const crashingJob = (job: JobLike<S, unknown, C>, crashCall: number): JobLike<S, E, C> => {
  let updateCalls = 0;
  return {
    get data() {
      return job.data;
    },
    async updateData(d) {
      updateCalls += 1;
      if (updateCalls === crashCall) {
        throw new Error(`simulated crash between appendEvent and updateData (call #${updateCalls})`);
      }
      await job.updateData(d);
    },
    async updateProgress(pct) {
      await job.updateProgress(pct);
    },
    async appendEvent(event, dedupKey) {
      await job.appendEvent(event, dedupKey);
    },
  };
};

// ---------------------------------------------------------------------------
// SC-002 — crash-window resume, both directions
// ---------------------------------------------------------------------------

describe("resumeFileJob — SC-002 crash window", () => {
  it("(a) a real crash between appendEvent and updateData resumes and recovers the lagging checkpoint by log replay", async () => {
    const dir = tempDir();

    // The run crashes on the second updateData call: the DONE event is
    // durable, but the checkpoint projection still holds the PRE-crash state
    // (one transition behind — the kernel's benign append-before-checkpoint
    // window, FR-005).
    const jobA = createFileJob<S, C>({ directory: dir, initial: genesis() });
    await expect(runStateMachine(crashingJob(jobA, 2), machine, executor, runOpts())).rejects.toThrow(
      /simulated crash between appendEvent and updateData/,
    );

    // FR-005 order was preserved: BOTH events committed; the checkpoint lags
    // at the first transition's post-state.
    const eventsAfterCrash = readFileEvents(dir);
    expect(eventsAfterCrash.ok).toBe(true);
    if (!eventsAfterCrash.ok) return;
    expect(eventsAfterCrash.value.map((e) => (e.event as E).type)).toEqual(["STEP", "DONE"]);
    expect(
      (JSON.parse(readFileSync(join(dir, CHECKPOINT_FILE), "utf-8")).data as { state: S }).state,
    ).toEqual({ kind: "pending", count: 1 });

    // Resume in a fresh process: the checkpoint disagrees with the full
    // replay but matches the strict prefix of length 1 — benign lag,
    // expected, NOT corruption. The resumed state is the LOG's final state
    // (succeeded), never the lagging projection.
    const resumed = await resume(dir, "sc002-crash");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ kind: "succeeded", count: 1 });
    expect(resumed.value.context).toEqual({ value: 1 });

    // Resume is side-effect-free: the lagging checkpoint is NOT rewritten —
    // the proof accepted it, the replay decided the state.
    expect(
      (JSON.parse(readFileSync(join(dir, CHECKPOINT_FILE), "utf-8")).data as { state: S }).state,
    ).toEqual({ kind: "pending", count: 1 });
  });

  it("(b) a manufactured checkpoint/log disagreement fails closed with the typed checkpoint-corrupt naming both keys", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    await runStateMachine(job, machine, executor, runOpts());

    // Manufacture a checkpoint whose state the log never passed through —
    // a stale/damaged projection from a different run or a corrupted file.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "pending", count: 42 }, context: { value: 99 } },
      }),
    );

    const resumed = await resume(dir, "sc002-disagree");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.runId).toBe(runId("sc002-disagree"));
    // The message names the checkpoint state key vs the replayed state key
    // — precise enough to diagnose the disagreement (FR-010).
    expect(resumed.error.message).toContain('checkpoint {"kind":"pending","count":42}');
    expect(resumed.error.message).toContain('vs replay {"kind":"succeeded","count":1}');
  });
});

// ---------------------------------------------------------------------------
// FR-014 — no recoverable state
// ---------------------------------------------------------------------------

describe("resumeFileJob — checkpoint-missing (FR-014)", () => {
  it("an empty run directory ⇒ checkpoint-missing, never a silent fresh start", async () => {
    const dir = tempDir();
    const resumed = await resume(dir, "missing-empty");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-missing");
    if (resumed.error.kind !== "checkpoint-missing") return;
    expect(resumed.error.runId).toBe(runId("missing-empty"));
  });

  it("a nonexistent run directory ⇒ checkpoint-missing, and resume creates nothing", async () => {
    const absent = join(tempDir(), "never-created");
    const resumed = await resume(absent, "missing-absent");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-missing");
    if (resumed.error.kind !== "checkpoint-missing") return;
    // Resume is side-effect-free: the missing directory is still missing.
    expect(existsSync(absent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-009 — strict per-record fail-closed variants (each names the file)
// ---------------------------------------------------------------------------

describe("resumeFileJob — corrupt event log variants fail closed (FR-009)", () => {
  it("a truncated (torn-write) event record ⇒ checkpoint-corrupt naming the file", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    const [name] = readdirSync(join(dir, EVENTS_DIR)).filter((n) => n.endsWith(".json"));
    const path = join(dir, EVENTS_DIR, name);
    const contents = readFileSync(path, "utf-8");
    writeFileSync(path, contents.slice(0, contents.length - 15)); // torn mid-token

    const resumed = await resume(dir, "corrupt-truncated");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("not valid JSON");
    expect(resumed.error.message).toContain(name); // FR-009: names the offending file
  });

  it("a schema-invalid record (valid JSON, wrong schemaVersion) ⇒ checkpoint-corrupt naming the file", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    const [name] = readdirSync(join(dir, EVENTS_DIR)).filter((n) => n.endsWith(".json"));
    writeFileSync(
      join(dir, EVENTS_DIR, name),
      toJson({ schemaVersion: 7, sequence: 0, dedupKey: "k0", recordedAtMs: 7, event: { type: "STEP" } }),
    );

    const resumed = await resume(dir, "corrupt-schema");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("schemaVersion 7");
    expect(resumed.error.message).toContain(name);
  });

  it("malformed nested serializer envelopes fail closed as checkpoint-corrupt before deserialization", async () => {
    const hostileDepth =
      '{"__set__":['.repeat(513) + "1" + "]}".repeat(513);
    const variants: ReadonlyArray<readonly [string, string, string]> = [
      ["map-extra", '{"outer":{"__map__":[["k",1]],"extra":true}}', "ambiguous serializer-tag object"],
      ["set-extra", '{"outer":{"__set__":[1],"extra":true}}', "ambiguous serializer-tag object"],
      ["date-extra", '{"outer":{"__date__":"2025-01-02T03:04:05.000Z","extra":1}}', "ambiguous serializer-tag object"],
      ["undefined-extra", '{"outer":{"__undefined__":true,"extra":1}}', "ambiguous serializer-tag object"],
      ["hostile-key", '{"__map__":[["k",{"constructor":{"polluted":true}}]]}', "prototype-pollution-filtered key"],
      ["hostile-depth", hostileDepth, "safe depth ceiling"],
    ];

    for (const [label, eventJson, expected] of variants) {
      const dir = tempDir();
      const journal = createFileJournal(dir, { now: () => 7 });
      await journal.appendEvent({ type: "STEP" }, "k0");
      const [name] = readdirSync(join(dir, EVENTS_DIR)).filter((entry) => entry.endsWith(".json"));
      writeFileSync(
        join(dir, EVENTS_DIR, name),
        `{"schemaVersion":1,"sequence":0,"dedupKey":"k0","recordedAtMs":7,"event":${eventJson}}`,
      );

      const resumed = await resume(dir, `corrupt-tag-${label}`);
      expect(resumed.ok, label).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, label).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.message).toContain(name);
      expect(resumed.error.message).toContain("serialized record is not canonical");
      expect(resumed.error.message).toContain(expected);
    }
  });

  it("a sequence gap in the log ⇒ checkpoint-corrupt naming the breaking record", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    await journal.appendEvent({ type: "STEP" }, "k1");
    await journal.appendEvent({ type: "STEP" }, "k2");
    const names = readdirSync(join(dir, EVENTS_DIR)).filter((n) => n.endsWith(".json")).sort();
    rmSync(join(dir, EVENTS_DIR, names[1])); // delete 000001 — the strict reader must fail, never silently skip

    const resumed = await resume(dir, "sequence-gap");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("sequence 2");
    expect(resumed.error.message).toContain("contiguity");
    expect(resumed.error.message).toContain(names[2]); // the file that breaks the contiguity
  });

  it("a filename-digest mismatch (renamed record) ⇒ checkpoint-corrupt naming the file", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    const [name] = readdirSync(join(dir, EVENTS_DIR)).filter((n) => n.endsWith(".json"));
    // Swap the digest suffix — the content no longer matches its filename
    // (AD-2 tamper/tear check).
    renameSync(
      join(dir, EVENTS_DIR, name),
      join(dir, EVENTS_DIR, name.replace(/[0-9a-f]{64}/, "a".repeat(64))),
    );

    const resumed = await resume(dir, "digest-mismatch");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("digest");
    expect(resumed.error.message).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// Replay-only resume — benign crash-before-first-checkpoint
// ---------------------------------------------------------------------------

describe("resumeFileJob — replay-only resume (no checkpoint.json)", () => {
  it("a journal with events but no checkpoint resumes from the pure replay (FR-011)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    await journal.appendEvent({ type: "DONE" }, "k1");
    expect(existsSync(join(dir, CHECKPOINT_FILE))).toBe(false);

    const resumed = await resume(dir, "replay-only");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ kind: "succeeded", count: 1 });
    expect(resumed.value.context).toEqual({ value: 1 });

    // Resume never writes: still no checkpoint after resuming.
    expect(existsSync(join(dir, CHECKPOINT_FILE))).toBe(false);
  });

  it("a crash on the FIRST updateData call leaves no checkpoint; resume replays to the post-crash state", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    await expect(runStateMachine(crashingJob(job, 1), machine, executor, runOpts())).rejects.toThrow(
      /simulated crash between appendEvent and updateData/,
    );

    const events = readFileEvents(dir);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => (e.event as E).type)).toEqual(["STEP"]);
    expect(existsSync(join(dir, CHECKPOINT_FILE))).toBe(false);

    const resumed = await resume(dir, "first-crash");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ kind: "pending", count: 1 });
    expect(resumed.value.context).toEqual({ value: 1 });
  });
});

// ---------------------------------------------------------------------------
// FR-012 — terminal-failed runs never resume into a rejected state
// ---------------------------------------------------------------------------

describe("resumeFileJob — terminal-failed runs (FR-012)", () => {
  it("a real terminal-failed run resumes to the last good state, never the rejected one", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis() });
    const failingExecutor = (state: S): Promise<E> =>
      Promise.resolve(state.kind === "pending" && state.count === 0 ? { type: "STEP" } : { type: "FAIL" });

    // The FAIL transition lands in the failed state; the kernel appends
    // NOTHING and checkpoints NOTHING for it (runner FR-005), then throws.
    await expect(runStateMachine(job, machine, failingExecutor, runOpts())).rejects.toThrow(
      /failed terminal state/,
    );

    // The durable surface never saw the failure event.
    const events = readFileEvents(dir);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => (e.event as E).type)).toEqual(["STEP"]);
    expect(
      (JSON.parse(readFileSync(join(dir, CHECKPOINT_FILE), "utf-8")).data as { state: S }).state,
    ).toEqual({ kind: "pending", count: 1 });

    // Resume: the failed state's key appears in no prefix replay, so the
    // proof can never hand it back — the run resumes from the last state its
    // own machine accepted (FR-012).
    const resumed = await resume(dir, "terminal-failed");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(machine.isFailed(resumed.value.state)).toBe(false);
    expect(resumed.value.state).toEqual({ kind: "pending", count: 1 });
  });

  it("a manufactured checkpoint claiming the failed terminal state fails the agreement proof", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    // A hostile/stale checkpoint of the failed state — the kernel would
    // never persist one, and the failed key appears in no prefix replay.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "failed", count: 1 }, context: { value: 1 } },
      }),
    );

    const resumed = await resume(dir, "terminal-failed-hostile");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain('checkpoint {"kind":"failed","count":1}');
    expect(resumed.error.message).toContain("vs replay");
  });
});

// ---------------------------------------------------------------------------
// US1 — completed journal round-trips to the identical final state
// ---------------------------------------------------------------------------

describe("resumeFileJob — completed journal round-trip (US1)", () => {
  it("a fully completed run resumes to the identical final state; events, checkpoint and progress all round-trip", async () => {
    const dir = tempDir();
    const job = createFileJob<S, C>({ directory: dir, initial: genesis(), now: () => 7 });
    const result = await runStateMachine(job, machine, executor, runOpts());
    expect(result.state).toEqual({ kind: "succeeded", count: 1 });

    const resumed = await resume(dir, "round-trip");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value).toEqual(result); // IDENTICAL final state (replay proves it)

    // Events, checkpoint AND progress survive the round-trip.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1]);
    expect(
      (JSON.parse(readFileSync(join(dir, CHECKPOINT_FILE), "utf-8")).data as { state: S }).state,
    ).toEqual({ kind: "succeeded", count: 1 });
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 100 });
  });
});

// ---------------------------------------------------------------------------
// AD-3 prefix semantics — the benign lag window
// ---------------------------------------------------------------------------

describe("resumeFileJob — strict-prefix benign lag (AD-3 step 5)", () => {
  it("a checkpoint of the genesis state with a non-empty log is the empty-prefix lag; resume returns the replay", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    await journal.appendEvent({ type: "STEP" }, "k1");
    await journal.appendEvent({ type: "DONE" }, "k2");
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({ schemaVersion: 1, data: genesis() }),
    );

    const resumed = await resume(dir, "empty-prefix-lag");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ kind: "succeeded", count: 2 });
    expect(resumed.value.context).toEqual({ value: 2 });
  });

  it("a checkpoint lagging by MANY transitions (strict prefix, not lag-by-one) is benign; resume returns the replay", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    await journal.appendEvent({ type: "STEP" }, "k1");
    await journal.appendEvent({ type: "DONE" }, "k2");
    // The state after exactly ONE of the three events — a strict prefix.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "pending", count: 1 }, context: { value: 1 } },
      }),
    );

    const resumed = await resume(dir, "lag-by-many");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ kind: "succeeded", count: 2 });
  });

  it("a checkpoint-only directory (no event files) with a genesis-agreeing checkpoint resumes to genesis", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, CHECKPOINT_FILE), toJson({ schemaVersion: 1, data: genesis() }));

    const resumed = await resume(dir, "checkpoint-only-agree");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value).toEqual(genesis());
  });

  it("a checkpoint-only directory whose checkpoint disagrees with genesis fails closed", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "succeeded", count: 3 }, context: { value: 3 } },
      }),
    );

    const resumed = await resume(dir, "checkpoint-only-disagree");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain('checkpoint {"kind":"succeeded","count":3}');
    expect(resumed.error.message).toContain('vs replay {"kind":"pending","count":0}');
  });
});

// ---------------------------------------------------------------------------
// Checkpoint decode failures — fail closed, naming checkpoint.json
// ---------------------------------------------------------------------------

describe("resumeFileJob — checkpoint decode failures", () => {
  const withEvent = async (dir: string): Promise<void> => {
    await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
  };

  it("an unparseable checkpoint.json ⇒ checkpoint-corrupt naming checkpoint.json", async () => {
    const dir = tempDir();
    await withEvent(dir);
    writeFileSync(join(dir, CHECKPOINT_FILE), "{ not valid json !!!");

    const resumed = await resume(dir, "decode-json");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("not valid JSON");
  });

  it("a checkpoint with an unsupported schemaVersion ⇒ checkpoint-corrupt naming checkpoint.json", async () => {
    const dir = tempDir();
    await withEvent(dir);
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({ schemaVersion: 99, data: genesis() }),
    );

    const resumed = await resume(dir, "decode-schema");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("schemaVersion 99");
  });

  it("a checkpoint whose data payload the caller's parseCheckpoint rejects ⇒ checkpoint-corrupt carrying the decoder's message", async () => {
    const dir = tempDir();
    await withEvent(dir);
    // Malformed payload: no context field — a shape the decoder rejects.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({ schemaVersion: 1, data: { state: { kind: "pending", count: 1 } } }),
    );

    const resumed = await resume(dir, "decode-data");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("state and context");
  });

  it("validates the complete raw checkpoint grammar before parseCheckpoint in checkpoint-only and log+checkpoint resumes", async () => {
    const nested = (raw: string): string =>
      `{"state":{"kind":"pending","count":0},"context":{"nested":${raw}}}`;
    const deep = '{"a":'.repeat(520) + "1" + "}".repeat(520);
    const variants: ReadonlyArray<readonly [string, string, string]> = [
      ["tag-sibling", nested('{"__map__":[["k",1]],"extra":true}'), "ambiguous serializer-tag object"],
      ["bad-set-payload", nested('{"__set__":"not-an-array"}'), ".__set__ must be an array"],
      ["bad-date-payload", nested('{"__date__":"not-a-date"}'), "canonical ISO timestamp"],
      ["bad-undefined-payload", nested('{"__undefined__":false}'), ".__undefined__ must be exactly true"],
      ["bad-map-tuple", nested('{"__map__":[["k",1,2]]}'), "exact two-element"],
      ["pollution-key", nested('{"safe":{"constructor":{"polluted":true}}}'), "prototype-pollution-filtered key"],
      ["duplicate-map-key", nested('{"__map__":[["k",1],["k",2]]}'), "duplicates a primitive Map key"],
      ["duplicate-set-value", nested('{"__set__":[1,1]}'), "duplicates a primitive Set value"],
      ["excessive-depth", nested(deep), "safe depth ceiling 512"],
    ];

    for (const scenario of ["checkpoint-only", "log+checkpoint"] as const) {
      for (const [label, dataJson, expected] of variants) {
        const dir = tempDir();
        if (scenario === "log+checkpoint") await withEvent(dir);
        writeFileSync(
          join(dir, CHECKPOINT_FILE),
          `{"schemaVersion":1,"data":${dataJson}}`,
        );
        let parseCalls = 0;

        const resumed = await resumeFileJob<S, E, C>({
          runId: runId(`grammar-${scenario === "checkpoint-only" ? "checkpoint-only" : "log-checkpoint"}-${label}`),
          directory: dir,
          machine,
          genesis: genesis(),
          parseCheckpoint(data) {
            parseCalls += 1;
            return parseCheckpoint(data);
          },
        });

        expect(resumed.ok, `${scenario}/${label}`).toBe(false);
        if (resumed.ok) continue;
        expect(resumed.error.kind, `${scenario}/${label}`).toBe("checkpoint-corrupt");
        if (resumed.error.kind !== "checkpoint-corrupt") continue;
        expect(resumed.error.message, `${scenario}/${label}`).toContain("checkpoint.json");
        expect(resumed.error.message, `${scenario}/${label}`).toContain("serialized checkpoint is not canonical");
        expect(resumed.error.message, `${scenario}/${label}`).toContain(expected);
        expect(parseCalls, `${scenario}/${label}`).toBe(0);
      }
    }
  });

  it("preserves nested canonical Map/Set/Date/undefined tags for checkpoint-only and log+checkpoint resumes", async () => {
    type TaggedState = Readonly<{
      kind: "tagged";
      phase: number;
      index: Map<string, unknown>;
      labels: Set<unknown>;
      happenedAt: Date;
      missing: undefined;
    }>;
    type TaggedContext = Readonly<{
      history: Set<string>;
      observedAt: Date;
      optional: undefined;
    }>;
    type TaggedEvent = { readonly type: "ADVANCE" };

    const taggedState = (phase: number): TaggedState => ({
      kind: "tagged",
      phase,
      index: new Map<string, unknown>([
        ["phase", phase],
        ["missing", undefined],
        ["nested", new Set<unknown>(["ready", phase, undefined])],
      ]),
      labels: new Set<unknown>(["ready", phase, undefined]),
      happenedAt: new Date(`2026-08-14T00:00:0${phase}.000Z`),
      missing: undefined,
    });
    const taggedContext = (phase: number): TaggedContext => ({
      history: new Set([`phase-${phase}`]),
      observedAt: new Date(`2026-08-14T00:01:0${phase}.000Z`),
      optional: undefined,
    });
    const taggedMachine: Machine<TaggedState, TaggedEvent, TaggedContext> = {
      transition: () => ({ state: taggedState(1), context: taggedContext(1) }),
      isTerminal: () => false,
      isFailed: () => false,
      stateProgress: () => 50,
      stateKey: (state) => toJson(state),
    };
    const taggedParser = (
      data: unknown,
    ): Result<{ state: TaggedState; context: TaggedContext }, string> => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return err("tagged checkpoint data must be an object");
      }
      const record = data as Record<string, unknown>;
      const state = record.state as Partial<TaggedState> | undefined;
      const context = record.context as Partial<TaggedContext> | undefined;
      if (
        state?.kind !== "tagged" ||
        !(state.index instanceof Map) ||
        !(state.labels instanceof Set) ||
        !(state.happenedAt instanceof Date) ||
        !Object.prototype.hasOwnProperty.call(state, "missing") ||
        !(context?.history instanceof Set) ||
        !(context.observedAt instanceof Date) ||
        !Object.prototype.hasOwnProperty.call(context, "optional")
      ) {
        return err("canonical serializer tags were not restored");
      }
      return ok({ state: state as TaggedState, context: context as TaggedContext });
    };

    for (const scenario of ["checkpoint-only", "log+checkpoint"] as const) {
      const dir = tempDir();
      const expected = scenario === "checkpoint-only"
        ? { state: taggedState(0), context: taggedContext(0) }
        : { state: taggedState(1), context: taggedContext(1) };
      if (scenario === "log+checkpoint") {
        await createFileJournal(dir, { now: () => 7 }).appendEvent(
          { type: "ADVANCE" },
          "tagged:advance",
        );
      }
      writeFileSync(
        join(dir, CHECKPOINT_FILE),
        toJson({ schemaVersion: 1, data: expected }),
      );
      let parseCalls = 0;

      const resumed = await resumeFileJob<TaggedState, TaggedEvent, TaggedContext>({
        runId: runId(`canonical-tags-${scenario === "checkpoint-only" ? "checkpoint-only" : "log-checkpoint"}`),
        directory: dir,
        machine: taggedMachine,
        genesis: { state: taggedState(0), context: taggedContext(0) },
        parseCheckpoint(data) {
          parseCalls += 1;
          return taggedParser(data);
        },
      });

      expect(resumed.ok, scenario).toBe(true);
      if (!resumed.ok) continue;
      expect(parseCalls, scenario).toBe(1);
      expect(resumed.value).toEqual(expected);
      expect(resumed.value.state.index).toBeInstanceOf(Map);
      expect(resumed.value.state.labels).toBeInstanceOf(Set);
      expect(resumed.value.state.happenedAt).toBeInstanceOf(Date);
      expect(resumed.value.state.index.get("nested")).toBeInstanceOf(Set);
      expect(resumed.value.state.index.get("missing")).toBeUndefined();
      expect(resumed.value.state.missing).toBeUndefined();
      expect(resumed.value.context.optional).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Replay determinism property
// ---------------------------------------------------------------------------

describe("resumeFileJob — replay determinism", () => {
  it("property: the same journal always resumes to the same state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constant({ type: "STEP" } as E), { minLength: 1, maxLength: 40 }),
        async (steps) => {
          const dir = tempDir();
          const journal = createFileJournal(dir, { now: () => 7 });
          for (let i = 0; i < steps.length; i++) {
            await journal.appendEvent({ type: "STEP" }, `k:${i}`);
          }

          const first = await resume(dir, "determinism");
          const second = await resume(dir, "determinism");
          expect(first.ok).toBe(true);
          expect(second.ok).toBe(true);
          if (!first.ok || !second.ok) return;
          expect(second.value).toEqual(first.value);
          expect(first.value.state).toEqual({ kind: "pending", count: steps.length });
          expect(first.value.context).toEqual({ value: steps.length });
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// FR-040 — the pure machine is not trusted to be throw-free on hostile-but-
// codec-valid input: every machine throw inside resume is re-tagged as the
// typed `checkpoint-corrupt`, never a raw untyped promise rejection
// ---------------------------------------------------------------------------

describe("resumeFileJob — throwing-machine guard (FR-040)", () => {
  it("a machine.transition that throws on a hostile-but-codec-valid event payload ⇒ typed checkpoint-corrupt naming the replay step (never a raw rejection)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    // Codec-valid hostile payload: the strict reader validates only the
    // record ENVELOPE (schemaVersion, sequence, recordedAtMs, dedupKey
    // charset, digest↔filename), so `{type:"wave-done"}` WITHOUT `outputs`
    // passes readFileEvents and reaches the fold — where a production
    // machine's matched ts-pattern arm iterating `outputs` throws.
    await journal.appendEvent({ type: "wave-done" }, "h:hostile");

    // The production `compileDagToMachine`-shaped machine: matches the event
    // TYPE, then derefs a missing field inside the arm.
    const hostile: Machine<S, E, C> = {
      ...machine,
      transition(state, event, context) {
        if ((event as { type: string }).type === "wave-done") {
          throw new TypeError(
            "undefined is not iterable (cannot read property Symbol(Symbol.iterator))",
          );
        }
        return machine.transition(state, event, context);
      },
    };

    const resumed = await resumeFileJob<S, E, C>({
      runId: runId("fr040-replay-guard"),
      directory: dir,
      machine: hostile,
      genesis: genesis(),
      parseCheckpoint,
    });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.runId).toBe(runId("fr040-replay-guard"));
    // The message names the replay step (FR-040) and carries the machine's
    // own error text for diagnosis.
    expect(resumed.error.message).toContain("machine.transition threw while replaying the event log");
    expect(resumed.error.message).toContain("undefined is not iterable");
  });

  it("a machine.stateKey that throws on a decoded hostile checkpoint state ⇒ typed checkpoint-corrupt naming checkpoint.json", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    // Version-drifted checkpoint state: the test decoder (deliberately
    // loose) accepts the payload, but a production stateKey's
    // `.exhaustive()` match throws NonExhaustiveError on the unknown
    // variant.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "version-drifted" }, context: { value: 0 } },
      }),
    );

    const hostile: Machine<S, E, C> = {
      ...machine,
      stateKey: (s) => {
        if ((s as { kind?: string }).kind === "version-drifted") {
          throw new TypeError(
            "NonExhaustiveError: no pattern matched the decoded checkpoint state",
          );
        }
        return machine.stateKey(s);
      },
    };

    const resumed = await resumeFileJob<S, E, C>({
      runId: runId("fr040-statekey-guard"),
      directory: dir,
      machine: hostile,
      genesis: genesis(),
      parseCheckpoint,
    });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.runId).toBe(runId("fr040-statekey-guard"));
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("machine.stateKey threw");
  });

  it("a machine.stateKey that throws only on an intermediate prefix-scan state ⇒ typed checkpoint-corrupt naming the scan step", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    await journal.appendEvent({ type: "STEP" }, "k1");
    await journal.appendEvent({ type: "STEP" }, "k2");
    // Checkpoint = a machine-keyable state that matches NO prefix before the
    // throwing state: the full-replay key (pending,3), the checkpoint key
    // (failed,0) and the genesis key (pending,0) all key fine; the scan runs
    // past i=0 (pending,1) and stateKey throws on (pending,2) at step i=1.
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({
        schemaVersion: 1,
        data: { state: { kind: "failed", count: 0 }, context: { value: 0 } },
      }),
    );

    const hostile: Machine<S, E, C> = {
      ...machine,
      stateKey: (s) => {
        const shape = s as { kind: string; count: number };
        if (shape.kind === "pending" && shape.count === 2) {
          throw new TypeError("NonExhaustiveError: no pattern matched state (pending,2)");
        }
        return machine.stateKey(s);
      },
    };

    const resumed = await resumeFileJob<S, E, C>({
      runId: runId("fr040-scan-statekey-guard"),
      directory: dir,
      machine: hostile,
      genesis: genesis(),
      parseCheckpoint,
    });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("prefix-scan step 1");
    expect(resumed.error.message).toContain("checkpoint.json");
  });
});

// ---------------------------------------------------------------------------
// FR-040 — the caller's parseCheckpoint is NOT trusted to be throw-free: a
// decoder that destructures/derefs before validating throws raw TypeErrors on
// hostile-but-envelope-valid data payloads; every variant must fail as the
// typed `checkpoint-corrupt` naming checkpoint.json — never a raw untyped
// promise rejection
// ---------------------------------------------------------------------------

describe("resumeFileJob — throwing parseCheckpoint guard (FR-040)", () => {
  /** The caller's decoder, written WITHOUT the defensive discipline the
   * framework recommends: it destructures `data.state` and derefs
   * `state.kind` BEFORE validating — the plausible shape of an unguarded
   * production decoder. Every hostile-but-envelope-valid payload makes it
   * throw a raw TypeError before it can return a verdict:
   * `{"__undefined__":true}` deserializes to a REAL `undefined` (the
   * destructure itself throws "Cannot destructure property 'state' of
   * 'undefined'"); `42` boxes to an object with no `.state`, so the
   * `.kind` deref throws; `[1,2,3]` destructures to state=1, whose `.kind`
   * deref is undefined — a decoder under test that derefs instead of
   * throwing returns a typed rejection, which must STILL surface as
   * `checkpoint-corrupt` (the envelope gates never inspected `data`'s
   * shape, so none of the three can be rejected earlier). */
  const hostileParseCheckpoint = (data: unknown): Result<{ state: S; context: C }, string> => {
    const { state, context } = data as { state: S; context: C };
    const kind = state.kind;
    if (kind !== "pending" && kind !== "succeeded" && kind !== "failed") {
      return err(`state has no recognized kind`);
    }
    return ok({ state, context });
  };

  const hostileResume = (directory: string, rid: string) =>
    resumeFileJob<S, E, C>({
      runId: runId(rid),
      directory,
      machine,
      genesis: genesis(),
      parseCheckpoint: hostileParseCheckpoint,
    });

  it("a data payload that deserializes to a REAL undefined ({__undefined__:true}) ⇒ typed checkpoint-corrupt naming checkpoint.json + 'parseCheckpoint threw'", async () => {
    const dir = tempDir();
    await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
    // Passes the complete serializer grammar: `__undefined__:true` is a
    // canonical serializer marker, the envelope is an object with exactly
    // schemaVersion + the
    // `data` KEY (`"data" in record` passes — its VALUE deserializes to
    // undefined), schemaVersion is 1. Only the decoder seam can catch it.
    writeFileSync(join(dir, CHECKPOINT_FILE), toJson({ schemaVersion: 1, data: { __undefined__: true } }));

    const resumed = await hostileResume(dir, "fr040-decoder-undefined");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.runId).toBe(runId("fr040-decoder-undefined"));
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("parseCheckpoint threw");
    // The decoder's own raw TypeError rides inside the typed error.
    expect(resumed.error.message).toContain("Cannot destructure property 'state'");
  });

  it("data payloads 42 and [1,2,3] reach the same typed checkpoint-corrupt, never a raw rejection", async () => {
    const variants: ReadonlyArray<readonly [string, unknown]> = [
      ["scalar-42", 42],
      ["array", [1, 2, 3]],
    ];
    for (const [label, payload] of variants) {
      const dir = tempDir();
      await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
      writeFileSync(join(dir, CHECKPOINT_FILE), toJson({ schemaVersion: 1, data: payload }));

      const resumed = await hostileResume(dir, `fr040-decoder-${label}`);
      expect(resumed.ok, `variant ${label}`).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, `variant ${label}`).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.runId, `variant ${label}`).toBe(runId(`fr040-decoder-${label}`));
      expect(resumed.error.message, `variant ${label}`).toContain("checkpoint.json");
      // 42: the decoder's `.kind` deref throws → the throw-guard message.
      // [1,2,3]: the decoder's deref yields no kind → its typed rejection.
      // Either way the seam fails closed as checkpoint-corrupt.
      expect(resumed.error.message, `variant ${label}`).toEqual(
        expect.stringMatching(/parseCheckpoint threw|state has no recognized kind/),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// FR-040 — systematic total-guard matrix across every resume callback seam
// ---------------------------------------------------------------------------

type HostileResumeArgs = ResumeFileJobArgs<S, E, C>;

interface HostileCallbackSeam {
  readonly label: string;
  readonly expectedContext: readonly string[];
  readonly arrange: (directory: string, thrown: unknown) => Promise<HostileResumeArgs>;
}

const throwHostile = (thrown: unknown): never => {
  throw thrown;
};

const appendSteps = async (directory: string, count: number): Promise<void> => {
  const journal = createFileJournal(directory, { now: () => 7 });
  for (let index = 0; index < count; index++) {
    await journal.appendEvent({ type: "STEP" }, `matrix:${index}`);
  }
};

const writeCheckpointState = (directory: string, state: S, context: C): void => {
  writeFileSync(
    join(directory, CHECKPOINT_FILE),
    toJson({ schemaVersion: 1, data: { state, context } }),
  );
};

const argsFor = (
  directory: string,
  callbackMachine: Machine<S, E, C>,
  callbackParser = parseCheckpoint,
): HostileResumeArgs => ({
  runId: runId("fr040-hostile-matrix"),
  directory,
  machine: callbackMachine,
  genesis: genesis(),
  parseCheckpoint: callbackParser,
});

const hostileCallbackSeams = (): readonly HostileCallbackSeam[] => [
  {
    label: "full replay transition/fold",
    expectedContext: ["events", "machine.transition threw while replaying", "shared fold"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 1);
      return argsFor(directory, {
        ...machine,
        transition: () => throwHostile(thrown),
      });
    },
  },
  {
    label: "parseCheckpoint decoder",
    expectedContext: ["checkpoint.json", "parseCheckpoint threw", "checkpoint payload"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "pending", count: 1 }, { value: 1 });
      return argsFor(
        directory,
        machine,
        () => throwHostile(thrown),
      );
    },
  },
  {
    label: "full-agreement replayed stateKey",
    expectedContext: ["checkpoint.json", "full-agreement replayed-state comparison", "machine.stateKey threw"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "pending", count: 1 }, { value: 1 });
      return argsFor(directory, {
        ...machine,
        stateKey: (state) =>
          state.kind === "pending" && state.count === 1
            ? throwHostile(thrown)
            : machine.stateKey(state),
      });
    },
  },
  {
    label: "full-agreement checkpoint stateKey",
    expectedContext: ["checkpoint.json", "full-agreement decoded-checkpoint-state comparison", "machine.stateKey threw"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "failed", count: 0 }, { value: 0 });
      return argsFor(directory, {
        ...machine,
        stateKey: (state) => state.kind === "failed"
          ? throwHostile(thrown)
          : machine.stateKey(state),
      });
    },
  },
  {
    label: "empty-prefix genesis stateKey",
    expectedContext: ["checkpoint.json", "empty-prefix benign-lag check", "machine.stateKey threw"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "failed", count: 0 }, { value: 0 });
      return argsFor(directory, {
        ...machine,
        stateKey: (state) =>
          state.kind === "pending" && state.count === 0
            ? throwHostile(thrown)
            : machine.stateKey(state),
      });
    },
  },
  {
    label: "strict-prefix transition/fold",
    expectedContext: ["events", "prefix-scan step 0", "event index 0", "machine.transition/fold threw"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 2);
      writeCheckpointState(directory, { kind: "failed", count: 0 }, { value: 0 });
      let transitionCalls = 0;
      return argsFor(directory, {
        ...machine,
        transition(state, event, context) {
          transitionCalls += 1;
          return transitionCalls === 3
            ? throwHostile(thrown)
            : machine.transition(state, event, context);
        },
      });
    },
  },
  {
    label: "strict-prefix intermediate stateKey",
    expectedContext: ["checkpoint.json", "prefix-scan step 0", "intermediate replay-state", "machine.stateKey threw"],
    arrange: async (directory, thrown) => {
      await appendSteps(directory, 3);
      writeCheckpointState(directory, { kind: "failed", count: 0 }, { value: 0 });
      return argsFor(directory, {
        ...machine,
        stateKey: (state) =>
          state.kind === "pending" && state.count === 1
            ? throwHostile(thrown)
            : machine.stateKey(state),
      });
    },
  },
];

describe("resumeFileJob — hostile thrown-value callback matrix (FR-040)", () => {
  for (const [seamIndex, seam] of hostileCallbackSeams().entries()) {
    it(`${seam.label} maps every hostile throw to contextual checkpoint-corrupt without mutation`, async () => {
      for (const [valueIndex, hostile] of hostileThrownValueMatrix().entries()) {
        const scenario = `${seam.label}/${hostile.label}`;
        const directory = tempDir();
        const args = await seam.arrange(directory, hostile.create());
        const before = snapshotDirectory(directory);

        // Any raw rejection fails this test before the typed assertions.
        const resumed = await resumeFileJob({
          ...args,
          runId: runId(`fr040-matrix-${seamIndex}-${valueIndex}`),
        });

        expect(resumed.ok, scenario).toBe(false);
        if (resumed.ok) continue;
        expect(resumed.error.kind, scenario).toBe("checkpoint-corrupt");
        if (resumed.error.kind !== "checkpoint-corrupt") continue;
        expect(resumed.error.runId, scenario).toBe(runId(`fr040-matrix-${seamIndex}-${valueIndex}`));
        for (const context of seam.expectedContext) {
          expect(resumed.error.message, `${scenario}: ${context}`).toContain(context);
        }
        expect(resumed.error.message, scenario).toContain("FR-040");
        expect(snapshotDirectory(directory), `${scenario}: resume must be read-only`).toEqual(before);
      }
    });
  }

  it("safely renders hostile parseCheckpoint rejection messages without mutation", async () => {
    for (const [valueIndex, hostile] of hostileThrownValueMatrix().entries()) {
      const directory = tempDir();
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "pending", count: 1 }, { value: 1 });
      const before = snapshotDirectory(directory);
      const resumed = await resumeFileJob<S, E, C>({
        ...argsFor(directory, machine),
        runId: runId(`fr040-message-${valueIndex}`),
        parseCheckpoint: () => err(hostile.create() as string),
      });

      expect(resumed.ok, hostile.label).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, hostile.label).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.message, hostile.label).toContain("checkpoint.json");
      expect(typeof resumed.error.message, hostile.label).toBe("string");
      expect(snapshotDirectory(directory), hostile.label).toEqual(before);
    }
  });

  it("rejects hostile non-string state keys with total rendering and exact comparison context", async () => {
    for (const [valueIndex, hostile] of hostileThrownValueMatrix().entries()) {
      const directory = tempDir();
      await appendSteps(directory, 1);
      writeCheckpointState(directory, { kind: "failed", count: 0 }, { value: 0 });
      const hostileKey = hostile.create();
      const before = snapshotDirectory(directory);
      const resumed = await resumeFileJob<S, E, C>({
        ...argsFor(directory, {
          ...machine,
          stateKey: (state) => state.kind === "failed"
            ? hostileKey as string
            : machine.stateKey(state),
        }),
        runId: runId(`fr040-key-${valueIndex}`),
      });

      expect(resumed.ok, hostile.label).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, hostile.label).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.message, hostile.label).toContain("full-agreement decoded-checkpoint-state comparison");
      expect(resumed.error.message, hostile.label).toContain("non-string state key");
      expect(snapshotDirectory(directory), hostile.label).toEqual(before);
    }
  });

  it("guards hostile parseCheckpoint Result inspection instead of leaking to the outer cache-error mapper", async () => {
    const directory = tempDir();
    await appendSteps(directory, 1);
    writeCheckpointState(directory, { kind: "pending", count: 1 }, { value: 1 });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const before = snapshotDirectory(directory);

    const resumed = await resumeFileJob<S, E, C>({
      ...argsFor(directory, machine),
      runId: runId("fr040-result-inspection"),
      parseCheckpoint: () => revoked.proxy as Result<{ state: S; context: C }, string>,
    });

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("parseCheckpoint threw");
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(snapshotDirectory(directory)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// AD-6 — readCheckpoint's typed throw passthrough + reader I/O re-tag
// ---------------------------------------------------------------------------

describe("resumeFileJob — checkpoint.json fs-failure passthrough (AD-6)", () => {
  it("a directory squatting on checkpoint.json (EISDIR) ⇒ the journal's typed cache-error propagates unchanged", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 7 });
    await journal.appendEvent({ type: "STEP" }, "k0");
    // A DIRECTORY wearing the checkpoint name: existsSync passes, the read
    // throws EISDIR, readCheckpoint relabels it `cache-error` (AD-6) — an
    // environment failure, not a content verdict.
    mkdirSync(join(dir, CHECKPOINT_FILE));

    const resumed = await resume(dir, "checkpoint-squat");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("cache-error");
    if (resumed.error.kind !== "cache-error") return;
    expect(resumed.error.operation).toBe("readCheckpoint");
    // The journal's fs-failure message (naming the directory + EISDIR)
    // rides through unchanged — a typed passthrough, not a re-tag.
    expect(resumed.error.message).toContain("EISDIR");
  });

  it("a directory squatting on an event-file name (EISDIR on read) ⇒ the reader failure is re-tagged checkpoint-corrupt with the message preserved", async () => {
    const dir = tempDir();
    const eventsDir = join(dir, EVENTS_DIR);
    mkdirSync(eventsDir, { recursive: true });
    // A DIRECTORY wearing a valid event-file name: the reader's listing
    // filter is name-only, so it IS listed, and the read throws EISDIR —
    // the reader fails closed (never treating the log as empty), and resume
    // re-tags the cache-error as checkpoint-corrupt per AD-6, preserving
    // the reader's message (which names the file and reason).
    mkdirSync(join(eventsDir, `000000-${"a".repeat(64)}.json`));

    const resumed = await resume(dir, "event-squat");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("read failed");
    expect(resumed.error.message).toContain("000000-");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint envelope shape gates — fail closed, naming checkpoint.json
// ---------------------------------------------------------------------------

describe("resumeFileJob — checkpoint envelope shape gates", () => {
  it("valid-JSON non-object checkpoints (array/scalar/null/string) ⇒ checkpoint-corrupt naming checkpoint.json", async () => {
    const variants: ReadonlyArray<readonly [string, string]> = [
      ["array", "[1,2,3]"],
      ["scalar", "42"],
      ["null", "null"],
      ["string", '"hello"'],
    ];
    for (const [label, json] of variants) {
      const dir = tempDir();
      await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
      writeFileSync(join(dir, CHECKPOINT_FILE), json);

      const resumed = await resume(dir, `shape-${label}`);
      expect(resumed.ok, `variant ${label}`).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, `variant ${label}`).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.message, `variant ${label}`).toContain("checkpoint.json");
      expect(resumed.error.message, `variant ${label}`).toContain("must be a JSON object");
    }
  });

  it("an unknown top-level field ⇒ checkpoint-corrupt naming the field", async () => {
    const dir = tempDir();
    await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
    writeFileSync(
      join(dir, CHECKPOINT_FILE),
      toJson({ schemaVersion: 1, data: genesis(), extra: 1 }),
    );

    const resumed = await resume(dir, "shape-extra-field");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain('unknown top-level field "extra"');
  });

  it("a missing data payload ⇒ checkpoint-corrupt naming checkpoint.json", async () => {
    const dir = tempDir();
    await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
    writeFileSync(join(dir, CHECKPOINT_FILE), toJson({ schemaVersion: 1 }));

    const resumed = await resume(dir, "shape-missing-data");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.kind).toBe("checkpoint-corrupt");
    if (resumed.error.kind !== "checkpoint-corrupt") return;
    expect(resumed.error.message).toContain("checkpoint.json");
    expect(resumed.error.message).toContain("missing data payload");
  });
});

// ---------------------------------------------------------------------------
// Pollution-keyed checkpoint envelope — the shared raw serializer-grammar
// gate (parity with the strict record codec's tryParseEventRecordJson seam)
// ---------------------------------------------------------------------------

describe("resumeFileJob — pollution-key checkpoint envelope fails closed", () => {
  it("constructor/prototype-keyed and __proto__-keyed checkpoint JSON ⇒ checkpoint-corrupt naming checkpoint.json", async () => {
    const hostileCheckpoints = [
      // A hostile top-level field the closed-field scan would catch anyway —
      // but deserializeValue ALREADY stripped it before the scan ran, so the
      // raw serializer-grammar gate is the only gate that can see it.
      `{"schemaVersion":1,"data":{"state":{"kind":"pending","count":0},"context":{"value":0}},"constructor":{"x":1}}`,
      `{"schemaVersion":1,"data":{"state":{"kind":"pending","count":0},"context":{"value":0}},"prototype":{"x":1}}`,
      `{"__proto__":{"polluted":true},"schemaVersion":1,"data":{"state":{"kind":"pending","count":0},"context":{"value":0}}}`,
    ];
    for (const [i, json] of hostileCheckpoints.entries()) {
      const dir = tempDir();
      await createFileJournal(dir, { now: () => 7 }).appendEvent({ type: "STEP" }, "k0");
      // RAW text on purpose: toJson would silently strip the pollution
      // keys — the seam under test is pre-deserialization grammar validation.
      writeFileSync(join(dir, CHECKPOINT_FILE), json);

      const resumed = await resume(dir, `pollution-${i}`);
      expect(resumed.ok, `variant ${i}`).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.kind, `variant ${i}`).toBe("checkpoint-corrupt");
      if (resumed.error.kind !== "checkpoint-corrupt") continue;
      expect(resumed.error.message, `variant ${i}`).toContain("checkpoint.json");
      expect(resumed.error.message, `variant ${i}`).toContain("prototype-pollution-filtered key");
    }
  });
});

// ---------------------------------------------------------------------------
// AD-3 prefix-space property — every strict prefix (incl. genesis and the
// full replay) is benign lag; any other checkpoint is corruption
// ---------------------------------------------------------------------------

describe("resumeFileJob — prefix-space property (fast-check)", () => {
  it("property: a checkpoint equal to the replay of ANY prefix of the log (k ≤ n, incl. empty prefix = genesis and the full replay) resumes ok from the full-replay state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        async (n, k) => {
          fc.pre(k <= n);
          const dir = tempDir();
          const journal = createFileJournal(dir, { now: () => 7 });
          for (let i = 0; i < n; i++) await journal.appendEvent({ type: "STEP" }, `k:${i}`);
          writeFileSync(
            join(dir, CHECKPOINT_FILE),
            toJson({
              schemaVersion: 1,
              data: { state: { kind: "pending", count: k }, context: { value: k } },
            }),
          );

          const resumed = await resume(dir, "prefix-space");
          expect(resumed.ok).toBe(true);
          if (!resumed.ok) return;
          // The resumed state is ALWAYS the full replay — never the lagging
          // projection (FR-010).
          expect(resumed.value.state).toEqual({ kind: "pending", count: n });
          expect(resumed.value.context).toEqual({ value: n });
        },
      ),
    );
  });

  it("property: a checkpoint whose state the log never passed through (count > n) is checkpoint-corrupt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 6 }),
        async (n, offset) => {
          const dir = tempDir();
          const journal = createFileJournal(dir, { now: () => 7 });
          for (let i = 0; i < n; i++) await journal.appendEvent({ type: "STEP" }, `k:${i}`);
          writeFileSync(
            join(dir, CHECKPOINT_FILE),
            toJson({
              schemaVersion: 1,
              data: {
                state: { kind: "pending", count: n + offset },
                context: { value: n + offset },
              },
            }),
          );

          const resumed = await resume(dir, "prefix-space-corrupt");
          expect(resumed.ok).toBe(false);
          if (resumed.ok) return;
          expect(resumed.error.kind).toBe("checkpoint-corrupt");
          if (resumed.error.kind !== "checkpoint-corrupt") return;
          expect(resumed.error.message).toContain("vs replay");
        },
      ),
    );
  });
});
