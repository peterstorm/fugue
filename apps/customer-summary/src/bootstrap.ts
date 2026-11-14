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
import type { FrameworkError } from "@fuguejs/framework";
import { RedisCache, RedisCheckpointer } from "@fuguejs/framework/redis";
import { DefaultAzureCredential } from "@azure/identity";
import type { LlmClient, TracingHandle, Checkpointer, CheckpointWriter, Observer, FoundryTelemetrySink, PromptRegistry, RunId, NodeId, MappedChildScope } from "@fuguejs/framework";
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

export const loadAppPrompts = async (
  registry: PromptRegistry,
  log: AppLogger,
): Promise<Map<string, string>> => {
  const prompts = new Map<string, string>();
  // One load path for every prompt. `synthesis` and `synthesis-system` are
  // pipeline-fatal: a load failure MUST fail bootstrap loudly (the same idiom
  // as resolveObservabilityBackends — a config error never silently degrades),
  // because a missing SYSTEM prompt cannot be detected per-request: the LLM
  // node would silently fall back to its generic default system prompt
  // (nodes/llm.ts) and every subsequent /summarize run would complete 200
  // under degraded behavior with no per-request, response, or readiness signal.
  const loadFatal = async (name: string): Promise<string> => {
    const loaded = await registry.load(name);
    if (loaded.ok) return loaded.value.text;
    const e = loaded.error;
    const detail = e.kind === "prompt-not-found" ? e.reason : JSON.stringify(e);
    throw new Error(`Required prompt "${name}" failed to load — ${detail}`);
  };
  prompts.set("synthesis", await loadFatal("synthesis"));
  prompts.set("synthesis-system", await loadFatal("synthesis-system"));
  // Note: the summary-eval-rubric prompt is loaded for external eval tooling
  // only; it is intentionally not consumed in the in-pipeline run (post-hoc
  // evaluation is handled by the eval sidecar), so it degrades to
  // log-and-continue.
  const rubric = await registry.load("summary-eval-rubric");
  if (rubric.ok) {
    prompts.set("summary-eval-rubric", rubric.value.text);
  } else {
    log.warn("Failed to load summary-eval-rubric prompt:", rubric.error);
  }
  return prompts;
};

/**
 * THE one rendering of a cache/checkpoint FrameworkError for these
 * diagnostics: the kind always, plus the message for `cache-error`. It is NOT
 * the sole message-carrying variant — `checkpoint-write-failed` and friends
 * carry messages too — so this rendering is a lossy diagnostic, not a
 * complete one; sites that must surface the message verbatim render the
 * error themselves. Three sites needed it and must agree, or the same
 * backend failure reads differently depending on which call hit it.
 */
const describeCacheError = (error: FrameworkError): string =>
  `${error.kind}${error.kind === "cache-error" ? ` — ${error.message}` : ""}`;

/**
 * Adapter: NodeContext.cache expects get/set. Node-output persistence is
 * wired separately through the CheckpointWriter. get() returns a discriminated
 * hit/miss so nullable values are no longer ambiguous with cache misses.
 */
export const buildContextCache = (cache: RedisCache, log: AppLogger): ContextCache => ({
  get: async (key: string) => {
    const r = await cache.get(key, z.unknown());
    if (!r.ok) {
      log.warn(`[cache] get failed for key=${key}: ${describeCacheError(r.error)}`);
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
      log.warn(`[cache] set failed for key=${key}: ${describeCacheError(r.error)}`);
    }
    return r;
  },
});

/**
 * Parameter types match the `CheckpointWriter` port it implements
 * (branded ids — the checkpoint domain's one identifier ownership rule);
 * the engine calls it with already-validated RunId/NodeId values.
 */
export const buildCheckpointWriter = (cp: Checkpointer): CheckpointWriter => ({
  write: async (runId: RunId, nodeId: NodeId, value: unknown, scope?: MappedChildScope) => {
    // Composite addressing (ADR-0075): a mapped child's fan index and its
    // freshness epoch map onto the composite key's index/attempt components,
    // so entries from distinct fan slots and execution epochs are stored at
    // distinct durable addresses instead of overwriting each other. No scope
    // → `saveNode`'s canonical folding keeps the bare-nodeId root address.
    const opts = scope ? { index: scope.index, attempt: scope.executionEpoch } : undefined;
    const r = await cp.saveNode(runId, {
      nodeId,
      output: value,
      completedAt: new Date(),
    }, opts);
    if (!r.ok) {
      throw new Error(
        `checkpoint write failed for run=${runId} node=${nodeId}: ${describeCacheError(r.error)}`,
      );
    }
  },
});

/**
 * The Redis-backed collaborators. When Redis is unreachable at bootstrap:
 * `contextCache`, `checkpointWriter` and `checkpointer` are all `null` and
 * `isHealthy()` is false. BUT `redis` still holds the constructed-unconnected
 * client — `redis !== null` is NOT a liveness signal; read `isHealthy()`
 * (or the nullability of the collaborators) instead.
 */
interface RedisSetup {
  readonly redis: Redis | null;
  /** Event-driven health flag read lazily by the readiness probe. */
  readonly isHealthy: () => boolean;
  readonly contextCache: ContextCache | null;
  readonly checkpointWriter: CheckpointWriter | null;
  readonly checkpointer: Checkpointer | null;
}

/**
 * Redis is a hard dependency: it backs the checkpointer (durable resume) and
 * the response cache. If it's unavailable at bootstrap, we still construct
 * the app, but readiness MUST report not-ready so traffic does not land here.
 * The /summarize handler also rejects requests when checkpointer is null.
 */
export const setUpRedis = async (config: Config, log: AppLogger): Promise<RedisSetup> => {
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
    contextCache = buildContextCache(cache, log);
    checkpointWriter = buildCheckpointWriter(checkpointer);
  } catch (e) {
    log.warn("Redis connection failed — running without cache/checkpointing:", e);
    // All-or-nothing: the collaborators are only usable together (the
    // /summarize handler refuses traffic unless BOTH checkpointer and
    // checkpointWriter are set), so a failure at any construction step leaves
    // NONE of them half-wired.
    contextCache = null;
    checkpointWriter = null;
    checkpointer = null;
  }
  return { redis, isHealthy: () => redisHealthy, contextCache, checkpointWriter, checkpointer };
};

/**
 * For Azure, deployment name is used as the model parameter; every other
 * provider uses `LLM_MODEL` or its default.
 */
const resolveModel = (config: Config): string => {
  const provider = config.LLM_PROVIDER;
  return provider === "azure"
    ? (config.AZURE_OPENAI_DEPLOYMENT ?? config.LLM_MODEL ?? DEFAULT_MODELS[provider])
    : (config.LLM_MODEL ?? DEFAULT_MODELS[provider]);
};

/**
 * Which LLM client the app runs on, as a tagged union. `fake-fallback` is the
 * no-API-key fallback onto the unconfigured FakeLlmClient — every /summarize
 * is then guaranteed to fail, so readiness must report not-ready (checkLlm)
 * instead of serving traffic into it. The tag replaces a free `llmIsFake`
 * boolean so the two states cannot be read apart from the client they name.
 */
type LlmSetup =
  | { readonly kind: "configured"; readonly llm: LlmClient }
  | { readonly kind: "fake-fallback"; readonly llm: LlmClient };

const selectLlmClient = (
  config: Config,
  model: string,
  traced: boolean,
  log: AppLogger,
): LlmSetup => {
  const provider = config.LLM_PROVIDER;
  if (provider === "azure" && config.AZURE_OPENAI_ENDPOINT && config.AZURE_OPENAI_API_KEY) {
    // Azure base URL: <endpoint>/openai/deployments/<model> — in the azure
    // branch `model` is already `AZURE_OPENAI_DEPLOYMENT ?? LLM_MODEL ??
    // DEFAULT_MODELS[azure]`, so no separate `deployment` name exists.
    const azureBaseUrl = `${config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${model}`;
    const llm = new OpenAILlmClient({
      apiKey: config.AZURE_OPENAI_API_KEY,
      baseUrl: azureBaseUrl,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
    });
    log.info(`Using Azure OpenAI LLM client (deployment: ${model}, endpoint: ${config.AZURE_OPENAI_ENDPOINT})`);
    return { kind: "configured", llm };
  }
  if (provider === "openai" && config.OPENAI_API_KEY) {
    const llm = new OpenAILlmClient({
      apiKey: config.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
    });
    log.info(`Using OpenAI LLM client (model: ${model})`);
    return { kind: "configured", llm };
  }
  if (provider === "anthropic" && config.ANTHROPIC_API_KEY) {
    const raw = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const llm = new AnthropicLlmClient(raw);
    log.info(`Using Anthropic LLM client (model: ${model})${traced ? " [traced]" : ""}`);
    return { kind: "configured", llm };
  }
  log.warn(`No API key set for provider "${provider}" — using FakeLlmClient (all LLM calls will fail)`);
  return { kind: "fake-fallback", llm: new FakeLlmClient(new Map()) };
};

/**
 * ENABLE_THINKING is only honored by providers whose client implements reasoning.
 * Anthropic client currently ignores `req.thinking` (extended-thinking integration
 * pending), so passing it through would be a silent no-op visible only in the trace
 * attribute. Refuse it explicitly here so config matches behavior.
 */
const resolveThinking = (
  config: Config,
  log: AppLogger,
): { type: "enabled"; budgetTokens: number } | undefined => {
  if (!config.ENABLE_THINKING) return undefined;
  const provider = config.LLM_PROVIDER;
  const providerSupportsThinking = provider === "openai" || provider === "azure";
  if (providerSupportsThinking) {
    return { type: "enabled", budgetTokens: config.THINKING_BUDGET_TOKENS };
  }
  log.warn(`[config] ENABLE_THINKING ignored: not implemented for provider "${provider}"`);
  return undefined;
};

/**
 * Bound the probe: a black-holed MLflow endpoint must not hang the k8s
 * readiness check until the platform socket timeout. A timeout aborts
 * the fetch and is handled as not-ready. (checkRedis does no live I/O — it
 * reads a cached flag — so only this probe needs an explicit bound.)
 *
 * Returns the outcome plus the failure detail; the caller logs transitions.
 */
const probeMlflow = async (config: Config): Promise<{ up: boolean; detail: string }> => {
  try {
    const res = await fetch(`${config.MLFLOW_TRACKING_URI}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok
      ? { up: true, detail: "ok" }
      : { up: false, detail: `non-ok status ${res.status}` };
  } catch (e) {
    return { up: false, detail: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** Readiness checks: flag/probe-backed, never per-request pings of Redis. */
export const buildHealth = (
  config: Config,
  log: AppLogger,
  redisSetup: RedisSetup,
  llmSetup: LlmSetup,
  tracing: TracingHandle | null,
): NonNullable<AppDeps["health"]> => {
  // MLflow probe transitions are logged at WARN (both directions) so a
  // flapping or newly-failing backend leaves an operator breadcrumb; steady
  // states are silent. `null` = no probe yet (first call never logs).
  let mlflowWasUp: boolean | null = null;
  return {
  // Always defined: if Redis was never reachable at bootstrap, we still
  // need readiness to report not-ready (otherwise k8s leaves the pod in
  // service while checkpointer/cache are null). Flag is event-driven —
  // no per-request ping (would add round-trip on every k8s probe).
  checkRedis: async () => redisSetup.isHealthy() && redisSetup.redis !== null,
  // Readiness gate for the LLM fallback: the unconfigured FakeLlmClient
  // guarantees every /summarize fails, so the pod must come OUT of
  // rotation instead of reporting ready while it can serve nothing.
  // No I/O — reads the bootstrap-set tag (same shape as checkRedis).
  checkLlm: async () => llmSetup.kind === "configured",
  checkMlflow: async () => {
    const probe = await probeMlflow(config);
    if (mlflowWasUp !== null && mlflowWasUp !== probe.up) {
      log.warn(
        probe.up
          ? "[health] MLflow recovered — trace backend reachable again"
          : `[health] MLflow failed — ${probe.detail}`,
      );
    }
    mlflowWasUp = probe.up;
    return probe.up;
  },
  // Surface CompositeSpanExporter per-child failure counts on /readyz so a
  // constructed-but-persistently-failing secondary backend (e.g. Foundry
  // export erroring while MLflow succeeds) is observable beyond the
  // exporter's rate-limited logs. Null unless multiple backends fan out.
  // Informational only — never gates readiness (observability spec FR-026).
  tracingExporterFailures: () => tracing?.exporterFailures() ?? null,
  };
};

/**
 * Resolve the trace backend(s) + auth from config (observability spec
 * FR-002/003/006/022/023). A config error MUST fail bootstrap loudly — never
 * silently fall back (observability spec FR-006). In well-formed config this
 * is already caught by the zod superRefine in loadConfig(); the resolver
 * re-checks defense-in-depth, so a thrown error here means contradictory
 * config slipped past the schema and must stop startup.
 */
const resolveObservabilityOrThrow = (config: Config): ResolvedObservability => {
  const resolvedObservability = resolveObservabilityBackends(config);
  if (!isOk(resolvedObservability)) {
    throw resolvedObservability.error;
  }
  return resolvedObservability.value;
};

/**
 * Pipeline-fatal prompts (synthesis / synthesis-system) fail bootstrap
 * loudly on load failure; the post-hoc eval rubric degrades (see
 * loadAppPrompts for the per-prompt severity contract).
 */
const loadPromptsFromDisk = (promptsDir: string, log: AppLogger): Promise<Map<string, string>> => {
  const promptRegistry = FilePromptRegistry({
    dir: promptsDir,
    registryPath: join(promptsDir, "registry.json"),
  });
  return loadAppPrompts(promptRegistry, log);
};

/** Everything `bootstrap` resolved before the app's dependency record is assembled. */
interface ResolvedParts {
  readonly config: Config;
  readonly log: AppLogger;
  readonly source: JsonFixtureSource;
  readonly prompts: Map<string, string>;
  readonly model: string;
  readonly llmSetup: LlmSetup;
  readonly redisSetup: RedisSetup;
  readonly tracingSetup: TracingSetup;
}

const assembleAppDeps = (parts: ResolvedParts): AppDeps => {
  const { config, log, model, llmSetup, redisSetup, tracingSetup } = parts;
  return {
    source: parts.source,
    llm: llmSetup.llm,
    prompts: parts.prompts,
    model,
    judgeModel: config.EVAL_JUDGE_MODEL ?? model,
    thinking: resolveThinking(config, log),
    cache: redisSetup.contextCache,
    checkpointWriter: redisSetup.checkpointWriter,
    checkpointer: redisSetup.checkpointer,
    // Default path: NoopObserver (byte-for-byte unchanged, observability spec SC-006/FR-027).
    // Foundry path: BufferedObserver(AiFoundryObserver) sharing the trace
    // policy instance — set by composeObservability above.
    observer: tracingSetup.observer,
    logger: log,
    // Read the env-derived flag once at bootstrap; the APP reads its config
    // from process.env exactly here in config.ts (ConfigSchema.parse) — the
    // framework's only env touch is the OBSERVER_STRICT test seam in
    // observer/dispatch.ts. When LLM_TRACE_PROMPTS is true, content passes
    // through unchanged; otherwise the PII scrubber strips sensitive patterns
    // while keeping non-PII content visible for debugging.
    contentFilter: config.LLM_TRACE_PROMPTS ? IDENTITY_FILTER : piiScrubber,
    health: buildHealth(config, log, redisSetup, llmSetup, tracingSetup.tracing),
  };
};

/**
 * Graceful shutdown — orchestration lives in `runGracefulShutdown` (extracted
 * so the per-step fault isolation is unit-tested directly). Each step is
 * guarded independently there: a rejecting trace flush must NOT abort the
 * observer dispose, sink drain, or redis disconnect (the "shutdown wedge"
 * guarantee). The observer is narrowed structurally so the default
 * NoopObserver path has no dispose step.
 */
const buildShutdown = (
  tracingSetup: TracingSetup,
  redis: Redis | null,
  log: AppLogger,
): (() => Promise<void>) => async () =>
  runGracefulShutdown(
    {
      tracing: tracingSetup.tracing,
      observer: tracingSetup.observer as Partial<Disposable> & { close?: () => void },
      foundrySink: tracingSetup.foundrySinkForFlush,
      redis,
    },
    log,
  );

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

  const resolved = resolveObservabilityOrThrow(config);

  // Tracing (OTel + MLflow [+ Foundry] with tail-based sampling): the
  // seam-injectable `setUpTracing` shell returns a coherent un-traced state on
  // any failure so the app still boots (observability spec SC-006 / FR-026).
  const tracingSetup = await setUpTracing(resolved, config, log);

  // Redis (cache + checkpointer)
  const redisSetup = await setUpRedis(config, log);

  const source = new JsonFixtureSource(resolve(config.FIXTURES_DIR));
  const prompts = await loadPromptsFromDisk(resolve(config.PROMPTS_DIR), log);

  const model = resolveModel(config);
  const llmSetup = selectLlmClient(config, model, tracingSetup.tracing !== null, log);

  const app = createApp(
    assembleAppDeps({ config, log, source, prompts, model, llmSetup, redisSetup, tracingSetup }),
  );
  const shutdown = buildShutdown(tracingSetup, redisSetup.redis, log);

  return { app, config, tracing: tracingSetup.tracing, shutdown };
};
