# ADR 0019: `runDag` routing predicate — full disjunction

**Status:** Accepted
**Date:** 2026-05-11
**Plan ref:** `docs/plans/2026-05-11-pr-review-remediation.md` §5.2
**Supersedes (in part):** ADR 0009 — its predicate covered only HITL + jobLike + retryLimits; this ADR extends it to retries-declared and conditional-edges-declared. ADR 0018 also amends by removing `onBackground` as a routing trigger.

## Context

ADR 0009 fixed the silent-HITL-drop in the original ADR 0007 predicate, but the routing surface has since grown:

- **Retries declared on the DAG.** A DAG with `defaultRetryLimit` or `retryLimits: {…}` set on `DagDef` requires the state-machine path — `runDagInner` has no retry loop. The pre-ADR-0019 predicate routed such DAGs through the legacy path and ignored the retry config entirely, producing silently zero-retry runs.
- **Conditional edges.** ADR 0015 introduced `EdgeDef.when` predicates and ADR 0016 added structural predicates. The active-set / pruning logic that makes these edges meaningful lives only in `runDagStateful` (via `decideRoute` and `computeIncomingByNode`). The legacy fast path has no concept of edge pruning. Without this routing trigger, a conditional edge in a DAG with no other SM trigger silently degrades to "edge is always active."
- **`onBackground` as routing trigger.** Removed by ADR 0018 — `onBackground` is now supported on both paths and routing is decided by *durability* requirements, not by tail-latency preferences.

The pre-existing predicate (post-ADR-0009) read:

```ts
const useStateMachinePath =
  dagDeclaresHITL ||
  opts?.jobLike !== undefined ||
  opts?.retryLimits !== undefined;
```

Two of three quiet defects fixed by this ADR:

1. **Silent retries drop.** `DagDef.defaultRetryLimit = 3` without `opts.retryLimits` and without HITL → legacy path → no retries.
2. **Silent conditional-edge drop.** A DAG with `EdgeDef.when` → legacy path → predicate ignored, all edges effectively unconditional.

Both produced runs that *looked* successful but had silently weaker behavior than the author declared. The fix is mechanical: extend the disjunction to cover every feature the SM path implements that the legacy path does not.

A third concern, surfaced by the architecture-tech-lead review:

3. **No-`jobLike` SM-path runs claim durability they don't deliver.** A caller can declare retries or conditional edges and run through the SM path with no `jobLike` — the SM path silently falls back to `createInMemoryJob`. That keeps the runtime semantics intact, but if the worker process crashes mid-run, all checkpoint state is lost. The user gets durability semantics *in-process* but no across-crash durability.

## Decision

**The runtime routing predicate is the full disjunction of "needs SM-path semantics":**

```ts
const useStateMachinePath =
  dagDeclaresHITL ||
  dagDeclaresRetries ||
  dagDeclaresConditionalEdges ||
  opts?.jobLike !== undefined ||
  opts?.retryLimits !== undefined;
```

Where:

- `dagDeclaresHITL` = `dag.nodes.some(n => n.humanReview !== undefined)` — unchanged from ADR 0009.
- `dagDeclaresRetries` = `dag.defaultRetryLimit !== undefined || (dag.retryLimits && Object.keys(dag.retryLimits).length > 0)`.
- `dagDeclaresConditionalEdges` = `dag.edges.some(e => isConditionalEdge(e) || isDefaultEdge(e))` — uses the type-guards from `types/dag.ts`.
- `opts?.jobLike !== undefined` — call-site supplies a durable job handle.
- `opts?.retryLimits !== undefined` — call-site overrides per-node retry budgets.

**`onBackground` is not in the disjunction** (ADR 0018). Its presence does not flip routing.

### No-`jobLike` warning

When `dagDeclaresRetries || dagDeclaresConditionalEdges` triggers SM-path routing **but `opts.jobLike` is not supplied**, `runDag` emits a one-line warning via `ctx.logger?.warn?.`:

> `[runDag] DAG declares retries/conditional edges but no \`jobLike\` provided — runtime semantics intact, but durability across worker crashes is not guaranteed.`

Suppressible via `opts.suppressRoutingWarnings: true` for callers that intentionally run SM-semantics in-memory (tests, transient batch jobs, fixture-driven examples).

HITL alone does not trigger the warning — a HITL DAG without `jobLike` is a common test-fixture shape, and the absence of `jobLike` is more clearly the caller's intent there.

### Bidirectional HITL contract retained

From ADR 0009 — unchanged:

- `dagDeclaresHITL && !opts.onHumanReview` → reject with `node-crash` error naming the offending node ids.
- `!dagDeclaresHITL && opts.onHumanReview !== undefined` → reject with `node-crash` error (likely misconfiguration: caller intended a different DAG or forgot to mark a node).

### `resume` × SM-path incompatibility retained

From ADR 0007, unchanged: `opts.resume` is the legacy-path-only checkpoint replay. If `useStateMachinePath` is `true` and `opts.resume` is also set, `runDag` returns a `node-crash` error directing the caller to use `jobLike.data.context.outputs` instead.

## Consequences

**Positive:**

- Three classes of silent-degradation removed: retries-declared, conditional-edges-declared, and no-`jobLike` durability-claim. All three now either *do* what the author declared or *say* (via warning or error) that they aren't doing it.
- The predicate's right-hand side now matches the SM path's feature set 1:1 — every feature `runDagStateful` implements that `runDagInner` does not is in the disjunction. New SM-only features will add one disjunct each.
- The warning gives operators a single search string (`"DAG declares retries/conditional edges"`) to find at-risk runs in production logs, before they crash.
- The HITL contract from ADR 0009 is preserved as-is — no regressions on the previously-documented behavior.

**Negative:**

- The disjunction grows with each SM-only feature, and the predicate is implicit coupling: adding a new feature without extending the predicate silently routes its callers to the legacy path. Mitigated by Wave 7 §7.3 — the planned legacy-path retirement collapses the two paths entirely. Once that lands, this ADR becomes historical context.
- The warning is `console.warn`-via-`Logger`, which means callers with `logger: null` get no signal. Suppressing it via `suppressRoutingWarnings` and silencing it via `logger: null` are semantically identical — the second is the more common test-suite path. The runtime contract (the *behavior*) is the same in both cases; the warning is operational signal only.
- The warning fires once per `runDag` call. For high-volume callers without `jobLike`, the log line is noise. Operators who don't want the warning should pass `suppressRoutingWarnings: true` at the call site — silencing the logger is a heavier hammer.

## Rejected alternatives

1. **Reject SM-path routing entirely when `jobLike` is missing.** Rejected — there are legitimate in-memory use cases (tests, fixture-driven CLI tools, transient batch jobs) where the caller knows the run won't survive a crash and just wants the SM semantics (retries, conditional edges). A hard rejection would break these. The warning is the right middle: visible, not blocking.

2. **Make `dagDeclaresRetries` / `dagDeclaresConditionalEdges` errors when `jobLike` is missing (not just warnings).** Rejected for the same reason — too aggressive for cases where in-memory is the intent.

3. **Encode the predicate as a method on `DagDef` (`dag.requiresStateMachine()`).** Considered. The predicate is half DAG-shape (HITL nodes, retries, conditional edges) and half call-site opts (`jobLike`, `retryLimits`). Splitting the encoding loses the unified-disjunction readability. Kept as a flat predicate at the routing site.

4. **Phase 5 retirement instead of extending the predicate.** Considered. Wave 7 §7.3 plans this; it is the right long-term fix. Until then, the predicate must be correct, because the legacy path is still reachable for the DAGs the predicate misses.

## Implementation note

The warning text is meant to be *grepped* by operators, not parsed by code. If you change it, update any production log alerts that key on `"DAG declares retries/conditional edges"`. The error messages produced by HITL contract violations (also grep-worthy) should be left alone unless coordinated with the alert side.

## Forward links

- ADR 0007 — original routing rationale (predicate amended).
- ADR 0009 — HITL contract (preserved).
- ADR 0018 — `onBackground` no longer a routing trigger.
- Wave 7 §7.3 in `docs/plans/2026-05-11-pr-review-remediation.md` — planned legacy-path retirement, which obsoletes the disjunction entirely.
