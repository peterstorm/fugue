# ADR-0071: Crash policy — synchronous runs fail fast, HITL runs resume from durable checkpoint; crashes are contained

## Status

Accepted

## Date

2026-06-19

## Context

The multi-tenant single-host topology runs each tenant's DAG runtime in its own
OS worker process under one supervisor (US4). This ADR settles AD-8 — the crash
policy: sync runs fail-fast, HITL runs resume from a durable checkpoint, and a
crash is contained to its tenant. The isolation guarantee that
makes this topology safe is that a fault in one tenant's worker stays inside that
worker: **FR-012** ("a worker crash MUST NOT affect any other tenant's worker or
runs") and **NFR-020** ("a worker crash MUST be contained to its own tenant")
are load-bearing, and **SC-005** holds the whole topology to "zero failed or
disrupted runs in any other tenant" under a fault-injection test that crashes one
worker under concurrent multi-tenant load. **FR-015** then requires the
supervisor to restart *only* the crashed tenant's worker, disturbing no other
tenant.

What the spec deliberately left open is *what happens to the crashed tenant's own
in-flight run* once its worker is restarted. **FR-016** states the intent — "the
system MUST attempt best-effort resume of the crashed tenant's in-flight run from
its last checkpoint, reusing existing checkpoint machinery; durable HITL runs
MUST survive" — but flags the mechanism `[DEFERRED TO ARCHITECTURE: run-resume vs
fail-fast]`. US4's acceptance criterion carries the same deferral. This ADR
settles that deferred question.

The forces are in tension. A run can be one of two kinds, and they want opposite
recovery semantics. A **synchronous** run is a request the supervisor is
proxying right now: a live HTTP caller is blocked on the answer, the run holds no
durable state worth replaying, and silently re-executing a half-finished,
side-effectful job behind the caller's back is *worse* than failing — the caller
can simply retry and is the right party to decide whether retry is safe. A
**HITL / suspended** run is the opposite: it is already event-sourced and
persisted (ADR-0060, ADR-0003) precisely so it can outlive any single process; it
may have been parked for human review for hours, and throwing away that durable
progress on a crash would defeat the entire point of the suspend/resume
primitive. A single uniform policy ("resume everything" or "fail everything")
cannot serve both without violating one of them. The decision must also *not*
introduce a new resume engine: FR-016 explicitly says "reusing existing
checkpoint machinery," and the codebase already owns durable HITL resume
(ADR-0060) and supervisor re-adoption (AD-2).

## Options Considered

1. **Per-run-kind policy: synchronous runs fail fast, HITL/suspended runs resume from their durable checkpoint; crash contained to the one tenant (chosen).**
   - Pros: matches each run kind to the recovery semantics it actually wants — a
     live sync caller gets a clean error and decides retry; durable HITL progress
     is preserved. Reuses what already exists (FR-016): HITL resume rides the
     ADR-0060 `processRun` idempotency + self-healing lock over the durable
     Redis checkpoint, and supervisor-side recovery rides the AD-2 re-adoption
     reconcile — **no new resume engine is built**. Containment is unchanged and
     independently proven: the crash is bounded by the OS process boundary, and
     the restart in `onCrash` touches only the crashed tenant's worker
     (FR-012/FR-015, SC-005). Avoids the cardinal sin of silently re-running a
     side-effectful synchronous job the caller never asked to repeat.
   - Cons: two recovery paths to reason about rather than one uniform rule; the
     "is this run durable?" distinction must be unambiguous (it is — sync runs
     are proxied request/response and hold no checkpoint; HITL runs are the only
     ones that own a `RunStorePort` checkpoint). A sync caller that crashes
     mid-run does observe an error and must retry — recovery is delegated to the
     client rather than performed transparently.

2. **Resume everything — best-effort replay of the sync run too, from a new sync checkpoint engine.**
   - Pros: one uniform recovery story; the crashed tenant's sync caller might
     never see the failure.
   - Cons: requires building durability the spec explicitly does *not* require
     for sync runs, contradicting FR-016's "reusing existing checkpoint
     machinery." Worse, it risks **silently re-executing a partially-applied,
     side-effectful job** behind a live caller's back — the caller cannot reason
     about whether the side effects ran once, twice, or not at all. It moves the
     retry decision away from the only party (the client) that knows whether
     retry is safe. Rejected.

3. **Fail everything — drop the crashed tenant's in-flight run regardless of kind.**
   - Pros: dead simple; no resume logic at all.
   - Cons: throws away **durable HITL progress** that was persisted specifically
     to survive process loss — directly violating FR-016 ("durable HITL runs MUST
     survive") and defeating the ADR-0060 suspend/resume primitive. A run parked
     for hours awaiting human review would be lost to an unrelated OOM. Rejected.

This was not a forced choice — all three are implementable. It is a deliberate
split that maps recovery semantics to the durability the run actually has,
chosen over both uniform policies.

## Decision

**On a contained worker crash, synchronous runs fail fast (the supervisor returns
`worker-unavailable` / 503 to the in-flight caller, who retries) while HITL /
suspended runs resume from their durable Redis checkpoint on worker restart via
the existing ADR-0060 machinery; the crash is contained to the one tenant — the
OS process boundary bounds the blast radius, and the supervisor restarts only the
crashed tenant's worker.**

Mapping to code:

- **Crash containment + contained restart.** `onCrash` in
  `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` runs the
  pure `crash(...)` transition for *that tenant's* map entry only, removes its
  registry record, and restarts *only* that worker via `lazySpawn`. Every other
  tenant's worker map entry, registry record, and in-flight requests are
  untouched. The crash-exit watcher keys on `handle.exited` as the sole crash
  signal and guards on "is the map entry still THIS incarnation?", so a deliberate
  drain/evict is never misread as a crash. The RESTART-AT-CAP detail (delete the
  crashed entry *before* respawning so the tenant does not count its own
  restarting slot against `SUPERVISOR_MAX_LIVE_WORKERS`) ensures a crashed tenant
  can always replace itself even at the live-worker cap.
- **Synchronous = fail fast.** The crash surfaces to any in-flight proxied caller
  as a `worker-unavailable` (503) for that tenant only. Sync runs hold no durable
  checkpoint; the supervisor does not replay them. The live client owns the retry
  decision. The lifecycle source documents this directly: "Sync runs fail-fast
  (the crash already surfaced as 503 to in-flight callers)."
- **HITL / suspended = durable resume.** Resume reuses the existing
  `packages/host/src/hitl/` primitive: `processRun` (`hitl/service.ts`, ADR-0060)
  is idempotent — its own guards come from terminal-status checks plus the
  decision-store pending marker — and is additionally single-flighted by a
  self-healing `SET NX EX` lock that wraps it in `hitl/adapters/run-queue.ts`. It
  rehydrates from the durable `{state, context}` checkpoint persisted by
  `makeRunStoreJobLike`
  (`hitl/run-store-job.ts`) backed by `RunStorePort` (ADR-0003/0008/0014). A
  restarted worker re-adopts and continues from the last good checkpoint. **No
  new resume engine is introduced** (FR-016) — `onCrash` deliberately builds none.
- **Supervisor-side recovery.** A supervisor restart (distinct from a worker
  crash) re-adopts still-live workers via the AD-2 Redis-registry +
  UDS-liveness-probe reconcile (`reconcileReadopt`), preserving in-flight runs
  (SC-006); durable HITL runs survive regardless of which process is alive.

Key invariants:

- **Crash contained to one tenant.** A worker crash affects no other tenant's
  worker or runs (FR-012/FR-015, NFR-020). Containment rests on the OS process
  boundary plus a tenant-scoped `onCrash`/restart; it is proven adversarially —
  see Related.
- **Sync = fail-fast.** Synchronous runs are never silently re-executed; a crash
  surfaces as `worker-unavailable` (503) to the live caller, who decides retry.
- **HITL = durable-resume.** Suspended/HITL runs resume from their durable
  checkpoint via the existing ADR-0060 machinery; durable HITL progress is never
  discarded by a crash (FR-016).
- **No new resume engine.** Recovery reuses existing checkpoint and re-adoption
  machinery only.

## Consequences

**Positive:**

- Each run kind gets the recovery semantics it actually wants: sync callers get a
  clean, retryable error and never a silent re-run; durable HITL progress
  survives an unrelated crash. The deferred FR-016 question is resolved without a
  uniform policy that would violate one kind or the other.
- Zero new durability machinery. HITL resume is the existing ADR-0060
  `processRun` + durable checkpoint; supervisor recovery is the existing AD-2
  re-adoption reconcile. Less code, fewer places resume correctness can drift.
- Containment is a first-class, adversarially-tested guarantee:
  `fault-worker-crash.test.ts` crashes one tenant's worker under concurrent
  multi-tenant load and asserts zero disrupted runs in any other tenant, exactly
  one contained respawn of the victim, and untouched registry records for every
  other tenant (SC-005, NFR-020).
- The retry decision for side-effectful sync work lives with the client, the only
  party that knows whether retry is safe — the supervisor never gambles on
  replaying a partially-applied job.

**Negative:**

- Two recovery paths exist rather than one; a reader must hold the sync-vs-HITL
  distinction in mind. The distinction is sharp in practice (only HITL runs own a
  durable checkpoint), but it is a policy a future contributor must not blur — for
  example, by adding durability to sync runs without revisiting this ADR.
- A synchronous caller whose worker crashes mid-run observes a 503 and must
  retry; recovery is *not* transparent for sync. This is the accepted tradeoff —
  transparency for sync would mean either silent re-execution (unsafe) or a new
  checkpoint engine (out of scope) — but it does push a retry burden onto
  clients.
- HITL durable-resume correctness is only as strong as the checkpoint: a
  torn/corrupt checkpoint settles the run `failed` rather than resuming (by
  design, since it cannot heal on retry — see `hitl/service.ts`). Crash recovery
  for HITL inherits the durability characteristics, and limits, of ADR-0060 and
  the underlying event-sourced store.

## Related

- ADR-0070 — worker lifecycle: the `crashed → restart` transition and the
  contained `onCrash`/`lazySpawn` restart this policy executes (the containment +
  restart mechanism in code).
- ADR-0060 — durable HITL suspend/resume primitive: the `processRun` idempotency
  + self-healing lock + durable checkpoint that HITL resume reuses (no new resume
  engine).
- ADR-0013 — `onHumanReview` hook-crash retry: the related, narrower retry
  semantics for a crashing human-review hook, distinct from node retry.
- ADR-0060 + `RunStorePort` — the durable Redis checkpoint that actually makes
  HITL resume safe here: HITL runs carry only the latest `{state, context}`
  checkpoint via `RunStorePort.saveCheckpoint`, NOT a per-transition event
  journal (the `makeRunStoreJobLike` resume path makes `appendEvent` an
  intentional no-op).
- ADR-0003 / ADR-0008 / ADR-0014 — event-sourcing via Redis Streams, the event
  envelope/time model, and idempotent `appendEvent`: the underlying store's
  general durability characteristics, not the load-bearing mechanism for this
  resume path (replay-idempotency is not exercised here).
- ADR-0065 — supervisor re-adoption preserving in-flight workers: the
  supervisor-restart counterpart (distinct from worker crash) that keeps in-flight
  runs alive across a supervisor cycle (SC-006).
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` —
  `onCrash` (contained crash transition + tenant-scoped restart) and
  `reconcileReadopt` (this decision in code).
- `packages/host/src/hitl/service.ts`, `packages/host/src/hitl/run-store-job.ts`
  — durable HITL checkpoint + idempotent resume (service-level idempotency via
  terminal-status guards + decision-store pending marker).
- `packages/host/src/hitl/adapters/run-queue.ts` — the `SET NX EX` single-flight
  lock that wraps `processRun`.
- `packages/host/src/__tests__/integration/fault-worker-crash.test.ts` — proves
  SC-005 / NFR-020: crashing one tenant's worker under concurrent load disrupts
  zero other tenants, with exactly one contained respawn of the victim.
- Spec + plan: `.claude/specs/2026-06-18-multi-tenant-single-host/spec.md`
  (FR-012, FR-015, FR-016, SC-005, US4, NFR-020) and the plan's AD-8 seed in
  `.claude/plans/2026-06-18-multi-tenant-single-host.md`.
