/**
 * Witness-extraction tests for the source-injected fetch-customer node.
 *
 * Mirrors the freshness assertions in fetch-customer-http.test.ts: the two
 * nodes carry identical `witnessValue("version", …)` / "not-found" logic, so
 * both must be pinned. The extractor is tested in isolation — it never touches
 * the injected source, so a trivial stub source is sufficient.
 */

import { describe, it, expect } from "bun:test";
import { ok, witnessValue } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { createFetchCustomerNode } from "../dag/nodes/fetch-customer.js";
import type { ConversationSource } from "../sources/conversation-source.js";
import type { CrmRecord } from "../schemas/crm.js";

const sampleCustomer = {
  customerId: "cust-001",
  name: "Acme Corp",
  accountType: "business",
  createdAt: "2024-01-15T10:00:00Z",
  conversations: [
    {
      id: "conv-1",
      date: "2024-06-01",
      channel: "email",
      messages: [
        { role: "customer", content: "I have a question about my invoice.", timestamp: "2024-06-01T14:30:00Z" },
        { role: "agent", content: "I'd be happy to help.", timestamp: "2024-06-01T14:32:00Z" },
      ],
    },
  ],
} satisfies CrmRecord;

// The extractor never calls the source; a stub that satisfies the port is enough.
const stubSource: ConversationSource = {
  fetchCustomer: async (): Promise<Result<CrmRecord | null, FrameworkError>> => ok(null),
};

describe("fetch-customer (source-injected) freshness witness", () => {
  it("emits a version witness encoding createdAt + conversation count", () => {
    const node = createFetchCustomerNode(stubSource);
    const se = node.sideEffects;
    expect(se.kind).toBe("reads");
    if (se.kind !== "reads") return;
    // Resource-free: the extractor yields (kind, value); the framework stamps
    // se.resource ("crm:customers") at emission time.
    const w = se.extractWitness?.({ customer: sampleCustomer });
    expect(w).toEqual(
      witnessValue(
        "version",
        `${sampleCustomer.createdAt}:${sampleCustomer.conversations.length}`,
      ),
    );
  });

  it("emits a 'not-found' witness sentinel when the customer is null", () => {
    const node = createFetchCustomerNode(stubSource);
    const se = node.sideEffects;
    expect(se.kind).toBe("reads");
    if (se.kind !== "reads") return;
    const w = se.extractWitness?.({ customer: null });
    expect(w).toEqual(witnessValue("version", "not-found"));
  });
});
