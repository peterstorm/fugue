import { z } from "zod";
import { createLlmNode } from "@ai-summary/framework";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";
import type { Message } from "../../schemas/crm.js";

// Input is the ExtractionResult from the extract-features node — reuse the proper schema
import { ExtractionResultSchema } from "./extract-features.js";
const InputSchema = ExtractionResultSchema;

const NullableSynthesisOutputSchema = SynthesisOutputSchema.optional();

export const createSynthesizeNode = (model = "claude-sonnet-4-20250514", opts?: { thinking?: { type: "enabled"; budgetTokens: number } }) =>
  createLlmNode<ExtractionResult, z.infer<typeof NullableSynthesisOutputSchema>>({
    id: "synthesize",
    inputSchema: InputSchema,
    outputSchema: NullableSynthesisOutputSchema,
    deps: ["extract-features"],
    promptName: "synthesis",
    model,
    thinking: opts?.thinking,
    skipWhen: (input) => input.branch !== "ok",
    buildInput: (input) => {
      if (input.branch !== "ok") return {};
      return {
        customerName: "Customer",
        customerId: "unknown",
        accountType: "unknown",
        conversationCount: input.scoredConversations.length,
        conversations: formatConversations(input.recentUtterances),
      };
    },
  });

const formatConversations = (messages: readonly Message[]): string =>
  messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");
