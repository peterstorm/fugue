import { z } from "zod";
import { createTransformNode, ok } from "@ai-summary/framework";
import type { Result } from "@ai-summary/framework";
import type { FrameworkError } from "@ai-summary/framework";
import { CrmRecordSchema } from "../../schemas/crm.js";
import type { CrmRecord, Message } from "../../schemas/crm.js";
import { scoreByRecency } from "../../extraction/recency.js";
import type { ScoredConversation } from "../../extraction/recency.js";
import { selectWithinBudget } from "../tokens.js";
import { MessageSchema, ConversationSchema } from "../../schemas/crm.js";

export type ExtractionResult =
  | {
      readonly branch: "ok";
      readonly recentUtterances: readonly Message[];
      readonly scoredConversations: readonly ScoredConversation[];
    }
  | { readonly branch: "not_found" }
  | { readonly branch: "no_history" }
  | { readonly branch: "insufficient_data" };

const InputSchema = z.object({ customer: CrmRecordSchema.nullable() });
type Input = z.infer<typeof InputSchema>;

const ScoredConversationSchema = z.object({
  conversation: ConversationSchema,
  score: z.number(),
});

export const ExtractionResultSchema: z.ZodType<ExtractionResult> = z.discriminatedUnion("branch", [
  z.object({
    branch: z.literal("ok"),
    recentUtterances: z.array(MessageSchema),
    scoredConversations: z.array(ScoredConversationSchema),
  }),
  z.object({ branch: z.literal("not_found") }),
  z.object({ branch: z.literal("no_history") }),
  z.object({ branch: z.literal("insufficient_data") }),
]);

export const extractFeatures = (input: { customer: CrmRecord | null }): ExtractionResult => {
  if (input.customer === null) return { branch: "not_found" };

  const { conversations } = input.customer;
  if (conversations.length === 0) return { branch: "no_history" };

  const scored = scoreByRecency(conversations);
  const allMessages = scored.flatMap((sc) => sc.conversation.messages);
  const selected = selectWithinBudget(allMessages);

  if (selected.length < 3) return { branch: "insufficient_data" };

  return {
    branch: "ok",
    recentUtterances: selected,
    scoredConversations: scored,
  };
};

export const createExtractFeaturesNode = () =>
  createTransformNode<Input, ExtractionResult>({
    id: "extract-features",
    inputSchema: InputSchema,
    outputSchema: ExtractionResultSchema,
    deps: ["fetch-crm"],
    transform: (input): Result<ExtractionResult, FrameworkError> => ok(extractFeatures(input)),
  });
