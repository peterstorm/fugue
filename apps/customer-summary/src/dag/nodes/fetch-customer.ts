import { z } from "zod";
import { createFetchNode, ok, err } from "@ai-summary/framework";
import type { Result, FrameworkError } from "@ai-summary/framework";
import { CrmRecordSchema } from "../../schemas/crm.js";
import type { CrmRecord } from "../../schemas/crm.js";
import type { ConversationSource } from "../../sources/conversation-source.js";

const InputSchema = z.object({ customerId: z.string() });
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({ customer: CrmRecordSchema.nullable() });
type Output = z.infer<typeof OutputSchema>;

export const createFetchCustomerNode = (source: ConversationSource) =>
  createFetchNode<Input, Output>({
    id: "fetch-crm",
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fetch: async (input, _ctx): Promise<Result<Output, FrameworkError>> => {
      const result = await source.fetchCustomer(input.customerId);
      if (!result.ok) return result;
      return ok({ customer: result.value });
    },
  });
