import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MLFLOW_TRACKING_URI: z.string().default("http://localhost:5000"),
  MLFLOW_EXPERIMENT_ID: z.string().default("0"),
  LLM_PROVIDER: z.enum(["anthropic", "openai", "azure"]).default("anthropic"),
  LLM_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().default("2025-04-01-preview"),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  EVAL_JUDGE_MODEL: z.string().optional(),
  // PII gate: include LLM prompts/outputs/thinking and node inputs/outputs in OTel traces.
  // Default off — enable only in environments where trace storage handles PII appropriately.
  LLM_TRACE_PROMPTS: z.string().default("false").transform((v) => v === "true" || v === "1"),
  ENABLE_THINKING: z.string().default("false").transform((v) => v === "true" || v === "1"),
  THINKING_BUDGET_TOKENS: z.coerce.number().default(4096),
  FIXTURES_DIR: z.string().default("./fixtures/customers"),
  PROMPTS_DIR: z.string().default("./prompts"),
  // Tail-sampling fallback ratio. errorOnly + hadRetry policies still apply;
  // this gates the residual probability for traces that match neither. 1.0
  // persists everything (dev only); 0.1 = 10% sampling for production.
  TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),

  // ── Observability backend selection (FR-001 … FR-006, FR-022, FR-023) ──────
  //
  // Trace backend(s), comma-separated. One = exclusive, two = dual export
  // (FR-002). MLflow is the DEFAULT so behavior is identical to the current
  // setup when nothing is configured (FR-003). Validated against the known
  // set {mlflow, foundry}; unknown tokens, blank entries, and duplicates are
  // rejected at startup (fail-closed, FR-006) rather than silently ignored.
  // Parsed into a frozen, deduped, order-preserving tuple of TraceBackend.
  OBSERVABILITY_TRACE_BACKENDS: z
    .string()
    .default("mlflow")
    .transform((raw, ctx) => {
      const tokens = raw.split(",").map((t) => t.trim());
      const seen = new Set<string>();
      const backends: TraceBackend[] = [];
      for (const token of tokens) {
        if (token === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "OBSERVABILITY_TRACE_BACKENDS contains a blank entry; expected a comma-separated list of mlflow|foundry.",
          });
          return z.NEVER;
        }
        if (token !== "mlflow" && token !== "foundry") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `OBSERVABILITY_TRACE_BACKENDS has unknown backend "${token}"; expected mlflow|foundry.`,
          });
          return z.NEVER;
        }
        if (seen.has(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `OBSERVABILITY_TRACE_BACKENDS has duplicate backend "${token}".`,
          });
          return z.NEVER;
        }
        seen.add(token);
        backends.push(token);
      }
      if (backends.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OBSERVABILITY_TRACE_BACKENDS resolved to an empty selection.",
        });
        return z.NEVER;
      }
      // Non-empty by construction: the `backends.length === 0` guard above
      // returns `z.NEVER`, so the cast to the non-empty tuple is honest.
      return Object.freeze(backends) as TraceBackends;
    }),

  // Application Insights connection string (FR-022). Optional at the schema
  // level because it is only REQUIRED when foundry is selected; the cross-field
  // refinement below enforces that. Blank string is normalized to undefined so
  // `APPLICATIONINSIGHTS_CONNECTION_STRING=` (set-but-empty) is treated as absent.
  APPLICATIONINSIGHTS_CONNECTION_STRING: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v : undefined)),

  // Auth mode for the Foundry (Application Insights) exporter.
  // Default = connection-string (FR-022); entra-id is opt-in (FR-023) and uses
  // the default Azure credential mechanism downstream.
  AZURE_AUTH_MODE: z.enum(["connection-string", "entra-id"]).default("connection-string"),

  // Eval backend selector (FR-004/FR-005). MLflow is the default eval backend.
  // "both" runs evals against MLflow and Foundry. The eval CLI selector consumes
  // this key; here we only add the key + validation.
  EVAL_BACKEND: z.enum(["mlflow", "foundry", "both"]).default("mlflow"),
})
  // ── Cross-field, fail-closed validation at STARTUP (FR-006) ────────────────
  //
  // When foundry is selected as a trace backend it MUST have usable auth.
  // The Azure Monitor SDK needs the Application Insights connection string to
  // carry the ingestion endpoint EVEN under Entra ID — so the
  // connection string is required for BOTH auth modes once foundry is on. A
  // foundry selection with no connection string is contradictory config and is
  // reported clearly here rather than failing silently at export time.
  .superRefine((cfg, ctx) => {
    const foundrySelected = cfg.OBSERVABILITY_TRACE_BACKENDS.includes("foundry");
    if (foundrySelected && cfg.APPLICATIONINSIGHTS_CONNECTION_STRING === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
        message:
          "OBSERVABILITY_TRACE_BACKENDS selects 'foundry' but APPLICATIONINSIGHTS_CONNECTION_STRING is not set. " +
          "The Application Insights connection string is required for both connection-string and entra-id auth modes " +
          "(it carries the ingestion endpoint). Set it, or remove 'foundry' from OBSERVABILITY_TRACE_BACKENDS.",
      });
    }
  });

/** A selectable trace backend. One = exclusive export, two = dual export (FR-002). */
export type TraceBackend = "mlflow" | "foundry";

/**
 * A resolved trace-backend selection: NON-EMPTY, deduped, order-preserving. The
 * non-emptiness is PROVEN at the parse boundary (the transform rejects an empty
 * selection with `z.NEVER`) and carried in the type so downstream consumers
 * (`ResolvedObservability`, `composeObservability`) never re-assert it.
 */
export type TraceBackends = readonly [TraceBackend, ...TraceBackend[]];

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (): Config => ConfigSchema.parse(process.env);

/** Default model per provider */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  azure: "gpt-4o", // Azure uses deployment name, not model name — override with LLM_MODEL or AZURE_OPENAI_DEPLOYMENT
};
