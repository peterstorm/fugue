import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag, dagFingerprint, FRAMEWORK_VERSION, makeNodeContext, runId as brandRunId, dagId as brandDagId } from "@fuguejs/framework";
import type { NodeContext, LlmClient, Observer, Checkpointer, ContextCacheAdapter, CheckpointWriter, ContentFilter } from "@fuguejs/framework";
import type { SummaryResponse } from "./schemas/index.js";
import type { ConversationSource } from "./sources/conversation-source.js";
import { createSummaryDag } from "./dag/summary-dag.js";
import type { AppLogger } from "./logger.js";
import { consoleAppLogger } from "./logger.js";

// --- Request validation ---

const SummarizeRequestSchema = z.object({
  customer_id: z.string().min(1),
  resume_run_id: z.string().optional(),
});

// --- Health check deps ---

interface HealthDeps {
  readonly checkRedis?: () => Promise<boolean>;
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

/** Simplified cache adapter for NodeContext — wraps Cache + Checkpointer */
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
    if (!deps.checkpointer) {
      return c.json({ error: "Checkpoint store unavailable" }, 503);
    }
    const checkpointer = deps.checkpointer;

    try {
      const dag = createSummaryDag(deps.source, customer_id, {
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
        checkpointWriter: deps.checkpointWriter,
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
  // Redis (queues / checkpoints / cache) is required; MLflow (tracing) is
  // informational and never gates readiness — losing it must not remove pods.
  const checkReadiness = async () => {
    // A rejecting probe is treated as "down", but the rejection reason is logged
    // here so the seam is safe-by-construction: a future probe that throws
    // WITHOUT its own internal logging still leaves an operator breadcrumb rather
    // than flipping readiness silently.
    const redisOk = deps.health?.checkRedis
      ? await deps.health.checkRedis().catch((err) => {
          log.debug("[/readyz] checkRedis probe threw — treating Redis as not-ready:", err);
          return false;
        })
      : true;
    const mlflowOk = deps.health?.checkMlflow
      ? await deps.health.checkMlflow().catch((err) => {
          log.debug("[/readyz] checkMlflow probe threw — treating MLflow as unavailable:", err);
          return false;
        })
      : true;
    // Cumulative per-backend export failures (multi-backend fan-out only).
    // Informational: a failing SECONDARY trace backend degrades the signal but
    // never gates readiness (observability spec FR-026) — exactly like MLflow above.
    const exporterFailures = deps.health?.tracingExporterFailures
      ? (deps.health.tracingExporterFailures() ?? null)
      : null;
    const tracingDegraded =
      exporterFailures !== null && exporterFailures.some((f) => f.failures > 0);
    const httpStatus = redisOk ? 200 : 503;
    // Three outcomes, one level: redis down gates readiness entirely; with
    // redis up, any degraded trace backend (MLflow or a secondary exporter)
    // downgrades to `ready-degraded` (observability spec FR-026: degrades the signal, never
    // gates readiness).
    const degraded = !mlflowOk || tracingDegraded;
    let status: string;
    if (!redisOk) {
      status = "not-ready";
    } else if (degraded) {
      status = "ready-degraded";
    } else {
      status = "ready";
    }
    return { status, redis: redisOk, mlflow: mlflowOk, exporterFailures, httpStatus } as const;
  };

  app.get("/readyz", async (c) => {
    const r = await checkReadiness();
    return c.json(
      {
        status: r.status,
        redis: r.redis,
        mlflow: r.mlflow,
        // Only present on a multi-backend deployment; omitted (null) otherwise.
        ...(r.exporterFailures ? { tracingExporterFailures: r.exporterFailures } : {}),
      },
      r.httpStatus,
    );
  });

  return app;
};
