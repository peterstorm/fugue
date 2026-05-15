import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag, dagFingerprint, FRAMEWORK_VERSION, makeNodeContext, runId as brandRunId } from "@ai-summary/framework";
import type { NodeContext, LlmClient, Observer, Checkpointer, ContextCacheAdapter, ContentFilter } from "@ai-summary/framework";
import type { SummaryResponse } from "./schemas/index.js";
import type { ConversationSource } from "./sources/conversation-source.js";
import { createSummaryDag } from "./dag/summary-dag.js";

// --- Request validation ---

const SummarizeRequestSchema = z.object({
  customer_id: z.string().min(1),
  resume_run_id: z.string().optional(),
});

// --- Health check deps ---

export interface HealthDeps {
  readonly checkRedis?: () => Promise<boolean>;
  readonly checkMlflow?: () => Promise<boolean>;
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
  readonly checkpointer?: Checkpointer | null;
  /** Content filter for trace span data. When set, content is included after filtering. */
  readonly contentFilter?: ContentFilter | null;
}

// --- Create Hono app ---

export const createApp = (deps: AppDeps): Hono => {
  const app = new Hono();

  app.post("/summarize", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
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
        const loaded = await checkpointer.load(brandRunId(resume_run_id));
        if (!loaded.ok) {
          console.warn(`[/summarize] checkpoint load failed for run=${resume_run_id}: ${JSON.stringify(loaded.error)}`);
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
          console.warn(
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
          dagId: dag.id,
          startedAt: new Date(),
          nodeCount: dag.nodes.length,
          subject: customer_id,
          dagFingerprint: fingerprint,
          frameworkVersion: FRAMEWORK_VERSION,
        });
        if (!metaResult.ok) {
          console.error(`[/summarize] checkpoint setMeta failed for run=${runId}: ${JSON.stringify(metaResult.error)}`);
          return c.json({ error: "Checkpoint store unavailable", requestId: runId }, 503);
        }
      }

      const timeoutMs = 60_000; // 60s request timeout
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);

      const ctx: NodeContext = makeNodeContext({
        runId,
        dagId: dag.id,
        observer: deps.observer ?? undefined,
        cache: deps.cache,
        prompts: { get: (name: string) => deps.prompts?.get(name) ?? null },
        llm: deps.llm,
        judgeLlm: deps.llm,
        signal: abortController.signal,
        includeContent: deps.contentFilter != null,
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
          console.warn(`[/summarize] Request timed out after ${timeoutMs}ms for customer=${customer_id} run=${runId}`);
          return c.json({ error: "Request timeout", requestId: runId }, 504);
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }

      if (abortController.signal.aborted) {
        console.warn(`[/summarize] Request timed out after ${timeoutMs}ms for customer=${customer_id} run=${runId}`);
        return c.json({ error: "Request timeout", requestId: runId }, 504);
      }

      if (!result.ok) {
        // Framework error — 500 (log detail server-side, return generic message)
        console.error("[/summarize] DAG error:", JSON.stringify(result.error));
        return c.json({ error: "Internal server error", requestId: runId }, 500);
      }

      return c.json(result.value, 200);
    } catch (e) {
      console.error("[/summarize] Unexpected error:", e);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // Liveness: process is up. Always 200 — k8s should restart only on hang/crash,
  // not on a downstream dependency outage.
  app.get("/livez", (c) => c.json({ status: "alive" }, 200));

  // Readiness: 503 only when a dependency required to serve traffic is down.
  // Redis (queues / checkpoints / cache) is required; MLflow (tracing) is
  // informational and never gates readiness — losing it must not remove pods.
  app.get("/readyz", async (c) => {
    const redisOk = deps.health?.checkRedis
      ? await deps.health.checkRedis().catch(() => false)
      : true;
    const mlflowOk = deps.health?.checkMlflow
      ? await deps.health.checkMlflow().catch(() => false)
      : true;

    const httpStatus = redisOk ? 200 : 503;
    const status = redisOk ? (mlflowOk ? "ready" : "ready-degraded") : "not-ready";
    return c.json({ status, redis: redisOk, mlflow: mlflowOk }, httpStatus);
  });

  // /healthz preserved as readiness alias for back-compat with existing probes.
  app.get("/healthz", async (c) => {
    const redisOk = deps.health?.checkRedis
      ? await deps.health.checkRedis().catch(() => false)
      : true;
    const mlflowOk = deps.health?.checkMlflow
      ? await deps.health.checkMlflow().catch(() => false)
      : true;

    const httpStatus = redisOk ? 200 : 503;
    const status = redisOk ? (mlflowOk ? "ready" : "ready-degraded") : "not-ready";
    return c.json({ status, redis: redisOk, mlflow: mlflowOk }, httpStatus);
  });

  return app;
};
