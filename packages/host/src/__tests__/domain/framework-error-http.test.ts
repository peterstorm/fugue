/**
 * Tests for the framework-error → HTTP classifier (review I4).
 *
 * Pins the status + circuit-breaker decision per error kind: a settled
 * authorization "no" (403) and a usage limit (429) must NOT count as circuit
 * failures; genuine execution (500) and transient infra (503) failures must.
 */

import { describe, it, expect } from "bun:test";
import type { FrameworkError } from "@fuguejs/framework";
import { classifyFrameworkError } from "../../domain/framework-error-http.js";

describe("classifyFrameworkError", () => {
  it("policy-refusal → 403, does NOT trip the circuit (settled authz no)", () => {
    const e: FrameworkError = { kind: "policy-refusal", scope: "msgraph:mail.send", agentClientId: "agent-x" };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(403);
    expect(c.countsAsCircuitFailure).toBe(false);
  });

  it("downstream-denied → 403, does NOT trip the circuit", () => {
    const e: FrameworkError = { kind: "downstream-denied", resource: "https://graph.microsoft.com", reason: "FIC mismatch" };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(403);
    expect(c.countsAsCircuitFailure).toBe(false);
  });

  it("llm-budget-exceeded → 429 with Retry-After, does NOT trip the circuit", () => {
    const e: FrameworkError = { kind: "llm-budget-exceeded", runId: "r" as never, nodeId: "n" as never, cumulative: 10, budget: 5 };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(429);
    expect(c.countsAsCircuitFailure).toBe(false);
    expect(c.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("infra-unreachable → 503 with Retry-After, DOES trip the circuit (real infra signal)", () => {
    const e: FrameworkError = { kind: "infra-unreachable", operation: "entra-wif", message: "ECONNREFUSED" };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(503);
    expect(c.countsAsCircuitFailure).toBe(true);
    expect(c.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a genuine execution failure (node-crash) → 500, DOES trip the circuit", () => {
    const e: FrameworkError = { kind: "node-crash", nodeId: "n" as never, retriability: "retriable", message: "boom" };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(500);
    expect(c.countsAsCircuitFailure).toBe(true);
  });

  it("validation → 500, DOES trip the circuit", () => {
    const e: FrameworkError = { kind: "validation", nodeId: "n" as never, message: "bad" };
    const c = classifyFrameworkError(e);
    expect(c.status).toBe(500);
    expect(c.countsAsCircuitFailure).toBe(true);
  });

  // retry-exhausted is the DAG retry machinery's wrapper — the kind that matters
  // for the client is `rootErrorKind`. Settled kinds fast-fail unwrapped in the
  // framework, so the wrapped cases here are defense-in-depth: a wrapped settled
  // "no" must never regress to 500 + breaker trip.
  describe("retry-exhausted unwraps rootErrorKind", () => {
    const wrapped = (rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">): FrameworkError => ({
      kind: "retry-exhausted",
      nodeId: "n" as never,
      attempts: 3,
      lastError: "…",
      rootErrorKind,
    });

    it("rooted in infra-unreachable → 503 (an outage that exhausted retries is still an outage), trips the circuit", () => {
      const c = classifyFrameworkError(wrapped("infra-unreachable"));
      expect(c.status).toBe(503);
      expect(c.countsAsCircuitFailure).toBe(true);
    });

    it("rooted in policy-refusal → 403, does NOT trip the circuit", () => {
      const c = classifyFrameworkError(wrapped("policy-refusal"));
      expect(c.status).toBe(403);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("rooted in downstream-denied → 403, does NOT trip the circuit", () => {
      const c = classifyFrameworkError(wrapped("downstream-denied"));
      expect(c.status).toBe(403);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("rooted in llm-budget-exceeded → 429, does NOT trip the circuit", () => {
      const c = classifyFrameworkError(wrapped("llm-budget-exceeded"));
      expect(c.status).toBe(429);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("rooted in a genuine execution failure (transient) → 500, trips the circuit", () => {
      const c = classifyFrameworkError(wrapped("transient"));
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
    });
  });
});
