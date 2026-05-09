# ADR 0009: `runDag` routing is driven by node config, not call-site opts

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** SC-001 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Supersedes (in part):** ADR 0007 — the routing predicate it described silently dropped HITL semantics for some DAGs.

## Context

ADR 0007 established the legacy-vs-state-machine routing predicate as a presence-of-opts check:

```ts
const useStateMachinePath =
  opts?.jobLike !== undefined ||
  opts?.onHumanReview !== undefined ||
  opts?.retryLimits !== undefined;
```

This predicate has a quiet defect: HITL is declared on the **node** (`NodeDef.humanReview`), not in opts. A DAG with `humanReview` nodes but no `onHumanReview` hook in the call's opts goes through the legacy path — which has no awareness of `humanReview` at all — and runs to completion without ever pausing for review. The HITL contract is silently dropped.

The same predicate also conflates two distinct meanings of `onHumanReview`:

1. *the hook implementation* (what to do when a node pauses for review), and
2. *a routing toggle* ("send me through the state-machine path").

Callers who supply `onHumanReview` against a DAG that does not declare any `humanReview` node pay for the durable runtime with no observable benefit — the review queue is always empty, the hook never fires.

## Options Considered

1. **Keep opts-driven routing; document the footgun.** Add a comment warning that `humanReview` nodes need `onHumanReview` in opts, and that supplying `onHumanReview` without a `humanReview` node is wasteful.
   - Pros: zero code change.
   - Cons: relies on every caller reading the comment. The defect is silent — no error, no test, no CI signal. A "documented footgun" is not a contract.

2. **Auto-promote: detect `humanReview` nodes and require the hook; otherwise reject.** The DAG declares the contract; opts must satisfy it. Routing follows automatically.
   - Pros: contract is enforced at the boundary. The two roles of `onHumanReview` (hook supplier vs. routing toggle) collapse into one (hook supplier only). Misconfiguration fails loudly with a clear message.
   - Cons: existing tests written against the opts-driven semantics need to be reshaped (`mkSimpleDag` + `onHumanReview` no longer routes through SM — it now errors).

3. **Discriminated-union RunOptions.** Force callers to opt into a "state-machine call" type explicitly via a tag.
   - Pros: type system enforces the path choice. No predicate at all.
   - Cons: callsite verbosity (every legacy call needs a tag); larger refactor; doesn't solve the "node says HITL, caller forgot the hook" case any better than (2) does.

## Decision

**Source of truth for HITL routing is node config. Opts only supply hooks and toggles, never silently flip routing for HITL.**

Concrete shape (in `packages/framework/src/executor/executor.ts`):

```ts
const hitlNodes = dag.nodes.filter((n) => n.humanReview !== undefined);
const dagDeclaresHITL = hitlNodes.length > 0;

if (dagDeclaresHITL && !opts?.onHumanReview) {
  return err({ kind: "node-crash", nodeId: "__executor__",
    message: `[runDag] DAG declares humanReview node(s) [${hitlNodes.map(n => n.id).join(", ")}] but no \`onHumanReview\` hook supplied` });
}
if (!dagDeclaresHITL && opts?.onHumanReview !== undefined) {
  return err({ kind: "node-crash", nodeId: "__executor__",
    message: "[runDag] `onHumanReview` hook supplied but no node declares `humanReview`" });
}

const useStateMachinePath =
  dagDeclaresHITL ||
  opts?.jobLike !== undefined ||
  opts?.retryLimits !== undefined;
```

**Three rules, each load-bearing:**

1. *DAG declares HITL → hook is mandatory.* Otherwise the runtime would route through the legacy path, lose the review semantics, and complete the run as if `humanReview` weren't there.
2. *Hook supplied but no DAG node declares HITL → error.* Symmetrical contract; prevents callers from paying the durable-runtime overhead for a gate that can never trigger, and surfaces likely misconfiguration (caller intended a different DAG, or forgot to mark a node).
3. *`onHumanReview` is no longer in the routing disjunction.* It supplies the hook — nothing more. Routing is `dagDeclaresHITL || jobLike || retryLimits`.

**Invariants preserved:**

- `resume` and `onBackground` remain incompatible with the state-machine path (unchanged from ADR 0007); the rejection message is updated to name the new triggers (`humanReview` node, `jobLike`, `retryLimits`).
- The legacy fast path (no `humanReview` nodes, no `jobLike`, no `retryLimits`) continues to take `runDagInner` byte-for-byte.

## Consequences

**Positive:**

- The HITL contract is enforced at the boundary. A DAG that declares `humanReview` cannot silently degrade to a runtime that ignores it.
- `onHumanReview` is single-purpose. Reviewers don't have to ask "is this a hook, or a routing trigger, or both?" — it's the hook.
- Misconfiguration produces an immediate, named error pointing at the offending node ids; debugging is direct rather than archaeological.
- The routing predicate now reads as the actual semantics: "use the state machine when the DAG needs HITL or when the caller asked for durability/retry."

**Negative:**

- Existing tests that passed `onHumanReview` against a non-HITL DAG to "trigger the state-machine path" no longer do so — they now error. Those tests have been reshaped to use a real `humanReview` DAG.
- A caller building a DAG dynamically must conditionally pass `onHumanReview` based on whether any built node has `humanReview`. This is the right contract — not a wart — but is a behavior change for any caller doing the wrong thing previously.

## Migration

- Tests in `executor.test.ts` covering `onHumanReview`-routes-to-state-machine were rewritten to use `mkHitlDag` (DAG with one `humanReview` node) so the routing trigger is the node config, not the opts.
- New validation tests cover both rejection arms (HITL node + no hook; hook + no HITL node).
- ADR 0007's predicate snippet is now historical context; the runtime predicate matches this ADR. ADR 0007 remains as the rationale for *having* a routing shim at all; this ADR records *what* the routing predicate looks at.

## Open question deferred

Phase 5 of the durable-runtime migration (collapsing the two paths once all consumers move to durable runs) is unchanged by this ADR. When the legacy path is removed, the validation rules in this ADR move into `runDagStateful`'s entry, and the `useStateMachinePath` disjunction goes away.
