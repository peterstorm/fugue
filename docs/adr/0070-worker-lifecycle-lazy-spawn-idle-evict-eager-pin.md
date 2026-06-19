# ADR-0070: Worker lifecycle — lazy spawn + idle-evict, with eager-pin; cold-start SLA bench-then-set

## Status

Accepted

## Date

2026-06-19

## Context

The supervisor (ADR-0064) serves many tenants from one box by giving each tenant
its own worker process behind a per-tenant UDS. NFR-001 sets the target at ~10–20
active tenant workers on a single pod; FR-034/NFR-002 bound each worker's memory
to an order-of-hundreds-of-MB ceiling; FR-033 imposes a configurable upper bound
on the number of *live* workers that must never be exceeded. US4 and FR-014 then
require the supervisor to drive a worker through spawn, crash-detect-and-restart,
and graceful drain — with the hard isolation rule that a crash is contained to one
tenant and never disturbs another's worker or runs.

Two policy questions were left open by the spec and deferred to architecture
(FR-018, NFR-003, plus open question 1): **when** does a tenant's worker come into
existence and **when** does it go away, and **what** is the cold-start latency
target. These are in tension. A standing warm worker per tenant minimises
first-request latency but pays full per-worker memory at idle for every registered
tenant, which collides with the per-worker ceiling at scale and does not fit a
bursty tenant set on one box. Never reclaiming workers leaks memory and slots and
eventually breaches the FR-033 live-worker bound. And committing to a cold-start
latency *number* before any worker has actually been booted under the real
single-pod profile would be a guess masquerading as an SLA.

Underneath the policy sits a correctness question: a worker's lifecycle is a small
state machine (it is spawning, or live, or draining, or it has crashed, or it has
been evicted) and the legal transitions between those states — and especially the
*illegal* ones (you cannot drain a crashed worker; you cannot idle-evict a
pinned one) — are isolation-load-bearing. This ADR settles the lifecycle policy
**and** how that policy is represented so that illegal lifecycle states are
unrepresentable rather than guarded by scattered conditionals.

## Options Considered

1. **Pure lifecycle ADT with a LAZY-spawn + IDLE-EVICT policy, an EAGER-PIN
   escape hatch, and a bench-then-set cold-start SLA (chosen).**
   - Pros: matches the NFR-001 shape — at ~10–20 tenants on one box, only
     actually-active tenants hold a worker (and its memory), so idle tenants cost
     nothing against the per-worker ceiling (FR-034). Idle-evict makes worker
     count self-bounding, so it does not drift into the FR-033 live-worker bound on
     its own; eager-pin gives latency-sensitive tenants the always-warm behaviour
     of a pool *selectively*, per-tenant, instead of paying it for everyone.
     Modelling the lifecycle as a discriminated-union ADT with total,
     Result-returning transitions makes every illegal move (idle-evict a pinned
     worker, drain a crashed one, restart a live one) a typed rejection rather than
     a runtime footgun, and makes crash-containment structural — a state names only
     its own tenant, so no transition can reference another tenant. Deferring the
     latency *number* to a boot benchmark yields an SLA grounded in a measured
     worker boot under the real profile rather than a guess.
   - Cons: first request for an idle/evicted tenant pays a cold-start (spawn +
     UDS-ready wait) — a real latency tail that eager-pin only mitigates for the
     tenants explicitly opted in. The idle TTL is a tuning knob (default ~15 min)
     that trades memory reclamation against cold-start frequency, and a wrong value
     degrades one or the other. The SLA is not a fixed contract until the benchmark
     is run, so the number is provisional at ship time.

2. **Always-eager warm pool: a standing worker per registered tenant.**
   - Pros: no cold-start — every tenant's first request hits a live worker; the
     simplest mental model (a worker exists iff a tenant is registered).
   - Cons: pays full per-worker memory for every registered tenant at idle, which
     collides with the per-worker ceiling (FR-034) and does not fit a bursty
     tenant set on one box (NFR-001); the standing pool scales with *registered*
     tenants, not *active* ones, so it wastes the box's memory exactly when most
     tenants are quiet.

3. **Always-lazy with no eviction: spawn on first request, never reclaim.**
   - Pros: zero idle memory until a tenant is first touched; simplest reclamation
     story (there is none).
   - Cons: leaks workers — once a tenant is touched its worker lives forever, so
     the live count only ever grows and eventually breaches the FR-033 upper
     bound; a long-lived box accumulates workers for tenants that went quiet hours
     ago, the opposite of NFR-001's "active workers" target.

The chosen option is lazy-spawn from option 3 plus a bound (idle-evict) that
option 3 lacks, plus the *selective* warmth of option 2 (eager-pin) without its
blanket memory cost — the two rejected options are the unbounded extremes this
decision sits between.

## Decision

**Represent a worker's lifecycle as a pure discriminated-union ADT
(`spawning | live | draining | crashed | evicted`) with total, immutable,
Result-returning transitions, and drive it with a LAZY spawn-on-first-request +
IDLE-EVICT-after-TTL policy, an EAGER-PIN per-tenant flag that exempts a worker
from idle-eviction, and crash→restart scoped to the crashed tenant only. The
cold-start latency SLA (FR-018, NFR-003) is set from a boot benchmark under the
single-pod profile, not guessed up front.**

Concretely:

- **Pure lifecycle ADT** —
  `packages/host/src/supervisor/lifecycle/worker-lifecycle.ts`. `WorkerState` is a
  five-variant union. Fields ride only on the states where they exist (`udsPath`,
  `pid` live on `live`/`draining` only; "a live worker with no socket" is
  unrepresentable). `tenant` and `eagerPin` ride on *every* variant so a transition
  never needs an out-of-band lookup to decide legality. Every transition takes an
  injected `now: number` (no `Date.now()` — repo ban), is immutable (replace, never
  mutate), and returns `Result<WorkerState, WorkerTransitionError>` — illegal moves
  return `err(invalidWorkerTransition(...))`; they never throw and never silently
  no-op.

- **Lazy spawn (AD-7, FR-014, NFR-003)** — absence of a worker is the absence of a
  map entry, so spawn begins with the `requestWorker` *constructor* (→ `spawning`),
  not a transition from a prior state. `workerLive` (→ `live`) fires once the
  process is up and its UDS is bound. The manager's `ensureWorker`
  (`worker-lifecycle-manager.ts`) is the seam the supervisor calls: a live worker
  is `touch`ed (refreshing its idle clock) and routed to; otherwise it lazy-spawns
  and waits, bounded, for UDS readiness, failing closed to
  `worker-unavailable(tenant)` (503) — contained to that one tenant.

- **Idle-evict (AD-7, FR-017, FR-033)** — `idleEvict` moves `live → evicted` only
  when `!eagerPin` *and* `now - lastActivityAt >= idleTtlMs`; the eager-pin check is
  enforced *inside the pure transition*, so a pinned worker is structurally never
  idle-evicted. `isIdleEvictable` mirrors that gate as a pure query so the
  supervisor's timer-driven `idleEvictSweep` can pick candidates without producing
  errors. `evicted` is terminal for an incarnation; the next request re-enters via a
  fresh `requestWorker` (lazy again).

- **Eager-pin (AD-7)** — a per-tenant boolean sourced authoritatively from the
  tenant registry (ADR-0068's `fugue:tenants:<id>` config), carried on every
  `WorkerState`, never defaulted to `false`. It is the *only* difference between a
  warm tenant and a cold one; it changes the idle-evict gate and nothing else.

- **Drain (FR-017)** — `beginDrain` (`live → draining`) stops routing new work;
  `canServe` is `false` for `draining` so the supervisor sends no new requests
  while in-flight runs finish/checkpoint. `drainComplete` lands `draining →
  evicted`.

- **Crash → restart (AD-8, FR-015)** — `crash` (`live`/`draining → crashed`,
  `exitCode: null` for a signal-kill incl. OOM) is the worker's `handle.exited`
  signal. The ADT's `restart` transition (`crashed → spawning`) exists, but the
  manager deliberately deletes the crashed entry and re-enters via `requestWorker`
  so the FR-033 admission check runs first and a tenant's *own* restart slot does
  not block it at the cap. Containment is structural: a crashed state names only its
  own tenant; `onCrash` touches no other entry.

- **Cold-start SLA — bench then set (FR-018, NFR-003).** The *policy* above is
  locked. The latency *number* is deliberately **not** invented in this ADR: it is
  to be derived from a measured worker boot under the single-pod profile
  (capacity/soak test, SC-013), so the SLA reflects real spawn + UDS-ready latency
  rather than a guess. Until that benchmark runs, the number is provisional.

Key invariants:

- **The lifecycle is a pure ADT.** All transition *decisions* live in
  `worker-lifecycle.ts`; the manager (`worker-lifecycle-manager.ts`, imperative
  shell) only performs I/O (spawn / signal / UDS-probe / Redis write) and threads
  pure states through a `Map<TenantId, WorkerState>`. Transitions are total — every
  variant is handled, illegal moves return an error, none throw (asserted by the
  property test in `worker-lifecycle.test.ts`).
- **Lazy-spawn / idle-evict / eager-pin / crash-restart transitions.**
  `requestWorker → workerLive`; `live --idleEvict--> evicted` *only* when
  `!eagerPin && idle >= ttl`; `live --beginDrain--> draining --drainComplete-->
  evicted`; `live|draining --crash--> crashed --(re-enter requestWorker)-->
  spawning`. An eager-pinned worker is never idle-evicted, by construction.
- **SLA bench-then-set.** The cold-start latency target is measured, then set — it
  is not asserted as a fixed number by this decision.

## Consequences

**Positive:**

- Memory tracks *active* tenants, not registered ones: idle tenants cost nothing
  against the per-worker ceiling (FR-034), which is what makes ~10–20 workers on one
  box realistic (NFR-001). Idle-evict keeps the live count self-bounding so it does
  not drift into the FR-033 ceiling on its own.
- Latency-sensitive tenants get always-warm behaviour via eager-pin without
  imposing a standing pool's memory cost on everyone — a per-tenant knob, not a
  global mode.
- Illegal lifecycle states are unrepresentable and illegal transitions are typed
  rejections, so crash-containment and the drain/evict/pin rules are enforced by the
  type system and total transitions rather than scattered runtime guards. The pure
  core is deterministic (`now` injected) and trivially property-testable.
- Drain and crash-restart reuse the same ADT transitions (`beginDrain` /
  `drainComplete`, `crash`), and re-adoption (ADR-0065) reuses the same `live`
  state via `adoptLive` — one lifecycle vocabulary across spawn, evict, drain,
  crash, and supervisor-restart re-adoption.
- The cold-start SLA, once benchmarked, is grounded in a real measured boot rather
  than an aspirational guess, so it can actually be held to.

**Negative:**

- A cold tenant's first request after spawn or eviction pays a real cold-start tail
  (spawn + bounded UDS-ready wait); eager-pin only removes it for tenants explicitly
  opted in, so the latency distribution is bimodal by design.
- The idle TTL (default ~15 min) is a tuning knob with no single right value: too
  short evicts workers that are about to be used again (more cold-starts); too long
  holds idle memory. It must be tuned per deployment against the benchmark.
- The cold-start SLA is provisional until the boot benchmark (SC-013) is run, so at
  ship time there is a locked policy but not yet a locked number — a deliberate,
  acknowledged gap closed by measurement rather than this document.
- The idle-evict sweep and the deliberate evict/drain paths remove the map entry
  *before* signalling the process (the crash watcher is the protected reader, not
  a signaller — `onCrash` never signals a process, since the worker has already
  exited), which is correct for not misreading a deliberate kill as a crash, but
  a failed SIGTERM/SIGKILL then leaves an orphan still bound to its UDS while the
  slot reads as reclaimed — surfaced as an `error`-level orphan-risk log, not
  prevented.

## Related

- ADR-0064 — supervisor: process-per-tenant, HTTP over UDS. The overall topology
  this lifecycle drives a worker through; `ensureWorker` returns the UDS path the
  supervisor reverse-proxies to.
- ADR-0065 — thin init / supervisor re-adoption of live workers. Re-adoption
  (SC-006, FR-019/FR-020) reuses this lifecycle's `live` state via `adoptLive`
  rather than re-spawning.
- ADR-0068 — tenant registry (Redis-backed metadata, pub/sub propagation). Sources
  the authoritative per-tenant config under `fugue:tenants:<id>` from which the
  `eagerPin` flag (and `secretsRef`) carried on every `WorkerState` is read.
- ADR-0071 — crash policy (sync fail-fast / HITL resume). Defines what the
  `crashed → restart` transition recorded here *means* for in-flight runs.
- ADR-0072 — per-worker heap cap. The memory enforcement (`--max-old-space-size`
  via the spawn adapter) that makes an OOM a *contained crash* — the `crash`
  transition's OOM path (`exitCode: null`).
- `packages/host/src/supervisor/lifecycle/worker-lifecycle.ts` — the pure lifecycle
  ADT and its transitions (this decision in code).
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` — the
  imperative-shell orchestrator (lazy-spawn, idle-evict sweep, drain, crash-restart,
  re-adopt) composing the ADT with the ports.
- `packages/host/src/supervisor/lifecycle/spawn-port.ts` — `SpawnPort` /
  `ProcManagePort` / `WorkerLifecyclePort` boundary contracts; `WorkerSpawnSpec`
  carries the `heapCapMb` per-worker cap (ADR-0072).
- `packages/host/src/__tests__/supervisor/lifecycle/worker-lifecycle.test.ts` —
  lazy-spawn → live, drain (FR-017), crash → restart (AD-8/FR-015), idle-evict
  respecting eager-pin + TTL, illegal transitions rejected (not thrown), and the
  totality property test. Supported by `worker-registry-redis.test.ts` and
  `thin-init.test.ts`.
