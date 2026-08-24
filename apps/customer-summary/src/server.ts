import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag, dagFingerprint, FRAMEWORK_VERSION, makeNodeContext, runId as brandRunId, tryRunId, dagId as brandDagId } from "@fuguejs/framework";
import type { NodeContext, LlmClient, Observer, Checkpointer, ContextCacheAdapter, CheckpointWriter, ContentFilter } from "@fuguejs/framework";
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
}

// --- Create Hono app ---

type ReadinessStatus = "not-ready" | "ready-degraded" | "ready";

const readinessStatus = (notReady: boolean, degraded: boolean): ReadinessStatus => {
  if (notReady) return "not-ready";
  if (degraded) return "ready-degraded";
  return "ready";
};

export const createApp = (deps: AppDeps): Hono => {
  const app = new Hono();
  const log = deps.logger ?? consoleAppLogger;

  app.post("/summarize", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      log.warn(`[/summarize] Request body parse failed: ${e instanceof Error ? e.message : String(e)}`);
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SummarizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.issues }, 400);
    }

    const { customer_id, resume_run_id } = parsed.data;

    // Durability is a hard contract: every run must be checkpointed so that
    // resume works and so that retried/in-flight writes are not lost on crash.
    // If the checkpoint store is unavailable, refuse traffic at the handler
    // (belt-and-suspenders with /readyz reporting not-ready).
    if (!deps.checkpointer || !deps.checkpointWriter) {
      return c.json({ error: "Checkpoint store unavailable" }, 503);
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
      const runId = brandRunId(resume_run_id ?? randomUUID());
      const fingerprint = dagFingerprint(dag);

      // Resume: load prior checkpoint if requested. Fresh run: write meta so future resume can load.
      // Security: bind every checkpoint to `subject = customer_id`. Reject resume on
      // mismatch (or missing subject) to prevent IDOR via stolen/guessed run IDs.
      // Identity: also reject when the persisted DAG shape differs from the running
      // one (id mismatch, fingerprint drift, framework version skew, node-count
      // change) — otherwise resume could inject outputs from a stale DAG into a
      // re-shaped one and skip nodes whose schemas have evolved.
      let resumeCheckpoint: Map<string, unknown> | undefined;
      if (resume_run_id) {
        const loaded = await checkpointer.load(brandRunId(resume_run_id), {
          expectedDagFingerprint: fingerprint,
        });
        if (!loaded.ok) {
          log.warn(`[/summarize] checkpoint load failed for run=${resume_run_id}: ${JSON.stringify(loaded.error)}`);
          // checkpoint-version-mismatch and checkpoint-expired are *semantic*
          // failures (the stored checkpoint is incompatible with the current
          // DAG / framework / TTL); callers must start fresh, not retry. 409
          // matches the existing identity-mismatch branch below. Other load
          // failures (cache transient, corrupt JSON) remain a server 500.
          if (
            loaded.error.kind === "checkpoint-version-mismatch" ||
            loaded.error.kind === "checkpoint-expired"
          ) {
            return c.json({ error: "Checkpoint incompatible with current DAG" }, 409);
          }
          return c.json({ error: "Resume failed" }, 500);
        }
        if (!loaded.value) {
          // No checkpoint exists for this runId — do not silently start fresh under
          // a caller-supplied id (could shadow a real run). 404 instead.
          return c.json({ error: "Run not found" }, 404);
        }
        const meta = loaded.value.meta;
        if (meta.subject !== customer_id) {
          // Either the runId belongs to another customer, or the meta predates
          // subject binding. Either way: refuse. 404 to avoid leaking existence.
          return c.json({ error: "Run not found" }, 404);
        }
        if (
          meta.dagId !== dag.id ||
          meta.nodeCount !== dag.nodes.length ||
          meta.dagFingerprint !== fingerprint ||
          meta.frameworkVersion !== FRAMEWORK_VERSION
        ) {
          // DAG shape or framework semantics changed since the checkpoint was
          // written. Replaying cached node outputs into the current shape would
          // skip validation against evolved schemas. 409 so callers know to
          // start a fresh run, not retry the same id.
          log.warn(
            `[/summarize] checkpoint identity mismatch run=${resume_run_id} ` +
            `meta.dagId=${meta.dagId} dag.id=${dag.id} ` +
            `meta.nodeCount=${meta.nodeCount} dag.nodeCount=${dag.nodes.length} ` +
            `meta.fingerprint=${meta.dagFingerprint} expected=${fingerprint} ` +
            `meta.frameworkVersion=${meta.frameworkVersion} expected=${FRAMEWORK_VERSION}`,
          );
          return c.json({ error: "Checkpoint incompatible with current DAG" }, 409);
        }
        if (loaded.value.corruptNodeAddresses.length > 0) {
          log.error(
            `[/summarize] checkpoint contains corrupt node entries for run=${resume_run_id}: ` +
            JSON.stringify(loaded.value.corruptNodeAddresses),
          );
          return c.json({ error: "Resume failed" }, 500);
        }
        resumeCheckpoint = new Map(
          Object.entries(loaded.value.nodes).map(([nodeId, ns]) => [nodeId, ns.output]),
        );
      }
      if (!resumeCheckpoint) {
        const metaResult = await checkpointer.setMeta(runId, {
          dagId: brandDagId(dag.id),
          startedAt: new Date(),
          nodeCount: dag.nodes.length,
          subject: customer_id,
          dagFingerprint: fingerprint,
          frameworkVersion: FRAMEWORK_VERSION,
        });
        if (!metaResult.ok) {
          log.error(`[/summarize] checkpoint setMeta failed for run=${runId}: ${JSON.stringify(metaResult.error)}`);
          return c.json({ error: "Checkpoint store unavailable", requestId: runId }, 503);
        }
      }

      const timeoutMs = 60_000; // 60s request timeout
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);

      const ctx: NodeContext = makeNodeContext({
        runId,
        dagId: dag.id,
        observer: deps.observer ?? undefined,
        cache: deps.cache,
        checkpointWriter,
        prompts: { get: (name: string) => deps.prompts?.get(name) ?? null },
        llm: deps.llm,
        judgeLlm: deps.llm,
        signal: abortController.signal,
        contentFilter: deps.contentFilter,
      });

      let result: Awaited<ReturnType<typeof runDag<{ customerId: string }, SummaryResponse>>>;
      try {
        const runOpts = resumeCheckpoint
          ? { resume: { runId, checkpoint: resumeCheckpoint } }
          : undefined;
        result = await runDag<{ customerId: string }, SummaryResponse>(dag, { customerId: customer_id }, ctx, runOpts);
      } catch (e) {
        if (abortController.signal.aborted) {
          log.warn(`[/summarize] Request timed out after ${timeoutMs}ms for customer=${customer_id} run=${runId}`);
          return c.json({ error: "Request timeout", requestId: runId }, 504);
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }

      if (result.ok) {
        return c.json(result.value, 200);
      }

      // Result is err — determine whether it was timeout-caused:
      if (abortController.signal.aborted) {
        log.warn(`[/summarize] Request timed out after ${timeoutMs}ms for customer=${customer_id} run=${runId}`);
        return c.json({ error: "Request timeout", requestId: runId }, 504);
      }

      // Framework error — 500 (log detail server-side, return generic message)
      log.error("[/summarize] DAG error:", JSON.stringify(result.error));
      return c.json({ error: "Internal server error", requestId: runId }, 500);
    } catch (e) {
      log.error("[/summarize] Unexpected error:", e);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // Liveness: process is up. Always 200 — k8s should restart only on hang/crash,
  // not on a downstream dependency outage.
  app.get("/livez", (c) => c.json({ status: "alive" }, 200));

  // Readiness: 503 only when a dependency required to serve traffic is down.
  // Redis (queues / checkpoints / cache) and the LLM (every /summarize needs a
  // real provider, not the unconfigured fake) are required; MLflow (tracing) is
  // informational and never gates readiness — losing it must not remove pods.
  const checkReadiness = async () => {
    // A rejecting probe is treated as "down", but the rejection reason is logged
    // here so the seam is safe-by-construction: a future probe that throws
    // WITHOUT its own internal logging still leaves an operator breadcrumb rather
    // than flipping readiness silently.
    const probe = async (check: (() => Promise<boolean>) | undefined, message: string): Promise<boolean> =>
      check
        ? check().catch((error) => {
            log.debug(message, error);
            return false;
          })
        : true;
    const redisOk = await probe(deps.health?.checkRedis, "[/readyz] checkRedis probe threw — treating Redis as not-ready:");
    const llmOk = await probe(deps.health?.checkLlm, "[/readyz] checkLlm probe threw — treating the LLM as unavailable:");
    const mlflowOk = await probe(deps.health?.checkMlflow, "[/readyz] checkMlflow probe threw — treating MLflow as unavailable:");
    // Cumulative per-backend export failures (multi-backend fan-out only).
    // Informational: a failing SECONDARY trace backend degrades the signal but
    // never gates readiness (observability spec FR-026) — exactly like MLflow above.
    const exporterFailures = deps.health?.tracingExporterFailures
      ? (deps.health.tracingExporterFailures() ?? null)
      : null;
    const tracingDegraded =
      exporterFailures !== null && exporterFailures.some((f) => f.failures > 0);
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

  app.get("/readyz", async (c) => {
    const r = await checkReadiness();
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
