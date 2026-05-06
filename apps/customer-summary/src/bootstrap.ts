import Anthropic from "@anthropic-ai/sdk";
import OpenAI, { AzureOpenAI } from "openai";
import Redis from "ioredis";
import { join, resolve } from "node:path";
import {
  AnthropicLlmClient,
  OpenAILlmClient,
  FakeLlmClient,
  FilePromptRegistry,
  initTracing,
  alwaysOn,
  errorOnly,
  anyOf,
  hadRetry,
  ratio,
  RedisCache,
  RedisCheckpointer,
} from "@ai-summary/framework";
import type { LlmClient, TracingHandle } from "@ai-summary/framework";
import { NoopObserver } from "@ai-summary/framework";
import { JsonFixtureSource } from "./sources/json-fixture-source.js";
import { createApp, type AppDeps, type ContextCache } from "./server.js";
import { loadConfig, DEFAULT_MODELS } from "./config.js";

const LLM_CACHE_TTL = 3600; // 1 hour

export const bootstrap = async () => {
  const config = loadConfig();

  const fixturesDir = resolve(config.FIXTURES_DIR);
  const promptsDir = resolve(config.PROMPTS_DIR);

  // --- Tracing (OTel + MLflow with tail-based sampling) ---
  let tracing: TracingHandle | null = null;
  try {
    const policy = anyOf(errorOnly(), hadRetry(), ratio(1.0));
    tracing = await initTracing({
      trackingUri: config.MLFLOW_TRACKING_URI,
      experimentId: config.MLFLOW_EXPERIMENT_ID,
      policy,
    });
    console.log(`Tracing initialized — MLflow at ${config.MLFLOW_TRACKING_URI} (experiment ${config.MLFLOW_EXPERIMENT_ID})`);
  } catch (e) {
    console.warn("Tracing initialization failed — continuing without tracing:", e);
  }

  // --- Redis (cache + checkpointer) ---
  let contextCache: ContextCache | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis CJS/ESM interop requires dynamic handling
  let redis: any = null;
  try {
    const RedisClient = (Redis as any).default ?? Redis;
    redis = new RedisClient(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    await redis.connect();
    console.log(`Redis connected at ${config.REDIS_URL}`);

    const cache = new RedisCache(redis);
    const checkpointer = new RedisCheckpointer(redis);

    // Adapter: NodeContext.cache expects get/set/writeCheckpoint
    // get() must return { ok: true, value } to match what llm.ts checks
    contextCache = {
      get: async (key: string) => {
        const r = await cache.get(key);
        if (!r.ok) {
          console.warn(`[cache] get failed for key=${key}: ${r.error.kind}`);
          return null;
        }
        return r.value;
      },
      set: async (key: string, value: unknown) => {
        const r = await cache.set(key, value, LLM_CACHE_TTL);
        if (!r.ok) {
          console.warn(`[cache] set failed for key=${key}: ${r.error.kind}`);
        }
      },
      writeCheckpoint: async (runId: string, nodeId: string, value: unknown) => {
        const r = await checkpointer.saveNode(runId, nodeId, {
          nodeId,
          output: value,
          completedAt: new Date(),
        });
        if (!r.ok) {
          console.warn(`[checkpoint] write failed for run=${runId} node=${nodeId}: ${r.error.kind}`);
        }
      },
    };
  } catch (e) {
    console.warn("Redis connection failed — running without cache/checkpointing:", e);
  }

  // Source
  const source = new JsonFixtureSource(fixturesDir);

  // Prompt registry
  const promptRegistry = FilePromptRegistry({
    dir: promptsDir,
    registryPath: join(promptsDir, "registry.json"),
  });
  const prompts = new Map<string, string>();
  const synthesisPrompt = await promptRegistry.load("synthesis");
  if (synthesisPrompt.ok) {
    prompts.set("synthesis", synthesisPrompt.value.text);
  } else {
    console.error("Failed to load synthesis prompt:", synthesisPrompt.error);
  }
  const evalRubricPrompt = await promptRegistry.load("summary-eval-rubric");
  if (evalRubricPrompt.ok) {
    prompts.set("summary-eval-rubric", evalRubricPrompt.value.text);
  }
  // Note: eval rubric kept in prompts registry for reference but no longer used in-pipeline.
  // Quality evaluation is handled by MLflow's built-in scorer (post-hoc, async).

  // LLM client
  let llm: LlmClient;
  const provider = config.LLM_PROVIDER;
  // For Azure, deployment name is used as the model parameter
  const model = provider === "azure"
    ? (config.AZURE_OPENAI_DEPLOYMENT ?? config.LLM_MODEL ?? DEFAULT_MODELS[provider])
    : (config.LLM_MODEL ?? DEFAULT_MODELS[provider]);

  if (provider === "azure" && config.AZURE_OPENAI_ENDPOINT && config.AZURE_OPENAI_API_KEY) {
    const azureClient = new AzureOpenAI({
      endpoint: config.AZURE_OPENAI_ENDPOINT,
      apiKey: config.AZURE_OPENAI_API_KEY,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
    });
    llm = new OpenAILlmClient(azureClient as any);
    // Azure uses deployment name as the "model" parameter
    const deployment = config.AZURE_OPENAI_DEPLOYMENT ?? model;
    console.log(`Using Azure OpenAI LLM client (deployment: ${deployment}, endpoint: ${config.AZURE_OPENAI_ENDPOINT})`);
  } else if (provider === "openai" && config.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    llm = new OpenAILlmClient(openai as any);
    console.log(`Using OpenAI LLM client (model: ${model})`);
  } else if (provider === "anthropic" && config.ANTHROPIC_API_KEY) {
    const raw = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    llm = new AnthropicLlmClient(raw as any);
    console.log(`Using Anthropic LLM client (model: ${model})${tracing ? " [traced]" : ""}`);
  } else {
    console.warn(`No API key set for provider "${provider}" — using FakeLlmClient (all LLM calls will fail)`);
    llm = new FakeLlmClient(new Map());
  }

  const deps: AppDeps = {
    source,
    llm,
    prompts,
    model,
    judgeModel: config.EVAL_JUDGE_MODEL,
    thinking: config.ENABLE_THINKING ? { type: "enabled", budgetTokens: config.THINKING_BUDGET_TOKENS } : undefined,
    cache: contextCache,
    observer: new NoopObserver(),
    health: {
      checkRedis: redis ? async () => {
        try { await redis!.ping(); return true; } catch { return false; }
      } : undefined,
      checkMlflow: async () => {
        try {
          const res = await fetch(`${config.MLFLOW_TRACKING_URI}/health`);
          return res.ok;
        } catch { return false; }
      },
    },
  };
  const app = createApp(deps);

  // Graceful shutdown
  const shutdown = async () => {
    if (tracing) {
      console.log("Flushing traces...");
      await tracing.flush();
      await tracing.shutdown();
    }
    if (redis) {
      await redis.disconnect();
    }
  };

  return { app, config, tracing, shutdown };
};
