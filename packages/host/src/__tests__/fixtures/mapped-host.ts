import { z } from "zod";
import { dagId, gitSha, noopTracer, ok, tokensOnly } from "@fuguejs/framework";
import type { DagDef, LlmClient } from "@fuguejs/framework";
import type { RegisteredDag } from "../../domain/registry.js";
import type { RedisPort, SharedInfra } from "../../ports.js";
import { markTeam } from "../../domain/auth.js";
import { createInMemorySpendLedger } from "../../adapters/spend-ledger-memory.js";
import { tenantId } from "../../domain/tenant.js";

export const mappedTestTenant = (name: string) => {
  const parsed = tenantId(name);
  if (!parsed.ok) throw new Error("Invalid acceptance tenant");
  return parsed.value;
};

export const CHECKPOINT_TTL_SEC = 120;
export const RUN_RETENTION_SEC = 240;
export const mappedHostInfra = (redis: RedisPort, llm: LlmClient = {
  sendStructured: async (req) => ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }),
  sendWithTools: async (req) => ok({ output: req.schema.parse(7), rawText: "7", ...tokensOnly(10, 5) }),
}): SharedInfra => ({
  redis, llm, llmPricingModel: { kind: "request" },
  spendLedger: createInMemorySpendLedger(), tracer: noopTracer,
  contentFilter: null, prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} }, capabilities: [],
});

export const registeredMapDag = (dag: DagDef, tenant: string): RegisteredDag => ({
  id: dagId(dag.id), team: markTeam(tenant), dag, inputSchema: z.unknown(),
  route: `/dags/${dag.id}/run`,
  config: { timeout: 60_000, maxConcurrency: 1, cacheTtlMs: CHECKPOINT_TTL_SEC * 1000, checkpointTtlMs: CHECKPOINT_TTL_SEC * 1000 },
  meta: { description: "mapped host acceptance", version: "1" },
  loadedAt: 1, sha: gitSha("abc1234"), status: { kind: "healthy" },
  modulePath: import.meta.path, prompts: new Map([["root-prompt", "root-owned"]]),
});
