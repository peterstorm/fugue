import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag, dagFingerprint, FRAMEWORK_VERSION, formatFrameworkError, makeNodeContext, runId as brandRunId, tryRunId, dagId as brandDagId, safeErrorMessage, ok, err } from "@fuguejs/framework";
import type { NodeContext, LlmClient, Observer, Checkpointer, ContextCacheAdapter, CheckpointWriter, ContentFilter, Result, RunMeta, FrameworkError } from "@fuguejs/framework";
import type { SummaryResponse } from "./schemas/index.js";
import type { ConversationSource } from "./sources/conversation-source.js";
import { createSummaryDag } from "./dag/summary-dag.js";
import type { AppLogger } from "./logger.js";
import { consoleAppLogger } from "./logger.js";

// --- Request validation ---

const SummarizeRequestSchema = z.object({
  customer_id: z.string().min(1),
  resume_run_id: z.string().refine((value) => tryRunId(value).ok, {
    message: "must be a valid run id",
  }).optional(),
});

// --- Health check deps ---

interface HealthDeps {
  readonly checkRedis?: () => Promise<boolean>;
  /**
   * LLM availability gate. Bootstrap wires this to the provider-key fallback:
   * when no API key is configured the app runs on the unconfigured
   * `FakeLlmClient`, so EVERY /summarize is guaranteed to fail — readiness
   * must report not-ready (503) exactly like the Redis gate, or k8s leaves
   * the pod in service while it can serve nothing. Default-true when unwired
   * (test apps that construct `createApp` directly with a fake LLM keep
   * today's readiness semantics).
   */
  readonly checkLlm?: () => Promise<boolean>;
  readonly checkMlflow?: () => Promise<boolean>;
  /**
   * Cumulative per-trace-backend export-failure counts when MULTIPLE backends
   * fan out, else `null` (single backend — nothing to fan out). Surfaced in
   * `/readyz` so a constructed-but-failing secondary backend (e.g. Foundry
   * export erroring while MLflow succeeds) is observable beyond the exporter's
   * rate-limited logs. INFORMATIONAL ONLY — it never gates readiness (observability spec FR-026: a
   * failing secondary trace backend must not remove the pod), so it can only
   * flip `ready` → `ready-degraded`, never → `not-ready`. A plain synchronous
   * getter (no I/O — it reads in-memory counters).
   */
  readonly tracingExporterFailures?: () => ReadonlyArray<{ readonly index: number; readonly failures: number }> | null;
}

/** Cache adapter used for NodeContext response caching. */
export type ContextCache = ContextCacheAdapter;

// --- App dependencies ---

export interface AppDeps {
  readonly source: ConversationSource;
  readonly llm: LlmClient;
  readonly health?: HealthDeps;
  readonly prompts?: Map<string, string>;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  readonly observer?: Observer | null;
  readonly cache?: ContextCache | null;
  readonly checkpointWriter?: CheckpointWriter | null;
  readonly checkpointer?: Checkpointer | null;
  /** Content filter for trace span data. When set, content is included after filtering. */
  readonly contentFilter?: ContentFilter | null;
  /** Application logger. Defaults to console-backed logger when omitted. */
  readonly logger?: AppLogger;
  /** Request-owned DAG timeout. Production defaults to 60 seconds. */
  readonly requestTimeoutMs?: number;
}

// --- Create Hono app ---

type ReadinessStatus = "not-ready" | "ready-degraded" | "ready";

const readinessStatus = (notReady: boolean, degraded: boolean): ReadinessStatus => {
  if (notReady) return "not-ready";
  if (degraded) return "ready-degraded";
  return "ready";
};

/** Diagnostics never replace the response or fallback they describe. */
const reportWithoutThrowing = (report: () => void): void => {
  try {
    report();
  } catch {
    // The request/probe outcome remains authoritative.
  }
};

const isAbortThrow = (error: unknown): boolean => {
  try {
    return error instanceof Error &&
      (error.name === "AbortError" || error.name === "APIUserAbortError");
  } catch {
    return false;
  }
};

type DeadlineResult<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "timed-out" };

type DeadlineDiagnostics<T> = {
  readonly onLateFulfillment: (value: T) => void;
  readonly onLateRejection: (error: unknown) => void;
  readonly onTimeoutCancellationFailure: (error: unknown) => void;
};

const settleBeforeDeadline = <T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  onTimeout: () => void,
  diagnostics: DeadlineDiagnostics<T>,
): Promise<DeadlineResult<T>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch (error) {
        reportWithoutThrowing(() => diagnostics.onTimeoutCancellationFailure(error));
      }
      resolve({ kind: "timed-out" });
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) {
          reportWithoutThrowing(() => diagnostics.onLateFulfillment(value));
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve({ kind: "settled", value });
      },
      (error: unknown) => {
        if (settled) {
          reportWithoutThrowing(() => diagnostics.onLateRejection(error));
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

const parseRequestTimeoutMs = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("requestTimeoutMs must be a positive safe integer");
  }
  return value;
};

// --- /summarize pipeline ---

/** A refusal the handler turns into an HTTP response; the body never carries internals. */
type Rejection = {
  readonly status: 400 | 404 | 409 | 500 | 503 | 504;
  readonly body: { readonly error: string; readonly requestId?: string; readonly details?: unknown };
};

/** One pipeline step: the value to continue with, or the refusal that ends the request. */
type Step<T> = Result<T, Rejection>;

/**
 * THE Rejection constructor: builds the refusal the handler turns into an
 * HTTP response; the body never carries internals. `requestId` and `details`
 * land on the body only when supplied.
 */
const refuse = (
  status: Rejection["status"],
  error: string,
  requestId?: string,
  details?: unknown,
): Rejection => {
  const body: { error: string; requestId?: string; details?: unknown } = { error };
  if (requestId !== undefined) body.requestId = requestId;
  if (details !== undefined) body.details = details;
  return { status, body };
};

const respondWith = (c: Context, rejection: Rejection): Response =>
  c.json(rejection.body, rejection.status);

type SummaryDag = ReturnType<typeof createSummaryDag>;

/** What every /summarize step needs besides its own inputs. */
type SummarizeRuntime = {
  readonly deps: AppDeps;
  readonly log: AppLogger;
  readonly timeoutMs: number;
};

const parseSummarizeRequest = async (
  c: Context,
  log: AppLogger,
): Promise<Step<z.infer<typeof SummarizeRequestSchema>>> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (e) {
    reportWithoutThrowing(() =>
      log.warn(`[/summarize] Request body parse failed: ${safeErrorMessage(e)}`),
    );
    return err(refuse(400, "Invalid JSON body"));
  }

  const parsed = SummarizeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return err(refuse(400, "Validation failed", undefined, parsed.error.issues));
  }
  return ok(parsed.data);
};

/**
 * checkpoint-version-mismatch and checkpoint-expired are *semantic*
 * failures (the stored checkpoint is incompatible with the current
 * DAG / framework / TTL); callers must start fresh, not retry. 409
 * matches the identity-mismatch branch. Other load failures (cache
 * transient, corrupt JSON) remain a server 500.
 */
const rejectCheckpointLoadFailure = (kind: FrameworkError["kind"]): Step<never> =>
  kind === "checkpoint-version-mismatch" || kind === "checkpoint-expired"
    ? err(refuse(409, "Checkpoint incompatible with current DAG"))
    : err(refuse(500, "Resume failed"));

/**
 * DAG shape or framework semantics changed since the checkpoint was written
 * when this is false: replaying cached node outputs into the current shape
 * would skip validation against evolved schemas. The framework's `RunMeta`
 * (branded `DagId` included) is the one meta shape; no local duplicate.
 */
const checkpointMatchesDag = (meta: RunMeta, dag: SummaryDag, fingerprint: string): boolean =>
  meta.dagId === dag.id &&
  meta.nodeCount === dag.nodes.length &&
  meta.dagFingerprint === fingerprint &&
  meta.frameworkVersion === FRAMEWORK_VERSION;

/**
 * Resume: load prior checkpoint if requested.
 * Security: bind every checkpoint to `subject = customer_id`. Reject resume on
 * mismatch (or missing subject) to prevent IDOR via stolen/guessed run IDs.
 * Identity: also reject when the persisted DAG shape differs from the running
 * one (id mismatch, fingerprint drift, framework version skew, node-count
 * change) — otherwise resume could inject outputs from a stale DAG into a
 * re-shaped one and skip nodes whose schemas have evolved.
 */
const loadResumeCheckpoint = async (
  checkpointer: Checkpointer,
  dag: SummaryDag,
  fingerprint: string,
  resumeRunId: string,
  customerId: string,
  log: AppLogger,
): Promise<Step<Map<string, unknown>>> => {
  const loaded = await checkpointer.load(brandRunId(resumeRunId), {
    expectedDagFingerprint: fingerprint,
  });
  if (!loaded.ok) {
    reportWithoutThrowing(() =>
      log.warn(`[/summarize] checkpoint load failed for run=${resumeRunId}: ${JSON.stringify(loaded.error)}`),
    );
    return rejectCheckpointLoadFailure(loaded.error.kind);
  }
  if (!loaded.value) {
    // No checkpoint exists for this runId — do not silently start fresh under
    // a caller-supplied id (could shadow a real run). 404 instead.
    return err(refuse(404, "Run not found"));
  }
  const meta = loaded.value.meta;
  if (meta.subject !== customerId) {
    // Either the runId belongs to another customer, or the meta predates
    // subject binding. Either way: refuse. 404 to avoid leaking existence.
    return err(refuse(404, "Run not found"));
  }
  if (!checkpointMatchesDag(meta, dag, fingerprint)) {
    // 409 so callers know to start a fresh run, not retry the same id.
    reportWithoutThrowing(() =>
      log.warn(
        `[/summarize] checkpoint identity mismatch run=${resumeRunId} ` +
        `meta.dagId=${meta.dagId} dag.id=${dag.id} ` +
        `meta.nodeCount=${meta.nodeCount} dag.nodeCount=${dag.nodes.length} ` +
        `meta.fingerprint=${meta.dagFingerprint} expected=${fingerprint} ` +
        `meta.frameworkVersion=${meta.frameworkVersion} expected=${FRAMEWORK_VERSION}`,
      ),
    );
    return err(refuse(409, "Checkpoint incompatible with current DAG"));
  }
  if (loaded.value.corruptNodeAddresses.length > 0) {
    const corruptNodeAddresses = loaded.value.corruptNodeAddresses;
    reportWithoutThrowing(() =>
      log.error(
        `[/summarize] checkpoint contains corrupt node entries for run=${resumeRunId}: ` +
        JSON.stringify(corruptNodeAddresses),
      ),
    );
    return err(refuse(500, "Resume failed"));
  }
  return ok(
    new Map(Object.entries(loaded.value.nodes).map(([nodeId, ns]) => [nodeId, ns.output])),
  );
};

/** Fresh run: write meta so future resume can load. */
const recordFreshRun = async (
  checkpointer: Checkpointer,
  runId: ReturnType<typeof brandRunId>,
  dag: SummaryDag,
  fingerprint: string,
  customerId: string,
  log: AppLogger,
): Promise<Step<undefined>> => {
  const metaResult = await checkpointer.setMeta(runId, {
    dagId: brandDagId(dag.id),
    startedAt: new Date(),
    nodeCount: dag.nodes.length,
    subject: customerId,
    dagFingerprint: fingerprint,
    frameworkVersion: FRAMEWORK_VERSION,
  });
  if (!metaResult.ok) {
    reportWithoutThrowing(() =>
      log.error(`[/summarize] checkpoint setMeta failed for run=${runId}: ${JSON.stringify(metaResult.error)}`),
    );
    return err(refuse(503, "Checkpoint store unavailable", runId));
  }
  return ok(undefined);
};

type RunRequest = {
  readonly dag: SummaryDag;
  readonly runId: ReturnType<typeof brandRunId>;
  readonly customerId: string;
  /** Prior node outputs to replay; `undefined` for a fresh run. */
  readonly resumeCheckpoint: Map<string, unknown> | undefined;
  readonly checkpointWriter: CheckpointWriter;
};

const timeoutRejection = (
  rt: SummarizeRuntime,
  req: RunRequest,
  cause: string,
): Step<never> => {
  reportWithoutThrowing(() => rt.log.warn(
    `[/summarize] Request timed out after ${rt.timeoutMs}ms for customer=${req.customerId} run=${req.runId}; cause=${cause}`,
  ));
  return err(refuse(504, "Request timeout", req.runId));
};

type DagResult = Awaited<ReturnType<typeof runDag<{ customerId: string }, SummaryResponse>>>;

/** Diagnostics for a run that settles after the request deadline already answered. */
const lateRunDiagnostics = (
  log: AppLogger,
  req: RunRequest,
): DeadlineDiagnostics<DagResult> => ({
  onLateFulfillment: (lateResult) => {
    if (!lateResult.ok) {
      log.error(
        `[/summarize] DAG failed after timeout for customer=${req.customerId} run=${req.runId}: ${formatFrameworkError(lateResult.error)}`,
      );
    }
  },
  onLateRejection: (error) => log.error(
    `[/summarize] DAG rejected after timeout for customer=${req.customerId} run=${req.runId}: ${safeErrorMessage(error)}`,
  ),
  onTimeoutCancellationFailure: (error) => log.error(
    `[/summarize] timeout cancellation failed for customer=${req.customerId} run=${req.runId}: ${safeErrorMessage(error)}`,
  ),
});

/** Run the DAG under the request-owned deadline; a timeout is a refusal, not a throw. */
const runUnderDeadline = async (
  rt: SummarizeRuntime,
  req: RunRequest,
): Promise<Step<DagResult>> => {
  const abortController = new AbortController();
  const ctx: NodeContext = makeNodeContext({
    runId: req.runId,
    dagId: req.dag.id,
    observer: rt.deps.observer ?? undefined,
    cache: rt.deps.cache,
    checkpointWriter: req.checkpointWriter,
    prompts: { get: (name: string) => rt.deps.prompts?.get(name) ?? null },
    llm: rt.deps.llm,
    judgeLlm: rt.deps.llm,
    signal: abortController.signal,
    contentFilter: rt.deps.contentFilter,
  });

  try {
    const runOpts = req.resumeCheckpoint
      ? { resume: { runId: req.runId, checkpoint: req.resumeCheckpoint } }
      : undefined;
    const completion = await settleBeforeDeadline(
      runDag<{ customerId: string }, SummaryResponse>(req.dag, { customerId: req.customerId }, ctx, runOpts),
      rt.timeoutMs,
      () => abortController.abort("timeout"),
      lateRunDiagnostics(rt.log, req),
    );
    if (completion.kind === "timed-out") {
      return timeoutRejection(rt, req, "hard request deadline expired");
    }
    const result = completion.value;
    // Only the framework's explicit abort result can be classified as the
    // request-owned timeout. A different failure racing with the timer keeps
    // its real classification and diagnostic.
    if (!result.ok && abortController.signal.aborted && result.error.kind === "aborted") {
      return timeoutRejection(rt, req, formatFrameworkError(result.error));
    }
    return ok(result);
  } catch (e) {
    if (abortController.signal.aborted && isAbortThrow(e)) {
      return timeoutRejection(rt, req, safeErrorMessage(e));
    }
    throw e;
  }
};

/** Resume from a prior checkpoint when asked to, else record the fresh run. */
const prepareRun = (
  rt: SummarizeRuntime,
  checkpointer: Checkpointer,
  dag: SummaryDag,
  runId: ReturnType<typeof brandRunId>,
  fingerprint: string,
  request: z.infer<typeof SummarizeRequestSchema>,
): Promise<Step<Map<string, unknown> | undefined>> =>
  request.resume_run_id
    ? loadResumeCheckpoint(checkpointer, dag, fingerprint, request.resume_run_id, request.customer_id, rt.log)
    : recordFreshRun(checkpointer, runId, dag, fingerprint, request.customer_id, rt.log);

/** Success is 200; a framework error is 500 (detail logged server-side, generic message returned). */
const respondToDagResult = (
  c: Context,
  log: AppLogger,
  runId: ReturnType<typeof brandRunId>,
  result: DagResult,
): Response => {
  if (result.ok) {
    return c.json(result.value, 200);
  }
  reportWithoutThrowing(() =>
    log.error("[/summarize] DAG error:", formatFrameworkError(result.error)),
  );
  return c.json({ error: "Internal server error", requestId: runId }, 500);
};

const handleSummarize = async (c: Context, rt: SummarizeRuntime): Promise<Response> => {
  const { deps, log } = rt;
  const request = await parseSummarizeRequest(c, log);
  if (!request.ok) return respondWith(c, request.error);

  // Durability is a hard contract: every run must be checkpointed so that
  // resume works and so that retried/in-flight writes are not lost on crash.
  // If the checkpoint store is unavailable, refuse traffic at the handler
  // (belt-and-suspenders with /readyz reporting not-ready).
  if (!deps.checkpointer || !deps.checkpointWriter) {
    return respondWith(c, refuse(503, "Checkpoint store unavailable"));
  }
  const checkpointer = deps.checkpointer;
  const checkpointWriter = deps.checkpointWriter;

  try {
    const dag = createSummaryDag(deps.source, {
      model: deps.model,
      judgeModel: deps.judgeModel,
      thinking: deps.thinking,
      synthesisSystemPrompt: deps.prompts?.get("synthesis-system"),
    });
    const runId = brandRunId(request.value.resume_run_id ?? randomUUID());
    const fingerprint = dagFingerprint(dag);

    const prepared = await prepareRun(rt, checkpointer, dag, runId, fingerprint, request.value);
    if (!prepared.ok) return respondWith(c, prepared.error);

    const req: RunRequest = {
      dag,
      runId,
      customerId: request.value.customer_id,
      resumeCheckpoint: prepared.value,
      checkpointWriter,
    };
    const run = await runUnderDeadline(rt, req);
    if (!run.ok) return respondWith(c, run.error);

    return respondToDagResult(c, log, runId, run.value);
  } catch (e) {
    reportWithoutThrowing(() => log.error("[/summarize] Unexpected error:", e));
    return respondWith(c, refuse(500, "Internal server error"));
  }
};

// --- /readyz ---

type ExporterFailures = ReadonlyArray<{ readonly index: number; readonly failures: number }>;

/**
 * What /readyz reports for trace-exporter health: per-backend failure counts,
 * a distinct marker when the probe itself threw (so the payload shows WHY
 * tracing is degraded instead of omitting the field), or `null` (single
 * backend — nothing to fan out).
 */
type ExporterFailureReport = ExporterFailures | { readonly error: "probe-threw" };

/**
 * A rejecting probe is treated as "down", but the rejection reason is logged
 * here so the seam is safe-by-construction: a future probe that throws
 * WITHOUT its own internal logging still leaves an operator breadcrumb rather
 * than flipping readiness silently.
 */
const probeDependency = async (
  check: (() => Promise<boolean>) | undefined,
  message: string,
  log: AppLogger,
): Promise<boolean> => {
  if (!check) return true;
  try {
    return await check();
  } catch (error) {
    reportWithoutThrowing(() => log.warn(message, error));
    return false;
  }
};

/**
 * Cumulative per-backend export failures (multi-backend fan-out only).
 * Informational: a failing SECONDARY trace backend degrades the signal but
 * never gates readiness (observability spec FR-026) — exactly like MLflow.
 */
const probeTracingExporters = (
  deps: AppDeps,
  log: AppLogger,
): { readonly exporterFailures: ExporterFailureReport | null; readonly degraded: boolean } => {
  try {
    const exporterFailures = deps.health?.tracingExporterFailures?.() ?? null;
    return {
      exporterFailures,
      degraded: exporterFailures !== null && exporterFailures.some((f) => f.failures > 0),
    };
  } catch (error) {
    reportWithoutThrowing(() =>
      log.warn("[/readyz] tracingExporterFailures probe threw — treating tracing as degraded:", error),
    );
    // A thrown probe is distinct from "no fan-out": emit the marker so the
    // readiness payload shows why tracing is degraded instead of omitting
    // the field.
    return { exporterFailures: { error: "probe-threw" }, degraded: true };
  }
};

// Readiness: 503 only when a dependency required to serve traffic is down.
// Redis (queues / checkpoints / cache) and the LLM (every /summarize needs a
// real provider, not the unconfigured fake) are required; MLflow (tracing) is
// informational and never gates readiness — losing it must not remove pods.
const checkReadiness = async (deps: AppDeps, log: AppLogger) => {
  const redisOk = await probeDependency(deps.health?.checkRedis, "[/readyz] checkRedis probe threw — treating Redis as not-ready:", log);
  const llmOk = await probeDependency(deps.health?.checkLlm, "[/readyz] checkLlm probe threw — treating the LLM as unavailable:", log);
  const mlflowOk = await probeDependency(deps.health?.checkMlflow, "[/readyz] checkMlflow probe threw — treating MLflow as unavailable:", log);
  const { exporterFailures, degraded: tracingDegraded } = probeTracingExporters(deps, log);
  // Three outcomes, one level: redis or the LLM down gates readiness entirely
  // (either one means /summarize cannot serve traffic); with both up, any
  // degraded trace backend (MLflow or a secondary exporter) downgrades to
  // `ready-degraded` (observability spec FR-026: degrades the signal, never
  // gates readiness).
  const notReady = !redisOk || !llmOk;
  const degraded = !mlflowOk || tracingDegraded;
  // Derived from the SAME predicate as `status`, so the HTTP code and the body
  // can never disagree about whether this instance is ready.
  const httpStatus = notReady ? 503 : 200;
  const status = readinessStatus(notReady, degraded);
  return { status, redis: redisOk, llm: llmOk, mlflow: mlflowOk, exporterFailures, httpStatus } as const;
};

export const createApp = (deps: AppDeps): Hono => {
  const app = new Hono();
  const timeoutMs = parseRequestTimeoutMs(deps.requestTimeoutMs ?? 60_000);
  const log = deps.logger ?? consoleAppLogger;
  const runtime: SummarizeRuntime = { deps, log, timeoutMs };

  app.post("/summarize", (c) => handleSummarize(c, runtime));

  // Liveness: process is up. Always 200 — k8s should restart only on hang/crash,
  // not on a downstream dependency outage.
  app.get("/livez", (c) => c.json({ status: "alive" }, 200));

  app.get("/readyz", async (c) => {
    const r = await checkReadiness(deps, log);
    return c.json(
      {
        status: r.status,
        redis: r.redis,
        llm: r.llm,
        mlflow: r.mlflow,
        // Only present on a multi-backend deployment; omitted (null) otherwise.
        ...(r.exporterFailures ? { tracingExporterFailures: r.exporterFailures } : {}),
      },
      r.httpStatus,
    );
  });

  return app;
};
