import type { Result, FrameworkError } from "@ai-summary/framework";
import type { CrmRecord } from "../schemas/crm.js";

/** Port: fetch a customer's CRM record by ID. null = not found. */
export interface ConversationSource {
  fetchCustomer(customerId: string): Promise<Result<CrmRecord | null, FrameworkError>>;
}
