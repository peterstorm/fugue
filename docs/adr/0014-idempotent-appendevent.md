# ADR 0014: Idempotent `appendEvent` via deterministic dedup keys

**Status:** Accepted
**Date:** 2026-05-10
**Spec ref:** FR-005 (checkpoint-after-transition), FR-048 (event log)
**Related:** ADR 0006 (`JobLike` minimal write-side), ADR 0008 (event envelope)
**Plan:** `docs/plans/2026-05-10-pr-review-remediation-followup.md` (wave 4.2)

## Context

The runner persists each successful transition in two steps:

```ts
await job.appendEvent(event);
await job.updateData({ state, context });
```

A worker crash between the two writes leaves the durable state at the *prior* state while the event log already records the transition. When the queue retries the job, the runner re-derives the same transition (same prior state, same executor output, same event) and calls `appendEvent` again — producing a *duplicate* event in the log.

Until this ADR, the runner accepted that duplication and documented "at-least-once event delivery" as a contract. Replay consumers had to tolerate duplicates. That was a documented hole in the audit trail.

## Decision

Make `appendEvent` idempotent on a **deterministic per-transition key**. The runner stamps each call with a key derived from inputs that survive the crash (the prior state's serialization, the per-state attempt counter visible at that point, and the event's discriminator). Adapters dedup against the most recent stream entry's key; if it matches, the second call is a no-op.

```ts
appendEvent(event: unknown, dedupKey?: string): Promise<void>;
```

`dedupKey` is optional for back-compat. Adapters that don't support dedup ignore it (and accept the at-least-once window as before).

### Key derivation

```ts
const dedupKey = sha256(`${prevStateKey}|${attemptNumber}|${eventTypeOf(event)}`).slice(0, 16);
```

- `prevStateKey` — `JSON.stringify(prevState)` already computed by the runner.
- `attemptNumber` — `retryCounters.get(prevStateKey) ?? 0`. Best-effort: on a clean crash with no prior in-invocation retries on this state, the post-crash invocation re-derives the same number (0) and the dedup hits. With prior retries, the post-crash counter resets and the dedup may miss — duplication is then no worse than the pre-ADR behavior.
- `eventTypeOf` — the event's `type` field (the discriminator on `DagEvent` / `Event`); falls back to `"<event>"` for events without one.

16 hex chars (8 bytes) is enough to avoid collisions within a single job's stream.

### Adapter contract

- **In-memory** (`createInMemoryJob`) — track the last seen `dedupKey`; if the next call matches it, skip the push. Older keys are not remembered; the runner only re-derives the *most recent* transition.
- **BullMQ** (`adaptBullMQJob`) — before the `XADD`, do `XREVRANGE +/- COUNT 1` and inspect the most recent entry's `dedupKey` field. If it matches, no-op. Otherwise `XADD` with `dedupKey` as an extra field. BullMQ's per-job lock guarantees no concurrent appends from other workers, so the read-then-write is race-free in practice.

### Reader compatibility

`createRedisStreamReader` decodes by indexing `payload`; the new `dedupKey` field is simply ignored. Pre-ADR streams (no `dedupKey` field on entries) read identically.

## Consequences

- **Audit trail integrity**: replay-to-timestamp queries no longer see duplicate transitions in the common crash-resume path.
- **At-most-once for the dominant case**: clean crash with no prior in-invocation retries on the failing state.
- **At-least-once tail**: when a transition crashed *after* a series of retries on the same state, the post-crash invocation may emit a duplicate event with a different `dedupKey`. This is acceptable — pre-ADR behavior was always at-least-once; we strictly improve.
- **Adapter contract widened**: `JobLike.appendEvent` accepts an optional second arg. Existing callers passing only `event` continue to work; existing implementations that ignore the extra arg continue to work but lose the dedup benefit.

The previous "at-least-once" docstring on `runner.ts` is removed.

## Status of the predecessor caveat

ADR 0006 frames `JobLike.appendEvent` as a minimal write-side primitive. The optional `dedupKey` is additive — it does not introduce a read API or query surface. The minimal-write-side principle holds.
