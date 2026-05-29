import { z } from "zod";
import { createLlmNode } from "@fugue/framework";
import type { LlmNodeDef } from "@fugue/framework";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";
import type { Message } from "../../schemas/crm.js";

// Input is the ExtractionResult from the extract-features node — reuse the proper schema
import { ExtractionResultSchema } from "./extract-features.js";
const InputSchema = ExtractionResultSchema;

const NullableSynthesisOutputSchema = SynthesisOutputSchema.optional();

// No freshness extractor: LLM synthesis is non-deterministic — no meaningful
// freshness signal to capture. The grounding guardrail validates factual
// consistency instead. sideEffects defaults to { kind: "external-call" } via
// createLlmNode.
export const createSynthesizeNode = (
  model = "claude-sonnet-4-20250514",
  opts?: { thinking?: { type: "enabled"; budgetTokens: number }; systemPrompt?: string },
): LlmNodeDef<ExtractionResult, z.infer<typeof NullableSynthesisOutputSchema>> =>
  createLlmNode<ExtractionResult, z.infer<typeof NullableSynthesisOutputSchema>>({
    id: "synthesize",
    inputSchema: InputSchema,
    outputSchema: NullableSynthesisOutputSchema,
    promptName: "synthesis",
    model,
    thinking: opts?.thinking,
    system: opts?.systemPrompt,
    skipWhen: (input) => input.branch !== "ok",
    skipDefault: undefined,
    buildInput: (input) => {
      if (input.branch !== "ok") return {};
      return {
        customerName: input.customer.name,
        customerId: input.customer.id,
        accountType: input.customer.accountType,
        conversationCount: input.scoredConversations.length,
        conversations: formatConversations(input.recentUtterances),
      };
    },
  });

const formatConversations = (messages: readonly Message[]): string =>
  messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");
