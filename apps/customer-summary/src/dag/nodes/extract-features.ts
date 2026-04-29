import { z } from "zod";
import { createTransformNode, ok } from "@ai-summary/framework";
import type { Result } from "@ai-summary/framework";
import type { FrameworkError } from "@ai-summary/framework";
import { CrmRecordSchema } from "../../schemas/crm.js";
import type { CrmRecord, Message } from "../../schemas/crm.js";
import { scoreByRecency } from "../../extraction/recency.js";
import type { ScoredConversation } from "../../extraction/recency.js";
import { selectWithinBudget } from "../tokens.js";

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

const ExtractionResultSchema: z.ZodType<ExtractionResult> = z.any();

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
