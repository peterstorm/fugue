/**
 * Test demonstrating the http-capability-based fetch-customer node.
 *
 * Uses createFakeHttpCapability to test without a real CRM server.
 */

import { describe, it, expect } from "bun:test";
import { isOk, isErr, makeNodeContext, witness } from "@fuguejs/framework";
import { createFakeHttpCapability } from "@fuguejs/framework/testing";
import { createHttpFetchCustomerNode } from "../dag/nodes/fetch-customer-http.js";
import type { CrmRecord } from "../schemas/crm.js";

// The node's `run` expects a TypedNodeContext<["http"]> (non-null `http`).
// `makeNodeContext` returns the nullable runtime shape; in production the
// capability validator performs this narrowing, so the cast mirrors it.
type FetchCustomerCtx = Parameters<ReturnType<typeof createHttpFetchCustomerNode>["run"]>[1];

// Sample CRM response matching the CrmRecordSchema
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

describe("fetch-customer-http (capability-based)", () => {
  it("fetches customer via http capability", async () => {
    const fakeHttp = createFakeHttpCapability({
      "GET https://crm.example.com/api/v1/customers/cust-001": sampleCustomer,
    });

    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");

    const ctx = makeNodeContext({
      runId: "test-run",
      dagId: "test-dag",
      http: fakeHttp.client,
    });

    const result = await node.run({ customerId: "cust-001" }, ctx as FetchCustomerCtx);
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.customer).not.toBeNull();
      expect(result.value.customer?.name).toBe("Acme Corp");
    }
  });

  it("returns null customer for HTTP 404", async () => {
    const fakeHttp = createFakeHttpCapability({
      "GET https://crm.example.com/api/v1/customers/cust-999": { status: 404, body: "Not Found" },
    });

    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");

    const ctx = makeNodeContext({
      runId: "test-run",
      dagId: "test-dag",
      http: fakeHttp.client,
    });

    // A 404 means "customer does not exist" — the node maps it to a
    // successful null, not an error.
    const result = await node.run({ customerId: "cust-999" }, ctx as FetchCustomerCtx);
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.customer).toBeNull();
    }
  });

  it("propagates non-404 failures as errors (does not mask them as not-found)", async () => {
    const fakeHttp = createFakeHttpCapability({
      // A 500 whose body happens to contain "404" must NOT be treated as not-found.
      "GET https://crm.example.com/api/v1/customers/cust-500": { status: 500, body: "upstream error id 404" },
    });

    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");

    const ctx = makeNodeContext({
      runId: "test-run",
      dagId: "test-dag",
      http: fakeHttp.client,
    });

    const result = await node.run({ customerId: "cust-500" }, ctx as FetchCustomerCtx);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("transient");
      expect(result.error.kind === "transient" && result.error.httpStatus).toBe(500);
    }
  });

  it("unreachable endpoint (no route) is an error, not a null customer", async () => {
    const fakeHttp = createFakeHttpCapability({});

    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");

    const ctx = makeNodeContext({
      runId: "test-run",
      dagId: "test-dag",
      http: fakeHttp.client,
    });

    const result = await node.run({ customerId: "cust-999" }, ctx as FetchCustomerCtx);
    expect(isErr(result)).toBe(true);
  });

  it("node declares http capability requirement", () => {
    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");
    expect(node.requires).toEqual(["http"]);
    expect(node.kind).toBe("fetch");
  });

  it("emits a version witness encoding createdAt + conversation count", () => {
    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");
    const se = node.sideEffects;
    expect(se.kind).toBe("reads");
    if (se.kind !== "reads") return;
    const w = se.extractWitness?.({ customer: sampleCustomer });
    expect(w).toEqual(
      witness(
        "version",
        "crm:customers",
        `${sampleCustomer.createdAt}:${sampleCustomer.conversations.length}`,
      ),
    );
  });

  it("emits a 'not-found' witness sentinel when the customer is null", () => {
    const node = createHttpFetchCustomerNode("https://crm.example.com/api/v1");
    const se = node.sideEffects;
    expect(se.kind).toBe("reads");
    if (se.kind !== "reads") return;
    const w = se.extractWitness?.({ customer: null });
    expect(w).toEqual(witness("version", "crm:customers", "not-found"));
  });
});
