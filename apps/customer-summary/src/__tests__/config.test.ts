import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear all config-related env vars to isolate tests
    for (const key of [
      "PORT", "REDIS_URL", "MLFLOW_TRACKING_URI", "MLFLOW_EXPERIMENT_ID",
      "LLM_PROVIDER", "LLM_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION",
      "AZURE_OPENAI_DEPLOYMENT", "EVAL_JUDGE_MODEL", "LLM_TRACE_PROMPTS",
      "ENABLE_THINKING", "THINKING_BUDGET_TOKENS", "FIXTURES_DIR", "PROMPTS_DIR",
      "TRACE_SAMPLE_RATIO",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("applies all defaults when env is empty", () => {
    const config = loadConfig();
    expect(config.PORT).toBe(3000);
    expect(config.REDIS_URL).toBe("redis://localhost:6379");
    expect(config.LLM_PROVIDER).toBe("anthropic");
    expect(config.LLM_TRACE_PROMPTS).toBe(false);
    expect(config.ENABLE_THINKING).toBe(false);
    expect(config.THINKING_BUDGET_TOKENS).toBe(4096);
    expect(config.TRACE_SAMPLE_RATIO).toBe(0.1);
    expect(config.FIXTURES_DIR).toBe("./fixtures/customers");
  });

  test("coerces PORT from string", () => {
    process.env.PORT = "8080";
    const config = loadConfig();
    expect(config.PORT).toBe(8080);
  });

  test("transforms LLM_TRACE_PROMPTS 'true' → true", () => {
    process.env.LLM_TRACE_PROMPTS = "true";
    expect(loadConfig().LLM_TRACE_PROMPTS).toBe(true);
  });

  test("transforms LLM_TRACE_PROMPTS '1' → true", () => {
    process.env.LLM_TRACE_PROMPTS = "1";
    expect(loadConfig().LLM_TRACE_PROMPTS).toBe(true);
  });

  test("transforms LLM_TRACE_PROMPTS 'false' → false", () => {
    process.env.LLM_TRACE_PROMPTS = "false";
    expect(loadConfig().LLM_TRACE_PROMPTS).toBe(false);
  });

  test("rejects TRACE_SAMPLE_RATIO > 1", () => {
    process.env.TRACE_SAMPLE_RATIO = "1.5";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects TRACE_SAMPLE_RATIO < 0", () => {
    process.env.TRACE_SAMPLE_RATIO = "-0.1";
    expect(() => loadConfig()).toThrow();
  });

  test("accepts TRACE_SAMPLE_RATIO = 1.0", () => {
    process.env.TRACE_SAMPLE_RATIO = "1.0";
    expect(loadConfig().TRACE_SAMPLE_RATIO).toBe(1.0);
  });

  test("rejects invalid LLM_PROVIDER", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(() => loadConfig()).toThrow();
  });
});
