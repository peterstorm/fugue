# ADR 0010: Queue payload is fixed to `{state, context}` envelopes

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** FR-040, FR-041, FR-047 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0006 (JobLike minimal write-side).

## Context

Two `QueueBackend` implementations live side by side — `createInMemoryBackend` and `createBullMQBackend`. Both are expected to be drop-in interchangeable for tests vs. production. Both deliver work to a worker callback typed as `(job: JobLike<S, C>) => Promise<void>`, and the `JobLike` contract guarantees `job.data: { state: S; context: C }`.

Despite that shared contract, the two backends disagreed on what producers must enqueue:

- **BullMQ** (`adaptBullMQJob`) expected `bullJob.data: { state, context }` — i.e. the producer enqueued the envelope, the worker saw the envelope.
- **In-memory** (`queue/in-memory.ts` drain loop) wrapped whatever was enqueued *into* a synthetic envelope: `createInMemoryJob({ state: entry.data, context: undefined })`. So the producer enqueued raw state, the worker saw `{ state: rawState, context: undefined }`.

Concretely: a producer calling `queue.enqueue("j1", { state: "x", context: { y: 1 } })` against the in-memory backend got delivered to the worker as `{ state: { state: "x", context: { y: 1 } }, context: undefined }` — double-wrapped. Against BullMQ the same call delivered `{ state: "x", context: { y: 1 } }` — correct.

The divergence was invisible to either backend's test suite because each used its own enqueue shape. It would only surface in production when a caller swapped backends (e.g. tests → real Redis) and the worker started seeing a malformed `job.data`.

## Options Considered

1. **Document the divergence; let each backend define its own producer shape.**
   - Pros: zero code change.
   - Cons: ships a footgun. Producers can't write backend-agnostic code. Defeats the purpose of `QueueBackend` being an abstraction.

2. **Make in-memory match BullMQ — fix `{state, context}` as the envelope at the type level.** Producers always enqueue envelopes; both backends pass them through.
   - Pros: contract is single, expressed in types, enforced for both backends. Producer code is portable.
   - Cons: existing tests that enqueue raw values (`enqueue("j1", "hello")`) need updating.

3. **Make BullMQ match in-memory — auto-wrap on enqueue, auto-unwrap on receive.**
   - Pros: shorter producer call sites for simple cases (no envelope ceremony).
   - Cons: BullMQ's `Job.data` is then a lie — the durable record on Redis differs from what the producer sent. `updateData` and resume semantics get confusing fast. And producers with structured state (`{state, context}` payloads as in this codebase) end up *more* awkward, not less.

## Decision

**Producers MUST enqueue `{state, context}` envelopes. Both backends produce identical `job.data` to workers.** The contract is expressed at the type level via the `QueueHandle` and `QueueBackend` generics.

Concrete shape (in `packages/framework/src/queue/types.ts`):

```ts
export interface QueueHandle<S, C> {
  enqueue(id: string, data: { state: S; context: C }, opts?: EnqueueOpts): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface QueueBackend {
  createQueue<S, C>(name: string, opts?: QueueOpts): QueueHandle<S, C>;
  createWorker<S, C>(name: string,
    process: (job: JobLike<S, C>) => Promise<void>,
    opts?: WorkerOpts,
  ): WorkerHandle;
}
```

The in-memory drain loop now passes `entry.data` directly to `createInMemoryJob` instead of synthesizing the envelope:

```ts
const job = createInMemoryJob(entry.data); // entry.data is already {state, context}
```

**Why express the contract in types rather than in docs:**

A typed contract means the call site `queue.enqueue("j1", "hello")` does not compile — the caller is forced to make the envelope explicit (`{ state: "hello", context: undefined }`). Documentation alone would not have prevented the original divergence; types do.

**Note on `JobLike<S, C>`:** the worker-side type was already correct (matches the envelope). This ADR aligns the producer-side type with the worker-side type. After this change, the layers compose: enqueue `{state, context}`, JobLike exposes `{state, context}`, `updateData({state, context})` overwrites the same shape end-to-end.

## Consequences

**Positive:**

- Producer code is backend-agnostic. Swapping in-memory ↔ BullMQ does not change the enqueue call shape.
- The two backends emit byte-identical `job.data` for the same enqueue call. Tests written against in-memory exercise the same payload contract as production against BullMQ.
- The double-wrap bug is unrepresentable: there is no way to enqueue a raw value and have it silently rewrapped.
- `JobLike<S, C>` stays the single owning type for "what the worker sees" — `enqueue(...)` and `job.data` now reference the same shape.

**Negative:**

- All existing callers enqueuing raw values (mostly in-memory tests) had to be updated to wrap. The migration is mechanical (`enqueue(id, x)` → `enqueue(id, { state: x, context: undefined })`) but touched every call site.
- `createQueue` now requires two type parameters (`<S, C>`) instead of one (`<J>`). Slightly more verbose at the call site; the verbosity is the contract being explicit.

## Migration

- `queue/types.ts` — `QueueHandle<J>` → `QueueHandle<S, C>`; `createQueue<J>` → `createQueue<S, C>`.
- `queue/in-memory.ts` — drain loop passes `entry.data` directly; `QueueEntry` typed as `{ state: S; context: C }`.
- `queue-bullmq/adapter.ts` — `createQueue<J>` → `createQueue<S, C>`; enqueue parameter typed as `{state: S; context: C}` (BullMQ's actual shape).
- All in-memory queue tests rewritten to enqueue envelopes (e.g. `enqueue("j1", { state: "hello", context: undefined })`).
- BullMQ adapter tests updated to use the two-generic form `createQueue<S, C>` instead of `createQueue<{state: S; context: C}>`.
