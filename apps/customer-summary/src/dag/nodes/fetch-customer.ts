import { z } from "zod";
import { createFetchNode, ok, err, witnessValue, resourceName } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";
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
    sideEffects: {
      kind: "reads",
      resource: resourceName("crm:customers"),
      // Emit a freshness witness from the CRM record's createdAt field and
      // conversation count. Downstream writes (if any) can condition on this
      // witness to detect stale-read → write hazards. When customer is null
      // (not found), the witness value is "not-found". The framework stamps
      // the `resource` above, so we supply only (kind, value).
      extractWitness: (output) => {
        const o = output as Output;
        return witnessValue(
          "version",
          o.customer
            ? `${o.customer.createdAt}:${o.customer.conversations.length}`
            : "not-found",
        );
      },
    },
    fetch: async (input, _ctx): Promise<Result<Output, FrameworkError>> => {
      const result = await source.fetchCustomer(input.customerId);
      if (!result.ok) return result;
      return ok({ customer: result.value });
    },
  });
