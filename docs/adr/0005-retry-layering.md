# ADR 0005: Retry layering — machine inner loop, queue outer crash fallback

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** OQ-3, FR-007, FR-011, FR-027 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0008 (`onHumanReview` hook-crash retry — a distinct retry class scoped to the HITL hook, not the node).

## Context

The durable runtime sits between two retry-capable layers. The state machine has its own per-state and per-node retry budgets (`Machine.maxRetries`, `DagDef.retryLimits`, `NodeDef.retry`) for handling expected transient failures — LLM timeouts, HTTP 429s, brief upstream blips. BullMQ, sitting above the runner, has its own `attempts` / `backoff` knobs that re-pick a job after a worker crash, lock loss, or unhandled exception.

Both can fire on the same failure. Without an explicit precedence rule:

- A transient LLM timeout might consume one machine retry **and** one queue attempt, double-counting the budget.
- A worker process death mid-run loses its in-memory retry counter — the next queue attempt has no idea how many retries the previous incarnation already burned.
- Callers reasoning about the total retry surface have to mentally compose two independent policies, which is error-prone.

Spec OQ-3 raised this directly: *"When the queue backend's retry attempts are exhausted but the in-machine retry budget is not (or vice versa), which authority wins?"* The runtime needs a single, documented precedence so behavior is predictable from a single source of truth (the persisted checkpoint), and so the two layers compose rather than collide.

## Options Considered

1. **Two-layer retry policy with explicit precedence (chosen).**
   - Pros:
     - Inner loop stays "smart" — typed errors, per-state caps, custom backoff, no Redis round-trip per transient failure.
     - Outer loop stays "dumb but durable" — survives crashes, lock loss, worker restart.
     - Clean composition: the runner throws on terminal `failed` (FR-007) so the queue can apply its own policy on top.
     - Matches reclaw's production layering — known-good pattern.
   - Cons:
     - Two policies to configure; callers need to understand the boundary.
     - Counters reset on a fresh queue attempt (FR-011) — a worker that dies mid-retry-storm gets a "free" reset of the inner budget. Accepted: persisted checkpoint state is the source of truth, and retries-since-crash is a different concern from retries-within-attempt.

2. **Machine-only retries; queue `attempts = 1`.**
   - Pros:
     - One policy to reason about. No layering.
   - Cons:
     - Process death = lost retry budget with no recovery. A crash mid-DAG terminates the run.
     - No protection against lock loss or worker eviction — exactly the failures BullMQ exists to handle.
     - Defeats the whole point of putting a queue in front of the runner.

3. **Queue-only retries; machine `maxRetries = 0`.**
   - Pros:
     - One policy to reason about. Crash recovery for free.
   - Cons:
     - Loses per-state granularity. A node that wants 5 retries on 429 and 1 retry on schema-validation failure can't express that.
     - Every transient failure costs a Redis round-trip, a worker re-pickup, and a job-state rehydration. Latency cost on hot paths (e.g. LLM 429 storms) is non-trivial.
     - Backoff is uniform across all node failures — no way to tune per state.

4. **Cap totals across layers (e.g. `total_attempts = machine_retries + queue_attempts`).**
   - Pros:
     - One conceptual budget for callers.
   - Cons:
     - Couples two layers that should be independent. The machine would need to know the queue's remaining budget on every transition.
     - Untestable in pure form — `dagTransition` would need access to queue state, breaking FR-021's "no I/O" contract.
     - Surprising for callers: a crash near the budget cap could exhaust everything in a single fresh attempt. Hard to reason about.

## Decision

**Adopt a two-layer retry policy with documented precedence: the machine retries inside one queue attempt; the queue retries across queue attempts; counters reset on each fresh attempt.**

Layering rules:

1. **Inner loop (machine-level).** `Machine.maxRetries` (kernel) and `DagDef.retryLimits` / `NodeDef.retry` (DAG layer) handle expected transient failures *inside one queue attempt*. The runner does **not** give the job back to the queue between machine retries — it loops in `runStateMachine` applying `dagTransition` outputs (`retrying` / `retrying-hook` phases) and sleeping per-attempt backoff (FR-027: exponential, 1s/2s/4s default + jitter, configurable per-node via `NodeDef.retry`).

2. **Outer fallback (queue-level).** BullMQ `attempts` / `backoff` cover process crashes, lock loss, and exhaustion of the inner loop. The queue is the only authority for "the worker is gone."

3. **Throw on terminal failed (FR-007).** When `dagTransition` produces a terminal `failed` phase, `runStateMachine` throws after persisting the final checkpoint. The thrown error is what the queue's outer loop sees — the queue then applies its own `attempts` policy. If the queue exhausts, the dead-letter handler fires (FR-044).

4. **Counters reset on fresh queue attempt (FR-011).** `runStateMachine` resets transient retry counters (`ctx.retries`, per-state attempt maps) at invocation start. The persisted checkpoint state — current phase, completed nodes, outputs — is the source of truth across attempts. A worker restart resumes from the checkpoint with a clean inner-retry budget; it does **not** inherit stale counters from a previous worker's memory.

Concrete components:

- `packages/framework/src/state-machine/runner.ts` — owns the inner loop. Resets counters on entry. Throws on terminal `failed`.
- `packages/framework/src/dag-runtime/transition.ts` — pure. Decides `retrying` vs. terminal `failed` from `ctx.retries.get(nodeId)` against `retryLimits`. No knowledge of the queue.
- `packages/framework/src/queue/bullmq-adapter.ts` — passes through BullMQ's native `attempts` / `backoff` config. Does not parse or interpret machine retries.

Invariant: **the inner loop never enqueues, and the outer loop never inspects machine state.** They communicate exclusively through `throw` (machine → queue) and `runStateMachine` invocation (queue → machine).

## Consequences

**Positive:**

- Transient failures (LLM timeout, 429) recover in-process without Redis round-trips — fast path stays fast.
- Process crashes recover via the queue — durability invariants hold.
- Each layer is independently testable: `dagTransition` is pure (no queue knowledge), the BullMQ adapter is integration-tested against a live Redis (no machine knowledge).
- Callers can reason about each policy independently and tune them for different failure modes.
- The "throw on terminal failed" contract gives the queue a single, well-defined signal — no protocol negotiation between layers.

**Negative:**

- Two policies to configure. Callers who want a single budget have to compute it themselves (e.g. "I want at most 6 total tries: set node retries to 2 and queue attempts to 3").
- Counter reset on fresh attempt means a pathological crash loop *could* burn far more retries than either policy alone permits (a node that crashes the worker on every attempt gets a fresh inner budget on each queue re-pickup). Mitigation: queue `attempts` caps the outer loop; dead-letter notifier (FR-044) fires once at exhaustion. Accepted: this is the cost of crash recovery without inter-layer counter sync.
- The "machine retries don't survive a crash" property must be communicated to operators reading metrics — a `retry_count` from the trace stream is per-attempt, not lifetime.
- Future requirement to cap totals across layers would require either (a) plumbing queue-attempt count into `Machine` context, or (b) a thin wrapper above `runStateMachine` that does the math. Either is doable, but neither is built today.
