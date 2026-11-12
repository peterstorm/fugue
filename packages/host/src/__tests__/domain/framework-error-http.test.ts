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
    const e: FrameworkError = { kind: "infra-unreachable", operation: "federation", hop: "entra-wif", message: "ECONNREFUSED" };
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

  // The two kinds F1 PR-B added to EXECUTION_FAILURE_KINDS. The source comment
  // argues for placing them there BECAUSE they are deterministic and
  // caller-data-shaped, "classified alongside `validation` — its closest
  // sibling"; these pin the conclusion that argument reaches, so a later
  // reclassification has to change a test rather than only a comment. Both are
  // asserted to match `validation` exactly, since "they move together" is the
  // stated contract.
  for (const [label, error] of [
    ["map-width-invalid", {
      kind: "map-width-invalid", nodeId: "n" as never, widthFrom: "items", found: "3",
    }],
    ["map-width-exceeded", {
      kind: "map-width-exceeded", nodeId: "n" as never, resolvedWidth: 26, maxWidth: 25,
    }],
  ] as const satisfies readonly (readonly [string, FrameworkError])[]) {
    it(`${label} → 500, DOES trip the circuit (classified with validation)`, () => {
      const c = classifyFrameworkError(error);
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
      // Not a settled denial and not a usage limit: no Retry-After, because a
      // retry re-reads the same upstream value and reproduces the verdict.
      expect(c.retryAfterSeconds).toBeUndefined();

      const validation = classifyFrameworkError({
        kind: "validation", nodeId: "n" as never, message: "bad",
      });
      expect(c.status).toBe(validation.status);
      expect(c.countsAsCircuitFailure).toBe(validation.countsAsCircuitFailure);
    });
  }

  describe("fan errors (F1 PR-D)", () => {
    const refusal = {
      axis: "calls",
      ceiling: { kind: "calls", limit: 10 },
      perChildEstimate: 2,
      estimatorApplied: "largest-seen",
      effectiveConcurrency: 2,
      completed: 3,
      remaining: 4,
      lowerBound: false,
      hint: "redeploy the DAG with a larger budget",
      scopePath: [],
    } as const;
    const childFailed = (primary: FrameworkError): FrameworkError => ({
      kind: "fan-child-failed",
      nodeId: "map" as never,
      primary: { index: 0 as never, error: primary },
      causes: { kind: "refusal", refusal },
    });

    it("fan-budget-refused → 429 like llm-budget-exceeded, does NOT trip the circuit", () => {
      const e: FrameworkError = { kind: "fan-budget-refused", nodeId: "map" as never, refusal };
      const c = classifyFrameworkError(e);
      expect(c).toEqual(classifyFrameworkError({
        kind: "llm-budget-exceeded",
        runId: "r" as never,
        nodeId: "n" as never,
        cause: { kind: "reached", ceiling: { kind: "calls", limit: 10 }, basis: "settled", observed: 10 },
      }));
      expect(c.status).toBe(429);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("fan-child-failed delegates to its primary child error's class", () => {
      const denied = classifyFrameworkError(childFailed({ kind: "policy-refusal", scope: "mail.send" }));
      expect(denied.status).toBe(403);
      expect(denied.countsAsCircuitFailure).toBe(false);
      const outage = classifyFrameworkError(childFailed({ kind: "infra-unreachable", operation: "mint", hop: "kc", message: "down" }));
      expect(outage.status).toBe(503);
      expect(outage.countsAsCircuitFailure).toBe(true);
      const crash = classifyFrameworkError(childFailed({ kind: "node-crash", nodeId: "c" as never, message: "x", retriability: "non-retriable" }));
      expect(crash.status).toBe(500);
      expect(crash.countsAsCircuitFailure).toBe(true);
    });

    it("fan-budget-refused → 429 carries Retry-After: the client backs off, the host did its job", () => {
      const c = classifyFrameworkError({ kind: "fan-budget-refused", nodeId: "map" as never, refusal });
      expect(c.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("fan-child-failed delegates recursively: a nested fan-child-failed classifies as the innermost primary's class", () => {
      const innermost: FrameworkError = { kind: "infra-unreachable", operation: "mint", hop: "kc", message: "down" };
      expect(classifyFrameworkError(childFailed(childFailed(innermost)))).toEqual(classifyFrameworkError(innermost));
    });

    it("the attached causes never change the class: same primary, three arms, one answer", () => {
      // FR-025's HTTP stake: the refusal and the further failures ride along
      // as data without altering what the client sees — the primary alone
      // decides, in every `FanFailureCauses` arm (mirrors `retriabilityOf`).
      const primary: FrameworkError = { kind: "transient", nodeId: "c" as never, message: "429" };
      const secondary = {
        index: 2 as never,
        error: { kind: "node-crash", nodeId: "c2" as never, message: "x", retriability: "retriable" } as FrameworkError,
      };
      const statusWithCauses = (causes: unknown): number | undefined =>
        classifyFrameworkError({
          kind: "fan-child-failed",
          nodeId: "map" as never,
          primary: { index: 0 as never, error: primary },
          causes: causes as never,
        }).status;
      expect(statusWithCauses({ kind: "secondaries", secondary: [secondary] })).toBe(500);
      expect(statusWithCauses({ kind: "refusal", refusal })).toBe(500);
      expect(statusWithCauses({ kind: "secondaries-and-refusal", secondary: [secondary], refusal })).toBe(500);
      // The answer IS the primary's own class — not a new policy invented for
      // the wrapper.
      expect(statusWithCauses({ kind: "refusal", refusal })).toBe(classifyFrameworkError(primary).status);
    });

    it("an attached fan-budget-refused does NOT upgrade a failing primary to 429", () => {
      // The inverse direction of delegation: the refusal rides along as
      // FR-025 data; the client-facing status stays the primary's class —
      // 500 + breaker, no Retry-After, because this run failed, it was not
      // refused.
      const c = classifyFrameworkError(childFailed({ kind: "transient", nodeId: "c" as never, message: "429" }));
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
      expect(c.retryAfterSeconds).toBeUndefined();
    });

    it("a fan-budget-refused observed as a SECONDARY does not leak its 429 into the classification", () => {
      // A nested fan child's own refusal sits inside a secondary's error; it
      // is context for the operator, never the outcome the client called
      // about — the primary still decides.
      const c = classifyFrameworkError({
        kind: "fan-child-failed",
        nodeId: "map" as never,
        primary: {
          index: 0 as never,
          error: { kind: "node-crash", nodeId: "c" as never, message: "x", retriability: "non-retriable" },
        },
        causes: {
          kind: "secondaries",
          secondary: [{
            index: 3 as never,
            error: { kind: "fan-budget-refused", nodeId: "nested" as never, refusal },
          }],
        },
      } as FrameworkError);
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
    });

    it("fan-child-failed whose primary is a nested fan-budget-refused → 429, does NOT trip the circuit", () => {
      const c = classifyFrameworkError(childFailed({
        kind: "fan-budget-refused", nodeId: "nested-map" as never, refusal,
      }));
      expect(c.status).toBe(429);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("fan-child-failed whose primary exhausted retries on a budget breach → 429 (delegation crosses the retry wrapper)", () => {
      const c = classifyFrameworkError(childFailed({
        kind: "retry-exhausted", nodeId: "c" as never, attempts: 3, lastError: "…", rootErrorKind: "llm-budget-exceeded",
      }));
      expect(c.status).toBe(429);
      expect(c.countsAsCircuitFailure).toBe(false);
    });
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

    it("rooted in fan-budget-refused → 429, does NOT trip the circuit", () => {
      const c = classifyFrameworkError(wrapped("fan-budget-refused"));
      expect(c.status).toBe(429);
      expect(c.countsAsCircuitFailure).toBe(false);
    });

    it("rooted in fan-child-failed → 500 (only the kind survives the wrapper, the primary is unknowable)", () => {
      const c = classifyFrameworkError(wrapped("fan-child-failed"));
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
    });

    it("rooted in a genuine execution failure (transient) → 500, trips the circuit", () => {
      const c = classifyFrameworkError(wrapped("transient"));
      expect(c.status).toBe(500);
      expect(c.countsAsCircuitFailure).toBe(true);
    });
  });
});
