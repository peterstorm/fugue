/**
 * Configuration schemas for the Fugue host.
 *
 * - HostConfigSchema: validates environment variables for host startup
 * - FugueYamlSchema: validates per-DAG fugue.yaml configuration
 *
 * Satisfies:
 * - FR-006: Redis URL required (host refuses to start if missing/unreachable)
 * - FR-013: Sensible defaults for all optional config fields
 * - FR-040: Global TTL defaults for cache and checkpoint entries
 * - FR-041: Per-DAG TTL overrides in fugue.yaml
 * - FR-100: fugue.yaml declares team, owner, env, limit overrides
 */

import { z } from "zod";
import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "./host-error.js";

// ---------------------------------------------------------------------------
// Host Config — parsed from environment variables
// ---------------------------------------------------------------------------

export const HostConfigSchema = z.object({
  /** Git URL for the DAGs repository */
  DAGS_REPO_URL: z.string(),
  /** Branch to track in the DAGs repo */
  DAGS_REPO_BRANCH: z.string().default("main"),
  /** Polling interval for git sync (ms) */
  DAGS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Interval for the Redis liveness probe (ms) — drives degraded/recovered transitions */
  REDIS_PROBE_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  /** Optional local path override (skips git clone, useful for dev) */
  DAGS_LOCAL_PATH: z.string().optional(),
  /** Redis connection URL — required for host to start (FR-006) */
  REDIS_URL: z.string(),
  /** HTTP port to listen on */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Maximum concurrent DAG runs across all DAGs */
  MAX_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).default(50),
  /** Default per-DAG concurrency limit when not overridden in fugue.yaml */
  DEFAULT_DAG_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** Default per-DAG timeout (ms) when not overridden in fugue.yaml */
  DEFAULT_DAG_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Maximum allowed DAG timeout regardless of per-DAG config */
  MAX_DAG_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  /** Grace period for in-flight requests during graceful shutdown */
  DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  /** LLM provider to use */
  LLM_PROVIDER: z.enum(["anthropic", "openai", "azure"]).default("anthropic"),
  /** Anthropic API key */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** OpenAI API key */
  OPENAI_API_KEY: z.string().optional(),
  /** Azure OpenAI endpoint URL */
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  /** Azure OpenAI API key */
  AZURE_OPENAI_API_KEY: z.string().optional(),
  /** Azure OpenAI deployment name */
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  /** Azure OpenAI API version (defaults to 2025-03-01-preview) */
  AZURE_OPENAI_API_VERSION: z.string().default("2025-03-01-preview"),
  /** Admin bearer token for provisioning teams and full access (required) */
  ADMIN_TOKEN: z.string().min(16),
  /** OpenTelemetry OTLP exporter endpoint */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /** MLflow tracking server URI */
  MLFLOW_TRACKING_URI: z.string().optional(),
  /** MLflow experiment ID */
  MLFLOW_EXPERIMENT_ID: z.string().optional(),
  /** Number of failures before circuit breaker opens */
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  /** Time window for circuit breaker failure counting (ms) */
  CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Default cache TTL for DAG cache entries (FR-040) */
  DEFAULT_CACHE_TTL_MS: z.coerce.number().int().min(1000).default(300_000),
  /** Default checkpoint TTL for DAG checkpoint entries (FR-040) */
  DEFAULT_CHECKPOINT_TTL_MS: z.coerce.number().int().min(1000).default(86_400_000),
}).refine(
  (c) => c.DEFAULT_DAG_TIMEOUT_MS <= c.MAX_DAG_TIMEOUT_MS,
  { message: "DEFAULT_DAG_TIMEOUT_MS must not exceed MAX_DAG_TIMEOUT_MS" },
).superRefine((c, ctx) => {
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "Required when LLM_PROVIDER is 'anthropic'" });
  }
  if (c.LLM_PROVIDER === "openai" && !c.OPENAI_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "Required when LLM_PROVIDER is 'openai'" });
  }
  if (c.LLM_PROVIDER === "azure" && (!c.AZURE_OPENAI_ENDPOINT || !c.AZURE_OPENAI_API_KEY || !c.AZURE_OPENAI_DEPLOYMENT)) {
    ctx.addIssue({ code: "custom", path: ["AZURE_OPENAI_ENDPOINT"], message: "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT required when LLM_PROVIDER is 'azure'" });
  }
});

export type HostConfig = z.infer<typeof HostConfigSchema>;

// ---------------------------------------------------------------------------
// Per-DAG config — parsed from fugue.yaml (FR-100, FR-041)
// ---------------------------------------------------------------------------

export const FugueYamlSchema = z.object({
  /** Team owning this DAG (required, non-empty — drives authorization isolation) */
  team: z.string().min(1),
  /** Individual owner within the team */
  owner: z.string().optional(),
  /** Environment variable names this DAG requires at runtime */
  env: z.array(z.string()).default([]),
  // NOTE: these numeric overrides MUST mirror the constraints on DagRegistrationSchema.config
  // (int + positive). applyFugueYaml merges them straight into the resolved DagRegistration,
  // bypassing the dag.ts schema — so a zero/negative here would otherwise reach runtime
  // (maxConcurrent: 0 wedges the DAG at 429 forever; negative TTL → bad Redis expiry).
  /** Per-DAG concurrency limit override */
  maxConcurrent: z.number().int().positive().optional(),
  /** Per-DAG timeout override (ms) */
  timeoutMs: z.number().int().positive().optional(),
  /** Custom route path override (defaults to DAG ID) */
  route: z.string().optional(),
  /** Per-DAG cache TTL override (FR-041) */
  cacheTtlMs: z.number().int().positive().optional(),
  /** Per-DAG checkpoint TTL override (FR-041) */
  checkpointTtlMs: z.number().int().positive().optional(),
});

export type FugueYaml = z.infer<typeof FugueYamlSchema>;

// ---------------------------------------------------------------------------
// Parse functions — return Result, never throw (functional core)
// ---------------------------------------------------------------------------

/**
 * Parse and validate host configuration from environment variables.
 * Returns Result with config-invalid HostError on failure.
 */
export const parseHostConfig = (env: Record<string, string | undefined>): Result<HostConfig, HostError> => {
  const result = HostConfigSchema.safeParse(env);
  if (result.success) {
    return ok(result.data);
  }
  const message = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return err({ kind: "config-invalid", message });
};

/**
 * Parse and validate a fugue.yaml file content.
 * Returns Result with validation-failed HostError on failure.
 */
export const parseFugueYaml = (
  data: unknown,
  path: string,
): Result<FugueYaml, HostError> => {
  const result = FugueYamlSchema.safeParse(data);
  if (result.success) {
    return ok(result.data);
  }
  return err({ kind: "validation-failed", path, issues: result.error.issues });
};
