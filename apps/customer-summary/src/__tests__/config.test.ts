import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { asNonEmptyString } from "@fuguejs/framework";
import { loadConfig } from "../config.js";

/** Brand a known-good literal connection string for tests (non-blank by inspection). */
const conn = (s: string) => asNonEmptyString(s)!;

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
      "TRACE_SAMPLE_RATIO", "OBSERVABILITY_TRACE_BACKENDS",
      "APPLICATIONINSIGHTS_CONNECTION_STRING", "AZURE_AUTH_MODE", "EVAL_BACKEND",
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

  // ── Observability backend selection (FR-001 … FR-006, FR-022, FR-023) ──────

  test("OBSERVABILITY_TRACE_BACKENDS defaults to [mlflow] (FR-003)", () => {
    const config = loadConfig();
    expect(config.OBSERVABILITY_TRACE_BACKENDS).toEqual(["mlflow"]);
    expect(config.AZURE_AUTH_MODE).toBe("connection-string");
    expect(config.EVAL_BACKEND).toBe("mlflow");
    expect(config.APPLICATIONINSIGHTS_CONNECTION_STRING).toBeUndefined();
  });

  test("parses comma-separated dual selection mlflow,foundry (FR-002)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "mlflow,foundry";
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc;IngestionEndpoint=https://x/";
    expect(loadConfig().OBSERVABILITY_TRACE_BACKENDS).toEqual(["mlflow", "foundry"]);
  });

  test("trims whitespace around tokens", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = " mlflow , foundry ";
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc;IngestionEndpoint=https://x/";
    expect(loadConfig().OBSERVABILITY_TRACE_BACKENDS).toEqual(["mlflow", "foundry"]);
  });

  test("rejects unknown trace backend token (fail-closed, FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "mlflow,datadog";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects duplicate trace backend token (fail-closed, FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "mlflow,mlflow";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects blank entry in trace backend list (fail-closed, FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "mlflow,";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects empty trace backend string (fail-closed, FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects foundry selected without connection string (contradictory config, FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "foundry";
    // no APPLICATIONINSIGHTS_CONNECTION_STRING
    expect(() => loadConfig()).toThrow();
  });

  test("rejects foundry selected with blank connection string (FR-006)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "foundry";
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "   ";
    expect(() => loadConfig()).toThrow();
  });

  test("accepts foundry with connection string (FR-022)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "foundry";
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc;IngestionEndpoint=https://x/";
    const config = loadConfig();
    expect(config.OBSERVABILITY_TRACE_BACKENDS).toEqual(["foundry"]);
    expect(config.APPLICATIONINSIGHTS_CONNECTION_STRING).toBe(conn("InstrumentationKey=abc;IngestionEndpoint=https://x/"));
  });

  test("entra-id auth mode still requires a connection string (FR-023)", () => {
    process.env.OBSERVABILITY_TRACE_BACKENDS = "foundry";
    process.env.AZURE_AUTH_MODE = "entra-id";
    // no connection string → contradictory
    expect(() => loadConfig()).toThrow();
  });

  test("rejects invalid AZURE_AUTH_MODE", () => {
    process.env.AZURE_AUTH_MODE = "managed-identity";
    expect(() => loadConfig()).toThrow();
  });

  test("rejects invalid EVAL_BACKEND", () => {
    process.env.EVAL_BACKEND = "datadog";
    expect(() => loadConfig()).toThrow();
  });

  test("accepts EVAL_BACKEND = both (FR-004)", () => {
    process.env.EVAL_BACKEND = "both";
    expect(loadConfig().EVAL_BACKEND).toBe("both");
  });
});
