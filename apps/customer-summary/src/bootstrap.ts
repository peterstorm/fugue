import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "ioredis";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AnthropicLlmClient,
  OpenAILlmClient,
  FakeLlmClient,
  FilePromptRegistry,
  initTracing,
  createMlflowExporter,
  createAzureMonitorExporter,
  alwaysOn,
  errorOnly,
  anyOf,
  hadRetry,
  ratio,
  piiScrubber,
  IDENTITY_FILTER,
  isOk,
} from "@fugue/framework";
import { RedisCache, RedisCheckpointer } from "@fugue/framework/redis";
import { DefaultAzureCredential } from "@azure/identity";
import type { LlmClient, TracingHandle, Checkpointer, CheckpointWriter, Observer, FoundryTelemetrySink } from "@fugue/framework";
import { NoopObserver, runId as brandRunId } from "@fugue/framework";
import { JsonFixtureSource } from "./sources/json-fixture-source.js";
import { createApp, type AppDeps, type ContextCache } from "./server.js";
import { loadConfig, DEFAULT_MODELS } from "./config.js";
import { resolveObservabilityBackends, isFoundryEnabled } from "./observability.js";
import { composeObservability, resolveFoundryLeg, type SpanExporter } from "./observability-composition.js";
import { createFoundrySink } from "./foundry-sink.js";
import { consoleAppLogger } from "./logger.js";
import type { AppLogger } from "./logger.js";

const LLM_CACHE_TTL = 3600; // 1 hour

export const bootstrap = async (injectedLogger?: AppLogger) => {
  const log = injectedLogger ?? consoleAppLogger;
  const config = loadConfig();

  const fixturesDir = resolve(config.FIXTURES_DIR);
  const promptsDir = resolve(config.PROMPTS_DIR);

  // --- Observability backend selection (FR-002/003/006/022/023) ---
  // Resolve the trace backend(s) + auth from config. A config error MUST fail
  // bootstrap loudly — never silently fall back (FR-006). In well-formed config
  // this is already caught by the zod superRefine in loadConfig(); the resolver
  // re-checks defense-in-depth, so a thrown error here means contradictory
  // config slipped past the schema and must stop startup.
  const resolvedObservability = resolveObservabilityBackends(config);
  if (!isOk(resolvedObservability)) {
    throw resolvedObservability.error;
  }
  const resolved = resolvedObservability.value;

  // --- Tracing (OTel + MLflow [+ Foundry] with tail-based sampling) ---
  // The persistence policy is the SINGLE source of truth: the SAME instance
  // gates trace tail-sampling AND (in the Foundry path) the BufferedObserver's
  // domain-event emission, so a discarded trace produces no orphaned domain
  // events (FR-021 / SC-010).
  let tracing: TracingHandle | null = null;
  // Default to NoopObserver: this is the byte-for-byte unchanged behaviour for
  // the no-Foundry path (SC-006 / FR-027). composeObservability overrides it
  // only when Foundry is enabled.
  let observer: Observer = new NoopObserver();
  // Held for the graceful-shutdown drain (FR — flush buffered Foundry domain
  // events before exit). Null on the default/no-Foundry path.
  let foundrySinkForFlush: FoundryTelemetrySink | null = null;
  try {
    const policy = anyOf(errorOnly(), hadRetry(), ratio(config.TRACE_SAMPLE_RATIO));

    // MLflow is the always-available trace backend (FR-003). Its exporter is
    // built unconditionally and the factory is reused below; a Foundry
    // CONSTRUCTION fault must never disable MLflow tracing (FR-026 / SC-006 /
    // SC-009), so the Foundry leg is attempted in its OWN guard and, on failure,
    // we degrade to the MLflow-only selection while leaving MLflow tracing live.
    const createMlflowExporter_ = (): SpanExporter =>
      createMlflowExporter({
        url: config.MLFLOW_TRACKING_URI,
        experimentId: config.MLFLOW_EXPERIMENT_ID,
      });

    // Attempt to construct the Foundry exporter + sink in ISOLATION via the
    // fault-isolation boundary. A Foundry construction fault degrades ONLY the
    // Foundry leg (returning an MLflow-only effective selection), leaving MLflow
    // tracing live (FR-026 / SC-006 / SC-009). On success the prebuilt instances
    // are handed to composeObservability via thin factories below.
    const { effective: effectiveResolved, foundryExporter, foundrySink } = resolveFoundryLeg(
      resolved,
      (): SpanExporter => {
        // Reachable only when Foundry is enabled, where `resolved.auth` exists.
        if (!isFoundryEnabled(resolved)) {
          throw new Error("Foundry exporter requested without Foundry enabled");
        }
        const auth = resolved.auth;
        return createAzureMonitorExporter(
          auth.mode === "entra-id"
            ? { auth: { connectionString: auth.connectionString, credential: new DefaultAzureCredential() } }
            : { auth: { connectionString: auth.connectionString } },
        );
      },
      (): FoundryTelemetrySink => {
        if (!isFoundryEnabled(resolved)) {
          throw new Error("Foundry sink requested without Foundry enabled");
        }
        return createFoundrySink(resolved.auth);
      },
      log,
    );
    foundrySinkForFlush = foundrySink;

    // Compose exporters + observer from the EFFECTIVE selection. Factories are
    // bound here (the imperative shell); the composition itself is pure-ish. The
    // Foundry factories return the prebuilt instances (never re-construct), so
    // the isolation guard above is authoritative.
    const composed = composeObservability(effectiveResolved, policy, {
      createMlflowExporter: createMlflowExporter_,
      createFoundryExporter: (): SpanExporter => {
        if (foundryExporter === null) {
          throw new Error("createFoundryExporter called without a prebuilt Foundry exporter");
        }
        return foundryExporter;
      },
      createFoundrySink: (): FoundryTelemetrySink => {
        if (foundrySink === null) {
          throw new Error("createFoundrySink called without a prebuilt Foundry sink");
        }
        return foundrySink;
      },
    });
    observer = composed.observer;

    tracing = await initTracing({ exporter: composed.exporters, policy });
    log.info(
      `Tracing initialized — backends [${effectiveResolved.traceBackends.join(", ")}]; ` +
        `MLflow at ${config.MLFLOW_TRACKING_URI} (experiment ${config.MLFLOW_EXPERIMENT_ID})` +
        (isFoundryEnabled(effectiveResolved) ? ` + Foundry (auth: ${effectiveResolved.auth.mode})` : ""),
    );
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
  let redis: Redis | null = null;
  let redisHealthy = false;
  try {
    redis = new Redis(config.REDIS_URL, {
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
    // get() returns a discriminated hit/miss so nullable values
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
  } else {
    log.warn("Failed to load summary-eval-rubric prompt:", evalRubricPrompt.error);
  }
  const synthesisSystemPrompt = await promptRegistry.load("synthesis-system");
  if (synthesisSystemPrompt.ok) {
    prompts.set("synthesis-system", synthesisSystemPrompt.value.text);
  } else {
    log.error("Failed to load synthesis-system prompt:", synthesisSystemPrompt.error);
  }
  // Note: the summary-eval-rubric prompt is loaded for external eval tooling only;
  // it is intentionally not consumed in the in-pipeline run (post-hoc evaluation
  // is handled by the eval sidecar).

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
    // Default path: NoopObserver (byte-for-byte unchanged, SC-006/FR-027).
    // Foundry path: BufferedObserver(AiFoundryObserver) sharing the trace
    // policy instance — set by composeObservability above.
    observer,
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
        } catch (e) {
          log.debug(`[health] MLflow unreachable: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
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
    // Stop the BufferedObserver sweep so it doesn't outlive the process. The
    // NoopObserver default has no dispose; only the Foundry path's observer is
    // Disposable. Narrow structurally so the default path is untouched.
    const disposable = observer as Partial<Disposable> & { close?: () => void };
    if (typeof disposable.close === "function") {
      disposable.close();
    } else if (typeof disposable[Symbol.dispose] === "function") {
      disposable[Symbol.dispose]!();
    }
    // Drain buffered Foundry domain events before exit. The isolated
    // (connection-string-mode) Application Insights client batches track calls,
    // so without this final flush the last batch is lost on process.exit.
    if (foundrySinkForFlush) {
      log.info("Flushing Foundry domain events...");
      try {
        await foundrySinkForFlush.flush();
      } catch (e) {
        log.warn("Foundry sink flush failed during shutdown:", e);
      }
    }
    if (redis) {
      await redis.disconnect();
    }
  };

  return { app, config, tracing, shutdown };
};
