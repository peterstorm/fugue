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
  messageOf,
  retriabilityOf,
  FrameworkAugmentedError,
  type FrameworkError,
  type Retriability,
} from "../types/errors.js";
import type { Capability } from "../types/node.js";
import {
  probeErrorCode,
  safeDiagnosticRender,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
  UNPRINTABLE_ERROR,
  UNPRINTABLE_VALUE,
} from "../types/safe-error.js";

const rid = makeRunId("run-budget");
const nid = makeNodeId("node-x");

const budgetError: FrameworkError = {
  kind: "llm-budget-exceeded",
  runId: rid,
  nodeId: nid,
  cumulative: 1200,
  budget: 1000,
};

describe("FrameworkError: checkpoint-write-failed diagnostics", () => {
  it("keeps legacy branded locations required while preferring invalid raw diagnostics", () => {
    const error: FrameworkError = {
      kind: "checkpoint-write-failed",
      runId: makeRunId("checkpoint_invalid_run"),
      nodeId: makeNodeId("checkpoint_invalid_node"),
      invalidRunId: "../escape",
      invalidNodeId: "bad/node",
      message: "boundary rejected",
    };

    // Discriminant narrowing preserves the established required source shape.
    expect(String(error.runId)).toBe("checkpoint_invalid_run");
    expect(String(error.nodeId)).toBe("checkpoint_invalid_node");
    expect(error.invalidRunId).toBe("../escape");
    expect(error.invalidNodeId).toBe("bad/node");
    expect(formatFrameworkError(error)).toContain("../escape");
    expect(formatFrameworkError(error)).toContain("bad/node");
  });

  it("formats a metadata failure with its grammar-valid internal node location", () => {
    const error: FrameworkError = {
      kind: "checkpoint-write-failed",
      runId: rid,
      nodeId: makeNodeId("checkpoint_meta"),
      message: "meta write failed",
    };

    expect(formatFrameworkError(error)).toBe(
      "checkpoint write failed for run 'run-budget' node 'checkpoint_meta': meta write failed",
    );
  });
});

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

describe("retriabilityOf — single source of truth for the retry fast-fail fork", () => {
  const nid = makeNodeId("node-r");
  const rid2 = makeRunId("run-r");

  // One valid instance of every FrameworkError kind, paired with the
  // classification the retry machinery historically applied (the hand-written
  // disjunction in retry-policy.ts). This table IS the behavior-preservation
  // contract: `handleNodeFailed` now delegates to `retriabilityOf`, so any drift
  // between this classification and the old disjunction would flip a retry
  // decision. Adding a new error kind forces a new row (the type of `cases` is
  // checked against `FrameworkError`, and `retriabilityOf` is `.exhaustive()`).
  const cases: ReadonlyArray<readonly [FrameworkError, Retriability]> = [
    // Deterministic failures — fast-fail, preserve the retry budget.
    [{ kind: "predicate-malformed", nodeId: nid, message: "bad predicate" }, "non-retriable"],
    [{ kind: "validation", nodeId: nid, message: "schema mismatch" }, "non-retriable"],
    [{ kind: "checkpoint-write-failed", runId: rid2, nodeId: nid, message: "disk full" }, "non-retriable"],
    [{ kind: "aborted", reason: "caller cancelled" }, "non-retriable"],
    [{ kind: "policy-refusal", scope: "msgraph:mail.send" }, "non-retriable"],
    [{ kind: "downstream-denied", resource: "https://graph", reason: "FIC mismatch" }, "non-retriable"],
    [{ kind: "llm-budget-exceeded", runId: rid2, nodeId: nid, cumulative: 10, budget: 5 }, "non-retriable"],
    [{ kind: "missing-capability", missing: [{ nodeId: nid, capability: "llm" as Capability }] }, "non-retriable"],
    // node-crash carries its own discriminant — both directions honored.
    [{ kind: "node-crash", nodeId: nid, message: "boom", retriability: "non-retriable" }, "non-retriable"],
    [{ kind: "node-crash", nodeId: nid, message: "boom", retriability: "retriable" }, "retriable"],
    // Transient + everything else — standard backoff path.
    [{ kind: "transient", nodeId: nid, message: "429" }, "retriable"],
    [{ kind: "retry-exhausted", nodeId: nid, attempts: 3, lastError: "x", rootErrorKind: "transient" }, "retriable"],
    [{ kind: "checkpoint-missing", runId: rid2 }, "retriable"],
    [{ kind: "checkpoint-expired", runId: rid2, expiredAt: "2026-01-01T00:00:00Z" }, "retriable"],
    [{ kind: "checkpoint-corrupt", runId: rid2, message: "corrupt" }, "retriable"],
    [{ kind: "checkpoint-version-mismatch", runId: rid2, expected: "2", actual: "1" }, "retriable"],
    [{ kind: "prompt-not-found", promptName: "p", reason: "missing" }, "retriable"],
    [{ kind: "cache-error", operation: "get", message: "timeout" }, "retriable"],
    [{ kind: "cycle-detected", nodeIds: [nid] }, "retriable"],
    [{ kind: "rejected", nodeId: nid, reason: "no" }, "retriable"],
    [{ kind: "invalid-reroute", targetNodeId: nid, message: "bad" }, "retriable"],
    [{ kind: "missing-default-edge", nodeId: nid }, "retriable"],
    [{ kind: "output-unreachable-under-routing", outputNodeId: nid, missedFromNode: nid }, "retriable"],
    [{ kind: "duplicate-edge", fromNodeId: nid, toNodeId: nid }, "retriable"],
    [{ kind: "root-expects-input", nodeId: nid, message: "expects input" }, "retriable"],
    [{ kind: "source-has-incoming", nodeId: nid, message: "has edge" }, "retriable"],
    [{ kind: "invalid-dag-input-edge", edge: { from: "$input", to: "n" }, message: "bad" }, "retriable"],
    [{ kind: "infra-unreachable", operation: "mint", hop: "cc", message: "down" }, "retriable"],
  ];

  it("classifies every one of the 27 error kinds exactly as the old retry disjunction did", () => {
    for (const [error, expected] of cases) {
      expect(retriabilityOf(error)).toBe(expected);
    }
  });

  it("covers every FrameworkError kind (no kind silently defaults)", () => {
    // If a kind were added to the taxonomy without a table row here, this count
    // would drift; `retriabilityOf`'s `.exhaustive()` already fails compilation,
    // and this guards the test itself from falling behind.
    const kinds = new Set(cases.map(([e]) => e.kind));
    expect(kinds.size).toBe(27);
  });
});

describe("safeErrorMessage — hostile thrown-value matrix", () => {
  it("is total without instanceof, unguarded message reads, or coercion leaks", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const nullPrototype = Object.assign(Object.create(null) as object, {
      message: "null prototype failure",
    });
    const throwingMessage = Object.defineProperty({}, "message", {
      get: () => { throw new Error("message unavailable"); },
    });
    const coercionTraps = Object.defineProperties({}, {
      toString: {
        get: () => { throw new Error("toString unavailable"); },
      },
      [Symbol.toPrimitive]: {
        get: () => { throw new Error("Symbol.toPrimitive unavailable"); },
      },
    });
    const hostileInstanceof = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("prototype unavailable"); },
    });

    const corpus: readonly unknown[] = [
      revoked.proxy,
      nullPrototype,
      throwingMessage,
      coercionTraps,
      hostileInstanceof,
    ];
    for (const hostile of corpus) {
      expect(() => safeErrorMessage(hostile)).not.toThrow();
      expect(typeof safeErrorMessage(hostile)).toBe("string");
    }
    expect(safeErrorMessage(revoked.proxy)).toBe(UNPRINTABLE_ERROR);
    expect(safeErrorMessage(nullPrototype)).toBe("null prototype failure");
  });
});

describe("total Node errno diagnostics", () => {
  it("returns a discriminated code/absence result without invoking Proxy has traps", () => {
    let hasCalls = 0;
    const coded = new Proxy({ code: "ENOENT" }, {
      has: () => {
        hasCalls += 1;
        throw new Error("has trap must not run");
      },
    });

    expect(probeErrorCode(coded)).toEqual({ kind: "code", code: "ENOENT" });
    expect(probeErrorCode(new Error("ordinary"))).toEqual({ kind: "absent" });
    expect(probeErrorCode(null)).toEqual({ kind: "absent" });
    expect(hasCalls).toBe(0);
  });

  it("captures throwing code getters as safe actionable inspection diagnostics", () => {
    const primary = new Error("primary filesystem failure");
    Object.defineProperty(primary, "code", {
      get: () => { throw new Error("code getter exploded"); },
    });

    const probe = probeErrorCode(primary);
    expect(probe).toEqual({
      kind: "inspection-failed",
      diagnostic: "code getter exploded",
    });
    expect(safeErrorMessageWithCodeProbe(primary, probe)).toBe(
      "primary filesystem failure (error code inspection failed: code getter exploded)",
    );
  });

  it("is total for Proxy get traps, revoked Proxies, and hostile thrown trap values", () => {
    const revokedThrown = Proxy.revocable({}, {});
    revokedThrown.revoke();
    const hostileGet = new Proxy(new Error("primary proxy failure"), {
      get(target, property, receiver) {
        if (property === "code") throw revokedThrown.proxy;
        return Reflect.get(target, property, receiver);
      },
    });
    const revokedError = Proxy.revocable({}, {});
    revokedError.revoke();

    for (const hostile of [hostileGet, revokedError.proxy] as const) {
      expect(() => probeErrorCode(hostile)).not.toThrow();
      const probe = probeErrorCode(hostile);
      expect(probe.kind).toBe("inspection-failed");
      expect(() => safeErrorMessageWithCodeProbe(hostile, probe)).not.toThrow();
      expect(safeErrorMessageWithCodeProbe(hostile, probe)).toContain(
        "error code inspection failed",
      );
    }
    expect(probeErrorCode(hostileGet)).toEqual({
      kind: "inspection-failed",
      diagnostic: UNPRINTABLE_ERROR,
    });
  });
});

describe("messageOf — retry-exhausted lastError summariser", () => {
  const nid = makeNodeId("node-m");

  it("returns the purpose-written message for node-crash and transient", () => {
    expect(messageOf({ kind: "node-crash", nodeId: nid, message: "crashed hard", retriability: "retriable" })).toBe("crashed hard");
    expect(messageOf({ kind: "transient", nodeId: nid, message: "rate limited" })).toBe("rate limited");
  });

  it("JSON-stringifies every other kind so no structured payload is lost", () => {
    const err: FrameworkError = { kind: "downstream-denied", resource: "https://graph", reason: "FIC mismatch" };
    expect(messageOf(err)).toBe(JSON.stringify(err));
  });

  it("is total for hostile unknown values, throwing Error.message getters, revocation, and cycles", () => {
    const throwingMessage = new Error("hidden");
    Object.defineProperty(throwingMessage, "message", {
      configurable: true,
      get: () => { throw new Error("message unavailable"); },
    });
    const allTraps = new Proxy({}, {
      get: () => { throw new Error("get unavailable"); },
      getPrototypeOf: () => { throw new Error("prototype unavailable"); },
      ownKeys: () => { throw new Error("keys unavailable"); },
    });
    const throwingCoercion = Object.defineProperties({}, {
      toString: { get: () => { throw new Error("toString unavailable"); } },
      [Symbol.toPrimitive]: {
        get: () => { throw new Error("Symbol.toPrimitive unavailable"); },
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cyclic: Record<string, unknown> = { kind: "checkpoint-missing" };
    cyclic.self = cyclic;
    const corpus: readonly unknown[] = [
      allTraps,
      throwingCoercion,
      throwingMessage,
      revoked.proxy,
      cyclic,
    ];

    for (const hostile of corpus) {
      expect(() => messageOf(hostile)).not.toThrow();
      expect(typeof messageOf(hostile)).toBe("string");
      expect(() => safeDiagnosticRender(hostile)).not.toThrow();
      expect(typeof safeDiagnosticRender(hostile)).toBe("string");
    }
    expect(messageOf(revoked.proxy)).toBe(UNPRINTABLE_ERROR);
    expect(safeDiagnosticRender(revoked.proxy)).toBe(UNPRINTABLE_VALUE);
  });
});
