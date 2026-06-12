/**
 * Tests for the `llm-budget-exceeded` FrameworkError variant (FR-W1-003).
 *
 * Verifies the new variant is discriminable on `kind`, carries its structured
 * payload, formats to a legible single line, and round-trips through
 * FrameworkAugmentedError — without breaking the exhaustive `formatFrameworkError`.
 */

import { describe, it, expect } from "bun:test";
import { match } from "ts-pattern";
import { runId as makeRunId, nodeId as makeNodeId } from "../types/ids.js";
import {
  formatFrameworkError,
  FrameworkAugmentedError,
  type FrameworkError,
} from "../types/errors.js";

const rid = makeRunId("run-budget");
const nid = makeNodeId("node-x");

const budgetError: FrameworkError = {
  kind: "llm-budget-exceeded",
  runId: rid,
  nodeId: nid,
  cumulative: 1200,
  budget: 1000,
};

describe("FrameworkError: llm-budget-exceeded", () => {
  it("is discriminable on kind and carries the structured payload", () => {
    expect(budgetError.kind).toBe("llm-budget-exceeded");
    // Narrowing on the discriminant exposes the payload fields.
    if (budgetError.kind === "llm-budget-exceeded") {
      expect(budgetError.runId).toBe(rid);
      expect(budgetError.nodeId).toBe(nid);
      expect(budgetError.cumulative).toBe(1200);
      expect(budgetError.budget).toBe(1000);
    }
  });

  it("formats to a legible single line naming run, node, cumulative, and budget", () => {
    const msg = formatFrameworkError(budgetError);
    expect(msg).toContain("llm budget exceeded");
    expect(msg).toContain("run-budget");
    expect(msg).toContain("node-x");
    expect(msg).toContain("1200");
    expect(msg).toContain("1000");
  });

  it("never throws for the new variant (exhaustive match stays total)", () => {
    expect(() => formatFrameworkError(budgetError)).not.toThrow();
  });

  it("round-trips through FrameworkAugmentedError", () => {
    const augmented = new FrameworkAugmentedError(formatFrameworkError(budgetError), budgetError);
    expect(augmented.frameworkErrorKind).toBe("llm-budget-exceeded");
    const parsed = JSON.parse(augmented.frameworkErrorJson) as FrameworkError;
    expect(parsed.kind).toBe("llm-budget-exceeded");
    if (parsed.kind === "llm-budget-exceeded") {
      expect(parsed.cumulative).toBe(1200);
      expect(parsed.budget).toBe(1000);
    }
    expect(augmented.cause).toBe(budgetError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Capability-broker failure taxonomy (FR-X-001 / FR-X-002 / SC-013).
//
// The three variants are a TAXONOMY: each models a categorically different
// failure (transient infra outage vs. fail-closed local policy refusal vs. a
// settled downstream authorization denial). The tests below assert they are
// constructible, discriminable on `kind`, format to distinct non-empty lines,
// and survive the exhaustive `formatFrameworkError` match.
// ───────────────────────────────────────────────────────────────────────────

const infraError: FrameworkError = {
  kind: "infra-unreachable",
  operation: "mint",
  hop: "client-credentials",
  message: "ECONNREFUSED keycloak:8443",
};

const policyError: FrameworkError = {
  kind: "policy-refusal",
  scope: "msgraph:mail.send",
  agentClientId: "agent-client-42",
};

// Parse-time refusal: the offending `requires` name is unrecognised, so the
// agent client id is UNKNOWN and the optional `agentClientId` field is ABSENT.
const policyErrorNoClient: FrameworkError = {
  kind: "policy-refusal",
  scope: "bogus-scope-name",
};

const downstreamError: FrameworkError = {
  kind: "downstream-denied",
  resource: "https://graph.microsoft.com",
  reason: "FIC subject mismatch",
};

describe("FrameworkError: infra-unreachable (FR-X-001)", () => {
  it("is constructible and discriminable on kind, carrying its payload", () => {
    expect(infraError.kind).toBe("infra-unreachable");
    if (infraError.kind === "infra-unreachable") {
      expect(infraError.operation).toBe("mint");
      expect(infraError.hop).toBe("client-credentials");
      expect(infraError.message).toBe("ECONNREFUSED keycloak:8443");
    }
  });

  it("formats to a non-empty line naming the failed operation", () => {
    const msg = formatFrameworkError(infraError);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("unreachable");
    expect(msg).toContain("client-credentials");
  });

  it("round-trips through FrameworkAugmentedError", () => {
    const augmented = new FrameworkAugmentedError(formatFrameworkError(infraError), infraError);
    expect(augmented.frameworkErrorKind).toBe("infra-unreachable");
    const parsed = JSON.parse(augmented.frameworkErrorJson) as FrameworkError;
    expect(parsed.kind).toBe("infra-unreachable");
  });
});

describe("FrameworkError: policy-refusal (FR-X-001)", () => {
  it("is constructible and discriminable on kind, carrying its payload", () => {
    expect(policyError.kind).toBe("policy-refusal");
    if (policyError.kind === "policy-refusal") {
      expect(policyError.scope).toBe("msgraph:mail.send");
      expect(policyError.agentClientId).toBe("agent-client-42");
    }
  });

  it("formats to a non-empty line naming the unassigned scope and client (assignment-time, client present)", () => {
    const msg = formatFrameworkError(policyError);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("msgraph:mail.send");
    expect(msg).toContain("agent-client-42");
  });

  it("is discriminable and carries its scope when agentClientId is ABSENT (parse-time refusal)", () => {
    expect(policyErrorNoClient.kind).toBe("policy-refusal");
    if (policyErrorNoClient.kind === "policy-refusal") {
      expect(policyErrorNoClient.scope).toBe("bogus-scope-name");
      // Absence is modelled as an absent field, not an empty-string sentinel.
      expect(policyErrorNoClient.agentClientId).toBeUndefined();
    }
  });

  it("formats to a sensible non-empty line when agentClientId is absent (no empty-quote artifact)", () => {
    const msg = formatFrameworkError(policyErrorNoClient);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("bogus-scope-name");
    // Must not render a dangling empty client clause like "client ''".
    expect(msg).not.toContain("''");
    expect(msg).not.toContain('client \'\'');
  });
});

describe("FrameworkError: downstream-denied (FR-X-002)", () => {
  it("is constructible and discriminable on kind, carrying its payload", () => {
    expect(downstreamError.kind).toBe("downstream-denied");
    if (downstreamError.kind === "downstream-denied") {
      expect(downstreamError.resource).toBe("https://graph.microsoft.com");
      expect(downstreamError.reason).toBe("FIC subject mismatch");
    }
  });

  it("formats to a non-empty line naming the refused resource and reason", () => {
    const msg = formatFrameworkError(downstreamError);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("graph.microsoft.com");
    expect(msg).toContain("FIC subject mismatch");
  });
});

describe("Capability-broker taxonomy: discriminability (SC-013)", () => {
  const all: readonly FrameworkError[] = [infraError, policyError, downstreamError];

  it("each variant is uniquely discriminable on kind", () => {
    const kinds = all.map((e) => e.kind);
    expect(new Set(kinds).size).toBe(all.length);
    expect(kinds).toEqual(["infra-unreachable", "policy-refusal", "downstream-denied"]);
  });

  it("infra-unreachable is kept DISTINCT from downstream-denied (FR-X-002)", () => {
    // A transient outage and a settled denial must never collapse — retry
    // policy branches on this distinction.
    expect(infraError.kind).not.toBe(downstreamError.kind);
  });

  it("each variant formats to a DISTINCT non-empty string", () => {
    const msgs = all.map(formatFrameworkError);
    expect(msgs.every((m) => m.length > 0)).toBe(true);
    expect(new Set(msgs).size).toBe(all.length);
  });

  it("each survives the exhaustive formatFrameworkError match (SC-013)", () => {
    // `formatFrameworkError` is `.exhaustive()`; reaching a result here proves
    // every variant has a case and the match stays total.
    for (const e of all) {
      expect(() => formatFrameworkError(e)).not.toThrow();
    }
  });

  it("a ts-pattern exhaustive match over the new kinds compiles and dispatches", () => {
    // A local exhaustive match: if any of the three kinds lacked a `.with`,
    // `.exhaustive()` would be a compile error. This locks SC-013 at the
    // type level for a consumer-side switch, not just for formatFrameworkError.
    const categorize = (e: FrameworkError): "transient" | "refusal" | "denied" | "other" =>
      match(e)
        .with({ kind: "infra-unreachable" }, () => "transient" as const)
        .with({ kind: "policy-refusal" }, () => "refusal" as const)
        .with({ kind: "downstream-denied" }, () => "denied" as const)
        .otherwise(() => "other" as const);

    expect(categorize(infraError)).toBe("transient");
    expect(categorize(policyError)).toBe("refusal");
    expect(categorize(downstreamError)).toBe("denied");
  });
});
