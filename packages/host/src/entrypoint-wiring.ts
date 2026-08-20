import {
  AnthropicLlmClient,
  OpenAILlmClient,
} from "@fuguejs/framework";
import type { LlmClient } from "@fuguejs/framework";
import type { HostConfig } from "./domain/config.js";
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
    return `[unserializable: object]`;
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
  | { readonly provider: "anthropic"; readonly apiKey: string | undefined }
  | { readonly provider: "openai"; readonly apiKey: string | undefined; readonly baseUrl: string }
  | {
      readonly provider: "azure";
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly apiVersion: string;
      readonly deployment: string;
    };

/** Pure provider selection; `parseHostConfig` has already enforced required keys. */
export const planHostLlm = (config: HostConfig): HostLlmPlan => {
  if (config.LLM_PROVIDER === "anthropic") {
    return { provider: "anthropic", apiKey: config.ANTHROPIC_API_KEY };
  }
  if (config.LLM_PROVIDER === "azure") {
    const endpoint = (config.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/$/, "");
    const deployment = config.AZURE_OPENAI_DEPLOYMENT ?? "";
    return {
      provider: "azure",
      apiKey: config.AZURE_OPENAI_API_KEY ?? "",
      baseUrl: `${endpoint}/openai/deployments/${deployment}`,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
      deployment,
    };
  }
  return {
    provider: "openai",
    apiKey: config.OPENAI_API_KEY,
    baseUrl: "https://api.openai.com/v1",
  };
};

type LoadAnthropicClient = (apiKey: string | undefined) => Promise<LlmClient>;

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
      return new OpenAILlmClient({ apiKey: plan.apiKey ?? "", baseUrl: plan.baseUrl });
  }
};
