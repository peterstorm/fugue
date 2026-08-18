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
  errorOnly,
  anyOf,
  hadRetry,
  ratio,
  piiScrubber,
  IDENTITY_FILTER,
  isOk,
  setFrameworkLogger,
} from "@fuguejs/framework";
import { RedisCache, RedisCheckpointer } from "@fuguejs/framework/redis";
import { DefaultAzureCredential } from "@azure/identity";
import type { LlmClient, TracingHandle, Checkpointer, CheckpointWriter, Observer, FoundryTelemetrySink, FrameworkError, RunId, NodeId } from "@fuguejs/framework";
import { NoopObserver } from "@fuguejs/framework";
import { JsonFixtureSource } from "./sources/json-fixture-source.js";
import { createApp, type AppDeps, type ContextCache } from "./server.js";
import { loadConfig, DEFAULT_MODELS, type Config } from "./config.js";
import { resolveObservabilityBackends, isFoundryEnabled, type ResolvedObservability } from "./observability.js";
import { composeObservability, resolveFoundryLeg, type SpanExporter } from "./observability-composition.js";
import { createFoundrySink } from "./foundry-sink.js";
import { consoleAppLogger } from "./logger.js";
import type { AppLogger } from "./logger.js";
import { runGracefulShutdown } from "./shutdown.js";

const LLM_CACHE_TTL = 3600; // 1 hour

/** The resolved tracing state handed back to the bootstrap shell. */
interface TracingSetup {
  /** The started tracing pipeline, or `null` when tracing setup failed/degraded. */
  readonly tracing: TracingHandle | null;
  /** Domain-event observer — `NoopObserver` on the default/no-Foundry path or on failure. */
  readonly observer: Observer;
  /** Foundry sink held for the graceful-shutdown drain; `null` when not Foundry-active. */
  readonly foundrySinkForFlush: FoundryTelemetrySink | null;
}

/**
 * Test/override seams for {@link setUpTracing}. Each defaults to the real
 * construction path, so production passes none. Tests inject a throwing
 * `initTracing` to exercise the "continue without tracing" catch with no live
 * Azure/OTel pipeline.
 */
export interface TracingSeams {
  readonly initTracing?: typeof initTracing;
  readonly buildMlflowExporter?: () => SpanExporter;
  readonly buildFoundryExporter?: () => SpanExporter;
  readonly buildFoundrySink?: () => FoundryTelemetrySink;
}

type TracingConfig = Pick<Config, "TRACE_SAMPLE_RATIO" | "MLFLOW_TRACKING_URI" | "MLFLOW_EXPERIMENT_ID">;

/**
 * Imperative shell for tracing startup, extracted from {@link bootstrap} so the
 * fault-tolerant "continue without tracing" path is unit-testable WITHOUT the
 * full bootstrap (Redis/LLM/server).
 *
 * MLflow is the always-available trace backend (observability spec FR-003): its exporter is built
 * unconditionally. The Foundry leg is attempted in its OWN isolation guard
 * ({@link resolveFoundryLeg}); a Foundry CONSTRUCTION fault degrades only the
 * Foundry leg and leaves MLflow tracing live (observability spec FR-026 / SC-006 / SC-009). The
 * persistence policy is the SINGLE source of truth gating BOTH trace
 * tail-sampling AND the BufferedObserver's domain-event emission, so a discarded
 * trace produces no orphaned domain events (observability spec FR-021 / SC-010).
 *
 * On ANY failure the catch returns a COHERENT un-traced state — `null` tracing,
 * a fresh `NoopObserver`, and `null` sink — so the "continuing without tracing"
 * log is truthful and the domain-event leg is never left half-wired.
 */
export const setUpTracing = async (
  resolved: ResolvedObservability,
  config: TracingConfig,
  log: AppLogger,
  seams: TracingSeams = {},
): Promise<TracingSetup> => {
  const initTracingFn = seams.initTracing ?? initTracing;
  const buildMlflowExporter =
    seams.buildMlflowExporter ??
    ((): SpanExporter =>
      createMlflowExporter({
        url: config.MLFLOW_TRACKING_URI,
        experimentId: config.MLFLOW_EXPERIMENT_ID,
      }));
  const buildFoundryExporter =
    seams.buildFoundryExporter ??
    ((): SpanExporter => {
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
    });
  const buildFoundrySink =
    seams.buildFoundrySink ??
    ((): FoundryTelemetrySink => {
      if (!isFoundryEnabled(resolved)) {
        throw new Error("Foundry sink requested without Foundry enabled");
      }
      return createFoundrySink(resolved.auth);
    });

  try {
    const policy = anyOf(errorOnly(), hadRetry(), ratio(config.TRACE_SAMPLE_RATIO));

    // Attempt the Foundry exporter + sink in ISOLATION via the fault-isolation
    // boundary. On success the prebuilt instances are handed to
    // composeObservability via thin factories below; on failure the leg is
    // `inactive` with an MLflow-only effective selection.
    const leg = resolveFoundryLeg(resolved, buildFoundryExporter, buildFoundrySink, log);
    const effectiveResolved = leg.effective;
    const foundryExporter: SpanExporter | null = leg.outcome === "active" ? leg.foundryExporter : null;
    const foundrySink: FoundryTelemetrySink | null = leg.outcome === "active" ? leg.foundrySink : null;

    // Compose exporters + observer from the EFFECTIVE selection. The Foundry
    // factories return the prebuilt instances (never re-construct), so the
    // isolation guard above is authoritative.
    const composed = composeObservability(effectiveResolved, policy, {
      createMlflowExporter: buildMlflowExporter,
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

    const tracing = await initTracingFn({ exporter: composed.exporters, policy });
    log.info(
      `Tracing initialized — backends [${effectiveResolved.traceBackends.join(", ")}]; ` +
        `MLflow at ${config.MLFLOW_TRACKING_URI} (experiment ${config.MLFLOW_EXPERIMENT_ID})` +
        (isFoundryEnabled(effectiveResolved) ? ` + Foundry (auth: ${effectiveResolved.auth.mode})` : ""),
    );
    return { tracing, observer: composed.observer, foundrySinkForFlush: foundrySink };
  } catch (e) {
    log.error("Tracing initialization failed — continuing without tracing:", e);
    return { tracing: null, observer: new NoopObserver(), foundrySinkForFlush: null };
  }
};

export const bootstrap = async (injectedLogger?: AppLogger) => {
  const log = injectedLogger ?? consoleAppLogger;
  // Route the framework's fault-isolation warnings (CompositeSpanExporter,
  // AzureMonitorExporter, AiFoundryObserver, FoundryRunSummaryObserver — all via
  // fwLogger()) to the SAME logger the app uses. Without this they fall back to
  // the framework's console default, so the "swallow-but-log" safety net would
  // bypass an injected structured/aggregated AppLogger and be invisible to the
  // operator's log pipeline. AppLogger is structurally a FrameworkLogger.
  setFrameworkLogger(log);
  const config = loadConfig();

  const fixturesDir = resolve(config.FIXTURES_DIR);
  const promptsDir = resolve(config.PROMPTS_DIR);

  // --- Observability backend selection (observability spec FR-002/003/006/022/023) ---
  // Resolve the trace backend(s) + auth from config. A config error MUST fail
  // bootstrap loudly — never silently fall back (observability spec FR-006). In well-formed config
  // this is already caught by the zod superRefine in loadConfig(); the resolver
  // re-checks defense-in-depth, so a thrown error here means contradictory
  // config slipped past the schema and must stop startup.
  const resolvedObservability = resolveObservabilityBackends(config);
  if (!isOk(resolvedObservability)) {
    throw resolvedObservability.error;
  }
  const resolved = resolvedObservability.value;

  // --- Tracing (OTel + MLflow [+ Foundry] with tail-based sampling) ---
  // Delegated to the seam-injectable `setUpTracing` shell. It builds the
  // always-on MLflow backend, attempts the Foundry leg in isolation, composes
  // exporters + observer, and starts the pipeline — returning a coherent
  // un-traced state on any failure so the app still boots (observability spec SC-006 / FR-026).
  const { tracing, observer, foundrySinkForFlush } = await setUpTracing(resolved, config, log);

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
      // Parameter types match the `CheckpointWriter` port it implements
      // (branded ids — the checkpoint domain's one identifier ownership rule);
      // the engine calls it with already-validated RunId/NodeId values.
      write: async (runId: RunId, nodeId: NodeId, value: unknown) => {
        const r = await cp.saveNode(runId, nodeId, {
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
  // One load path for all prompt files: load-or-log, name threaded through so
  // each prompt keeps its own severity (synthesis/synthesis-system are fatal
  // to the pipeline, the eval rubric only feeds post-hoc tooling).
  const loadPrompt = async (
    name: string,
    onFail: (error: FrameworkError) => void,
  ): Promise<void> => {
    const loaded = await promptRegistry.load(name);
    if (loaded.ok) {
      prompts.set(name, loaded.value.text);
    } else {
      onFail(loaded.error);
    }
  };
  await loadPrompt("synthesis", (error) => log.error("Failed to load synthesis prompt:", error));
  await loadPrompt("summary-eval-rubric", (error) => log.warn("Failed to load summary-eval-rubric prompt:", error));
  await loadPrompt("synthesis-system", (error) => log.error("Failed to load synthesis-system prompt:", error));
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
    // Azure base URL: <endpoint>/openai/deployments/<model> — in the azure
    // branch `model` is already `AZURE_OPENAI_DEPLOYMENT ?? LLM_MODEL ??
    // DEFAULT_MODELS[azure]`, so no separate `deployment` name exists.
    const azureBaseUrl = `${config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${model}`;
    llm = new OpenAILlmClient({
      apiKey: config.AZURE_OPENAI_API_KEY,
      baseUrl: azureBaseUrl,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
    });
    log.info(`Using Azure OpenAI LLM client (deployment: ${model}, endpoint: ${config.AZURE_OPENAI_ENDPOINT})`);
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
    // Default path: NoopObserver (byte-for-byte unchanged, observability spec SC-006/FR-027).
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
          // Bound the probe: a black-holed MLflow endpoint must not hang the k8s
          // readiness check until the platform socket timeout. A timeout aborts
          // the fetch and is handled as not-ready below. (checkRedis above does
          // no live I/O — it reads a cached flag — so only this probe needs an
          // explicit bound.)
          const res = await fetch(`${config.MLFLOW_TRACKING_URI}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) {
            log.debug(`[health] MLflow returned non-ok status: ${res.status}`);
          }
          return res.ok;
        } catch (e) {
          log.debug(`[health] MLflow unreachable: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      },
      // Surface CompositeSpanExporter per-child failure counts on /readyz so a
      // constructed-but-persistently-failing secondary backend (e.g. Foundry
      // export erroring while MLflow succeeds) is observable beyond the
      // exporter's rate-limited logs. Null unless multiple backends fan out.
      // Informational only — never gates readiness (observability spec FR-026). Reads `tracing`
      // lazily: by request time the bootstrap tracing block has settled.
      tracingExporterFailures: () => tracing?.exporterFailures() ?? null,
    },
  };
  const app = createApp(deps);

  // Graceful shutdown — orchestration lives in `runGracefulShutdown` (extracted
  // so the per-step fault isolation is unit-tested directly). Each step is
  // guarded independently there: a rejecting trace flush must NOT abort the
  // observer dispose, sink drain, or redis disconnect (the "shutdown wedge"
  // guarantee). The observer is narrowed structurally so the default
  // NoopObserver path has no dispose step.
  const shutdown = async () =>
    runGracefulShutdown(
      {
        tracing,
        observer: observer as Partial<Disposable> & { close?: () => void },
        foundrySink: foundrySinkForFlush,
        redis,
      },
      log,
    );

  return { app, config, tracing, shutdown };
};
