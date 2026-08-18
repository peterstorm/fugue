import { describe, it, expect } from "bun:test";
import { parseHostConfig, parseFugueYaml, HostConfigSchema, FugueYamlSchema } from "../domain/config.js";
import type { HostConfig, FugueYaml } from "../domain/config.js";

describe("HostConfigSchema", () => {
  const validEnv = {
    DAGS_REPO_URL: "https://github.com/org/dags.git",
    REDIS_URL: "redis://localhost:6379",
    ADMIN_TOKEN: "test-admin-token-long-enough",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
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
    expect(c.CIRCUIT_BREAKER_THRESHOLD).toBe(5);
    expect(c.CIRCUIT_BREAKER_WINDOW_MS).toBe(60_000);
    expect(c.DEFAULT_CACHE_TTL_MS).toBe(300_000);
    expect(c.DEFAULT_CHECKPOINT_TTL_MS).toBe(86_400_000);
  });

  it("rejects missing DAGS_REPO_URL", () => {
    const result = parseHostConfig({ REDIS_URL: "redis://localhost:6379", ADMIN_TOKEN: "test-admin-token-long-enough" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("DAGS_REPO_URL");
  });

  it("rejects missing REDIS_URL (FR-006)", () => {
    const result = parseHostConfig({ DAGS_REPO_URL: "https://github.com/org/dags.git", ADMIN_TOKEN: "test-admin-token-long-enough" });
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

  it("accepts DOCUMENTS_ADAPTER=fs with a root dir (ADR-0052)", () => {
    const result = parseHostConfig({ ...validEnv, DOCUMENTS_ADAPTER: "fs", DOCUMENTS_FS_ROOT: "/data/reports" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DOCUMENTS_ADAPTER).toBe("fs");
    expect(result.value.DOCUMENTS_FS_ROOT).toBe("/data/reports");
  });

  it("rejects DOCUMENTS_ADAPTER=fs without DOCUMENTS_FS_ROOT", () => {
    const result = parseHostConfig({ ...validEnv, DOCUMENTS_ADAPTER: "fs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("DOCUMENTS_FS_ROOT");
  });

  it("leaves documents capability unconfigured by default", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DOCUMENTS_ADAPTER).toBeUndefined();
  });

  it("accepts DOCUMENTS_ADAPTER=ms-graph with the three credentials (resolve paths default off)", () => {
    const result = parseHostConfig({
      ...validEnv,
      DOCUMENTS_ADAPTER: "ms-graph",
      MSGRAPH_TENANT_ID: "tenant-1",
      MSGRAPH_CLIENT_ID: "client-1",
      MSGRAPH_CLIENT_SECRET: "secret-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DOCUMENTS_ADAPTER).toBe("ms-graph");
    expect(result.value.MSGRAPH_TENANT_ID).toBe("tenant-1");
    expect(result.value.MSGRAPH_RESOLVE_PATHS).toBe(false);
  });

  it("rejects DOCUMENTS_ADAPTER=ms-graph missing any credential (fail-closed at boot)", () => {
    const result = parseHostConfig({
      ...validEnv,
      DOCUMENTS_ADAPTER: "ms-graph",
      MSGRAPH_TENANT_ID: "tenant-1",
      MSGRAPH_CLIENT_ID: "client-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("MSGRAPH_CLIENT_SECRET");
  });

  it("coerces MSGRAPH_RESOLVE_PATHS string tokens and rejects typos (fail-closed-loud)", () => {
    const base = {
      ...validEnv,
      DOCUMENTS_ADAPTER: "ms-graph",
      MSGRAPH_TENANT_ID: "t",
      MSGRAPH_CLIENT_ID: "c",
      MSGRAPH_CLIENT_SECRET: "s",
    };
    for (const v of ["true", "1"]) {
      const r = parseHostConfig({ ...base, MSGRAPH_RESOLVE_PATHS: v });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.MSGRAPH_RESOLVE_PATHS).toBe(true);
    }
    const off = parseHostConfig({ ...base, MSGRAPH_RESOLVE_PATHS: "false" });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.value.MSGRAPH_RESOLVE_PATHS).toBe(false);
    // A typo'd `yes`/`on` is REJECTED at boot rather than silently off — same
    // fail direction as SUPERVISOR_REDIS_ACL_ENABLED.
    expect(parseHostConfig({ ...base, MSGRAPH_RESOLVE_PATHS: "yes" }).ok).toBe(false);
  });

  it("rejects a non-URL MSGRAPH_BASE_URL", () => {
    const result = parseHostConfig({
      ...validEnv,
      DOCUMENTS_ADAPTER: "ms-graph",
      MSGRAPH_TENANT_ID: "t",
      MSGRAPH_CLIENT_ID: "c",
      MSGRAPH_CLIENT_SECRET: "s",
      MSGRAPH_BASE_URL: "not a url",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects BOT_APP_ID without BOT_APP_PASSWORD (ADR-0060)", () => {
    const result = parseHostConfig({ ...validEnv, BOT_APP_ID: "00000000-0000-0000-0000-000000000000" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("BOT_APP_PASSWORD");
  });

  it("accepts BOT_APP_ID with BOT_APP_PASSWORD", () => {
    const result = parseHostConfig({ ...validEnv, BOT_APP_ID: "00000000-0000-0000-0000-000000000000", BOT_APP_PASSWORD: "bot-secret" });
    expect(result.ok).toBe(true);
  });

  it("rejects an http BOT_TOKEN_URL (the app password is POSTed there)", () => {
    const result = parseHostConfig({ ...validEnv, BOT_TOKEN_URL: "http://login.example.com/token" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("BOT_TOKEN_URL");
  });

  it("coerces string numbers for MAX_GLOBAL_CONCURRENCY", () => {
    const result = parseHostConfig({ ...validEnv, MAX_GLOBAL_CONCURRENCY: "100" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.MAX_GLOBAL_CONCURRENCY).toBe(100);
  });

  it("accepts optional LLM provider override", () => {
    const result = parseHostConfig({ ...validEnv, LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
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

  // ── AGENT_CLIENT_SCOPES validation (review suggestion #7) ──────────────────
  it("parses a valid AGENT_CLIENT_SCOPES policy into a clientId → scopes map", () => {
    const result = parseHostConfig({
      ...validEnv,
      AGENT_CLIENT_SCOPES: JSON.stringify({ "fugue-agent-mail": ["msgraph:mail.send"], "fugue-agent-sites": ["msgraph:sites.read", "dynamics:read"] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.AGENT_CLIENT_SCOPES["fugue-agent-mail"]).toEqual(["msgraph:mail.send"]);
  });

  it("defaults AGENT_CLIENT_SCOPES to {} when unset", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.AGENT_CLIENT_SCOPES).toEqual({});
  });

  // ── AGENT_CLIENT_MAP validation (FR-040) ───────────────────────────────────
  it("parses a valid AGENT_CLIENT_MAP into a dagId → real-client map (FR-040)", () => {
    const result = parseHostConfig({
      ...validEnv,
      AGENT_CLIENT_MAP: JSON.stringify({ "lead-desk": "fugue-agent-mail", "crm-sync": "fugue-agent-crm" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.AGENT_CLIENT_MAP["lead-desk"]).toBe("fugue-agent-mail");
    expect(result.value.AGENT_CLIENT_MAP["crm-sync"]).toBe("fugue-agent-crm");
  });

  it("defaults AGENT_CLIENT_MAP to {} when unset (every DAG fails closed until mapped)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.AGENT_CLIENT_MAP).toEqual({});
  });

  it("REJECTS at boot a non-JSON AGENT_CLIENT_MAP", () => {
    const result = parseHostConfig({ ...validEnv, AGENT_CLIENT_MAP: "{not json" });
    expect(result.ok).toBe(false);
  });

  it("REJECTS at boot an AGENT_CLIENT_MAP whose value is not a non-empty string", () => {
    const result = parseHostConfig({ ...validEnv, AGENT_CLIENT_MAP: JSON.stringify({ "lead-desk": "" }) });
    expect(result.ok).toBe(false);
  });

  // ── HITL_APPROVER_TEAMS validation (FR-041) ────────────────────────────────
  it("parses a valid HITL_APPROVER_TEAMS into an aadObjectId → teams map (FR-041)", () => {
    const result = parseHostConfig({
      ...validEnv,
      HITL_APPROVER_TEAMS: JSON.stringify({ "aad-alice": ["sales", "ops"], "aad-bob": ["marketing"] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.HITL_APPROVER_TEAMS["aad-alice"]).toEqual(["sales", "ops"]);
  });

  it("defaults HITL_APPROVER_TEAMS to {} when unset (every Teams click fails closed)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.HITL_APPROVER_TEAMS).toEqual({});
  });

  it("REJECTS at boot a malformed HITL_APPROVER_TEAMS (not aadObjectId → string[])", () => {
    const result = parseHostConfig({ ...validEnv, HITL_APPROVER_TEAMS: JSON.stringify({ "aad-alice": "sales" }) });
    expect(result.ok).toBe(false);
  });

  // ── HITL_TEAM_CHANNELS validation (FR-041, confidentiality routing) ─────────
  it("parses a valid HITL_TEAM_CHANNELS into an aadGroupId → fugue team map (FR-041)", () => {
    const result = parseHostConfig({
      ...validEnv,
      HITL_TEAM_CHANNELS: JSON.stringify({ "grp-sales": "sales", "grp-mkt": "marketing" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.HITL_TEAM_CHANNELS["grp-sales"]).toBe("sales");
    expect(result.value.HITL_TEAM_CHANNELS["grp-mkt"]).toBe("marketing");
  });

  it("defaults HITL_TEAM_CHANNELS to {} when unset (every team falls back to the default channel)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.HITL_TEAM_CHANNELS).toEqual({});
  });

  it("REJECTS at boot a non-object HITL_TEAM_CHANNELS (aadGroupId → non-string)", () => {
    const result = parseHostConfig({ ...validEnv, HITL_TEAM_CHANNELS: JSON.stringify({ "grp-sales": ["sales"] }) });
    expect(result.ok).toBe(false);
  });

  it("REJECTS at boot a HITL_TEAM_CHANNELS mapping to an empty team id", () => {
    const result = parseHostConfig({ ...validEnv, HITL_TEAM_CHANNELS: JSON.stringify({ "grp-sales": "" }) });
    expect(result.ok).toBe(false);
  });

  it("REJECTS invalid HITL_TEAM_CHANNELS JSON at boot", () => {
    const result = parseHostConfig({ ...validEnv, HITL_TEAM_CHANNELS: "{not json" });
    expect(result.ok).toBe(false);
  });

  // ── DYNAMICS_ORG_HOST parse/default (FR-042) ────────────────────────────────
  it("parses DYNAMICS_ORG_HOST when set (per-org Dataverse host)", () => {
    const result = parseHostConfig({ ...validEnv, DYNAMICS_ORG_HOST: "org.crm4.dynamics.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DYNAMICS_ORG_HOST).toBe("org.crm4.dynamics.com");
  });

  it("leaves DYNAMICS_ORG_HOST undefined when unset (dynamics:read fails closed at the broker)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DYNAMICS_ORG_HOST).toBeUndefined();
  });

  // ── Oracle `oracle` capability gating (FR-033 / FR-040 / FR-041) ────────────
  it("leaves the oracle capability unconfigured by default — all ORACLE_* fields absent is valid (FR-033 zero regression)", () => {
    const result = parseHostConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ORACLE_CONNECT_STRING).toBeUndefined();
    expect(result.value.ORACLE_USER).toBeUndefined();
    expect(result.value.ORACLE_PASSWORD).toBeUndefined();
    expect(result.value.ORACLE_POOL_MIN).toBeUndefined();
    expect(result.value.ORACLE_POOL_MAX).toBeUndefined();
  });

  it("accepts ORACLE_CONNECT_STRING with ORACLE_USER + ORACLE_PASSWORD (capability wires)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
      ORACLE_USER: "pricing_app",
      ORACLE_PASSWORD: "s3cr3t",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ORACLE_CONNECT_STRING).toBe("dbhost:1521/PRICING");
    expect(result.value.ORACLE_USER).toBe("pricing_app");
    expect(result.value.ORACLE_PASSWORD).toBe("s3cr3t");
  });

  it("coerces ORACLE_POOL_MIN / ORACLE_POOL_MAX to ints when set", () => {
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
      ORACLE_USER: "pricing_app",
      ORACLE_PASSWORD: "s3cr3t",
      ORACLE_POOL_MIN: "1",
      ORACLE_POOL_MAX: "8",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ORACLE_POOL_MIN).toBe(1);
    expect(result.value.ORACLE_POOL_MAX).toBe(8);
  });

  it("rejects ORACLE_CONNECT_STRING set without ORACLE_USER (FR-040)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
      ORACLE_PASSWORD: "s3cr3t",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_USER");
  });

  it("rejects ORACLE_CONNECT_STRING set without ORACLE_PASSWORD (FR-040)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
      ORACLE_USER: "pricing_app",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_PASSWORD");
  });

  it("rejects ORACLE_CONNECT_STRING set with NEITHER user NOR password (both gated)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_USER");
    expect(result.error.message).toContain("ORACLE_PASSWORD");
  });

  it("does NOT leak ORACLE_PASSWORD in the validation error message (FR-041)", () => {
    // Genuine non-leak proof: the sentinel password is PRESENT in the input AND
    // the config goes through the error path (ORACLE_USER omitted while
    // ORACLE_CONNECT_STRING is set, plus a sibling failure on PORT) so the
    // aggregated message is actually generated. The assertion then proves the
    // secret value never appears in that message — unlike the old test, whose
    // "super-secret-value" literal was never in the input and so passed vacuously.
    const sentinel = "s3ntinel-PW-do-not-log";
    const result = parseHostConfig({
      ...validEnv,
      ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
      ORACLE_PASSWORD: sentinel,
      // ORACLE_USER omitted on purpose → triggers the gated error path.
      // A sibling failure broadens the aggregated message that must stay clean.
      PORT: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    // The error path WAS exercised (it named the missing user)…
    expect(result.error.message).toContain("ORACLE_USER");
    // …and still the sentinel secret value never surfaced.
    expect(result.error.message).not.toContain(sentinel);
  });

  // ── ORACLE_POOL_MIN ≤ ORACLE_POOL_MAX cross-field check (FR-041) ─────────────
  const oracleEnv = {
    ORACLE_CONNECT_STRING: "dbhost:1521/PRICING",
    ORACLE_USER: "pricing_app",
    ORACLE_PASSWORD: "s3cr3t",
  };

  it("rejects ORACLE_POOL_MIN greater than ORACLE_POOL_MAX (min=10, max=4)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MIN: "10",
      ORACLE_POOL_MAX: "4",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_POOL_MIN");
    expect(result.error.message).toContain("ORACLE_POOL_MAX");
  });

  it("accepts ORACLE_POOL_MIN ≤ ORACLE_POOL_MAX (min=2, max=8)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MIN: "2",
      ORACLE_POOL_MAX: "8",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ORACLE_POOL_MIN).toBe(2);
    expect(result.value.ORACLE_POOL_MAX).toBe(8);
  });

  it("accepts ORACLE_POOL_MIN of 0 (the min(0)/min(1) asymmetry)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MIN: "0",
      ORACLE_POOL_MAX: "4",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ORACLE_POOL_MIN).toBe(0);
  });

  it("rejects ORACLE_POOL_MAX of 0 (below min 1)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MAX: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_POOL_MAX");
  });

  it("rejects negative ORACLE_POOL_MIN (below min 0)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MIN: "-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_POOL_MIN");
  });

  it("rejects fractional ORACLE_POOL_MAX (must be an integer)", () => {
    const result = parseHostConfig({
      ...validEnv,
      ...oracleEnv,
      ORACLE_POOL_MAX: "2.5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("ORACLE_POOL_MAX");
  });

  it("REJECTS at boot an AGENT_CLIENT_SCOPES with a typo'd/unrecognised scope name (fails at boot, never at runtime)", () => {
    const result = parseHostConfig({
      ...validEnv,
      // `msgrpah` is a typo — caught at boot rather than fail-closing every mint.
      AGENT_CLIENT_SCOPES: JSON.stringify({ "fugue-agent-mail": ["msgrpah:mail.send"] }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    expect(result.error.message).toContain("unrecognised scope");
  });

  it("REJECTS malformed AGENT_CLIENT_SCOPES JSON", () => {
    const result = parseHostConfig({ ...validEnv, AGENT_CLIENT_SCOPES: "{not json" });
    expect(result.ok).toBe(false);
  });

  it("parses global TTL defaults (FR-040)", () => {
    const result = parseHostConfig({
      ...validEnv,
      DEFAULT_CACHE_TTL_MS: "600000",
      DEFAULT_CHECKPOINT_TTL_MS: "172800000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DEFAULT_CACHE_TTL_MS).toBe(600_000);
    expect(result.value.DEFAULT_CHECKPOINT_TTL_MS).toBe(172_800_000);
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

  it("rejects DEFAULT_DAG_TIMEOUT_MS exceeding MAX_DAG_TIMEOUT_MS", () => {
    const result = parseHostConfig({
      ...validEnv,
      DEFAULT_DAG_TIMEOUT_MS: "200000",
      MAX_DAG_TIMEOUT_MS: "100000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind === "config-invalid") {
      expect(result.error.message).toContain("DEFAULT_DAG_TIMEOUT_MS");
    }
  });

  it("accepts DEFAULT_DAG_TIMEOUT_MS equal to MAX_DAG_TIMEOUT_MS", () => {
    const result = parseHostConfig({
      ...validEnv,
      DEFAULT_DAG_TIMEOUT_MS: "60000",
      MAX_DAG_TIMEOUT_MS: "60000",
    });
    expect(result.ok).toBe(true);
  });

  // Realm JWT split-horizon JWKS pairing — REALM_JWKS_URL is a key-fetch override
  // for the realm JWT path, which is gated on REALM_JWT_ISSUER. Setting the URL
  // alone is a silent no-op (host never builds the verifier), so it is rejected at
  // boot like every other paired field, rather than being silently ignored.
  it("rejects REALM_JWKS_URL set without REALM_JWT_ISSUER (silent no-op guard)", () => {
    const result = parseHostConfig({
      ...validEnv,
      REALM_JWKS_URL: "https://keycloak.svc/realms/fugue/protocol/openid-connect/certs",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config-invalid");
    if (result.error.kind !== "config-invalid") return;
    expect(result.error.message).toContain("REALM_JWKS_URL");
    expect(result.error.message).toContain("REALM_JWT_ISSUER");
  });

  it("accepts REALM_JWKS_URL when REALM_JWT_ISSUER is also set (split-horizon JWKS)", () => {
    const result = parseHostConfig({
      ...validEnv,
      REALM_JWT_ISSUER: "https://auth.example.com/realms/fugue",
      REALM_JWKS_URL: "https://keycloak.svc/realms/fugue/protocol/openid-connect/certs",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts REALM_JWT_ISSUER alone (verifier derives the /certs JWKS endpoint)", () => {
    const result = parseHostConfig({
      ...validEnv,
      REALM_JWT_ISSUER: "https://auth.example.com/realms/fugue",
    });
    expect(result.ok).toBe(true);
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
  });

  // These mirror the constraints on DagRegistrationSchema.config — applyFugueYaml merges
  // fugue.yaml straight into the resolved config, so a zero/negative would otherwise reach
  // runtime (maxConcurrent: 0 wedges the DAG at 429; negative TTL → bad Redis expiry).
  it("rejects an empty team (drives authorization isolation)", () => {
    expect(parseFugueYaml({ team: "" }, "/dags/x/fugue.yaml").ok).toBe(false);
  });

  it("rejects zero or negative maxConcurrent", () => {
    expect(parseFugueYaml({ team: "t", maxConcurrent: 0 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", maxConcurrent: -1 }, "/dags/x/fugue.yaml").ok).toBe(false);
  });

  it("rejects non-positive TTL overrides", () => {
    expect(parseFugueYaml({ team: "t", cacheTtlMs: 0 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", checkpointTtlMs: -5 }, "/dags/x/fugue.yaml").ok).toBe(false);
  });

  it("rejects fractional maxConcurrent / TTLs (must be integers)", () => {
    expect(parseFugueYaml({ team: "t", maxConcurrent: 2.5 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", cacheTtlMs: 1.5 }, "/dags/x/fugue.yaml").ok).toBe(false);
  });

  // ── llmBudgetTokens (FR-W1-001) — the per-run budget the metered-llm decorator enforces ──
  it("parses llmBudgetTokens when present (FR-W1-001)", () => {
    const result = parseFugueYaml({ team: "t", llmBudgetTokens: 50_000 }, "/dags/x/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.llmBudgetTokens).toBe(50_000);
  });

  it("leaves llmBudgetTokens undefined when absent (FR-W1-006 — no budget, no enforcement)", () => {
    const result = parseFugueYaml({ team: "t" }, "/dags/x/fugue.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.llmBudgetTokens).toBeUndefined();
  });

  it("rejects zero, negative, fractional, and non-number llmBudgetTokens (int + positive)", () => {
    expect(parseFugueYaml({ team: "t", llmBudgetTokens: 0 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", llmBudgetTokens: -100 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", llmBudgetTokens: 1000.5 }, "/dags/x/fugue.yaml").ok).toBe(false);
    expect(parseFugueYaml({ team: "t", llmBudgetTokens: "50000" }, "/dags/x/fugue.yaml").ok).toBe(false);
  });
});
