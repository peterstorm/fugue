# ADR 0008: `onHumanReview` hook-crash retry — distinct from node retry

**Status:** Accepted
**Date:** 2026-05-08
**Spec ref:** FR-029a (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0001 (single-package layout), AD-2 (rundag back-compat).

## Context

A DAG node may declare `humanReview` config. When such a node finishes, the runtime transitions to `awaiting-human` and calls the caller-supplied `onHumanReview` hook (UI prompt, Slack, webhook, etc.). The hook resolves to a `HumanAction` (`approve` / `approve-with-edit` / `reject` / `reroute-back`), which the runtime applies via `human-responded`.

What happens if the hook itself **throws** (network failure to the review surface, transient backend error, hook-implementation bug)?

Two reasonable answers:

1. **Treat as node failure.** Re-run the node from scratch via the normal `retrying` path.
2. **Treat as hook failure.** Preserve the node's already-validated output, retry only the hook.

The distinction matters because:

- The node may be expensive (LLM call, external API, mutation).
- The node may be non-deterministic — a re-run can yield a different output, invalidating any review work already in flight.
- The node may have side effects that shouldn't repeat.
- A wave with multiple HITL nodes loses ordering invariants if one node is rerun.

FR-029 covered the `human-responded` happy path but was silent on hook crashes. An earlier implementation made `awaiting-human + node-failed` a transition no-op, causing an infinite loop when the hook threw repeatedly. A subsequent fix routed the crash to terminal `failed`, which discarded recoverable state. Neither was right.

## Decision

We model hook crashes as a distinct failure class with its own state.

A new `DagPhase` variant `retrying-hook`:

```ts
{ kind: "retrying-hook";
  nodeId: string;
  output: unknown;            // node's validated output, preserved
  prompt: string;             // original review prompt
  pendingReviews: readonly string[];
  wave: number;
  attempt: number;
  nextDelayMs: number; }
```

Transition rules:

- `awaiting-human` + `node-failed` (event carrying the hook crash):
  - If `ctx.retries.get(nodeId) < retryLimit` → transition to `retrying-hook` with `attempt = retries + 1` and `nextDelayMs = computeBackoffMs(...)`.
  - Else → terminal `failed` with `node-crash` carrying the latest hook error.
- `retrying-hook` + `human-responded` (hook recovered) → reconstruct an `awaiting-human` shape using the preserved `output`/`prompt` and apply `handleHumanResponse` (the normal action handling).
- `retrying-hook` + `node-failed` (hook threw again) → same retry-budget check as above.
- `retrying-hook` + `abort` → terminal `failed` (covered by the global abort handler).

Executor (`buildDagExecutor`) handles `retrying-hook` by sleeping `nextDelayMs * jitter` and re-calling `onHumanReview` with the preserved `output`/`prompt`. The node's `run` function is **not** re-executed.

The hook retry budget is shared with the node retry budget (one counter per `nodeId` in `ctx.retries`). A node that already consumed N retries during execution has at most `retryLimit - N` hook attempts remaining.

## Consequences

**Positive:**

- Transient hook failures (network blips to Slack, etc.) recover without operator intervention.
- Node outputs are not silently re-computed — observability and side-effect contracts hold.
- The `retrying-hook` state is durable: a process crash mid-retry resumes from the preserved phase state, not from `running`.
- Sequential-HITL ordering (FR-028) is preserved across hook retries.

**Negative:**

- New phase variant adds one more case to the exhaustive transition match. Anyone extending `DagPhase` must remember to handle `retrying-hook` in transition.ts, executor.ts, machine.ts, and run-dag-stateful.ts.
- Shared retry budget is a deliberate simplification. A future requirement to budget hook retries separately from node retries would require splitting `ctx.retries` into two counters.
- Hook implementations that are *deterministically* broken (config error, bad credentials) consume the full retry budget before failing — adds latency. We accept this; alternative would require classifying hook errors, which adds surface for limited gain.

## Alternatives considered

1. **Treat hook crashes as node failures (option 1 above).** Rejected: re-runs the node, discarding validated output and risking non-deterministic divergence.

2. **Add a `pendingHookRetry` counter to `awaiting-human` itself; no new phase.** Rejected: `awaiting-human` would then need to encode "currently waiting for input" vs. "scheduled to re-call hook in N ms" — overloading the same kind. A separate variant cleanly carries `nextDelayMs`.

3. **Separate hook retry budget.** Rejected for now (explicit shared-budget call in FR-029a). Easy to extend later if needed.

## Test coverage

- `dag-transition.test.ts` — `retrying-hook` lifecycle: 9+ pure tests including budget exhaustion, abort, `human-responded` recovery (approve / approve-with-edit / reject), wrong-nodeId no-op, threading of `pendingReviews`.
- `dag-runtime-stateful.test.ts` — `hook fails twice then succeeds` end-to-end test asserts `nodeRunCount === 1` while `hookCallCount === 3`. This is the regression guard for the no-re-run invariant.

## Implementation note

The `awaiting-human + node-failed` transition guards on `event.nodeId === phase.nodeId` and routes mismatched-nodeId failures to a no-op. This preserves FR-028 sequential-HITL ordering — a `node-failed` event for a different active reviewer must not collapse the current one. The `retrying-hook + node-failed` case applies the same guard.
