import { z } from "zod";
import { createLlmNode } from "@ai-summary/framework";
import { SynthesisOutputSchema } from "../../schemas/summary.js";
import type { ExtractionResult } from "./extract-features.js";
import type { Message } from "../../schemas/crm.js";

// Input is the ExtractionResult from the extract-features node
const InputSchema: z.ZodType<ExtractionResult> = z.any();

const NullableSynthesisOutputSchema = SynthesisOutputSchema.optional();

export const createSynthesizeNode = (model = "claude-sonnet-4-20250514") =>
  createLlmNode<ExtractionResult, z.infer<typeof NullableSynthesisOutputSchema>>({
    id: "synthesize",
    inputSchema: InputSchema,
    outputSchema: NullableSynthesisOutputSchema,
    deps: ["extract-features"],
    promptName: "synthesis",
    model,
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
