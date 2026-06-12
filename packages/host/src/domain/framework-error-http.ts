/**
 * Framework error → HTTP classification (pure; review I4).
 *
 * A DAG run that ends in `Err(FrameworkError)` must map to an HTTP status that
 * tells the client what KIND of failure it was, and must decide whether the
 * failure should count against the per-DAG circuit breaker. The two decisions
 * are coupled — a settled authorization "no" is NOT a host malfunction:
 * returning 500 for it (a) misleads clients into retrying/alerting on a
 * deliberate denial, and (b) trips `markFailure`, so a burst of policy refusals
 * could OPEN the breaker for every caller of that DAG.
 *
 * Mapping:
 *   - `policy-refusal` / `downstream-denied` → 403. A settled "no" from the
 *     broker's local gate or the downstream identity provider. Fail-closed,
 *     never retried (ADR-0059) → does NOT count as a circuit failure.
 *   - `llm-budget-exceeded` → 429. A deterministic per-run usage limit, not a
 *     host fault → does NOT count as a circuit failure (one run hitting its
 *     budget must not open the breaker for everyone).
 *   - `infra-unreachable` → 503. A TRANSIENT provider-reach failure (the broker
 *     could not reach Keycloak/Entra). Retriable AND a real infra signal → it
 *     DOES count as a circuit failure.
 *   - `retry-exhausted` → classified by its `rootErrorKind`, NOT as a blanket
 *     500. The DAG retry machinery wraps a node error that exhausted its
 *     budget; the kind that matters for the client is the underlying one (an
 *     `infra-unreachable` that exhausted retries is still a 503-class outage).
 *     The settled kinds above fast-fail in the framework's retry policy and so
 *     normally arrive UNWRAPPED — unwrapping here is defense-in-depth so a
 *     wrapped settled "no" can never regress to 500 + breaker trip.
 *   - everything else (node-crash, validation, …) → 500, a genuine execution
 *     failure → counts as a circuit failure.
 *
 * Both matches are `.exhaustive()` ON PURPOSE: this classifier decides
 * 403-vs-500 AND breaker counting, so a newly added `FrameworkError` kind must
 * be a compile error here — silently defaulting a future refusal-flavoured
 * kind to `{500, countsAsCircuitFailure: true}` is exactly the I4 regression
 * class this module exists to prevent.
 *
 * `countsAsCircuitFailure` is consumed by the run handler: `true` → `markFailure`,
 * `false` → `markSuccess` (a settled refusal is a HEALTHY completion from the
 * breaker's view — the host did its job — and the half-open probe must always be
 * resolved one way or the other so it never wedges).
 */

import { match, P } from "ts-pattern";
import type { FrameworkError, FrameworkErrorKind } from "@fuguejs/framework";

export interface FrameworkErrorHttp {
  /** HTTP status to return to the client. */
  readonly status: number;
  /**
   * Whether this failure should increment the circuit breaker. `false` for
   * settled refusals / usage limits (the host functioned correctly); `true` for
   * genuine execution or infra failures.
   */
  readonly countsAsCircuitFailure: boolean;
  /** Optional `Retry-After` (seconds) for retriable/limit responses. */
  readonly retryAfterSeconds?: number;
}

const SETTLED_DENIAL: FrameworkErrorHttp = { status: 403, countsAsCircuitFailure: false };
const BUDGET_LIMIT: FrameworkErrorHttp = { status: 429, countsAsCircuitFailure: false, retryAfterSeconds: 60 };
const INFRA_OUTAGE: FrameworkErrorHttp = { status: 503, countsAsCircuitFailure: true, retryAfterSeconds: 5 };
const EXECUTION_FAILURE: FrameworkErrorHttp = { status: 500, countsAsCircuitFailure: true };

/**
 * Every kind that classifies as a genuine execution failure (500 + breaker).
 * Enumerated — not `.otherwise()` — so adding a `FrameworkError` kind without
 * deciding its classification fails to compile (in BOTH matches below).
 */
const EXECUTION_FAILURE_KINDS = [
  "validation",
  "checkpoint-missing",
  "checkpoint-expired",
  "checkpoint-corrupt",
  "checkpoint-version-mismatch",
  "checkpoint-write-failed",
  "prompt-not-found",
  "cache-error",
  "node-crash",
  "cycle-detected",
  "aborted",
  "rejected",
  "invalid-reroute",
  "transient",
  "missing-default-edge",
  "output-unreachable-under-routing",
  "predicate-malformed",
  "duplicate-edge",
  "missing-capability",
] as const;

/**
 * Classify the kind that exhausted a retry budget. `rootErrorKind` is a bare
 * discriminant (the wrapped error's payload is only available as `lastError`
 * text), so this matches on the kind string alone.
 */
const classifyRootKind = (
  kind: Exclude<FrameworkErrorKind, "retry-exhausted">,
): FrameworkErrorHttp =>
  match(kind)
    .with("policy-refusal", "downstream-denied", () => SETTLED_DENIAL)
    .with("llm-budget-exceeded", () => BUDGET_LIMIT)
    .with("infra-unreachable", () => INFRA_OUTAGE)
    .with(P.union(...EXECUTION_FAILURE_KINDS), () => EXECUTION_FAILURE)
    .exhaustive();

export const classifyFrameworkError = (error: FrameworkError): FrameworkErrorHttp =>
  match(error)
    // Settled authorization "no" — fail-closed, never retried, NOT a host fault.
    .with({ kind: "policy-refusal" }, () => SETTLED_DENIAL)
    .with({ kind: "downstream-denied" }, () => SETTLED_DENIAL)
    // Deterministic per-run usage limit — client should back off, not the host.
    .with({ kind: "llm-budget-exceeded" }, () => BUDGET_LIMIT)
    // Transient provider-reach failure — retriable AND a real infra signal.
    .with({ kind: "infra-unreachable" }, () => INFRA_OUTAGE)
    // Retry wrapper — classify by what actually exhausted the budget.
    .with({ kind: "retry-exhausted" }, (e) => classifyRootKind(e.rootErrorKind))
    // Every other kind is a genuine execution failure.
    .with({ kind: P.union(...EXECUTION_FAILURE_KINDS) }, () => EXECUTION_FAILURE)
    .exhaustive();
