import { describe, it, expect } from "bun:test";
import { parseHostConfig, parseFugueYaml, HostConfigSchema, FugueYamlSchema } from "../domain/config.js";
import type { HostConfig, FugueYaml } from "../domain/config.js";

describe("HostConfigSchema", () => {
  const validEnv = {
    DAGS_REPO_URL: "https://github.com/org/dags.git",
    REDIS_URL: "redis://localhost:6379",
  };

  it("parses valid environment with only required fields", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DAGS_REPO_URL).toBe("https://github.com/org/dags.git");
    expect(result.value.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("applies sensible defaults for all optional fields (FR-013)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.value;
    expect(c.DAGS_REPO_BRANCH).toBe("main");
    expect(c.DAGS_POLL_INTERVAL_MS).toBe(30_000);
    expect(c.PORT).toBe(3000);
    expect(c.MAX_GLOBAL_CONCURRENCY).toBe(50);
    expect(c.DEFAULT_DAG_CONCURRENCY).toBe(10);
    expect(c.DEFAULT_DAG_TIMEOUT_MS).toBe(60_000);
    expect(c.MAX_DAG_TIMEOUT_MS).toBe(120_000);
    expect(c.DRAIN_TIMEOUT_MS).toBe(30_000);
    expect(c.LLM_PROVIDER).toBe("anthropic");
    expect(c.ASYNC_RESULT_TTL_MS).toBe(3_600_000);
    expect(c.CIRCUIT_BREAKER_THRESHOLD).toBe(5);
    expect(c.CIRCUIT_BREAKER_WINDOW_MS).toBe(60_000);
    expect(c.DEFAULT_CACHE_TTL_MS).toBe(300_000);
    expect(c.DEFAULT_CHECKPOINT_TTL_MS).toBe(86_400_000);
  });

  it("rejects missing DAGS_REPO_URL", () => {
    const result = parseHostConfig({ REDIS_URL: "redis://localhost:6379" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("DAGS_REPO_URL");
  });

  it("rejects missing REDIS_URL (FR-006)", () => {
    const result = parseHostConfig({ DAGS_REPO_URL: "https://github.com/org/dags.git" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("REDIS_URL");
  });

  it("rejects missing both required fields", () => {
    const result = parseHostConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("coerces string numbers for PORT", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "8080" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.PORT).toBe(8080);
  });

  it("coerces string numbers for MAX_GLOBAL_CONCURRENCY", () => {
    const result = parseHostConfig({ ...validEnv, MAX_GLOBAL_CONCURRENCY: "100" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.MAX_GLOBAL_CONCURRENCY).toBe(100);
  });

  it("accepts optional LLM provider override", () => {
    const result = parseHostConfig({ ...validEnv, LLM_PROVIDER: "openai" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.LLM_PROVIDER).toBe("openai");
  });

  it("rejects invalid LLM provider value", () => {
    const result = parseHostConfig({ ...validEnv, LLM_PROVIDER: "gemini" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("accepts all optional fields", () => {
    const result = parseHostConfig({
      ...validEnv,
      DAGS_LOCAL_PATH: "/tmp/dags",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      OPENAI_API_KEY: "sk-xxx",
      AZURE_OPENAI_ENDPOINT: "https://myoai.openai.azure.com",
      AZURE_OPENAI_API_KEY: "key",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
      MLFLOW_TRACKING_URI: "http://localhost:5000",
      MLFLOW_EXPERIMENT_ID: "123",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DAGS_LOCAL_PATH).toBe("/tmp/dags");
    expect(result.value.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });

  it("parses global TTL defaults (FR-040)", () => {
    const result = parseHostConfig({
      ...validEnv,
      DEFAULT_CACHE_TTL_MS: "600000",
      DEFAULT_CHECKPOINT_TTL_MS: "172800000",
      ASYNC_RESULT_TTL_MS: "7200000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DEFAULT_CACHE_TTL_MS).toBe(600_000);
    expect(result.value.DEFAULT_CHECKPOINT_TTL_MS).toBe(172_800_000);
    expect(result.value.ASYNC_RESULT_TTL_MS).toBe(7_200_000);
  });

  it("rejects PORT of 0 (below min 1)", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects negative PORT", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects PORT above 65535", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "70000" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects MAX_GLOBAL_CONCURRENCY of 0", () => {
    const result = parseHostConfig({ ...validEnv, MAX_GLOBAL_CONCURRENCY: "0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects negative MAX_GLOBAL_CONCURRENCY", () => {
    const result = parseHostConfig({ ...validEnv, MAX_GLOBAL_CONCURRENCY: "-5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects DAGS_POLL_INTERVAL_MS below 1000", () => {
    const result = parseHostConfig({ ...validEnv, DAGS_POLL_INTERVAL_MS: "500" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects DEFAULT_DAG_TIMEOUT_MS of 0", () => {
    const result = parseHostConfig({ ...validEnv, DEFAULT_DAG_TIMEOUT_MS: "0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects CIRCUIT_BREAKER_THRESHOLD of 0", () => {
    const result = parseHostConfig({ ...validEnv, CIRCUIT_BREAKER_THRESHOLD: "0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects empty string for numeric field (coerces to 0, below min)", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });

  it("rejects fractional PORT value", () => {
    const result = parseHostConfig({ ...validEnv, PORT: "3.5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
  });
});

describe("FugueYamlSchema", () => {
  it("parses valid YAML with only required field (team)", () => {
    const result = parseFugueYaml({ team: "platform" }, "/dags/foo/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.team).toBe("platform");
    expect(result.value.env).toEqual([]);
  });

  it("parses valid YAML with all fields", () => {
    const data = {
      team: "ml-team",
      owner: "alice",
      env: ["API_KEY", "SECRET"],
      maxConcurrent: 5,
      timeoutMs: 30_000,
      route: "/custom/path",
      cacheTtlMs: 60_000,
      checkpointTtlMs: 3_600_000,
      asyncResultTtlMs: 7_200_000,
    };
    const result = parseFugueYaml(data, "/dags/foo/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.team).toBe("ml-team");
    expect(result.value.owner).toBe("alice");
    expect(result.value.env).toEqual(["API_KEY", "SECRET"]);
    expect(result.value.maxConcurrent).toBe(5);
    expect(result.value.timeoutMs).toBe(30_000);
    expect(result.value.route).toBe("/custom/path");
    expect(result.value.cacheTtlMs).toBe(60_000);
    expect(result.value.checkpointTtlMs).toBe(3_600_000);
    expect(result.value.asyncResultTtlMs).toBe(7_200_000);
  });

  it("rejects missing team field (FR-100)", () => {
    const result = parseFugueYaml({ owner: "bob" }, "/dags/bar/fugue.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validation-failed");
    if (result.error.kind !== "validation-failed") return;
    expect(result.error.path).toBe("/dags/bar/fugue.yaml");
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("rejects invalid types", () => {
    const result = parseFugueYaml(
      { team: "x", maxConcurrent: "not-a-number" },
      "/dags/baz/fugue.yaml",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validation-failed");
  });

  it("provides default empty env array when omitted", () => {
    const result = parseFugueYaml({ team: "test" }, "/dags/foo/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.env).toEqual([]);
  });

  it("supports per-DAG TTL overrides (FR-041)", () => {
    const result = parseFugueYaml(
      { team: "data", cacheTtlMs: 120_000, checkpointTtlMs: 86_400_000 },
      "/dags/etl/fugue.yaml",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cacheTtlMs).toBe(120_000);
    expect(result.value.checkpointTtlMs).toBe(86_400_000);
  });

  it("leaves optional TTL fields undefined when not specified", () => {
    const result = parseFugueYaml({ team: "test" }, "/dags/x/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cacheTtlMs).toBeUndefined();
    expect(result.value.checkpointTtlMs).toBeUndefined();
    expect(result.value.asyncResultTtlMs).toBeUndefined();
  });
});
