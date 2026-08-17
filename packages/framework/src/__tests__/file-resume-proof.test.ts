/**
 * Direct PURE tests for `src/file/resume-proof.ts` — the ADR-0077 agreement
 * proof (`proveResumeAgreement`), extracted from the `resumeFileJob`
 * filesystem shell.
 *
 * The proof is the pure core of resume: given the already-acquired event log
 * and raw checkpoint JSON (plus machine, genesis, and the caller's strict
 * decoder), it decides full agreement ⇒ resume from the replay, strict-prefix
 * benign lag (incl. the empty prefix = genesis) ⇒ resume from the replay, or
 * disagreement ⇒ fail closed with the typed `checkpoint-corrupt`. No I/O:
 * every test here hands the proof synthetic `directory` strings and in-memory
 * events/checkpoint JSON.
 *
 * Coverage:
 * - Full agreement: checkpoint == full replay ⇒ `ok` with the replayed
 *   state; the decoder is consulted exactly once; no checkpoint
 *   (`checkpointJson: null`) resumes from the pure replay without touching
 *   the decoder; proof inputs are never mutated.
 * - Strict-prefix lag (ADR-0077 step 7): empty-prefix (genesis) lag, lag by one,
 *   lag by the last strict prefix, and checkpoint-only runs (empty log +
 *   genesis-agreeing checkpoint resume to genesis).
 * - Disagreement (FR-010): a checkpoint matching no prefix fails closed with
 *   the typed `checkpoint-corrupt` naming `checkpoint <key> vs replay <key>`
 *   and the runId; a manufactured failed-terminal-state checkpoint is
 *   rejected (FR-012); an empty log + disagreeing checkpoint fails closed.
 * - Envelope decode gates: bad JSON, non-object envelopes, unknown top-level
 *   fields, unsupported schemaVersion, missing data payload, complete raw
 *   serializer-grammar violations (each before `parseCheckpoint`), and
 *   canonical nested Map/Set/Date/undefined tags round-tripping to a full
 *   agreement.
 * - Guarded hostile callbacks (FR-040): every machine/decoder seam —
 *   `machine.transition` throws in the full replay, `machine.stateKey`
 *   throws on a decoded hostile checkpoint state, on the genesis empty-prefix
 *   check, and on an intermediate prefix-scan state, `machine.transition`
 *   throws inside the prefix scan, `parseCheckpoint` throws raw TypeErrors
 *   on hostile-but-envelope-valid payloads or returns hostile values — every
 *   variant re-tagged as the typed `checkpoint-corrupt` naming the step;
 *   hostile thrown values (revoked proxies, throwing getters, null-prototype
 *   objects) never escape and never make rendering throw; hostile non-string
 *   state keys fail closed.
 *
 * Filesystem integration (acquisition, re-tagging, ADR-0080 passthrough, the
 * FR-014 gate, and the outer typed boundary) stays covered by
 * `file-resume.test.ts`; the two suites share the same machine fixtures.
 */

import { describe, it, expect } from "bun:test";
import { proveResumeAgreement } from "../file/resume-proof.js";
import type { ResumeProofArgs } from "../file/resume-proof.js";
import { serializeFileCheckpoint } from "../file/checkpoint-record.js";
import type { Machine, RecordedEvent } from "../state-machine/types.js";
import { toJson } from "../state-machine/serialize.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { runId } from "../types/ids.js";

// ---------------------------------------------------------------------------
// Fixtures — the same minimal machine as the integration suite:
// pending(0) →STEP→ pending(n) →DONE→ succeeded, →FAIL→ failed (the failed
// state is the kernel's terminal-failed rejection target: never appended,
// never checkpointed, and its key appears in no prefix replay)
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
 * The caller's strict checkpoint decoder: the envelope's schemaVersion is the
 * proof's gate; the `data` payload shape ({ state, context }) is this
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

/** Wrap a raw event in the durable envelope the strict reader produces. */
const recorded = <T>(event: T, atMs = 1_000): RecordedEvent<unknown> => ({
  recordedAtMs: atMs,
  event,
});

/** A log of `count` STEP events at increasing recordedAtMs (envelope shape
 * exactly as `readFileEvents` returns it). */
const stepLog = (count: number): readonly RecordedEvent<unknown>[] =>
  Array.from({ length: count }, (_, i) => recorded({ type: "STEP" }, (i + 1) * 1_000));

/** Serialize a checkpoint exactly as `serializeFileCheckpoint` would. */
const checkpointJson = (state: S, context: C): string =>
  toJson({ schemaVersion: 1, data: { state, context } });

/** The proof under test with sane defaults; tests override what they probe. */
const prove = (
  overrides: Partial<ResumeProofArgs<S, E, C>>,
): Result<{ state: S; context: C }, FrameworkError> =>
  proveResumeAgreement<S, E, C>({
    runId: runId("pure-proof"),
    directory: "run/pure-proof",
    events: [],
    checkpointJson: null,
    machine,
    genesis: genesis(),
    parseCheckpoint,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Full agreement — the checkpoint equals the full replay (ADR-0077 step 6)
// ---------------------------------------------------------------------------

describe("proveResumeAgreement — full agreement (ADR-0077 step 6)", () => {
  it("resumes from the log replay when the checkpoint equals the full replay, consulting the decoder exactly once", () => {
    let parseCalls = 0;
    const result = prove({
      events: stepLog(2).concat([recorded({ type: "DONE" }, 3_000)]),
      checkpointJson: checkpointJson({ kind: "succeeded", count: 2 }, { value: 2 }),
      parseCheckpoint(data) {
        parseCalls += 1;
        return parseCheckpoint(data);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "succeeded", count: 2 });
    expect(result.value.context).toEqual({ value: 2 });
    expect(parseCalls).toBe(1);
  });

  it("resumes from the pure replay when no checkpoint exists, never consulting the decoder", () => {
    let parseCalls = 0;
    const result = prove({
      events: stepLog(2),
      checkpointJson: null,
      parseCheckpoint(data) {
        parseCalls += 1;
        return parseCheckpoint(data);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "pending", count: 2 });
    expect(result.value.context).toEqual({ value: 2 });
    expect(parseCalls).toBe(0);
  });

  it("never mutates its inputs (the events array and machine survive untouched)", () => {
    const events = stepLog(3);
    const snapshot: string = toJson(events);
    const machineSnapshot: string = toJson(machine);

    const agreed = prove({
      events,
      checkpointJson: checkpointJson({ kind: "pending", count: 3 }, { value: 3 }),
    });
    expect(agreed.ok).toBe(true);
    expect(toJson(events)).toBe(snapshot);
    expect(toJson(machine)).toBe(machineSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Strict-prefix lag — the benign append-before-checkpoint window (ADR-0077 step 7)
// ---------------------------------------------------------------------------

describe("proveResumeAgreement — strict-prefix benign lag (ADR-0077 step 7)", () => {
  const threeStepsThenDone = (): readonly RecordedEvent<unknown>[] =>
    stepLog(3).concat([recorded({ type: "DONE" }, 4_000)]);

  it("a checkpoint of the genesis state over a non-empty log is the empty-prefix lag; the replay wins", () => {
    const result = prove({
      events: threeStepsThenDone(),
      checkpointJson: checkpointJson(genesis().state, genesis().context),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "succeeded", count: 3 });
    expect(result.value.context).toEqual({ value: 3 });
  });

  it("a checkpoint lagging by ONE strict prefix is benign; the replay wins", () => {
    const result = prove({
      events: threeStepsThenDone(),
      checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "succeeded", count: 3 });
    expect(result.value.context).toEqual({ value: 3 });
  });

  it("a checkpoint lagging by the LAST strict prefix (one transition behind the full replay) is benign", () => {
    const result = prove({
      events: threeStepsThenDone(),
      checkpointJson: checkpointJson({ kind: "pending", count: 2 }, { value: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "succeeded", count: 3 });
  });

  it("a lag-by-many checkpoint far behind the replay is benign (any strict prefix qualifies)", () => {
    const result = prove({
      events: stepLog(8),
      checkpointJson: checkpointJson({ kind: "pending", count: 2 }, { value: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ kind: "pending", count: 8 });
    expect(result.value.context).toEqual({ value: 8 });
  });

  it("an empty log + genesis-agreeing checkpoint (checkpoint-only run) resumes to genesis", () => {
    const result = prove({
      events: [],
      checkpointJson: checkpointJson(genesis().state, genesis().context),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(genesis());
  });
});

// ---------------------------------------------------------------------------
// Disagreement — the checkpoint matches NO state the log provably passed
// through (FR-010)
// ---------------------------------------------------------------------------

describe("proveResumeAgreement — disagreement fails closed (FR-010)", () => {
  const threeStepsThenDone = (): readonly RecordedEvent<unknown>[] =>
    stepLog(3).concat([recorded({ type: "DONE" }, 4_000)]);

  it("a checkpoint matching no prefix of the log ⇒ checkpoint-corrupt naming both keys and the runId", () => {
    const result = prove({
      runId: runId("pure-disagree"),
      events: threeStepsThenDone(),
      checkpointJson: checkpointJson({ kind: "pending", count: 99 }, { value: 99 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.runId).toBe(runId("pure-disagree"));
    expect(result.error.message).toContain('checkpoint {"kind":"pending","count":99}');
    expect(result.error.message).toContain('vs replay {"kind":"succeeded","count":3}');
    expect(result.error.message).toContain("run pure-disagree");
  });

  it("a manufactured failed-terminal-state checkpoint is rejected (FR-012) — the failed key appears in no prefix replay", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "failed", count: 1 }, { value: 1 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain('checkpoint {"kind":"failed","count":1}');
    expect(result.error.message).toContain("vs replay");
  });

  it("an empty log + a checkpoint disagreeing with genesis fails closed naming both keys", () => {
    const result = prove({
      events: [],
      checkpointJson: checkpointJson({ kind: "succeeded", count: 3 }, { value: 3 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain('checkpoint {"kind":"succeeded","count":3}');
    expect(result.error.message).toContain('vs replay {"kind":"pending","count":0}');
  });
});

// ---------------------------------------------------------------------------
// Envelope decode gates — fail closed, naming checkpoint.json. The proof
// owns raw-JSON parse + complete canonical serializer grammar + shape +
// closed field set + schemaVersion; the caller's decoder owns the payload
// shape.
// ---------------------------------------------------------------------------

describe("proveResumeAgreement — checkpoint envelope decode gates", () => {
  it("unparseable checkpoint JSON ⇒ checkpoint-corrupt naming checkpoint.json", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: "{ not valid json !!!",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("not valid JSON");
  });

  it("valid-JSON non-object checkpoints (array/scalar/null/string) ⇒ checkpoint-corrupt", () => {
    for (const [label, json] of [
      ["array", "[1,2,3]"],
      ["scalar", "42"],
      ["null", "null"],
      ["string", '"hello"'],
    ] as const) {
      const result = prove({
        runId: runId(`pure-shape-${label}`),
        events: stepLog(1),
        checkpointJson: json,
      });

      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind, label).toBe("checkpoint-corrupt");
      if (result.error.kind !== "checkpoint-corrupt") continue;
      expect(result.error.message, label).toContain("checkpoint.json");
      expect(result.error.message, label).toContain("must be a JSON object");
    }
  });

  it("an unknown top-level field ⇒ checkpoint-corrupt naming the field", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: toJson({
        schemaVersion: 1,
        data: { state: genesis().state, context: genesis().context },
        extra: 1,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain('unknown top-level field "extra"');
  });

  it("an unsupported schemaVersion ⇒ checkpoint-corrupt naming schemaVersion", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: toJson({ schemaVersion: 99, data: genesis() }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("schemaVersion 99");
  });

  it("a missing data payload ⇒ checkpoint-corrupt naming checkpoint.json", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: toJson({ schemaVersion: 1 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("missing data payload");
  });

  it("a payload the caller's parseCheckpoint rejects ⇒ checkpoint-corrupt carrying the decoder's message", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: toJson({ schemaVersion: 1, data: { state: { kind: "pending", count: 1 } } }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("state and context");
  });

  // Round-8 (silent-failure-hunter-2): a decoder that FORGETS the Result
  // wrapper (returns the bare `{ state, context }` payload) used to fall into
  // the rejected arm with `decoded.error === undefined`, so the reason the
  // operator greps for read `<checkpoint.json>: undefined`. The off-contract
  // RETURN is now named explicitly — resume still fails closed and typed.
  it("a parseCheckpoint that returns a non-Result value ⇒ checkpoint-corrupt naming the off-contract return", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
      parseCheckpoint: ((data: unknown) => data as { state: S; context: C }) as unknown as typeof parseCheckpoint,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("non-Result value");
    expect(result.error.message).toContain("must return ok(data) or err(message)");
  });

  it("checkpoint depth parity: the write and read boundaries count the envelope identically (initialDepth 1)", () => {
    // The envelope `{schemaVersion, data}` sits at depth 1 on BOTH
    // boundaries: the write pre-scan (`assertLosslessEvent(payload)` starts
    // at the envelope in checkpoint-record.ts) and the resume read gate
    // (`validateSerializedValueGrammar` with `initialDepth: 1`). A data
    // chain of 510 nested containers reaches exactly depth 512 — the shared
    // `MAX_SAFE_RECORD_DEPTH` ceiling; 511 containers would reach 513 and
    // must fail closed on BOTH sides (the event codec pins the same
    // identical-counting invariant for journal records).
    const deepArrayValue = (depth: number): unknown => {
      const root: unknown[] = [];
      let cur = root;
      for (let i = 0; i < depth - 1; i++) {
        const next: unknown[] = [];
        (cur as unknown[]).push(next);
        cur = next;
      }
      (cur as unknown[]).push(1);
      return root;
    };
    const state = { kind: "pending" as const, count: 0 };

    // Write boundary: exactly-at-ceiling data is accepted; one past throws.
    expect(() =>
      serializeFileCheckpoint({ state, context: deepArrayValue(510) }),
    ).not.toThrow();
    expect(() =>
      serializeFileCheckpoint({ state, context: deepArrayValue(511) }),
    ).toThrow(/safe depth ceiling/);

    // Read boundary — the same ceiling-depth payload passes the proof's raw
    // grammar gate and reaches full agreement with the empty log (genesis),
    // proving the gate did NOT reject it as too deep...
    const at = prove({
      events: [],
      checkpointJson: checkpointJson(state, deepArrayValue(510) as C),
    });
    expect(at.ok).toBe(true);

    // ...while one level past the ceiling fails closed naming the depth
    // ceiling, exactly like the writer (identical counting).
    const past = prove({
      events: [],
      checkpointJson: checkpointJson(state, deepArrayValue(511) as C),
    });
    expect(past.ok).toBe(false);
    if (!past.ok) {
      if (past.error.kind !== "checkpoint-corrupt") throw new Error("expected checkpoint-corrupt");
      expect(past.error.message).toContain("safe depth ceiling 512");
    }
  });

  it("violates the complete raw serializer grammar before parseCheckpoint (ambiguous tags, pollution keys, excessive depth)", () => {
    const nested = (raw: string): string =>
      `{"state":{"kind":"pending","count":0},"context":{"nested":${raw}}}`;
    const deep = '{"a":'.repeat(520) + "1" + "}".repeat(520);
    const variants: ReadonlyArray<readonly [string, string, string]> = [
      ["tag-sibling", nested('{"__map__":[["k",1]],"extra":true}'), "ambiguous serializer-tag object"],
      ["bad-set-payload", nested('{"__set__":"not-an-array"}'), ".__set__ must be an array"],
      ["bad-undef-payload", nested('{"__undefined__":false}'), ".__undefined__ must be exactly true"],
      ["duplicate-map-key", nested('{"__map__":[["k",1],["k",2]]}'), "duplicates a primitive Map key"],
      ["pollution-key", nested('{"safe":{"constructor":{"polluted":true}}}'), "prototype-pollution-filtered key"],
      ["excessive-depth", nested(deep), "safe depth ceiling 512"],
    ];

    for (const [label, dataJson, expected] of variants) {
      let parseCalls = 0;
      const result = prove({
        runId: runId(`pure-grammar-${label}`),
        events: stepLog(1),
        checkpointJson: `{"schemaVersion":1,"data":${dataJson}}`,
        parseCheckpoint(data) {
          parseCalls += 1;
          return parseCheckpoint(data);
        },
      });

      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind, label).toBe("checkpoint-corrupt");
      if (result.error.kind !== "checkpoint-corrupt") continue;
      expect(result.error.message, label).toContain("checkpoint.json");
      expect(result.error.message, label).toContain("serialized checkpoint is not canonical");
      expect(result.error.message, label).toContain(expected);
      expect(parseCalls, label).toBe(0);
    }
  });

  it("restores canonical nested Map/Set/Date/undefined tags and reaches full agreement", () => {
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

    let parseCalls = 0;
    const result = proveResumeAgreement<TaggedState, TaggedEvent, TaggedContext>({
      runId: runId("pure-canonical-tags"),
      directory: "run/pure-proof",
      events: [recorded({ type: "ADVANCE" })],
      checkpointJson: toJson({
        schemaVersion: 1,
        data: { state: taggedState(1), context: taggedContext(1) },
      }),
      machine: taggedMachine,
      genesis: { state: taggedState(0), context: taggedContext(0) },
      parseCheckpoint(data) {
        parseCalls += 1;
        return taggedParser(data);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseCalls).toBe(1);
    expect(result.value.state.index).toBeInstanceOf(Map);
    expect(result.value.state.labels).toBeInstanceOf(Set);
    expect(result.value.state.happenedAt).toBeInstanceOf(Date);
    expect(result.value.state.index.get("nested")).toBeInstanceOf(Set);
    expect(result.value.state.index.get("missing")).toBeUndefined();
    expect(result.value.context.optional).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Guarded hostile callbacks — FR-040: the pure machine and the caller's
// decoder are NOT trusted to be throw-free on hostile-but-codec-valid input;
// every seam re-tags as the typed checkpoint-corrupt, never a raw untyped
// error
// ---------------------------------------------------------------------------

describe("proveResumeAgreement — guarded hostile callbacks (FR-040)", () => {
  // The caller's decoder, written WITHOUT the defensive discipline the
  // framework recommends: it destructures `data.state` and derefs
  // `state.kind` BEFORE validating — `{"__undefined__":true}` deserializes
  // to a REAL `undefined`, so the destructure itself throws.
  const hostileParseCheckpoint = (data: unknown): Result<{ state: S; context: C }, string> => {
    const { state, context } = data as { state: S; context: C };
    const kind = state.kind;
    if (kind !== "pending" && kind !== "succeeded" && kind !== "failed") {
      return err("state has no recognized kind");
    }
    return ok({ state, context });
  };

  it("machine.transition throwing on a hostile-but-codec-valid event payload during the full replay ⇒ checkpoint-corrupt naming the replay step", () => {
    const result = prove({
      runId: runId("pure-replay-guard"),
      events: [recorded({ type: "wave-done" })],
      checkpointJson: null,
      machine: {
        ...machine,
        transition() {
          throw new TypeError(
            "undefined is not iterable (cannot read property Symbol(Symbol.iterator))",
          );
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.runId).toBe(runId("pure-replay-guard"));
    expect(result.error.message).toContain("machine.transition threw while replaying the event log");
    expect(result.error.message).toContain("undefined is not iterable");
  });

  it("machine.stateKey throwing on a decoded hostile checkpoint state in the full-agreement compare ⇒ checkpoint-corrupt naming checkpoint.json", () => {
    const result = prove({
      runId: runId("pure-statekey-guard"),
      events: stepLog(1),
      // Version-drifted checkpoint state: the deliberately loose decoder
      // accepts the payload, but a production stateKey's `.exhaustive()`
      // match throws NonExhaustiveError on the unknown variant.
      checkpointJson: toJson({
        schemaVersion: 1,
        data: { state: { kind: "version-drifted" }, context: { value: 0 } },
      }),
      machine: {
        ...machine,
        stateKey: (s) => {
          if ((s as { kind?: string }).kind === "version-drifted") {
            throw new TypeError("NonExhaustiveError: no pattern matched the decoded checkpoint state");
          }
          return machine.stateKey(s);
        },
      },
      parseCheckpoint: (data) => {
        // Deliberately loose: accepts the version-drifted state the strict
        // parseCheckpoint would reject, so only stateKey can catch it.
        if (typeof data !== "object" || data === null) return err("not an object");
        const record = data as Record<string, unknown>;
        return ok({ state: record.state as S, context: record.context as C });
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("machine.stateKey threw");
    expect(result.error.message).toContain("NonExhaustiveError: no pattern matched the decoded checkpoint state");
  });

  it("machine.stateKey throwing on the genesis empty-prefix check ⇒ checkpoint-corrupt naming the step", () => {
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "failed", count: 0 }, { value: 0 }),
      machine: {
        ...machine,
        stateKey: (s) => {
          if (s.kind === "pending" && s.count === 0) {
            throw new TypeError("NonExhaustiveError on genesis");
          }
          return machine.stateKey(s);
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("empty-prefix benign-lag check");
    expect(result.error.message).toContain("NonExhaustiveError on genesis");
  });

  it("machine.transition throwing inside the strict-prefix scan ⇒ checkpoint-corrupt naming the scan step and event index", () => {
    let transitionCalls = 0;
    const result = prove({
      events: stepLog(2),
      checkpointJson: checkpointJson({ kind: "failed", count: 0 }, { value: 0 }),
      machine: {
        ...machine,
        transition(state, event, context) {
          transitionCalls += 1;
          if (transitionCalls === 3) {
            throw new TypeError("NonExhaustiveError at the prefix-scan fold");
          }
          return machine.transition(state, event, context);
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("prefix-scan step 0");
    expect(result.error.message).toContain("event index 0");
    expect(result.error.message).toContain("machine.transition/fold threw");
    expect(result.error.message).toContain("NonExhaustiveError at the prefix-scan fold");
  });

  it("machine.stateKey throwing on an intermediate prefix-scan state ⇒ checkpoint-corrupt naming the scan step", () => {
    const result = prove({
      events: stepLog(3),
      checkpointJson: checkpointJson({ kind: "failed", count: 0 }, { value: 0 }),
      machine: {
        ...machine,
        stateKey: (s) => {
          if (s.kind === "pending" && s.count === 2) {
            throw new TypeError("NonExhaustiveError on state (pending,2)");
          }
          return machine.stateKey(s);
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("prefix-scan step 1");
    expect(result.error.message).toContain("intermediate replay-state");
    expect(result.error.message).toContain("NonExhaustiveError on state (pending,2)");
  });

  it("parseCheckpoint destructuring a REAL undefined payload throws; the raw TypeError surfaces as typed checkpoint-corrupt", () => {
    const result = prove({
      runId: runId("pure-decoder-undefined"),
      events: stepLog(1),
      // Passes the complete serializer grammar: a canonical __undefined__
      // marker inside the data KEY — only the decoder seam can catch it.
      checkpointJson: toJson({ schemaVersion: 1, data: { __undefined__: true } }),
      parseCheckpoint: hostileParseCheckpoint,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.runId).toBe(runId("pure-decoder-undefined"));
    expect(result.error.message).toContain("checkpoint.json");
    expect(result.error.message).toContain("parseCheckpoint threw");
    expect(result.error.message).toContain("Cannot destructure property 'state'");
  });

  it("data payloads 42 and [1,2,3] reach the same typed checkpoint-corrupt through the decoder seam", () => {
    for (const [label, payload] of [
      ["scalar-42", 42],
      ["array", [1, 2, 3]],
    ] as const) {
      const result = prove({
        runId: runId(`pure-decoder-${label}`),
        events: stepLog(1),
        checkpointJson: toJson({ schemaVersion: 1, data: payload }),
        parseCheckpoint: hostileParseCheckpoint,
      });

      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind, label).toBe("checkpoint-corrupt");
      if (result.error.kind !== "checkpoint-corrupt") continue;
      expect(result.error.message, label).toContain("checkpoint.json");
      expect(result.error.message, label).toEqual(
        expect.stringMatching(/parseCheckpoint threw|state has no recognized kind/),
      );
    }
  });

  it("machine.stateKey returning a hostile non-string key ⇒ checkpoint-corrupt naming the comparison source", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "failed", count: 0 }, { value: 0 }),
      machine: {
        ...machine,
        stateKey: (s) => (s.kind === "failed" ? (revoked.proxy as unknown as string) : machine.stateKey(s)),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("full-agreement decoded-checkpoint-state comparison");
    expect(result.error.message).toContain("non-string state key");
    expect(result.error.message).toContain("FR-040");
  });

  it("parseCheckpoint returning a hostile Result (revoked proxy) ⇒ checkpoint-corrupt, never a raw error", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
      parseCheckpoint: () => revoked.proxy as Result<{ state: S; context: C }, string>,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(result.error.message).toContain("parseCheckpoint threw");
    expect(result.error.message).toContain("checkpoint.json");
  });

  it("parseCheckpoint returning a hostile rejection message is rendered totally; the typed error still names checkpoint.json", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const result = prove({
      events: stepLog(1),
      checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
      parseCheckpoint: () => err(revoked.proxy as unknown as string),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("checkpoint-corrupt");
    if (result.error.kind !== "checkpoint-corrupt") return;
    expect(typeof result.error.message).toBe("string");
    expect(result.error.message).toContain("checkpoint.json");
  });

  it("hostile thrown values across the machine/decoder seams never escape and never make rendering throw", () => {
    const hostileThrownValues: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "revoked proxy",
        () => {
          const revoked = Proxy.revocable({}, {});
          revoked.revoke();
          return revoked.proxy;
        },
      ],
      [
        "throwing message getter",
        () =>
          Object.defineProperty({}, "message", {
            get: () => {
              throw new Error("message getter must stay contained");
            },
          }),
      ],
      [
        "null-prototype object",
        () => Object.assign(Object.create(null) as object, { message: "null prototype failure" }),
      ],
    ];

    const scenarios: ReadonlyArray<
      readonly [string, (thrown: unknown) => Partial<ResumeProofArgs<S, E, C>>]
    > = [
      ["full-replay transition", (thrown: unknown) => ({
        events: stepLog(1),
        checkpointJson: null,
        machine: { ...machine, transition: () => { throw thrown; } },
      })],
      ["parseCheckpoint decoder", (thrown: unknown) => ({
        events: stepLog(1),
        checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
        parseCheckpoint: () => { throw thrown; },
      })],
      ["full-agreement stateKey", (thrown: unknown) => ({
        events: stepLog(1),
        checkpointJson: checkpointJson({ kind: "pending", count: 1 }, { value: 1 }),
        machine: { ...machine, stateKey: () => { throw thrown; } },
      })],
    ];
    for (const [scenario, build] of scenarios) {
      for (const [label, create] of hostileThrownValues) {
        const result = prove({
          runId: runId("pure-hostile-matrix"),
          ...build(create()),
        });

        expect(result.ok, `${scenario}/${label}`).toBe(false);
        if (result.ok) continue;
        expect(result.error.kind, `${scenario}/${label}`).toBe("checkpoint-corrupt");
        if (result.error.kind !== "checkpoint-corrupt") continue;
        expect(result.error.message, `${scenario}/${label}`).toContain("FR-040");
        expect(result.error.message, `${scenario}/${label}`).toContain(
          scenario === "full-replay transition"
            ? "machine.transition threw while replaying the event log"
            : scenario === "parseCheckpoint decoder"
              ? "parseCheckpoint threw"
              : "machine.stateKey threw",
        );
      }
    }
  });
});
