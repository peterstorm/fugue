/**
 * Host Migration Tests — validates the DagRegistration export shape
 * is correct and compatible with the Fugue host contract.
 *
 * @satisfies host spec SC-004 — DagRegistration validates correctly
 * @satisfies host spec FR-011 — Custom route override (/summarize)
 */

import { describe, test, expect } from "bun:test";
import registration, { SummarizeInputSchema } from "../dag-registration.js";
import {
  DagRegistrationSchema,
  validateDagRegistration,
  resolveDefaults,
} from "@fuguejs/host/contract";

// ---------------------------------------------------------------------------
// DagRegistration shape validation
// ---------------------------------------------------------------------------

describe("DagRegistration export", () => {
  test("default export is a valid DagRegistration", () => {
    const result = DagRegistrationSchema.safeParse(registration);
    expect(result.success).toBe(true);
  });

  test("validateDagRegistration returns Ok for the export", () => {
    const result = validateDagRegistration(registration);
    expect(result.ok).toBe(true);
  });

  test("dag.id is 'customer-summary'", () => {
    expect((registration.dag as unknown as { id: string }).id).toBe("customer-summary");
  });

  test("route override is /summarize for backward compatibility", () => {
    expect(registration.route).toBe("/summarize");
  });

  test("config specifies timeoutMs", () => {
    expect(registration.config?.timeoutMs).toBe(90_000);
  });

  test("config specifies maxConcurrent", () => {
    expect(registration.config?.maxConcurrent).toBe(5);
  });

  test("meta contains description and version", () => {
    expect(registration.meta?.description).toBeDefined();
    expect(registration.meta?.version).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// resolveDefaults integration
// ---------------------------------------------------------------------------

describe("resolveDefaults with customer-summary registration", () => {
  test("preserves custom route (does not default to /dags/customer-summary/run)", () => {
    const resolved = resolveDefaults(registration);
    expect(resolved.route).toBe("/summarize");
  });

  test("preserves config values", () => {
    const resolved = resolveDefaults(registration);
    expect(resolved.config.timeoutMs).toBe(90_000);
    expect(resolved.config.maxConcurrent).toBe(5);
  });

  test("preserves meta values", () => {
    const resolved = resolveDefaults(registration);
    expect(resolved.meta.version).toBe("1.0.0");
    expect(resolved.meta.description).toContain("Customer summary");
  });
});

// ---------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------

describe("SummarizeInputSchema", () => {
  test("accepts the standalone customer_id wire shape and parses domain customerId", () => {
    const result = SummarizeInputSchema.safeParse({ customer_id: "cust-123" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ customerId: "cust-123" });
  });

  test("rejects empty customer_id", () => {
    const result = SummarizeInputSchema.safeParse({ customer_id: "" });
    expect(result.success).toBe(false);
  });

  test("rejects missing customer_id", () => {
    const result = SummarizeInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects camel-case wire input instead of silently diverging from server.ts", () => {
    expect(SummarizeInputSchema.safeParse({ customerId: "cust-123" }).success).toBe(false);
  });

  test("accepts optional resume_run_id", () => {
    const result = SummarizeInputSchema.safeParse({
      customer_id: "cust-123",
      resume_run_id: "run-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ customerId: "cust-123", resume_run_id: "run-abc" });
    }
  });

  test("accepts payload without resume_run_id", () => {
    const result = SummarizeInputSchema.safeParse({ customer_id: "cust-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resume_run_id).toBeUndefined();
    }
  });

  test("inputSchema on registration is a Zod schema with .parse", () => {
    expect(typeof registration.inputSchema.parse).toBe("function");
  });

  test("registration inputSchema performs the same wire-to-domain parse", () => {
    const parsed = registration.inputSchema.parse({ customer_id: "test-id" });
    expect(parsed).toEqual({ customerId: "test-id" });
  });
});
