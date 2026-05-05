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
  ENABLE_THINKING: z.string().default("false").transform((v) => v === "true" || v === "1"),
  THINKING_BUDGET_TOKENS: z.coerce.number().default(4096),
  FIXTURES_DIR: z.string().default("./fixtures/customers"),
  PROMPTS_DIR: z.string().default("./prompts"),
});

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (): Config => ConfigSchema.parse(process.env);

/** Default model per provider */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  azure: "gpt-4o", // Azure uses deployment name, not model name — override with LLM_MODEL or AZURE_OPENAI_DEPLOYMENT
};
