import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag } from "@ai-summary/framework";
import type { NodeContext, LlmClient, Observer, Checkpointer } from "@ai-summary/framework";
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
export interface ContextCache {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly set: (key: string, value: unknown) => Promise<void>;
  readonly writeCheckpoint?: (runId: string, nodeId: string, value: unknown) => Promise<void>;
}

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

    try {
      const dag = createSummaryDag(deps.source, customer_id, {
        model: deps.model,
        judgeModel: deps.judgeModel,
        thinking: deps.thinking,
      });
      const runId = resume_run_id ?? randomUUID();

      // Resume: load prior checkpoint if requested. Fresh run: write meta so future resume can load.
      // Security: bind every checkpoint to `subject = customer_id`. Reject resume on
      // mismatch (or missing subject) to prevent IDOR via stolen/guessed run IDs.
      let resumeCheckpoint: Map<string, unknown> | undefined;
      if (deps.checkpointer) {
        if (resume_run_id) {
          const loaded = await deps.checkpointer.load(resume_run_id);
          if (!loaded.ok) {
            console.warn(`[/summarize] checkpoint load failed for run=${resume_run_id}: ${JSON.stringify(loaded.error)}`);
            return c.json({ error: "Resume failed" }, 500);
          }
          if (!loaded.value) {
            // No checkpoint exists for this runId — do not silently start fresh under
            // a caller-supplied id (could shadow a real run). 404 instead.
            return c.json({ error: "Run not found" }, 404);
          }
          if (loaded.value.meta.subject !== customer_id) {
            // Either the runId belongs to another customer, or the meta predates
            // subject binding. Either way: refuse. 404 to avoid leaking existence.
            return c.json({ error: "Run not found" }, 404);
          }
          resumeCheckpoint = new Map(
            Object.entries(loaded.value.nodes).map(([nodeId, ns]) => [nodeId, ns.output]),
          );
        }
        if (!resumeCheckpoint) {
          const metaResult = await deps.checkpointer.setMeta(runId, {
            dagId: dag.id,
            startedAt: new Date(),
            nodeCount: dag.nodes.length,
            subject: customer_id,
          });
          if (!metaResult.ok) {
            console.warn(`[/summarize] checkpoint setMeta failed for run=${runId}: ${JSON.stringify(metaResult.error)}`);
          }
        }
      }

      const timeoutMs = 60_000; // 60s request timeout
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);

      const ctx: NodeContext = {
        runId,
        dagId: dag.id,
        observer: deps.observer ?? null,
        cache: deps.cache ?? null,
        logger: null,
        prompts: { get: (name: string) => deps.prompts?.get(name) ?? null },
        llm: deps.llm,
        judgeLlm: deps.llm,
        signal: abortController.signal,
      };

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

  app.get("/healthz", async (c) => {
    const redisOk = deps.health?.checkRedis
      ? await deps.health.checkRedis().catch(() => false)
      : true;
    const mlflowOk = deps.health?.checkMlflow
      ? await deps.health.checkMlflow().catch(() => false)
      : true;

    const status = redisOk && mlflowOk ? "healthy" : "degraded";
    const httpStatus = status === "healthy" ? 200 : 503;
    return c.json({ status, redis: redisOk, mlflow: mlflowOk }, httpStatus);
  });

  return app;
};
