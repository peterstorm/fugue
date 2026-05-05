import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runDag } from "@ai-summary/framework";
import type { NodeContext, LlmClient, Observer } from "@ai-summary/framework";
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
  readonly judgeLlm?: LlmClient | null;
  readonly health?: HealthDeps;
  readonly prompts?: Map<string, string>;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  readonly observer?: Observer | null;
  readonly cache?: ContextCache | null;
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

      const ctx: NodeContext = {
        runId,
        dagId: dag.id,
        observer: deps.observer ?? null,
        cache: deps.cache ?? null,
        logger: null,
        prompts: { get: (name: string) => deps.prompts?.get(name) ?? null },
        llm: deps.llm,
        judgeLlm: deps.judgeLlm ?? null,
      };

      const result = await runDag<{ customerId: string }, SummaryResponse>(
        dag,
        { customerId: customer_id },
        ctx,
      );

      if (!result.ok) {
        // Framework error — 500
        return c.json({ error: "Internal server error", message: JSON.stringify(result.error) }, 500);
      }

      return c.json(result.value, 200);
    } catch (e) {
      return c.json({ error: "Internal server error", message: String(e) }, 500);
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
    return c.json({ status, redis: redisOk, mlflow: mlflowOk }, 200);
  });

  return app;
};
