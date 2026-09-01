import {
  AnthropicLlmClient,
  OpenAILlmClient,
  safeErrorMessage,
} from "@fuguejs/framework";
import type { LlmClient, LlmPricingModel } from "@fuguejs/framework";
import type { HostConfig } from "./domain/config.js";
import type { HostError } from "./domain/host-error.js";
import type { LogPort } from "./ports.js";

export interface JsonLogSink {
  readonly info: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly error: (line: string) => void;
}

const consoleSink: JsonLogSink = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const renderLogLine = (
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown> | undefined,
  now: () => Date,
): string => {
  try {
    return JSON.stringify({ level, msg: message, ...data, ts: now().toISOString() });
  } catch {
    return JSON.stringify({
      level,
      msg: message,
      ts: null,
      logSerializationError: "log payload could not be serialized",
    });
  }
};

/** Derive every secret spelling that a Redis driver diagnostic might echo. */
export const redisUrlRedactions = (redisUrl: string): readonly string[] => {
  const redactions = new Set<string>([redisUrl]);
  try {
    const password = new URL(redisUrl).password;
    if (password.length > 0) {
      redactions.add(password);
      try {
        redactions.add(decodeURIComponent(password));
      } catch {
        // Keep the URL-encoded spelling; malformed percent escapes cannot add a decoded form.
      }
    }
  } catch {
    // Host config currently accepts non-URL Redis connection strings; redact the raw value.
  }
  return [...redactions];
};

/** Build an observable Redis failure without allowing configured secrets into diagnostics. */
export const redisOperationFailure = (
  operation: string,
  error: unknown,
  redactions: readonly string[],
): HostError => {
  let diagnostic = safeErrorMessage(error);
  for (const secret of redactions) {
    if (secret.length > 0) diagnostic = diagnostic.replaceAll(secret, "[redacted]");
  }
  return { kind: "redis-unavailable", operation: `${operation} (${diagnostic})` };
};

export interface RedisDisconnectTarget {
  readonly name: string;
  readonly quit: () => Promise<unknown>;
}

/** Attempt every Redis close and reject once with all failures preserved. */
export const disconnectRedisClients = async (
  targets: readonly RedisDisconnectTarget[],
): Promise<void> => {
  const outcomes = await Promise.allSettled(
    targets.map(async (target) => target.quit()),
  );
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [new Error(
          `${targets[index]!.name}: ${safeErrorMessage(outcome.reason)}`,
          { cause: outcome.reason },
        )]
      : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Redis disconnect failed: ${failures.map((failure) => failure.message).join("; ")}`,
    );
  }
};

/** Structured JSON logger shared by every executable shell entrypoint. */
export const createJsonConsoleLogger = (
  sink: JsonLogSink = consoleSink,
  now: () => Date = () => new Date(),
): LogPort => ({
  info: (message, data) => sink.info(renderLogLine("info", message, data, now)),
  warn: (message, data) => sink.warn(renderLogLine("warn", message, data, now)),
  error: (message, data) => sink.error(renderLogLine("error", message, data, now)),
});

export type HostLlmPlan =
  | { readonly provider: "anthropic"; readonly apiKey: string }
  | { readonly provider: "openai"; readonly apiKey: string; readonly baseUrl: string }
  | {
      readonly provider: "azure";
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly apiVersion: string;
      readonly deployment: string;
      readonly model: string;
    };

/** Pure provider selection; `parseHostConfig` has already enforced required keys. */
export const planHostLlm = (config: HostConfig): HostLlmPlan => {
  if (config.LLM_PROVIDER === "anthropic") {
    return { provider: "anthropic", apiKey: config.ANTHROPIC_API_KEY };
  }
  if (config.LLM_PROVIDER === "azure") {
    const endpoint = config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "");
    const deployment = config.AZURE_OPENAI_DEPLOYMENT;
    return {
      provider: "azure",
      apiKey: config.AZURE_OPENAI_API_KEY,
      baseUrl: `${endpoint}/openai/deployments/${deployment}`,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
      deployment,
      model: config.AZURE_OPENAI_MODEL,
    };
  }
  return {
    provider: "openai",
    apiKey: config.OPENAI_API_KEY,
    baseUrl: "https://api.openai.com/v1",
  };
};

/** Bind the provider's effective model policy at host composition. */
export const hostLlmPricingModel = (config: HostConfig): LlmPricingModel => {
  const plan = planHostLlm(config);
  return plan.provider === "azure"
    ? { kind: "fixed", model: plan.model }
    : { kind: "request" };
};

type LoadAnthropicClient = (apiKey: string) => Promise<LlmClient>;

const loadAnthropicClient: LoadAnthropicClient = async (apiKey) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new AnthropicLlmClient(new Anthropic({ apiKey }));
};

/** Materialize the pure provider plan at the executable shell boundary. */
export const createHostLlmClient = async (
  config: HostConfig,
  loadAnthropic: LoadAnthropicClient = loadAnthropicClient,
): Promise<LlmClient> => {
  const plan = planHostLlm(config);
  switch (plan.provider) {
    case "anthropic":
      return loadAnthropic(plan.apiKey);
    case "azure":
      return new OpenAILlmClient({
        apiKey: plan.apiKey,
        baseUrl: plan.baseUrl,
        apiVersion: plan.apiVersion,
        modelOverride: plan.deployment,
      });
    case "openai":
      return new OpenAILlmClient({ apiKey: plan.apiKey, baseUrl: plan.baseUrl });
  }
};
