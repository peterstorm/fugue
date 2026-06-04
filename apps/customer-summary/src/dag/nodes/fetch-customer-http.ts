/**
 * fetch-customer node using the http capability (ADR-0051).
 *
 * This demonstrates how a real production node would fetch customer data
 * from a CRM API using the built-in http capability instead of a manually
 * injected source port.
 *
 * The node:
 * - Declares `requires: ["http"]` to get typed access to `ctx.http`
 * - Calls the CRM API endpoint with schema-validated response
 * - Emits a freshness witness for stale-read detection
 * - Returns Result (no exceptions)
 *
 * This replaces the source-injection pattern when your data comes from
 * an HTTP API. For database-backed data, use `requires: ["db"]` with
 * the @fuguejs/pg adapter instead.
 */

import { z } from "zod";
import { createFetchNode, ok, err, witness, resourceName } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { CrmRecordSchema } from "../../schemas/crm.js";

const InputSchema = z.object({ customerId: z.string() });
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({ customer: CrmRecordSchema.nullable() });
type Output = z.infer<typeof OutputSchema>;

/**
 * Fetch customer node that uses the framework's http capability.
 *
 * Unlike the source-injected version, this node:
 * - Gets its HTTP client from the framework's capability system
 * - Is validated at DAG start (missing http capability = immediate error)
 * - Benefits from automatic OTel tracing (if withTracedCapability is used)
 * - Works with the fake http capability in tests
 *
 * @param crmBaseUrl - Base URL of the CRM API (e.g., "https://crm.example.com/api/v1")
 */
export const createHttpFetchCustomerNode = (crmBaseUrl: string) =>
  createFetchNode({
    id: "fetch-crm",
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    requires: ["http"] as const,
    sideEffects: {
      kind: "reads",
      resource: resourceName("crm:customers"),
      extractWitness: (output) => {
        const o = output as Output;
        return witness(
          "version",
          "crm:customers",
          o.customer
            ? `${o.customer.createdAt}:${o.customer.conversations.length}`
            : "not-found",
        );
      },
    },
    fetch: async (input, ctx): Promise<Result<Output, FrameworkError>> => {
      // The ctx.http is typed and guaranteed non-null thanks to requires: ["http"]
      const result = await ctx.http.get(
        `${crmBaseUrl}/customers/${input.customerId}`,
        { schema: CrmRecordSchema },
      );

      if (!result.ok) {
        // HTTP 404 → customer not found (not an error, just null).
        // Branch on the structured status — message text can contain "404"
        // in a body for entirely unrelated reasons.
        if (result.error.kind === "transient" && result.error.httpStatus === 404) {
          return ok({ customer: null });
        }
        return result as Result<never, FrameworkError>;
      }

      return ok({ customer: result.value });
    },
  });
