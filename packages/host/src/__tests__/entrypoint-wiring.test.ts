import { describe, expect, it } from "bun:test";
import { parseHostConfig } from "../domain/config.js";
import {
  createHostLlmClient,
  createJsonConsoleLogger,
  planHostLlm,
} from "../entrypoint-wiring.js";
import type { LlmClient } from "@fuguejs/framework";

const config = (provider: "anthropic" | "openai" | "azure") => {
  const result = parseHostConfig({
    DAGS_REPO_URL: "https://github.com/test/dags.git",
    REDIS_URL: "redis://localhost:6379",
    ADMIN_TOKEN: "test-admin-token-long-enough",
    LLM_PROVIDER: provider,
    ANTHROPIC_API_KEY: "anthropic-key",
    OPENAI_API_KEY: "openai-key",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    AZURE_OPENAI_DEPLOYMENT: "deployment-a",
    AZURE_OPENAI_API_KEY: "azure-key",
  });
  if (!result.ok) throw new Error("invalid test configuration");
  return result.value;
};

describe("createJsonConsoleLogger", () => {
  it("emits the shared JSON envelope through the selected sink", () => {
    const lines: string[] = [];
    const logger = createJsonConsoleLogger(
      {
        info: (line) => lines.push(`info:${line}`),
        warn: (line) => lines.push(`warn:${line}`),
        error: (line) => lines.push(`error:${line}`),
      },
      () => new Date("2026-08-20T05:00:00.000Z"),
    );

    logger.info("boot", { tenant: "acme" });
    expect(lines).toEqual([
      'info:{"level":"info","msg":"boot","tenant":"acme","ts":"2026-08-20T05:00:00.000Z"}',
    ]);
  });

  it("preserves the established fallback for unserializable data", () => {
    const lines: string[] = [];
    const logger = createJsonConsoleLogger({
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    logger.error("failed", cyclic);
    expect(lines).toEqual(["[unserializable: object]"]);
  });
});

describe("host LLM entrypoint wiring", () => {
  it("plans OpenAI and Azure endpoints once for both entrypoints", () => {
    expect(planHostLlm(config("openai"))).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(planHostLlm(config("azure"))).toEqual({
      provider: "azure",
      apiKey: "azure-key",
      baseUrl: "https://example.openai.azure.com/openai/deployments/deployment-a",
      apiVersion: "2025-03-01-preview",
      deployment: "deployment-a",
    });
  });

  it("keeps the Anthropic SDK behind the injected lazy loader", async () => {
    const fake = { chat: async () => ({ content: "ok", usage: { inputTokens: 0, outputTokens: 0 } }) } as LlmClient;
    const keys: Array<string | undefined> = [];
    const client = await createHostLlmClient(config("anthropic"), async (apiKey) => {
      keys.push(apiKey);
      return fake;
    });

    expect(client).toBe(fake);
    expect(keys).toEqual(["anthropic-key"]);
  });
});
