// JobLike persistence adapter for DagMachineContext.
//
// `DagMachineContext` extends `DagMachineContextPersisted` with four
// closure/derived fields that cannot survive JSON serialization:
//   - `dag`: contains `run` closures and Zod schemas
//   - `incomingByNode`: derived from `dag.edges`
//   - `outgoingByNode`: contains Predicate functions on conditional edges
//   - `nodeById`: contains `run` closures and Zod schemas
//
// `wrapDagJobLike` accepts the inner `JobLike` typed against the persisted
// shape and returns a wrapped `JobLike` typed against the full runtime shape.
// On `updateData`, closure fields are stripped (type-safe via `DagMachineContextPersisted`).
// On `get data()`, they are re-injected from the live DAG.
//
// On top of the strip/re-inject behaviour, the wrapper stamps the live DAG's
// `dagFingerprint` onto the persisted context. On resume, the wrapper's
// `verifyDagFingerprint()` compares the persisted fingerprint against the
// live one and returns `checkpoint-version-mismatch` when they diverge — a
// redeploy that rewired edges or renamed nodes is no longer undefined
// behaviour (pass-4 plan §4.6).

import type { JobLike } from "../state-machine/types.js";
import type {
  DagPhase,
  DagEvent,
  DagMachineContext,
  DagMachineContextPersisted,
  PersistedEdgeDef,
} from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { Confidence } from "../types/confidence.js";
import { tryConfidence } from "../types/confidence.js";
import type { Witness } from "../types/witness.js";
import { __brandFreshnessExecutionEpoch, __brandWitness, isWitnessKind } from "../types/witness.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, RunId } from "../types/ids.js";
import { DAG_INPUT, tryNodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { dagFingerprint } from "../checkpoint/fingerprint.js";
import { computeIncomingByNode, computeOutgoingByNode, computeUnconditionalAdj } from "./topology.js";
import { asNonEmptyString } from "../types/non-empty-string.js";
import type { NonEmptyString } from "../types/non-empty-string.js";

/**
 * The persisted shape plus an optional fingerprint stamp. This is the type
 * that actually lives in the durable backend (BullMQ job data, Redis, etc.).
 *
 * `__dagFingerprint` is stamped by `persistDagContext` and compared on resume
 * by `verifyDagFingerprint`. It remains optional only for caller-owned fresh or
 * legacy in-memory snapshots; durable seed writers must use `persistDagContext`.
 */
export type PersistedDagContext = DagMachineContextPersisted & {
  readonly __dagFingerprint?: string;
};

/**
 * Wrapped `JobLike` plus an out-of-band fingerprint verifier. The verifier
 * is invoked once at run start (before `runStateMachine` reads `job.data`)
 * so a topology-drift mismatch is surfaced as a structured error rather than
 * propagated to the runner as a corrupt context.
 */
export interface WrappedDagJobLike {
  readonly job: JobLike<DagPhase, unknown, DagMachineContext>;
  verifyDagFingerprint(): Result<void, FrameworkError>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type RetryConfig = {
  readonly backoffMs: readonly number[];
  readonly jitterRatio: number;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const parseNodeIdValue = (
  value: unknown,
  path: string,
  allowDagInput = false,
): Result<NodeId, string> => {
  if (allowDagInput && value === DAG_INPUT) return ok(DAG_INPUT);
  if (typeof value !== "string") return err(`${path} must be a node id string`);
  const parsed = tryNodeId(value);
  return parsed.ok ? parsed : err(`${path}: ${parsed.error}`);
};

const parseNodeIdArray = (
  value: unknown,
  path: string,
): Result<readonly NodeId[], string> => {
  if (!Array.isArray(value)) return err(`${path} must be an array`);
  const parsed: NodeId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const node = parseNodeIdValue(value[index], `${path}[${index}]`);
    if (!node.ok) return node;
    parsed.push(node.value);
  }
  return ok(parsed);
};

const parseNodeIdSet = (
  value: unknown,
  path: string,
): Result<ReadonlySet<NodeId>, string> => {
  if (!(value instanceof Set)) return err(`${path} must be a Set`);
  const parsed = new Set<NodeId>();
  let index = 0;
  for (const raw of value) {
    const node = parseNodeIdValue(raw, `${path}[${index}]`);
    if (!node.ok) return node;
    parsed.add(node.value);
    index += 1;
  }
  return ok(parsed);
};

const parseNodeIdMap = <T>(
  value: unknown,
  path: string,
  parseValue: (raw: unknown, valuePath: string) => Result<T, string>,
  allowDagInputKeys = false,
): Result<ReadonlyMap<NodeId, T>, string> => {
  if (!(value instanceof Map)) return err(`${path} must be a Map`);
  const parsed = new Map<NodeId, T>();
  let index = 0;
  for (const [rawKey, rawValue] of value) {
    const key = parseNodeIdValue(rawKey, `${path}.key[${index}]`, allowDagInputKeys);
    if (!key.ok) return key;
    const item = parseValue(rawValue, `${path}.value[${index}]`);
    if (!item.ok) return item;
    parsed.set(key.value, item.value);
    index += 1;
  }
  return ok(parsed);
};

const parseRetryConfig = (value: unknown, path: string): Result<RetryConfig, string> => {
  if (!isRecord(value) || !Array.isArray(value.backoffMs)) {
    return err(`${path} must carry a backoffMs array and jitterRatio`);
  }
  if (
    value.backoffMs.length === 0 ||
    !value.backoffMs.every((delay) => typeof delay === "number" && Number.isFinite(delay) && delay >= 0)
  ) {
    return err(`${path}.backoffMs must be a non-empty array of finite non-negative numbers`);
  }
  if (
    typeof value.jitterRatio !== "number" ||
    !Number.isFinite(value.jitterRatio) ||
    value.jitterRatio < 0 ||
    value.jitterRatio > 1
  ) {
    return err(`${path}.jitterRatio must be a finite number in [0, 1]`);
  }
  return ok({ backoffMs: [...value.backoffMs], jitterRatio: value.jitterRatio });
};

const parseRetryCount = (value: unknown, path: string): Result<number, string> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? ok(value)
    : err(`${path} must be a non-negative safe integer`);

const parseNonEmptyString = (value: unknown, path: string): Result<NonEmptyString, string> => {
  if (typeof value !== "string") return err(`${path} must be a string`);
  const parsed = asNonEmptyString(value);
  return parsed === undefined ? err(`${path} must be non-blank`) : ok(parsed);
};

const parseConfidenceValue = (
  value: unknown,
  path: string,
): Result<Confidence | null, string> => {
  if (value === null) return ok(null);
  if (!isRecord(value) || typeof value.bucket !== "string" || typeof value.source !== "string") {
    return err(`${path} must be null or a confidence record`);
  }
  const raw = value.raw;
  if (raw !== undefined && typeof raw !== "number" && typeof raw !== "string") {
    return err(`${path}.raw must be a number or string when present`);
  }
  const parsed = tryConfidence(value.bucket, value.source, raw);
  return parsed.ok ? parsed : err(`${path}: ${parsed.error}`);
};

const parseWitness = (value: unknown, path: string): Result<Witness, string> => {
  if (!isRecord(value)) return err(`${path} must be a witness record`);
  if (!isWitnessKind(value.kind)) return err(`${path}.kind is invalid`);
  if (typeof value.resource !== "string" || value.resource.length === 0) {
    return err(`${path}.resource must be a non-empty string`);
  }
  if (typeof value.value !== "string" || value.value.length === 0) {
    return err(`${path}.value must be a non-empty string`);
  }
  return ok(__brandWitness({
    kind: value.kind,
    resource: value.resource,
    value: value.value,
  }));
};

const parsePriorWitnesses = (value: unknown): Result<ReadonlyMap<string, Witness>, string> => {
  if (!(value instanceof Map)) return err("context.priorWitnesses must be a Map");
  const parsed = new Map<string, Witness>();
  let index = 0;
  for (const [rawResource, rawWitness] of value) {
    if (typeof rawResource !== "string" || rawResource.length === 0) {
      return err(`context.priorWitnesses.key[${index}] must be a non-empty string`);
    }
    const witness = parseWitness(rawWitness, `context.priorWitnesses.value[${index}]`);
    if (!witness.ok) return witness;
    if (witness.value.resource !== rawResource) {
      return err(`context.priorWitnesses.value[${index}].resource must match its map key`);
    }
    parsed.set(rawResource, witness.value);
    index += 1;
  }
  return ok(parsed);
};

const parseWaves = (value: unknown): Result<readonly (readonly NodeId[])[], string> => {
  if (!Array.isArray(value)) return err("context.waves must be an array");
  const waves: Array<readonly NodeId[]> = [];
  for (let index = 0; index < value.length; index += 1) {
    const wave = parseNodeIdArray(value[index], `context.waves[${index}]`);
    if (!wave.ok) return wave;
    waves.push(wave.value);
  }
  return ok(waves);
};

const parseEdges = (value: unknown): Result<readonly PersistedEdgeDef[], string> => {
  if (!Array.isArray(value)) return err("context.edges must be an array");
  const edges: PersistedEdgeDef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) return err(`context.edges[${index}] must be a record`);
    const from = parseNodeIdValue(raw.from, `context.edges[${index}].from`, true);
    if (!from.ok) return from;
    const to = parseNodeIdValue(raw.to, `context.edges[${index}].to`);
    if (!to.ok) return to;
    if (raw.kind !== "unconditional" && raw.kind !== "conditional" && raw.kind !== "default") {
      return err(`context.edges[${index}].kind is invalid`);
    }
    if (from.value === DAG_INPUT && raw.kind !== "unconditional") {
      return err(`context.edges[${index}] may use DAG_INPUT only for an unconditional edge`);
    }
    edges.push({ from: from.value, to: to.value, kind: raw.kind });
  }
  return ok(edges);
};

const parseRetryLimits = (value: unknown): Result<Readonly<Record<string, number>> | undefined, string> => {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return err("context.retryLimits must be a record or undefined");
  const limits: Record<string, number> = {};
  for (const [rawNodeId, rawLimit] of Object.entries(value)) {
    const node = parseNodeIdValue(rawNodeId, `context.retryLimits.${rawNodeId}`);
    if (!node.ok) return node;
    const limit = parseRetryCount(rawLimit, `context.retryLimits.${rawNodeId}`);
    if (!limit.ok) return limit;
    limits[node.value] = limit.value;
  }
  return ok(limits);
};

const parseOptionalRetryLimit = (value: unknown): Result<number | undefined, string> =>
  value === undefined ? ok(undefined) : parseRetryCount(value, "context.defaultRetryLimit");

const parseOptionalOutputNodeId = (value: unknown): Result<NodeId | undefined, string> =>
  value === undefined ? ok(undefined) : parseNodeIdValue(value, "context.outputNodeId");

/**
 * Parse durable DAG context bytes into the complete closure-free context ADT.
 * Every required field is earned here before a persistence adapter can expose
 * the value as `DagMachineContextPersisted`.
 */
export const parsePersistedDagContext = (value: unknown): Result<PersistedDagContext, string> => {
  if (!isRecord(value)) return err("context must be a record");
  const requiredFields = [
    "waves",
    "edges",
    "unconditionalAdj",
    "outputNodeId",
    "retries",
    "retryConfigs",
    "defaultRetryLimit",
    "retryLimits",
    "humanReviewNodeIds",
    "humanReviewPrompts",
    "activeNodeIds",
    "confidenceByNode",
    "outputs",
    "initialInput",
    "priorWitnesses",
    "freshnessCompletedNodeIds",
    "freshnessExecutionEpoch",
  ] as const;
  const missing = requiredFields.find((field) => !hasOwn(value, field));
  if (missing !== undefined) return err(`context is missing required field '${missing}'`);

  const waves = parseWaves(value.waves);
  if (!waves.ok) return waves;
  const edges = parseEdges(value.edges);
  if (!edges.ok) return edges;
  const unconditionalAdj = parseNodeIdMap(value.unconditionalAdj, "context.unconditionalAdj", parseNodeIdArray);
  if (!unconditionalAdj.ok) return unconditionalAdj;
  const outputNodeId = parseOptionalOutputNodeId(value.outputNodeId);
  if (!outputNodeId.ok) return outputNodeId;
  const retries = parseNodeIdMap(value.retries, "context.retries", parseRetryCount);
  if (!retries.ok) return retries;
  const retryConfigs = parseNodeIdMap(value.retryConfigs, "context.retryConfigs", parseRetryConfig);
  if (!retryConfigs.ok) return retryConfigs;
  const defaultRetryLimit = parseOptionalRetryLimit(value.defaultRetryLimit);
  if (!defaultRetryLimit.ok) return defaultRetryLimit;
  const retryLimits = parseRetryLimits(value.retryLimits);
  if (!retryLimits.ok) return retryLimits;
  const humanReviewNodeIds = parseNodeIdSet(value.humanReviewNodeIds, "context.humanReviewNodeIds");
  if (!humanReviewNodeIds.ok) return humanReviewNodeIds;
  const humanReviewPrompts = parseNodeIdMap(
    value.humanReviewPrompts,
    "context.humanReviewPrompts",
    parseNonEmptyString,
  );
  if (!humanReviewPrompts.ok) return humanReviewPrompts;
  const activeNodeIds = parseNodeIdSet(value.activeNodeIds, "context.activeNodeIds");
  if (!activeNodeIds.ok) return activeNodeIds;
  const confidenceByNode = parseNodeIdMap(value.confidenceByNode, "context.confidenceByNode", parseConfidenceValue);
  if (!confidenceByNode.ok) return confidenceByNode;
  const outputs = parseNodeIdMap(value.outputs, "context.outputs", (raw) => ok(raw), true);
  if (!outputs.ok) return outputs;
  const priorWitnesses = parsePriorWitnesses(value.priorWitnesses);
  if (!priorWitnesses.ok) return priorWitnesses;
  const freshnessCompletedNodeIds = parseNodeIdSet(
    value.freshnessCompletedNodeIds,
    "context.freshnessCompletedNodeIds",
  );
  if (!freshnessCompletedNodeIds.ok) return freshnessCompletedNodeIds;
  const freshnessExecutionEpoch = parseRetryCount(
    value.freshnessExecutionEpoch,
    "context.freshnessExecutionEpoch",
  );
  if (!freshnessExecutionEpoch.ok) return freshnessExecutionEpoch;

  const fingerprint = value.__dagFingerprint;
  if (fingerprint !== undefined && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
    return err("context.__dagFingerprint must be a lowercase sha256 hex string when present");
  }

  return ok({
    waves: waves.value,
    edges: edges.value,
    unconditionalAdj: unconditionalAdj.value,
    outputNodeId: outputNodeId.value,
    retries: retries.value,
    retryConfigs: retryConfigs.value,
    defaultRetryLimit: defaultRetryLimit.value,
    retryLimits: retryLimits.value,
    humanReviewNodeIds: humanReviewNodeIds.value,
    humanReviewPrompts: humanReviewPrompts.value,
    activeNodeIds: activeNodeIds.value,
    confidenceByNode: confidenceByNode.value,
    outputs: outputs.value,
    initialInput: value.initialInput,
    priorWitnesses: priorWitnesses.value,
    freshnessCompletedNodeIds: freshnessCompletedNodeIds.value,
    freshnessExecutionEpoch: __brandFreshnessExecutionEpoch(freshnessExecutionEpoch.value),
    ...(fingerprint === undefined ? {} : { __dagFingerprint: fingerprint }),
  });
};

/**
 * Extract the plain-data fields from a full `DagMachineContext`. The return
 * type is `DagMachineContextPersisted` — no cast required because the
 * interface relationship is structural (DagMachineContext extends it).
 */
export const stripNonPersistable = (
  ctx: DagMachineContext,
): DagMachineContextPersisted => ({
  waves: ctx.waves,
  outputs: ctx.outputs,
  retries: ctx.retries,
  initialInput: ctx.initialInput,
  activeNodeIds: ctx.activeNodeIds,
  retryConfigs: ctx.retryConfigs,
  outputNodeId: ctx.outputNodeId,
  defaultRetryLimit: ctx.defaultRetryLimit,
  retryLimits: ctx.retryLimits,
  humanReviewNodeIds: ctx.humanReviewNodeIds,
  humanReviewPrompts: ctx.humanReviewPrompts,
  edges: ctx.edges.map(({ from, to, kind }) => ({ from, to, kind })),
  unconditionalAdj: ctx.unconditionalAdj,
  confidenceByNode: ctx.confidenceByNode,
  priorWitnesses: ctx.priorWitnesses,
  freshnessCompletedNodeIds: ctx.freshnessCompletedNodeIds,
  freshnessExecutionEpoch: ctx.freshnessExecutionEpoch,
});

/**
 * Project a live DAG context into its complete durable representation. The DAG
 * which produced the context supplies the fingerprint in the same pure step, so
 * an initial seed and later transition checkpoints cannot disagree about
 * topology binding.
 */
export const persistDagContext = (
  ctx: DagMachineContext,
  dag: DagDef,
): PersistedDagContext => ({
  ...stripNonPersistable(ctx),
  __dagFingerprint: dagFingerprint(dag),
});

/**
 * Wrap a caller-supplied `JobLike` (typed against the persisted shape) so the
 * runner sees a fully-formed `DagMachineContext`. The wrapper:
 *
 *   - `get data()`: re-injects `dag`, `incomingByNode`, `outgoingByNode`,
 *     `nodeById` from the live DAG onto the persisted fields.
 *   - `updateData()`: strips closure fields and stamps `__dagFingerprint`.
 *
 * The inner `JobLike` is typed `DagMachineContextPersisted` — the actual
 * shape that survives serialization. No double-casts.
 */
export const wrapDagJobLike = (
  inner: JobLike<DagPhase, unknown, DagMachineContextPersisted>,
  dag: DagDef,
  runId: RunId,
): WrappedDagJobLike => {
  const incomingByNode = computeIncomingByNode(dag);
  const outgoingByNode = computeOutgoingByNode(dag);
  const unconditionalAdj = computeUnconditionalAdj(dag);
  const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));
  const expectedFingerprint = dagFingerprint(dag);

  // Cached result of `get data()` — invalidated on `updateData`.
  let cachedData: { state: DagPhase; context: DagMachineContext } | null = null;

  const job: JobLike<DagPhase, unknown, DagMachineContext> = {
    get data(): { state: DagPhase; context: DagMachineContext } {
      if (cachedData !== null) return cachedData;
      const raw = inner.data;
      // Re-inject the live DAG-derived fields. The persisted raw.context
      // is `DagMachineContextPersisted` — missing closures; live values win.
      const restored = {
        state: raw.state,
        context: {
          ...raw.context,
          dag,
          edges: dag.edges,
          incomingByNode,
          outgoingByNode,
          unconditionalAdj,
          nodeById,
        },
      };
      cachedData = restored;
      return restored;
    },
    async updateData(d: { state: DagPhase; context: DagMachineContext }): Promise<void> {
      cachedData = null; // invalidate cache
      const persistable = persistDagContext(d.context, dag);
      await inner.updateData({
        state: d.state,
        context: persistable,
      });
    },
    updateProgress: (pct: number) => inner.updateProgress(pct),
    appendEvent: (event: DagEvent, dedupKey?: string) =>
      inner.appendEvent(event, dedupKey),
  };

  return {
    job,
    verifyDagFingerprint(): Result<void, FrameworkError> {
      const rawContext = inner.data.context as PersistedDagContext;
      const actual = rawContext.__dagFingerprint;
      // Absent fingerprint = first write on a fresh job — accept and let
      // `updateData` stamp the current value on the next checkpoint. Only a
      // stamped *and* divergent value is a mismatch.
      if (actual !== undefined && actual !== expectedFingerprint) {
        return err({
          kind: "checkpoint-version-mismatch",
          runId,
          expected: expectedFingerprint,
          actual,
        });
      }
      return ok(undefined);
    },
  };
};
