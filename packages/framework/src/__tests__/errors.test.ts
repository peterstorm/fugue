/**
 * Shared error-taxonomy test surface for `FrameworkError` (`types/errors.ts`)
 * and its total renderers — the blocks:
 *
 * - `checkpoint-write-failed` diagnostics (truthful branding + `invalid*` facets)
 * - `llm-budget-exceeded` (FR-W1-003)
 * - `infra-unreachable` / `policy-refusal` / `downstream-denied` (FR-X-001/002)
 * - capability-broker taxonomy discriminability (SC-013)
 * - `retriabilityOf` — the single source of truth for the retry fast-fail fork
 * - `usageOfError` — the FR-W0-001 token-attribution contract (which kinds carry `usage`)
 * - `safeErrorMessage` hostile thrown-value matrix
 * - total Node errno diagnostics
 * - `messageOf` retry-exhausted lastError summariser
 *
 * Each block verifies its variant is discriminable on `kind`, carries its
 * structured payload, and formats to a legible single line — without breaking
 * the exhaustive `formatFrameworkError`.
 */

import { describe, it, expect } from "bun:test";
import { tokensOnly } from "../types/token-usage.js";
import { observedOf } from "../types/budget.js";
import type { MicroUsd } from "../types/spend.js";
import { match } from "ts-pattern";
import { runId as makeRunId, nodeId as makeNodeId } from "../types/ids.js";
import {
  CHECKPOINT_INVALID_NODE_ID,
  CHECKPOINT_INVALID_RUN_ID,
  META_RECORD_NODE_ID,
} from "../types/error-factories.js";
import {
  formatFrameworkError,
  asFrameworkError,
  isFrameworkError,
  isFrameworkErrorKind,
  PersistedFrameworkErrorSchema,
  messageOf,
  retriabilityOf,
  usageOfError,
  FrameworkAugmentedError,
  type FrameworkError,
  type PartialTokenUsage,
  type Retriability,
} from "../types/errors.js";
import type { Capability } from "../types/node.js";
import {
  probeErrorCode,
  safeDiagnosticRender,
  safeDiagnosticString,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
  safeErrorStack,
  UNPRINTABLE_ERROR,
  UNPRINTABLE_VALUE,
} from "../types/safe-error.js";

const rid = makeRunId("run-budget");
const nid = makeNodeId("node-x");

const budgetError: FrameworkError = {
  kind: "llm-budget-exceeded",
  runId: rid,
  nodeId: nid,
  cause: {
    kind: "reached",
    ceiling: { kind: "tokens", limit: 1000 },
    basis: "settled",
    observed: 1200,
  },
};

describe("FrameworkError: checkpoint-write-failed diagnostics", () => {
  it("keeps legacy wire fields required while preferring invalid raw diagnostics", () => {
    // The rejected-address arm: the placeholders are the ONLY inhabitants the
    // type admits alongside an `invalid*` diagnostic — a real `RunId`/`NodeId`
    // here is now a compile error, which is the whole point of the ADT split.
    const error: FrameworkError = {
      kind: "checkpoint-write-failed",
      runId: CHECKPOINT_INVALID_RUN_ID,
      nodeId: CHECKPOINT_INVALID_NODE_ID,
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

  it("renders a hostile multi-KB invalid id bounded: structured bytes preserved, log line truncated", () => {
    const huge = "x".repeat(200_000);
    const error: FrameworkError = {
      kind: "checkpoint-write-failed",
      runId: CHECKPOINT_INVALID_RUN_ID,
      invalidRunId: huge,
      // Only the RUN address was rejected here; the node address is real, and
      // the ADT now makes that combination the only representable one.
      nodeId: nid,
      message: "boundary rejected",
    };

    expect(error.invalidRunId).toBe(huge); // structured consumers keep raw bytes
    const rendered = formatFrameworkError(error);
    expect(rendered.length).toBeLessThan(500); // never an unbounded log line
    expect(rendered).toContain("checkpoint write failed");
  });

  it("formats a metadata failure with its grammar-valid internal node location", () => {
    const error: FrameworkError = {
      kind: "checkpoint-write-failed",
      runId: rid,
      nodeId: META_RECORD_NODE_ID,
      message: "meta write failed",
    };

    expect(formatFrameworkError(error)).toBe(
      "checkpoint write failed for run 'run-budget' node 'checkpoint_meta': meta write failed",
    );
  });
});

describe("PersistedFrameworkErrorSchema", () => {
  it("parses a complete variant, brands ids, and preserves additive fields", () => {
    const parsed = PersistedFrameworkErrorSchema.safeParse({
      kind: "node-crash",
      nodeId: "node-x",
      message: "boom",
      retriability: "retriable",
      futureDiagnostic: "preserved",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "node-crash") {
      expect(parsed.data.nodeId).toBe(makeNodeId("node-x"));
      expect((parsed.data as FrameworkError & { futureDiagnostic?: string }).futureDiagnostic).toBe("preserved");
    }
  });

  it("rejects missing required fields and invalid branded ids", () => {
    expect(PersistedFrameworkErrorSchema.safeParse({ kind: "node-crash" }).success).toBe(false);
    expect(PersistedFrameworkErrorSchema.safeParse({
      kind: "node-crash",
      nodeId: "bad node id",
      message: "boom",
      retriability: "retriable",
    }).success).toBe(false);
  });

  it("admits only complete variants through isFrameworkError and is total for hostile input", () => {
    for (const malformed of [
      { kind: "node-crash" },
      { kind: "validation", nodeId: "node-x" },
      { kind: "policy-refusal" },
      { kind: "infra-unreachable", operation: "mint" },
    ]) {
      expect(isFrameworkError(malformed)).toBe(false);
    }
    expect(isFrameworkError({
      kind: "node-crash",
      nodeId: "node-x",
      message: "boom",
      retriability: "non-retriable",
    })).toBe(true);

    // A parser repair/canonicalization proves only its OUTPUT. The original
    // object remains malformed and must not be narrowed by a type guard.
    expect(PersistedFrameworkErrorSchema.safeParse({
      kind: "checkpoint-write-failed",
      runId: "run-x",
      nodeId: "node-x",
      invalidRunId: "../escape",
      message: "bad address",
    }).success).toBe(true);
    expect(isFrameworkError({
      kind: "checkpoint-write-failed",
      runId: "run-x",
      nodeId: "node-x",
      invalidRunId: "../escape",
      message: "bad address",
    })).toBe(false);
    expect(isFrameworkError({
      kind: "llm-budget-exceeded",
      runId: "run-x",
      nodeId: "node-x",
      cause: {
        kind: "unpriced",
        ceiling: { kind: "usd", limit: 10 },
        basis: "settled",
        models: ["z-model", "a-model"],
        observedAtLeast: 0,
      },
    })).toBe(false);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => isFrameworkError(revoked.proxy)).not.toThrow();
    expect(isFrameworkError(revoked.proxy)).toBe(false);
  });

  it("recovers a pre-prompt-caching usage record through asFrameworkError", () => {
    // A record written before prompt caching carries only the two token counts.
    // `persistedUsageSchema` exists to accept it, defaulting the cache figures.
    const legacy = {
      kind: "node-crash",
      nodeId: "node-x",
      message: "boom",
      retriability: "retriable",
      usage: { tokensIn: 10, tokensOut: 5 },
    };

    // The wire parser accepts it...
    expect(PersistedFrameworkErrorSchema.safeParse(legacy).success).toBe(true);

    // ...but the source object is NOT a `FrameworkError`: `TokenUsage` declares
    // all four fields required, and every `isFrameworkError` caller carries the
    // SOURCE forward. Narrowing here would push `undefined` cache-token fields
    // into budget accounting — a fail-open. The guard stays exact.
    expect(isFrameworkError(legacy)).toBe(false);

    // Recovery is what the caller actually wants, and it yields the CANONICAL
    // value: structured kind/retriability intact, usage completed by the
    // schema's defaults rather than dropped as unrecognizable.
    const recovered = asFrameworkError(legacy);
    expect(recovered).toBeDefined();
    expect(recovered?.kind).toBe("node-crash");
    if (recovered?.kind !== "node-crash") throw new Error("expected node-crash");
    expect(recovered.retriability).toBe("retriable");
    expect(recovered.usage).toEqual({
      tokensIn: 10,
      tokensOut: 5,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    // The recovered value is canonical, never the hostile source.
    expect(recovered).not.toBe(legacy);

    // Total for input the parser rejects, and for hostile input.
    expect(asFrameworkError({ kind: "node-crash" })).toBeUndefined();
    expect(asFrameworkError("not an error")).toBeUndefined();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => asFrameworkError(revoked.proxy)).not.toThrow();
    expect(asFrameworkError(revoked.proxy)).toBeUndefined();
  });

  it("parses a standalone augmented-error kind without pretending it is a full error", () => {
    expect(isFrameworkErrorKind("node-crash")).toBe(true);
    expect(isFrameworkErrorKind("policy-refusal")).toBe(true);
    expect(isFrameworkErrorKind("made-up-kind")).toBe(false);
    expect(isFrameworkError({ kind: "node-crash" })).toBe(false);
  });
});

describe("FrameworkError: llm-budget-exceeded", () => {
  it("is discriminable on kind and carries the structured payload", () => {
    expect(budgetError.kind).toBe("llm-budget-exceeded");
    // Narrowing on the discriminant exposes the payload fields.
    if (budgetError.kind === "llm-budget-exceeded") {
      expect(budgetError.runId).toBe(rid);
      expect(budgetError.nodeId).toBe(nid);
      expect(budgetError.cause.kind).toBe("reached");
      expect(budgetError.cause.ceiling).toEqual({ kind: "tokens", limit: 1000 });
      expect(budgetError.cause.basis).toBe("settled");
      expect(observedOf(budgetError.cause)).toBe(1200);
    }
  });

  it("formats to a legible single line naming run, node, observed figure, and limit", () => {
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
      expect(parsed.cause.ceiling).toEqual({ kind: "tokens", limit: 1000 });
      expect(observedOf(parsed.cause)).toBe(1200);
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
    [{ kind: "llm-budget-exceeded", runId: rid2, nodeId: nid, cause: { kind: "reached", ceiling: { kind: "tokens", limit: 5 }, basis: "settled", observed: 10 } }, "non-retriable"],
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
    // cache-error's explicit failure-class discriminant overrides the default:
    // deterministic file-backend failures must fast-fail like the other
    // deterministic kinds instead of burning the retry budget.
    [{ kind: "cache-error", operation: "appendEvent", message: "capacity exhausted", failureClass: "permanent" }, "non-retriable"],
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

  it("recognizes every table-constructed kind as a typed framework error (identity survives the guard)", () => {
    // PersistedFrameworkErrorSchema is compiler-checked for complete kind
    // coverage; this pins the consumer-side contract from the other side: no
    // complete kind this file constructs is dropped by `isFrameworkError`, so the boundary fences that
    // branch on it (resume.ts, job.ts appendEvent, atomic.ts acquireFileLock)
    // can never re-tag a kind that lost its identity.
    for (const [error] of cases) {
      expect(isFrameworkError(error)).toBe(true);
    }
  });
});

describe("usageOfError — FR-W0-001 token-attribution contract", () => {
  const nid = makeNodeId("node-u");
  const rid2 = makeRunId("run-u");
  const used = { ...tokensOnly(7, 3) };

  // The contract: ONLY `node-crash`, `transient`, and `aborted` carry `usage`
  // (the tool-use-loop variants that can burn tokens before failing); every
  // other kind reads `undefined`. The usage-carrying rows pin BOTH directions
  // — passthrough of the exact partial totals, and `undefined` when absent —
  // because the loop's budget accounting branches on the presence/absence of
  // the value, not merely on the kind. Every non-carrying kind gets an explicit
  // row (not `.otherwise`-style silence): a regression that moves an arm
  // between the two sides of `usageOfError`'s exhaustive `match` compiles
  // cleanly (both sides stay exhaustive), so this table is the pin.
  const cases: ReadonlyArray<readonly [FrameworkError, PartialTokenUsage | undefined]> = [
    // The three usage-carrying kinds — passthrough AND absence, per kind.
    [{ kind: "node-crash", nodeId: nid, message: "boom", retriability: "retriable", usage: used }, used],
    [{ kind: "node-crash", nodeId: nid, message: "boom", retriability: "non-retriable" }, undefined],
    [{ kind: "transient", nodeId: nid, message: "429", usage: used }, used],
    [{ kind: "transient", nodeId: nid, message: "429" }, undefined],
    [{ kind: "aborted", reason: "caller cancelled", usage: used }, used],
    [{ kind: "aborted", reason: "caller cancelled" }, undefined],
    // Every other kind reads undefined — one row per kind.
    [{ kind: "validation", nodeId: nid, message: "schema mismatch" }, undefined],
    [{ kind: "checkpoint-write-failed", runId: rid2, nodeId: nid, message: "disk full" }, undefined],
    [{ kind: "policy-refusal", scope: "msgraph:mail.send" }, undefined],
    [{ kind: "downstream-denied", resource: "https://graph", reason: "FIC mismatch" }, undefined],
    [{ kind: "llm-budget-exceeded", runId: rid2, nodeId: nid, cause: { kind: "reached", ceiling: { kind: "tokens", limit: 5 }, basis: "settled", observed: 10 } }, undefined],
    [{ kind: "missing-capability", missing: [{ nodeId: nid, capability: "llm" as Capability }] }, undefined],
    [{ kind: "retry-exhausted", nodeId: nid, attempts: 3, lastError: "x", rootErrorKind: "transient" }, undefined],
    [{ kind: "checkpoint-missing", runId: rid2 }, undefined],
    [{ kind: "checkpoint-expired", runId: rid2, expiredAt: "2026-01-01T00:00:00Z" }, undefined],
    [{ kind: "checkpoint-corrupt", runId: rid2, message: "corrupt" }, undefined],
    [{ kind: "checkpoint-version-mismatch", runId: rid2, expected: "2", actual: "1" }, undefined],
    [{ kind: "prompt-not-found", promptName: "p", reason: "missing" }, undefined],
    [{ kind: "cache-error", operation: "get", message: "timeout" }, undefined],
    [{ kind: "cache-error", operation: "appendEvent", message: "capacity exhausted", failureClass: "permanent" }, undefined],
    [{ kind: "cycle-detected", nodeIds: [nid] }, undefined],
    [{ kind: "rejected", nodeId: nid, reason: "no" }, undefined],
    [{ kind: "invalid-reroute", targetNodeId: nid, message: "bad" }, undefined],
    [{ kind: "missing-default-edge", nodeId: nid }, undefined],
    [{ kind: "output-unreachable-under-routing", outputNodeId: nid, missedFromNode: nid }, undefined],
    [{ kind: "predicate-malformed", nodeId: nid, message: "bad predicate" }, undefined],
    [{ kind: "duplicate-edge", fromNodeId: nid, toNodeId: nid }, undefined],
    [{ kind: "root-expects-input", nodeId: nid, message: "expects input" }, undefined],
    [{ kind: "source-has-incoming", nodeId: nid, message: "has edge" }, undefined],
    [{ kind: "invalid-dag-input-edge", edge: { from: "$input", to: "n" }, message: "bad" }, undefined],
    [{ kind: "infra-unreachable", operation: "mint", hop: "cc", message: "down" }, undefined],
  ];

  it("attributes usage exactly on the three tool-use-loop kinds and nowhere else", () => {
    for (const [error, expected] of cases) {
      expect(usageOfError(error)).toEqual(expected);
    }
  });

  it("covers every FrameworkError kind (no kind silently defaults)", () => {
    // Same guard as the `retriabilityOf` block: a new kind without a row here
    // would drift the count; `usageOfError`'s `.exhaustive()` fails
    // compilation first, and this guards the table itself.
    const kinds = new Set(cases.map(([e]) => e.kind));
    expect(kinds.size).toBe(27);
  });

  it("returns the caller's exact partial totals, not a copy or a mutation sink", () => {
    // Passthrough is reference-identity: the metering shell must attribute the
    // SAME partials the loop accumulated (a silent copy would break identity
    // comparisons the budget code is allowed to make).
    const withUsage: FrameworkError = { kind: "transient", nodeId: nid, message: "429", usage: used };
    expect(usageOfError(withUsage)).toBe(used);
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

describe("safeErrorStack — hostile stack extraction", () => {
  it("returns ordinary stacks and is total for absent, throwing, and revoked stacks", () => {
    const ordinary = new Error("boom");
    expect(safeErrorStack(ordinary)).toBe(ordinary.stack);
    expect(safeErrorStack("boom")).toBeUndefined();
    expect(safeErrorStack({ stack: 42 })).toBeUndefined();

    const throwingStack = Object.defineProperty({}, "stack", {
      get: () => { throw new Error("stack unavailable"); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const hostile of [throwingStack, revoked.proxy]) {
      expect(() => safeErrorStack(hostile)).not.toThrow();
      expect(safeErrorStack(hostile)).toBeUndefined();
    }
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

describe("safeDiagnosticString — total, non-truncated rendering for known strings (FR-040)", () => {
  // Round-10 A7 (type-design-analyzer): the `parseFileEventRecord` catch-all
  // rendered its `source` path through `safeDiagnosticRender`, whose 60-char
  // cap truncates legal-but-long run-directory paths in exactly the branch
  // where the full name is the diagnostic. `safeDiagnosticString` keeps the
  // escape-only half of that rendering (JSON quoting — quotes, backslashes,
  // and control characters cannot break the surrounding message) and drops
  // the cap.

  const longPath =
    "/var/lib/fugue/runs/2026-08-17/standalone-2026-08-17-171928-f6-file-durable-runtime/events/node-a1b2c3/000042-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.json";

  it("preserves a string past the 60-char cap in full (the deliberate divergence from safeDiagnosticRender)", () => {
    expect(longPath.length).toBeGreaterThan(60);
    const rendered = safeDiagnosticString(longPath);
    // JSON-quoted, complete, and not the truncated form.
    expect(rendered).toBe(JSON.stringify(longPath));
    expect(rendered).not.toContain("…(");
    // The cap still applies to the arbitrary-value renderer — pin the
    // divergence so the two renderers cannot be conflated later.
    expect(safeDiagnosticRender(longPath)).toContain("…(");
  });

  it("escapes quotes, backslashes, and control characters (no structural injection)", () => {
    const hostile = 'a"quote\\back\nnew\rline\ttab';
    const rendered = safeDiagnosticString(hostile);
    // The rendered form is a self-contained JSON string literal: parsing it
    // back yields exactly the original — quotes and escapes cannot break out
    // of the surrounding `\`${rendered}: message\`` interpolation.
    expect(JSON.parse(rendered)).toBe(hostile);
    expect(rendered).not.toContain("\n");
  });

  it("is total on every string (empty included) and never throws", () => {
    expect(() => safeDiagnosticString("")).not.toThrow();
    expect(safeDiagnosticString("")).toBe('""');
    expect(() => safeDiagnosticString("a")).not.toThrow();
    expect(safeDiagnosticString("a")).toBe('"a"');
  });
});

describe("PersistedFrameworkErrorSchema: llm-budget-exceeded round-trips through the WIRE parser", () => {
  // The existing coverage round-tripped this error through `JSON.stringify` /
  // `JSON.parse` via FrameworkAugmentedError — which never touches the Zod
  // schema. This change rewrote that schema (`persistedBreachSchema`,
  // `persistedCeilingSchema`, the MicroUsd brand restore), so the boundary a
  // resumed run actually reads a persisted error back through was untested.

  it("parses a `reached` cause, restoring the branded ids", () => {
    const wire = JSON.parse(
      JSON.stringify({
        kind: "llm-budget-exceeded",
        runId: "run-budget",
        nodeId: "node-x",
        cause: {
          kind: "reached",
          ceiling: { kind: "usd", limit: 1_500_000 },
          basis: "projected",
          observed: 2_000_000,
        },
      }),
    ) as unknown;

    const parsed = PersistedFrameworkErrorSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe("llm-budget-exceeded");
    if (parsed.data.kind !== "llm-budget-exceeded") return;
    expect(parsed.data.runId).toBe(rid);
    expect(parsed.data.cause.basis).toBe("projected");
    expect(parsed.data.cause.ceiling).toEqual({ kind: "usd", limit: 1_500_000 as MicroUsd });
    expect(observedOf(parsed.data.cause)).toBe(2_000_000);
  });

  it("parses an `unpriced` cause, keeping the model list non-empty", () => {
    const wire = JSON.parse(
      JSON.stringify({
        kind: "llm-budget-exceeded",
        runId: "run-budget",
        nodeId: "node-x",
        cause: {
          kind: "unpriced",
          ceiling: { kind: "usd", limit: 1_000_000 },
          basis: "settled",
          models: ["brand-new-model"],
          observedAtLeast: 250_000,
        },
      }),
    ) as unknown;

    const parsed = PersistedFrameworkErrorSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "llm-budget-exceeded") return;
    expect(parsed.data.cause.kind).toBe("unpriced");
    if (parsed.data.cause.kind !== "unpriced") return;
    expect([...parsed.data.cause.models]).toEqual(["brand-new-model"]);
    expect(parsed.data.cause.observedAtLeast).toBe(250_000 as MicroUsd);
    // The formatter is total over anything the parser admits.
    expect(() => formatFrameworkError(parsed.data)).not.toThrow();
  });

  it("parses unknown usage for token/USD ceilings and rejects it for calls", () => {
    const unknown = (ceiling: unknown) => ({
      kind: "llm-budget-exceeded",
      runId: "run-budget",
      nodeId: "node-x",
      cause: {
        kind: "unknown-usage",
        ceiling,
        basis: "settled",
        observedAtLeast: 12,
      },
    });

    for (const ceiling of [
      { kind: "tokens", limit: 100 },
      { kind: "usd", limit: 100 },
    ]) {
      const parsed = PersistedFrameworkErrorSchema.safeParse(unknown(ceiling));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(() => formatFrameworkError(parsed.data)).not.toThrow();
    }
    expect(PersistedFrameworkErrorSchema.safeParse(
      unknown({ kind: "calls", limit: 100 }),
    ).success).toBe(false);
  });

  it("REJECTS an unpriced cause naming no model", () => {
    // "Unknown cost, caused by nothing" is unrepresentable in memory (the
    // models list is a non-empty tuple); the wire schema has to agree, or a
    // persisted record could reintroduce the state the type forbids.
    const parsed = PersistedFrameworkErrorSchema.safeParse({
      kind: "llm-budget-exceeded",
      runId: "run-budget",
      nodeId: "node-x",
      cause: {
        kind: "unpriced",
        ceiling: { kind: "usd", limit: 1_000_000 },
        basis: "settled",
        models: [],
        observedAtLeast: 0,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("REJECTS a cause with an unknown discriminant or a missing ceiling", () => {
    expect(
      PersistedFrameworkErrorSchema.safeParse({
        kind: "llm-budget-exceeded",
        runId: "run-budget",
        nodeId: "node-x",
        cause: { kind: "exploded", basis: "settled", observed: 1 },
      }).success,
    ).toBe(false);
    expect(
      PersistedFrameworkErrorSchema.safeParse({
        kind: "llm-budget-exceeded",
        runId: "run-budget",
        nodeId: "node-x",
        cause: { kind: "reached", basis: "settled", observed: 1 },
      }).success,
    ).toBe(false);
  });
});
