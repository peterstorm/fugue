import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AnthropicLlmClient,
  OpenAILlmClient,
  FakeLlmClient,
  FilePromptRegistry,
  initTracing,
  createMlflowExporter,
  alwaysOn,
  errorOnly,
  anyOf,
  hadRetry,
  ratio,
  RedisCache,
  RedisCheckpointer,
  piiScrubber,
  IDENTITY_FILTER,
} from "@ai-summary/framework";
import type { LlmClient, TracingHandle, Checkpointer, CheckpointWriter } from "@ai-summary/framework";
import { NoopObserver, runId as brandRunId } from "@ai-summary/framework";
import { JsonFixtureSource } from "./sources/json-fixture-source.js";
import { createApp, type AppDeps, type ContextCache } from "./server.js";
import { loadConfig, DEFAULT_MODELS } from "./config.js";
import { consoleAppLogger } from "./logger.js";
import type { AppLogger } from "./logger.js";

const LLM_CACHE_TTL = 3600; // 1 hour

export const bootstrap = async (injectedLogger?: AppLogger) => {
  const log = injectedLogger ?? consoleAppLogger;
  const config = loadConfig();

  const fixturesDir = resolve(config.FIXTURES_DIR);
  const promptsDir = resolve(config.PROMPTS_DIR);

  // --- Tracing (OTel + MLflow with tail-based sampling) ---
  let tracing: TracingHandle | null = null;
  try {
    const policy = anyOf(errorOnly(), hadRetry(), ratio(config.TRACE_SAMPLE_RATIO));
    const exporter = createMlflowExporter({
      url: config.MLFLOW_TRACKING_URI,
      experimentId: config.MLFLOW_EXPERIMENT_ID,
    });
    tracing = await initTracing({ exporter, policy });
    log.info(`Tracing initialized — MLflow at ${config.MLFLOW_TRACKING_URI} (experiment ${config.MLFLOW_EXPERIMENT_ID})`);
  } catch (e) {
    log.error("Tracing initialization failed — continuing without tracing:", e);
  }

  // --- Redis (cache + checkpointer) ---
  // Redis is a hard dependency: it backs the checkpointer (durable resume) and
  // the response cache. If it's unavailable at bootstrap, we still construct
  // the app, but readiness MUST report not-ready so traffic does not land here.
  // The /summarize handler also rejects requests when checkpointer is null.
  let contextCache: ContextCache | null = null;
  let checkpointWriter: CheckpointWriter | null = null;
  let checkpointer: Checkpointer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis CJS/ESM interop requires dynamic handling
  let redis: any = null;
  let redisHealthy = false;
  try {
    const RedisClient = (Redis as any).default ?? Redis;
    redis = new RedisClient(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    // Event-driven health: ioredis emits "error" on disconnect AND on operation
    // failures. Without a listener, "Unhandled error event" floods stderr and
    // readiness has to ping per request. Authoritative state lives in flags
    // updated by ready/end/error events.
    redis.on("error", (e: unknown) => {
      log.error(`[redis] connection error: ${e instanceof Error ? e.message : String(e)}`);
      redisHealthy = false;
    });
    redis.on("ready", () => {
      redisHealthy = true;
    });
    redis.on("end", () => {
      redisHealthy = false;
    });
    await redis.connect();
    log.info(`Redis connected at ${config.REDIS_URL}`);
    redisHealthy = true;

    const cache = new RedisCache(redis);
    checkpointer = new RedisCheckpointer(redis);
    const cp = checkpointer;

    // Adapter: NodeContext.cache expects get/set/writeCheckpoint
    // Wave 4 §4.6: get() returns a discriminated hit/miss so nullable values
    // are no longer ambiguous with cache misses.
    contextCache = {
      get: async (key: string) => {
        const r = await cache.get(key, z.unknown());
        if (!r.ok) {
          log.warn(`[cache] get failed for key=${key}: ${r.error.kind}`);
          return { hit: false } as const;
        }
        // RedisCache.get returns ok(null) on miss, ok(value) on hit.
        return r.value === null
          ? ({ hit: false } as const)
          : ({ hit: true, value: r.value } as const);
      },
      set: async (key: string, value: unknown) => {
        const r = await cache.set(key, value, LLM_CACHE_TTL);
        if (!r.ok) {
          log.warn(`[cache] set failed for key=${key}: ${r.error.kind}`);
        }
        return r;
      },
    };
    checkpointWriter = {
      write: async (runId: string, nodeId: string, value: unknown) => {
        const r = await cp.saveNode(brandRunId(runId), nodeId, {
          nodeId,
          output: value,
          completedAt: new Date(),
        });
        if (!r.ok) {
          throw new Error(
            `checkpoint write failed for run=${runId} node=${nodeId}: ${r.error.kind}${
              r.error.kind === "cache-error" ? ` — ${r.error.message}` : ""
            }`,
          );
        }
      },
    };
  } catch (e) {
    log.warn("Redis connection failed — running without cache/checkpointing:", e);
    checkpointer = null;
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
    log.error("Failed to load synthesis prompt:", synthesisPrompt.error);
  }
  const evalRubricPrompt = await promptRegistry.load("summary-eval-rubric");
  if (evalRubricPrompt.ok) {
    prompts.set("summary-eval-rubric", evalRubricPrompt.value.text);
  }
  const synthesisSystemPrompt = await promptRegistry.load("synthesis-system");
  if (synthesisSystemPrompt.ok) {
    prompts.set("synthesis-system", synthesisSystemPrompt.value.text);
  } else {
    log.error("Failed to load synthesis-system prompt:", synthesisSystemPrompt.error);
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
    // Azure base URL: <endpoint>/openai/deployments/<deployment>
    const deployment = config.AZURE_OPENAI_DEPLOYMENT ?? model;
    const azureBaseUrl = `${config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${deployment}`;
    llm = new OpenAILlmClient({
      apiKey: config.AZURE_OPENAI_API_KEY,
      baseUrl: azureBaseUrl,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
    });
    log.info(`Using Azure OpenAI LLM client (deployment: ${deployment}, endpoint: ${config.AZURE_OPENAI_ENDPOINT})`);
  } else if (provider === "openai" && config.OPENAI_API_KEY) {
    llm = new OpenAILlmClient({
      apiKey: config.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
    });
    log.info(`Using OpenAI LLM client (model: ${model})`);
  } else if (provider === "anthropic" && config.ANTHROPIC_API_KEY) {
    const raw = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    llm = new AnthropicLlmClient(raw);
    log.info(`Using Anthropic LLM client (model: ${model})${tracing ? " [traced]" : ""}`);
  } else {
    log.warn(`No API key set for provider "${provider}" — using FakeLlmClient (all LLM calls will fail)`);
    llm = new FakeLlmClient(new Map());
  }

  // ENABLE_THINKING is only honored by providers whose client implements reasoning.
  // Anthropic client currently ignores `req.thinking` (extended-thinking integration
  // pending), so passing it through would be a silent no-op visible only in the trace
  // attribute. Refuse it explicitly here so config matches behavior.
  const providerSupportsThinking = provider === "openai" || provider === "azure";
  let thinkingDep: { type: "enabled"; budgetTokens: number } | undefined;
  if (config.ENABLE_THINKING) {
    if (providerSupportsThinking) {
      thinkingDep = { type: "enabled", budgetTokens: config.THINKING_BUDGET_TOKENS };
    } else {
      log.warn(`[config] ENABLE_THINKING ignored: not implemented for provider "${provider}"`);
    }
  }

  const deps: AppDeps = {
    source,
    llm,
    prompts,
    model,
    judgeModel: config.EVAL_JUDGE_MODEL ?? model,
    thinking: thinkingDep,
    cache: contextCache,
    checkpointWriter,
    checkpointer,
    observer: new NoopObserver(),
    logger: log,
    // Read the env-derived flag once at bootstrap; the framework no longer
    // touches process.env. When LLM_TRACE_PROMPTS is true, content passes
    // through unchanged; otherwise the PII scrubber strips sensitive patterns
    // while keeping non-PII content visible for debugging.
    contentFilter: config.LLM_TRACE_PROMPTS ? IDENTITY_FILTER : piiScrubber,
    health: {
      // Always defined: if Redis was never reachable at bootstrap, we still
      // need readiness to report not-ready (otherwise k8s leaves the pod in
      // service while checkpointer/cache are null). Flag is event-driven —
      // no per-request ping (would add round-trip on every k8s probe).
      checkRedis: async () => redisHealthy && redis !== null,
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
      log.info("Flushing traces...");
      await tracing.flush();
      await tracing.shutdown();
    }
    if (redis) {
      await redis.disconnect();
    }
  };

  return { app, config, tracing, shutdown };
};
