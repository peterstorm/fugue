/**
 * Worked example: an LLM node that uses `sendWithTools` to let the model
 * call a CRM lookup tool mid-completion. Not wired into the production DAG
 * — it's here as a reference for how `LlmClient.sendWithTools` is meant to
 * be used. See `docs/library-ux.md` §7 and ADR 0012.
 */
import { z } from "zod";
import {
  createLlmWithToolsNode,
  type FrameworkError,
  type NodeDef,
  type ToolDef,
} from "@ai-summary/framework";
import type { CrmRecord } from "../../schemas/crm.js";

// --- Tool definition ---------------------------------------------------------

interface DealsClient {
  byCustomer: (
    customerId: string,
    limit: number,
  ) => Promise<Array<{ id: string; amount: number; closedAt: string }>>;
}

const makeLookupDealsTool = (
  deals: DealsClient,
): ToolDef<
  { customerId: string; limit?: number },
  { deals: Array<{ id: string; amount: number; closedAt: string }> }
> => ({
  name: "lookup_deals_by_customer",
  description: "Fetch closed deals for a customer (most recent first).",
  inputSchema: z.object({
    customerId: z.string(),
    limit: z.number().int().positive().max(50).default(20),
  }),
  outputSchema: z.object({
    deals: z.array(
      z.object({
        id: z.string(),
        amount: z.number(),
        closedAt: z.string(),
      }),
    ),
  }),
  run: async ({ customerId, limit }, ctx) => {
    // Memoize: the loop runs at-least-once per node retry. Without ctx.cache,
    // a node-level retry replays every tool call against the source of truth.
    const cacheKey = `crm:deals:${customerId}:${limit}`;
    const cached = (await ctx.cache?.get(cacheKey)) as
      | { deals: Array<{ id: string; amount: number; closedAt: string }> }
      | null;
    if (cached) return cached;

    const result = { deals: await deals.byCustomer(customerId, limit ?? 20) };
    if (ctx.cache?.set) {
      const setResult = await ctx.cache.set(cacheKey, result, 300);
      if (!setResult.ok) {
        const logger = ctx.logger?.warn ?? console.warn;
        logger(`[lookup_deals_by_customer] cache write failed for ${cacheKey}: ${setResult.error.kind === "cache-error" ? setResult.error.message : String(setResult.error)}`);
      }
    }
    return result;
  },
});

// --- Node --------------------------------------------------------------------

const InputSchema = z.object({
  customer: z.object({
    customerId: z.string(),
    name: z.string(),
  }),
});

const EnrichedSummarySchema = z.object({
  summary: z.string(),
  totalDealValue: z.number(),
  dealCount: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof EnrichedSummarySchema>;

export const createEnrichWithToolsNode = (
  deals: DealsClient,
  model = "claude-sonnet-4-5",
): NodeDef<Input, Output, FrameworkError> => {
  const lookupDealsTool = makeLookupDealsTool(deals);

  return createLlmWithToolsNode<Input, Output>({
    id: "enrich-with-tools",
    inputSchema: InputSchema,
    outputSchema: EnrichedSummarySchema,
    model,
    tools: [lookupDealsTool as ToolDef<unknown, unknown>],
    maxIterations: 5,
    system:
      "You are a CRM analyst. Use the lookup_deals_by_customer tool to gather " +
      "closed deals before composing a summary. Always cite the deal IDs you used.",
    buildUser: (input) =>
      `Customer ID: ${input.customer.customerId}\n` +
      `Customer name: ${input.customer.name}\n\n` +
      "Compose a one-paragraph summary highlighting their deal " +
      "activity over the last 12 months.",
  });
};

// --- Helpers used in tests / docs (kept exported for the example test) -------

export const __forExample = {
  makeLookupDealsTool,
  EnrichedSummarySchema,
};

// Suppress unused import warnings for reference types.
export type _Reference = CrmRecord;
