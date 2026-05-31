import { describe, test, expect } from "bun:test";
import { isOk, isErr } from "@fugue/framework";
import {
  resolveObservabilityBackends,
  isFoundryEnabled,
  ObservabilityConfigError,
} from "../observability.js";
import type { Config } from "../config.js";

/**
 * Build a minimal `Config` for the resolver. The resolver only reads the four
 * observability keys, so the rest are stubbed with their schema defaults. This
 * keeps the resolver tests PURE (no env, no `loadConfig`) — the zod-level
 * startup validation is covered separately in config.test.ts.
 */
const baseConfig = (
  over: Partial<Config> = {},
): Config => ({
  PORT: 3000,
  REDIS_URL: "redis://localhost:6379",
  MLFLOW_TRACKING_URI: "http://localhost:5000",
  MLFLOW_EXPERIMENT_ID: "0",
  LLM_PROVIDER: "anthropic",
  AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
  LLM_TRACE_PROMPTS: false,
  ENABLE_THINKING: false,
  THINKING_BUDGET_TOKENS: 4096,
  FIXTURES_DIR: "./fixtures/customers",
  PROMPTS_DIR: "./prompts",
  TRACE_SAMPLE_RATIO: 0.1,
  OBSERVABILITY_TRACE_BACKENDS: ["mlflow"],
  APPLICATIONINSIGHTS_CONNECTION_STRING: undefined,
  AZURE_AUTH_MODE: "connection-string",
  EVAL_BACKEND: "mlflow",
  ...over,
});

describe("resolveObservabilityBackends", () => {
  test("default selection → MLflow only, foundry disabled (FR-003)", () => {
    const result = resolveObservabilityBackends(baseConfig());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.traceBackends).toEqual(["mlflow"]);
    expect(isFoundryEnabled(result.value)).toBe(false);
    // No `auth` on the no-foundry arm (illegal state unrepresentable).
    expect("auth" in result.value).toBe(false);
  });

  test("dual-export selection (mlflow,foundry) → both backends, foundry enabled (FR-002)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["mlflow", "foundry"],
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc;IngestionEndpoint=https://x/",
      }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.traceBackends).toEqual(["mlflow", "foundry"]);
    expect(isFoundryEnabled(result.value)).toBe(true);
  });

  test("foundry-only selection → ['foundry'], foundry enabled (FR-002 exclusive)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["foundry"],
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc;IngestionEndpoint=https://x/",
      }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.traceBackends).toEqual(["foundry"]);
    expect(isFoundryEnabled(result.value)).toBe(true);
  });

  test("foundry + connection-string mode → auth carries the connection string (FR-022)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["foundry"],
        AZURE_AUTH_MODE: "connection-string",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc;IngestionEndpoint=https://x/",
      }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result) || !isFoundryEnabled(result.value)) return;
    expect(result.value.auth.mode).toBe("connection-string");
    expect(result.value.auth.connectionString).toBe("InstrumentationKey=abc;IngestionEndpoint=https://x/");
  });

  test("foundry + entra-id mode → auth {mode:'entra-id'} and still carries the connection string (FR-023)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["foundry"],
        AZURE_AUTH_MODE: "entra-id",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc;IngestionEndpoint=https://x/",
      }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result) || !isFoundryEnabled(result.value)) return;
    expect(result.value.auth.mode).toBe("entra-id");
    expect(result.value.auth.connectionString).toBe("InstrumentationKey=abc;IngestionEndpoint=https://x/");
  });

  test("foundry selected without connection string → fail-closed error (FR-006)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["foundry"],
        AZURE_AUTH_MODE: "connection-string",
        APPLICATIONINSIGHTS_CONNECTION_STRING: undefined,
      }),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(ObservabilityConfigError);
    expect(result.error.cause).toBe("missing-connection-string");
  });

  test("foundry + entra-id without connection string → fail-closed error (FR-006/T2 rule)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["foundry"],
        AZURE_AUTH_MODE: "entra-id",
        APPLICATIONINSIGHTS_CONNECTION_STRING: undefined,
      }),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.cause).toBe("missing-connection-string");
  });

  test("no-foundry selection ignores a present connection string (auth still absent)", () => {
    const result = resolveObservabilityBackends(
      baseConfig({
        OBSERVABILITY_TRACE_BACKENDS: ["mlflow"],
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc;IngestionEndpoint=https://x/",
      }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(isFoundryEnabled(result.value)).toBe(false);
    expect("auth" in result.value).toBe(false);
  });
});
