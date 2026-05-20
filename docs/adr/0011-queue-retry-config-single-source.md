# ADR 0011: Queue retry config has one source of truth — per-job attempts

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** FR-044 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0005 (retry layering).

## Context

The original `QueueBackend` API exposed two overlapping retry knobs:

- `QueueOpts.defaultAttempts` — declared but never wired through to BullMQ. The `_opts` parameter on `createQueue` was prefixed with `_` (ignored).
- `WorkerOpts.maxAttempts` — read by `createWorker`, stored on the worker, and passed verbatim to the dead-letter `onFailed` callback as the `max` argument. **It did not configure BullMQ's retry behavior.** A caller writing `createWorker(..., { maxAttempts: 3 })` against the BullMQ backend got: BullMQ retried once (its default), then `onFailed` reported `(attempts=1, max=3)` to the dead-letter handler — implying two more retries that never happened.

So three problems compounded:

1. The advertised `defaultAttempts` did nothing.
2. `maxAttempts` was a name that overpromised — it implied "configure BullMQ retry to 3" but actually meant "tell the dead-letter callback that max is 3."
3. The two fields lived on different option bags (`QueueOpts` vs `WorkerOpts`) which made it visually plausible that they were separate dials with separate purposes. They weren't — they were the same concept, both broken.

BullMQ's native retry model is per-job: each `Job.opts.attempts` is the cap for that specific job. `defaultJobOptions.attempts` on the `Queue` only seeds the per-job value when the producer doesn't override. The `failed` event handler can read `job.opts.attempts` to know the cap. There is no worker-level retry knob in BullMQ — workers don't decide retries; queues do.

## Options Considered

1. **Strict pairing: require `WorkerOpts.maxAttempts === QueueOpts.defaultAttempts`, validate at `createWorker`.** Keep both fields, enforce that they agree.
   - Pros: surfaces the duplication as a runtime check.
   - Cons: still two fields, still two knobs to remember. The "they must agree" rule is itself a workaround for "they shouldn't both exist."

2. **Lenient: keep `WorkerOpts.maxAttempts` purely as a dead-letter signal, rename to `dlqMaxAttempts`.** Document that it does not configure BullMQ retries.
   - Pros: minimal API churn.
   - Cons: still requires callers to set the same number twice (once on the queue, once on the worker, even if the worker version is just informational). "Why are there two?" remains a real question.

3. **Drop `WorkerOpts.maxAttempts` entirely. Wire `QueueOpts.defaultAttempts` to BullMQ's `defaultJobOptions.attempts`. Read the per-job max from `job.opts.attempts` in the `failed` listener.** One source of truth, aligned with BullMQ's native model.
   - Pros: matches BullMQ semantics exactly. No duplication; no field overlap; no "informational" fields. Producers control retry per-job (canonical) or via the queue default (also canonical).
   - Cons: existing tests that set `maxAttempts` on `createWorker` need to migrate to either `defaultAttempts` on `createQueue` or `attempts` on `enqueue`. The migration is mechanical.

## Decision

**Drop `WorkerOpts.maxAttempts`. Retry is configured per-job (`EnqueueOpts.attempts`) with a queue-level default (`QueueOpts.defaultAttempts`). The dead-letter `onFailed` callback receives `max` from `job.opts.attempts` (BullMQ) or from the per-entry record (in-memory).**

Concrete shape (in `packages/framework/src/queue/types.ts`):

```ts
export interface QueueOpts {
  /** Default attempts per job (overridable per-enqueue via EnqueueOpts.attempts).
   *  When omitted, jobs run with attempts = 1 (no retry). */
  readonly defaultAttempts?: number;
}

export interface EnqueueOpts {
  // ...
  /** Per-job max attempts; overrides QueueOpts.defaultAttempts. */
  readonly attempts?: number;
  // ...
}

export interface WorkerOpts {
  /** Max concurrent jobs. */
  readonly concurrency?: number;
  // (no maxAttempts — see ADR 0011)
}
```

In the BullMQ adapter (`queue-bullmq/adapter.ts`):

```ts
const queue = new Queue(name, {
  connection: bullConnection,
  defaultJobOptions:
    opts?.defaultAttempts !== undefined
      ? { attempts: opts.defaultAttempts }
      : undefined,
});

// ...

worker.on("failed", (job, error) => {
  const max = job.opts?.attempts ?? 1; // resolved by BullMQ from enqueue ?? defaults ?? 1
  handler(id, error, attemptsMade, max);
});
```

In the in-memory adapter, the drain loop reads the per-entry `attempts` (with the queue's `defaultAttempts` as fallback):

```ts
const max = entry.opts.attempts ?? defaults.defaultAttempts;
while (attempt < max && !succeeded) { /* ... */ }
```

**Why per-job is the canonical layer:**

Retry policy is a producer decision, not a worker decision. Different jobs in the same queue can legitimately want different retry budgets — a transient HTTP fetch may want 3 attempts, a one-shot bulk import may want 1. Putting the knob on the worker forced one budget across all jobs in the queue (the wrong granularity) and required the worker to know things the producer should own. BullMQ's per-job model is correct; the in-memory backend now mirrors it.

## Consequences

**Positive:**

- One source of truth for retry. There is no second field that "looks like" it controls retry but doesn't.
- BullMQ retries actually happen when the caller asks for them. `defaultAttempts: 3` configures the queue; `enqueue(..., { attempts: 5 })` overrides for that job.
- The dead-letter `onFailed` callback's `max` argument matches the actual cap BullMQ enforces (read from `job.opts.attempts`, not from a stale worker config).
- The two backends now have identical retry semantics: per-job cap, with queue default as fallback. Tests against in-memory exercise the same retry contract as production against BullMQ.
- `WorkerOpts` is now a single-purpose interface (concurrency only), making the worker/queue separation cleaner.

**Negative:**

- Tests that set `maxAttempts` on `createWorker` had to migrate. Two patterns:
  - `{ maxAttempts: N }` on `createWorker` + `enqueue(...)` → `enqueue(..., { attempts: N })`.
  - The retry-validation tests (`maxAttempts: 0/-1/NaN/Infinity`) moved to `createQueue` with `defaultAttempts` — semantically equivalent.
- The validation message changed from `"maxAttempts must be a finite integer >= 1"` to `"defaultAttempts must be a finite integer >= 1"`. Any downstream tooling matching on the old string would need updating; nothing in this repo does.

## Migration

- `WorkerOpts.maxAttempts` removed; `QueueOpts.defaultAttempts` validated at `createQueue` time on both backends.
- `WorkerHandle.onFailed` JSDoc clarified: `max` is per-job (`EnqueueOpts.attempts ?? QueueOpts.defaultAttempts ?? 1`).
- `attachDeadLetterHandler` is unchanged — it already operated on `(attempts, max)` arguments and never read worker-level config.
- All adapter tests updated to use either `defaultAttempts` (queue-level) or `attempts` (per-enqueue).
