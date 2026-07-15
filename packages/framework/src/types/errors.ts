// Discriminated union of all framework errors

import { match } from "ts-pattern";
import type { RunId, NodeId } from "./ids.js";
// Type-only circular reference with `types/node.ts` (which imports
// `FrameworkError` from this module) — safe: type imports erase at compile
// time, so no runtime cycle exists.
import type { Capability } from "./node.js";

/** A single unsatisfied capability declaration: which node required which capability. */
export type MissingCapability = {
  readonly nodeId: NodeId;
  readonly capability: Capability;
};

/**
 * Tokens consumed by a call that ultimately failed. Carried on the error
 * variants emitted by the tool-use loop (`node-crash`, `transient`, `aborted`)
 * and the clients' terminal-status short-circuits (e.g. OpenAI
 * `sendStructured`'s `status:"failed"` arm, which attaches usage via
 * `responseFailedError` outside any loop) so that the partial usage burned
 * across already-completed turns — or a single non-looping call — is
 * representable on the `Err` path and can be metered UNCONDITIONALLY (FR-W0-001:
 * 100% attribution). Absent (`undefined`) means the failure consumed no
 * attributable tokens (e.g. an upfront validation error before any turn ran).
 */
export type PartialTokenUsage = {
  readonly tokensIn: number;
  readonly tokensOut: number;
};

export type FrameworkError =
  | { readonly kind: "validation"; readonly nodeId: NodeId; readonly message: string; readonly path?: string }
  | {
      readonly kind: "retry-exhausted";
      readonly nodeId: NodeId;
      readonly attempts: number;
      /**
       * Human-readable summary of the final failure. For `node-crash` and
       * `transient` this is the original `message` field; for other kinds it
       * is `JSON.stringify(error)` so the structured payload is still
       * legible. Prefer `rootErrorKind` for programmatic pattern-matching.
       */
      readonly lastError: string;
      /**
       * Discriminant of the underlying error that exhausted the budget.
       * Lets consumers tell a rate-limit storm (`"transient"`) from a logic
       * crash (`"node-crash"`) without parsing `lastError`. The recursive
       * `"retry-exhausted"` value is excluded — a retry-exhausted error
       * never wraps itself.
       */
      readonly rootErrorKind: Exclude<FrameworkError["kind"], "retry-exhausted">;
    }
  | { readonly kind: "checkpoint-missing"; readonly runId: RunId }
  | {
      readonly kind: "checkpoint-expired";
      readonly runId: RunId;
      /** ISO 8601 UTC timestamp. Stored as a string so the error round-trips
       * through `JSON.stringify` / `JSON.parse` without losing type fidelity. */
      readonly expiredAt: string;
    }
  | { readonly kind: "checkpoint-corrupt"; readonly runId: RunId; readonly nodeId?: NodeId; readonly message: string }
  | {
      readonly kind: "checkpoint-version-mismatch";
      readonly runId: RunId;
      readonly expected: string;
      readonly actual: string | undefined;
    }
  | {
      readonly kind: "checkpoint-write-failed";
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | { readonly kind: "prompt-not-found"; readonly promptName: string; readonly reason: string }
  | { readonly kind: "cache-error"; readonly operation: string; readonly message: string }
  | {
      readonly kind: "node-crash";
      readonly nodeId: NodeId;
      readonly message: string;
      readonly stack?: string;
      /**
       * Explicit retriability discriminant. `"non-retriable"` makes the DAG
       * transition fast-fail this error without consuming the retry budget;
       * use it for deterministic failures (tool-call iteration exhaustion,
       * schema mismatches, prompt-defect loops). `"retriable"` is the default
       * and goes through the standard backoff path.
       */
      readonly retriability: "retriable" | "non-retriable";
      /**
       * HTTP status code when this crash originated from an HTTP response —
       * a deterministic 4xx client error (non-retriable, e.g. 401/400/404), a
       * 5xx server error (retriable), or a malformed-success 2xx body — on the
       * raw-HTTP path or a duck-typed SDK error. Lets consumers branch on
       * `httpStatus === 401` instead of string-matching `HTTP 401` out of the
       * message. Absent on non-HTTP `node-crash` producers (iteration limit,
       * schema mismatch, thrown exception with no `.status`).
       */
      readonly httpStatus?: number;
      /**
       * Tokens already consumed by the failed call. The tool-use loop populates
       * this from its accumulated cross-turn totals so a crash (iteration limit,
       * schema mismatch, JSON parse failure) still attributes the burned tokens
       * (FR-W0-001) and counts them toward the per-run budget. Absent when no
       * tokens were consumed before the failure.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "cycle-detected"; readonly nodeIds: readonly NodeId[] }
  | {
      readonly kind: "aborted";
      readonly reason: string;
      /**
       * Tokens already consumed before the abort signal halted the loop. See
       * `node-crash.usage`.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "rejected"; readonly nodeId: NodeId; readonly reason: string }
  | { readonly kind: "invalid-reroute"; readonly targetNodeId: NodeId; readonly message: string }
  | {
      readonly kind: "transient";
      readonly nodeId: NodeId;
      readonly message: string;
      /**
       * HTTP status code when the transient failure originated from an HTTP
       * response (e.g. the built-in http capability). Lets consumers branch
       * on `httpStatus === 404` instead of string-matching the message.
       */
      readonly httpStatus?: number;
      /**
       * Tokens already consumed before a transient failure (e.g. a total
       * deadline exceeded mid-loop). See `node-crash.usage`.
       */
      readonly usage?: PartialTokenUsage;
    }
  | { readonly kind: "missing-default-edge"; readonly nodeId: NodeId }
  | {
      readonly kind: "output-unreachable-under-routing";
      readonly outputNodeId: NodeId;
      readonly missedFromNode: NodeId;
    }
  | { readonly kind: "predicate-malformed"; readonly nodeId: NodeId; readonly message: string }
  | { readonly kind: "duplicate-edge"; readonly fromNodeId: NodeId; readonly toNodeId: NodeId }
  | {
      /**
       * A node has zero incoming edges but is not a source node (C0 / 0.2.0).
       * Under 0.2.0 semantics no node implicitly receives the DAG input: a root
       * is by definition a *source* (build it with `createSourceNode`, which
       * sets `isSource: true`), and any other consumption of the request must flow over
       * an explicit `DAG_INPUT` edge. This replaces the old "root inputSchema
       * matches the DAG inputSchema" rule with a structural one.
       */
      readonly kind: "root-expects-input";
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | {
      /**
       * A node marked `isSource` has at least one incoming edge. A source
       * produces from the context alone and consumes no input, so an incoming
       * edge (including a `DAG_INPUT` edge) is a definition error — drop the
       * `isSource` form and accept the input, or remove the edge.
       */
      readonly kind: "source-has-incoming";
      readonly nodeId: NodeId;
      readonly message: string;
    }
  | {
      /**
       * A `DAG_INPUT` edge is malformed: `$input` appears as a `to` target, or
       * carries conditional/default routing semantics. The virtual request
       * source can only be an unconditional `from`. The offending edge endpoints
       * are carried verbatim as raw strings — one end is `$input`, which is the
       * virtual request source, not a real (brandable) node id.
       */
      readonly kind: "invalid-dag-input-edge";
      readonly edge: { readonly from: string; readonly to: string };
      readonly message: string;
    }
  | {
      /**
       * Emitted at run start when one or more nodes declare a capability
       * (`requires: ["llm"]`, etc.) that the wired NodeContext does not
       * supply. The run aborts before any `node.run` is called.
       *
       * `missing` is a non-empty tuple — an error of this kind always names at
       * least one gap, so `missing[0]` is the guaranteed first miss (read it
       * for single-gap programmatic access). The full tuple lists every
       * `(nodeId, capability)` pair so callers can fix all gaps in one pass
       * instead of replaying the run for each field. The first miss is *not*
       * duplicated as scalar fields — that would be a representable illegal
       * state (scalar disagreeing with `missing[0]`).
       */
      readonly kind: "missing-capability";
      readonly missing: readonly [MissingCapability, ...MissingCapability[]];
    }
  | {
      /**
       * Emitted by the host's metered LLM decorator (FR-W1-003) when a per-run
       * token budget is reached. The admission check runs BEFORE the call:
       * it refuses when the SETTLED cumulative has reached `budget`, or when
       * settled cumulative plus the learned reservation for admitted-but-
       * unsettled concurrent calls projects past it — so a refusal can fire
       * while `cumulative` is still below `budget`. Concurrent overshoot is
       * bounded (FR-W1-004): the first parallel burst (reservation estimate
       * still unlearned) may overshoot by up to that burst's call count;
       * thereafter the per-call reservation bounds it.
       */
      readonly kind: "llm-budget-exceeded";
      readonly runId: RunId;
      readonly nodeId: NodeId;
      /**
       * Cumulative tokens already SETTLED (consumed) by this run before the
       * refused call. Excludes the in-flight reservation estimate that may
       * have triggered the refusal — that projection lives in the host's
       * `llm.metered` warn log, not here, so this figure always reconciles
       * against the metered totals.
       */
      readonly cumulative: number;
      /** Configured per-run budget (`llmBudgetTokens`) that was reached. */
      readonly budget: number;
    }
  | {
      /**
       * The capability broker could not reach the identity provider / token
       * endpoint to mint or exchange a token — a TRANSIENT infrastructure
       * failure (Keycloak down, DNS/socket error, 5xx from the mint endpoint),
       * NOT an authorization decision. Callers may retry. Kept deliberately
       * DISTINCT from `downstream-denied` (FR-X-002): a denial is a settled
       * authorization answer ("no"), whereas `infra-unreachable` is "we never
       * got an answer". Conflating the two would make a retry loop hammer a
       * provider that has already said no, or fail-closed on a blip that a
       * retry would clear.
       *
       * `operation` names the ROLE of the broker hop that failed, as a closed
       * literal union so a consumer can branch on it exhaustively. The roles
       * are provider-agnostic on purpose (ADR-0054: no vendor literal crosses
       * the framework boundary; ADR-0059 amendment 2026-06-12):
       *   - `mint`       — acquiring a fresh token from the local IdP
       *                    (e.g. a client-credentials grant),
       *   - `exchange`   — exchanging one local token for another
       *                    (e.g. Token Exchange V2),
       *   - `federation` — crossing a trust boundary into an external IdP
       *                    (e.g. an Entra WIF exchange),
       *   - `downstream` — the final resource request (e.g. Graph/Dynamics).
       * `hop` carries the host-specific hop name for audit/diagnostics
       * (free-form: each embedder names its own topology), and `message` the
       * diagnostic detail (status line, socket error). (FR-X-001)
       */
      readonly kind: "infra-unreachable";
      readonly operation: "mint" | "exchange" | "federation" | "downstream";
      readonly hop: string;
      readonly message: string;
    }
  | {
      /**
       * A required scope is not assigned to the agent's client in the identity
       * provider's policy — an AUTHORIZATION refusal raised FAIL-CLOSED by the
       * broker's local policy check BEFORE any downstream (Entra) call is made
       * (FR-X-001). This is the cheap, deterministic gate: if the agent client
       * was never granted `scope`, there is no point minting or exchanging a
       * token, so the broker refuses up front. Because it precedes any network
       * call it is never transient and must never be retried — distinct from
       * `infra-unreachable`.
       *
       * `scope` is the unassigned scope that triggered the refusal.
       *
       * `agentClientId` is the agent client whose policy lacks the scope (the
       * same id carried on `InvocationOrigin`), so an assignment-time refusal is
       * attributable to a concrete client without re-deriving identity. It is
       * OPTIONAL because a refusal has two possible origins:
       *   - PARSE-TIME (an unrecognised scope name, no client known yet): the
       *     field is ABSENT. NOTE: this origin is currently unrealised in
       *     production — the host's scope parser models "not a downstream
       *     scope" as first-class absence (`DownstreamScope | undefined`), not
       *     a refusal: an unknown name in a node's `requires` defers to
       *     run-start `missing-capability`, and the boot-time
       *     `AGENT_CLIENT_SCOPES` policy validator rejects a typo'd entry at
       *     startup instead. So all emitted refusals today are
       *     assignment-time. The variant keeps the absent-field shape for
       *     parsers that DO choose to surface it.
       *   - ASSIGNMENT-TIME (the broker, with a known client, finds the scope
       *     unassigned): the field is PRESENT and names that client.
       * Modelling absence as an absent field (not an empty string) keeps the
       * "unknown client" state honest rather than representable-but-illegal.
       * (FR-X-001)
       */
      readonly kind: "policy-refusal";
      readonly scope: string;
      readonly agentClientId?: string;
    }
  | {
      /**
       * A downstream identity decision rejected the invocation: an Entra
       * Federated Identity Credential (FIC) subject/issuer mismatch, a Workload
       * Identity Federation (WIF) rejection, or a resource-scoping denial.
       * These are deliberately COLLAPSED into one authorization category
       * (FR-X-002): from the node's perspective they are all "the downstream
       * said no", and a settled "no" is handled identically (fail-closed, no
       * retry) regardless of which mechanism produced it. Kept DISTINCT from
       * `infra-unreachable` — a denial is an answer, not an outage — so retry
       * policy can branch on the kind alone.
       *
       * `resource` is the downstream resource/audience that was refused (e.g. a
       * Graph or Dynamics resource id); `reason` carries the provider's stated
       * cause (FIC mismatch, audience not permitted) for the audit record.
       * (FR-X-002)
       */
      readonly kind: "downstream-denied";
      readonly resource: string;
      readonly reason: string;
    };

/** Discriminant union of all error kinds — use for consumer-side exhaustive switches. */
export type FrameworkErrorKind = FrameworkError["kind"];

/**
 * Extract the partial token usage carried by a failed call, if any. Only the
 * tool-use-loop error variants (`node-crash`, `transient`, `aborted`) carry
 * usage; every other kind reads as `undefined` (no attributable tokens). Lets
 * the metering shell attribute consumed tokens on the `Err` path without
 * widening every call site to know which variants carry usage (FR-W0-001).
 */
export const usageOfError = (e: FrameworkError): PartialTokenUsage | undefined =>
  match(e)
    .with({ kind: "node-crash" }, (e) => e.usage)
    .with({ kind: "transient" }, (e) => e.usage)
    .with({ kind: "aborted" }, (e) => e.usage)
    // Every other kind carries no attributable tokens. Listed exhaustively (not
    // `.otherwise`) so adding a new `usage?`-carrying variant without extending
    // the three arms above is a COMPILE error here — it can never silently drop
    // burned tokens and regress FR-W0-001's 100% attribution.
    .with(
      { kind: "validation" },
      { kind: "retry-exhausted" },
      { kind: "checkpoint-missing" },
      { kind: "checkpoint-expired" },
      { kind: "checkpoint-corrupt" },
      { kind: "checkpoint-version-mismatch" },
      { kind: "checkpoint-write-failed" },
      { kind: "prompt-not-found" },
      { kind: "cache-error" },
      { kind: "cycle-detected" },
      { kind: "rejected" },
      { kind: "invalid-reroute" },
      { kind: "missing-default-edge" },
      { kind: "output-unreachable-under-routing" },
      { kind: "predicate-malformed" },
      { kind: "duplicate-edge" },
      { kind: "root-expects-input" },
      { kind: "source-has-incoming" },
      { kind: "invalid-dag-input-edge" },
      { kind: "missing-capability" },
      { kind: "llm-budget-exceeded" },
      { kind: "infra-unreachable" },
      { kind: "policy-refusal" },
      { kind: "downstream-denied" },
      () => undefined,
    )
    .exhaustive();

/**
 * Retriability of a `FrameworkError` — the SINGLE source of truth for the DAG
 * retry machinery's fast-fail-vs-retry fork (`handleNodeFailed`). Retriability
 * is the defining behavioral axis of the whole taxonomy, so it lives here, on
 * the type's own module, as a TOTAL function the compiler forces to be
 * exhaustive: adding a new error kind without classifying it is a compile
 * error, and a new kind can never silently default to "retriable" (the unsafe,
 * non-fail-closed direction that a hand-maintained boolean disjunction allowed).
 *
 * `"non-retriable"` = a deterministic failure that re-running cannot clear;
 * `handleNodeFailed` fast-fails it, preserving the retry budget for genuinely
 * transient kinds. See that function for the per-kind rationale (settled auth
 * denials, tool-loop exhaustion, schema mismatches, budget exhaustion, …).
 */
export type Retriability = "retriable" | "non-retriable";

export const retriabilityOf = (e: FrameworkError): Retriability =>
  match(e)
    // `node-crash` carries its own explicit retriability discriminant.
    .with({ kind: "node-crash" }, (c) => c.retriability)
    // Deterministic failures — re-execution reproduces them, so fast-fail.
    .with(
      { kind: "predicate-malformed" },
      { kind: "validation" },
      { kind: "checkpoint-write-failed" },
      { kind: "aborted" },
      { kind: "policy-refusal" },
      { kind: "downstream-denied" },
      { kind: "llm-budget-exceeded" },
      { kind: "missing-capability" },
      () => "non-retriable" as const,
    )
    // Everything else goes through the standard backoff path. The graph-
    // structural kinds (cycle-detected, duplicate-edge, root-expects-input, …)
    // are emitted at validation time and never reach the retry machinery, so
    // their `"retriable"` label is nominal — it faithfully preserves the
    // historical fall-through default rather than asserting they would retry.
    .with(
      { kind: "transient" },
      { kind: "retry-exhausted" },
      { kind: "checkpoint-missing" },
      { kind: "checkpoint-expired" },
      { kind: "checkpoint-corrupt" },
      { kind: "checkpoint-version-mismatch" },
      { kind: "prompt-not-found" },
      { kind: "cache-error" },
      { kind: "cycle-detected" },
      { kind: "rejected" },
      { kind: "invalid-reroute" },
      { kind: "missing-default-edge" },
      { kind: "output-unreachable-under-routing" },
      { kind: "duplicate-edge" },
      { kind: "root-expects-input" },
      { kind: "source-has-incoming" },
      { kind: "invalid-dag-input-edge" },
      { kind: "infra-unreachable" },
      () => "retriable" as const,
    )
    .exhaustive();

/**
 * The human-readable summary threaded into `retry-exhausted.lastError`.
 * `node-crash`/`transient` carry a purpose-written `message`; every other kind
 * has no single message field, so its structured payload is JSON-stringified so
 * nothing is lost. Single source of truth for the retry-policy call sites, which
 * would otherwise each re-list the `node-crash | transient` carrier set and drift.
 */
export const messageOf = (e: FrameworkError): string =>
  e.kind === "node-crash" || e.kind === "transient" ? e.message : JSON.stringify(e);

/**
 * Human-readable single-line summary of a FrameworkError. Exhaustive —
 * adding a new `kind` without a case here is a compile error via
 * ts-pattern's `.exhaustive()`.
 */
export const formatFrameworkError = (e: FrameworkError): string =>
  match(e)
    .with({ kind: "validation" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "missing-default-edge" }, (e) => `node '${e.nodeId}' has conditional out-edges but no default edge`)
    .with({ kind: "output-unreachable-under-routing" }, (e) => `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`)
    .with({ kind: "duplicate-edge" }, (e) => `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`)
    .with({ kind: "root-expects-input" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "source-has-incoming" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "invalid-dag-input-edge" }, (e) => `${e.message} ('${e.edge.from}' -> '${e.edge.to}')`)
    .with({ kind: "predicate-malformed" }, (e) => `${e.message} (node '${e.nodeId}')`)
    .with({ kind: "cycle-detected" }, (e) => `cycle detected: ${e.nodeIds.join(" -> ")}`)
    .with({ kind: "retry-exhausted" }, (e) => `node '${e.nodeId}' exhausted ${e.attempts} retries (root: ${e.rootErrorKind}): ${e.lastError}`)
    .with({ kind: "node-crash" }, (e) => `node '${e.nodeId}' crashed (${e.retriability}): ${e.message}`)
    .with({ kind: "aborted" }, (e) => `run aborted: ${e.reason}`)
    .with({ kind: "rejected" }, (e) => `node '${e.nodeId}' rejected: ${e.reason}`)
    .with({ kind: "transient" }, (e) => `node '${e.nodeId}' transient failure: ${e.message}`)
    .with({ kind: "prompt-not-found" }, (e) => `prompt '${e.promptName}' not found: ${e.reason}`)
    .with({ kind: "cache-error" }, (e) => `cache ${e.operation} failed: ${e.message}`)
    .with({ kind: "invalid-reroute" }, (e) => `invalid reroute to '${e.targetNodeId}': ${e.message}`)
    .with({ kind: "checkpoint-missing" }, (e) => `checkpoint missing for run '${e.runId}'`)
    .with({ kind: "checkpoint-expired" }, (e) => `checkpoint for run '${e.runId}' expired at ${e.expiredAt}`)
    .with({ kind: "checkpoint-corrupt" }, (e) => `checkpoint corrupt for run '${e.runId}'${e.nodeId ? ` (node '${e.nodeId}')` : ""}: ${e.message}`)
    .with({ kind: "checkpoint-version-mismatch" }, (e) => `checkpoint version mismatch for run '${e.runId}': expected '${e.expected}', got '${e.actual ?? "undefined"}'`)
    .with({ kind: "checkpoint-write-failed" }, (e) => `checkpoint write failed for run '${e.runId}' node '${e.nodeId}': ${e.message}`)
    .with({ kind: "missing-capability" }, (e) => `missing capabilities: ${e.missing.map(m => `${m.capability} (node '${m.nodeId}')`).join(", ")}`)
    .with({ kind: "llm-budget-exceeded" }, (e) => `llm budget exceeded for run '${e.runId}' (node '${e.nodeId}'): cumulative ${e.cumulative} tokens reached budget ${e.budget}`)
    .with({ kind: "infra-unreachable" }, (e) => `capability provider unreachable during '${e.operation}' (hop '${e.hop}'): ${e.message}`)
    .with({ kind: "policy-refusal" }, (e) =>
      e.agentClientId !== undefined
        ? `policy refusal: scope '${e.scope}' not assigned to agent client '${e.agentClientId}'`
        : `policy refusal: scope '${e.scope}' not recognised (agent client unknown)`)
    .with({ kind: "downstream-denied" }, (e) => `downstream denied resource '${e.resource}': ${e.reason}`)
    .exhaustive();

/**
 * Error subclass thrown by `runDagAsWorkerJob` so queue adapters (BullMQ)
 * can access the structured framework error after serialization round-trips.
 *
 * Queue workers catch this and see typed fields (`frameworkErrorKind`,
 * `frameworkErrorJson`) instead of parsing the message string. The original
 * `FrameworkError` is also available via `Error.cause`.
 */
export class FrameworkAugmentedError extends Error {
  readonly frameworkErrorKind: FrameworkError["kind"];
  readonly frameworkErrorJson: string;

  constructor(message: string, error: FrameworkError) {
    super(message, { cause: error });
    this.name = "FrameworkAugmentedError";
    this.frameworkErrorKind = error.kind;
    this.frameworkErrorJson = JSON.stringify(error);
  }
}
