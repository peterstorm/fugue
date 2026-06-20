# ADR-0072: Resource enforcement — single pod + supervisor admission + per-worker heap cap (not cgroups)

## Status

Accepted

## Date

2026-06-19

## Context

The multi-tenant single-host design (US8) runs every tenant's worker as a child
process inside ONE Kubernetes pod, with the supervisor as PID 1 and a worker per
tenant behind a UDS reverse proxy. Sharing one box means tenants share one CPU
budget, one RAM budget, and one bounded pool of live workers. The spec demands
that this sharing be *fair and bounded*: FR-032 requires per-tenant resource
admission that **replaces** the single global concurrency limit so no one tenant
can exhaust the box; FR-033 requires a configurable upper bound on live workers
that is **never** exceeded; FR-034 requires per-tenant memory to be bounded by a
configurable ceiling (order hundreds of MB). SC-011 makes the fairness property
adversarial: under a single tenant attempting to saturate the box, other tenants
must experience **zero** quota rejections attributable to the heavy tenant.

The spec deliberately deferred *the depth of resource enforcement* to
architecture (spec open question 7, attached to FR-034 and US8's acceptance
scenario): process-level admission only, versus per-tenant cgroup CPU/memory
limits, versus a container per tenant. That is the question this ADR settles.
The forces in tension: (a) the single-pod deployment model is fixed (ADR-0064) —
introducing a container or cgroup *per tenant* would mean nested containers or
delegated cgroup hierarchies, which the chosen platform does not grant the
process and which would change the deployment topology; (b) the fairness and
bound requirements are hard guarantees that must be *testable* deterministically,
not best-effort kernel scheduling behaviour; (c) a runaway tenant must be
*contained to its own blast radius*, never able to OOM the shared host or starve
peers; (d) the codebase already owns a pure, property-tested concurrency limiter
(ADR-0037) whose ADT is the natural place to express a per-tenant fairness axis.

The problem, stated without the solution: **with all tenants sharing one pod, by
what mechanism are per-tenant concurrency fairness, the global live-worker
bound, and the per-tenant memory ceiling enforced — given that the deployment is
a single pod and a cgroup/container per tenant is not available?**

## Options Considered

1. **Two software layers: supervisor admission control + per-worker heap cap (chosen).**
   Enforce fairness and the live-worker bound in the supervisor's *admission*
   path — a pure ADT extending the existing concurrency limiter with a per-tenant
   ceiling and a global live-worker bound — and bound memory with a per-worker V8
   heap cap applied at spawn time. Everything stays in one pod; no cgroups, no
   per-tenant containers.
   - Pros: The fairness axis is a *pure state machine* (`admitTenant`), so
     SC-011 anti-starvation is provable by a deterministic property test rather
     than measured against kernel scheduling. Reuses the already-property-tested
     limiter ADT (ADR-0037) — admission *composes* it, it does not fork it. The
     live-worker bound (FR-033) is an exact integer cap, never approximate.
     Memory containment (FR-034) is a single spawn flag: a runaway tenant OOMs
     *its own* worker (contained crash → contained restart, ADR-0070/ADR-0071),
     never the shared host. Over-quota and capacity-exhaustion become typed,
     tenant-scoped HTTP signals (`tenant-over-quota` → 429 + Retry-After;
     `worker-unavailable` → 503) with zero cross-tenant bleed (ADR-0073). No
     change to the single-pod deployment topology; no new ops surface.
   - Cons: Heap cap bounds *V8 old-space*, not total RSS — native allocations,
     buffers, and FDs are not capped by this flag, so the memory ceiling is a
     strong-but-not-airtight bound. Admission is *concurrency* fairness, not CPU
     fairness: a heavy tenant within its own concurrency ceiling can still
     consume more CPU than peers (the OS scheduler, not admission, arbitrates CPU
     time-slices). The heap cap is enforced by the spawn adapter (imperative
     shell), so its correctness rests on adapter-level tests rather than the type
     system.

2. **Per-tenant cgroups (CPU/memory limits per worker).**
   - Pros: Kernel-enforced CPU *and* memory limits, including total RSS, not just
     V8 heap; closer to "true" resource isolation; CPU fairness as well as memory.
   - Cons: Requires a delegated cgroup hierarchy the process does not have inside
     the single pod, or a privileged/elevated container — a material change to
     the deployment model (ADR-0064) and a new ops surface to provision and
     audit. Fairness would then depend on kernel scheduling behaviour, which is
     not deterministically testable the way a pure admission ADT is — SC-011
     would degrade from a property proof to a load-test approximation. Adds
     platform coupling (the cgroup mechanism becomes part of the host contract)
     for a guarantee the two software layers already deliver at the granularity
     the spec requires.

3. **No admission — rely on the existing single global concurrency limit only.**
   - Pros: Nothing new to build; the global limiter already exists (ADR-0037).
   - Cons: Directly violates FR-032 and SC-011. A single heavy tenant filling
     the global limit *is* the starvation vector the spec forbids — peers would
     be rejected for the heavy tenant's load, with no per-tenant ceiling and no
     way to attribute or scope the rejection. Non-viable.

This was a genuine choice — cgroups were a real, available-on-some-platforms
alternative — and it was decided deliberately in favour of software enforcement
to keep the single-pod topology and to make the fairness guarantee a
deterministic property rather than a kernel-behaviour approximation.

## Decision

**Enforce resource fairness and limits at two software layers inside the single
pod — supervisor admission control (per-tenant concurrency ceiling) and a
per-worker V8 heap cap at spawn time — and NOT via per-tenant cgroups or
containers. The box-wide live-worker bound (FR-033) is enforced separately by the
worker-lifecycle manager (ADR-0070), NOT by admission.**

**Layer 1 — Admission control** lives in
`packages/host/src/supervisor/admission.ts` as a pure ADT,
`TenantConcurrencyState`, that *composes* (embeds as `inner`, does not fork) the
`ConcurrencyState` limiter from `packages/host/src/domain/concurrency.ts`
(ADR-0037), instantiated at `ConcurrencyState<TenantId>`. `admitTenant(state,
tenant, now)` is the gate, checked in this order:

1. **Per-tenant ceiling (FR-032).** If the tenant is at its own `{current, max}`,
   refuse with `tenant-over-quota` carrying a per-tenant `retryAfterSeconds`.
   This check reads *only the caller's own counters*, so it can never be
   triggered by another tenant's load.
2. **Inner concurrency.** Defer to the reused `acquire` for the global + per-DAG
   axes (the tenant id is the inner key; its inner per-key max equals the tenant
   ceiling, so the inner per-key counter and the `perTenant` counter move in
   lockstep). The inner global limit is sized via `INNER_GLOBAL_HEADROOM` so it
   can *never* bind before the per-tenant ceilings — because FR-032 *replaces* the
   single global limit, a binding inner global would reintroduce the exact
   starvation SC-011 forbids. An inner rejection at this step is therefore
   unreachable and is surfaced as a 500 `internal-invariant-violated` (carrying
   the inner error in `context`) rather than mislabelled as the tenant's quota
   error.

`admitTenant` returns a branded `AdmitToken`; `releaseTenant` reverses the inner
slot and the per-tenant counter — both clamped at 0. Admission deliberately does
NOT model the live-worker bound: a counter here would be a dead, drift-prone
duplicate of the lifecycle manager's authoritative one (it was previously carried
sized-to-never-bind, and removed for that reason). The worker-lifecycle manager's
`liveWorkerCount()` (ADR-0070) is the SOLE authoritative FR-033 enforcement point —
it refuses a new spawn at `SUPERVISOR_MAX_LIVE_WORKERS` → `worker-unavailable`
(503). `main-supervisor.ts` wires the two so admission gates per-tenant fairness
while the lifecycle manager gates the box-wide worker count, with no competing
counters.

**Layer 2 — Per-worker heap cap (FR-034)** is applied at spawn time. The
`WorkerSpawnSpec.heapCapMb` field (`spawn-port.ts`) carries the configurable
per-tenant ceiling (`WORKER_HEAP_CAP_MB`); the Bun.spawn adapter
(`bun-spawn-adapter.ts`) translates it into
`NODE_OPTIONS=--max-old-space-size=<heapCapMb>` in the *child's* environment
(appended to any inherited `NODE_OPTIONS`), so the V8 old-space ceiling applies
to that tenant's worker alone. Unset → no cap. A tenant exceeding its heap OOMs
its own worker, which is a contained crash that the lifecycle manager restarts
for that tenant only.

Key invariants:

- **Per-tenant ceiling + global bound are independent axes.** One tenant
  saturating its ceiling never consumes another tenant's slots; the live-worker
  bound is an exact integer cap that is never exceeded (FR-032, FR-033).
- **Anti-starvation (SC-011).** A heavy tenant's per-tenant fill *never* causes a
  peer's rejection — `admitTenant` reads only the caller's own counters, proved by
  its anti-starvation property test. A peer can be gated only by the box-wide
  live-worker bound (enforced in the lifecycle manager, ADR-0070), and only
  legitimately.
- **Tenant-scoped, retriable error signals.** Over-quota →
  `tenant-over-quota` → **429 + Retry-After** (the Retry-After comes from the
  error, never a hardcoded header); capacity-exhausted →
  `worker-unavailable` → **503** (ADR-0073). Both name only their own tenant.
- **Per-worker heap cap, not cgroups.** Memory is bounded by `--max-old-space-size`
  in each worker's own environment; enforcement is software inside one pod.

## Consequences

**Positive:**

- Fairness is a *pure, deterministic property*, not a kernel-scheduling
  approximation: `admitTenant` is total and side-effect-free, so SC-011 is proved
  by the anti-starvation property test in
  `packages/host/src/__tests__/supervisor/admission.test.ts`, and the
  end-to-end 429-vs-503 taxonomy under concurrent load (with zero cross-tenant
  bleed) is proved by
  `packages/host/src/__tests__/integration/error-taxonomy-concurrent.test.ts`.
- No change to the single-pod deployment topology and no new ops surface: there
  is nothing to provision, delegate, or audit beyond config flags
  (`defaultTenantMax`, `maxLiveWorkers`, `retryAfterSeconds`, `WORKER_HEAP_CAP_MB`).
- Memory runaway is contained to the offending tenant: a worker that breaches its
  heap cap OOMs *itself* and is restarted in isolation, never threatening the
  shared host or its peers.
- The limiter ADT (ADR-0037) is reused verbatim — admission composes it at
  `K = TenantId` with no brand-erasing cast — so the per-tenant axis inherits the
  inner ADT's already-tested invariants rather than duplicating them.
- The live-worker bound has a single authoritative enforcement point (the
  lifecycle manager's `liveWorkerCount()`, ADR-0070), so FR-033 cannot drift
  between two competing counters.

**Negative:**

- The memory ceiling bounds V8 old-space, not total RSS: native allocations,
  buffers, and FDs are *not* capped by `--max-old-space-size`, so FR-034 is a
  strong but not airtight bound. A pathological native-memory leak could still
  exceed the intended per-tenant ceiling — accepted as the cost of staying within
  the single-pod model without cgroups.
- Admission enforces *concurrency* fairness, not CPU fairness: a tenant within
  its own ceiling can still out-consume peers on CPU time, which the OS scheduler
  (not admission) arbitrates. If CPU starvation becomes a real problem,
  per-tenant cgroup CPU shares (option 2) would have to be revisited.
- The heap cap lives in the imperative shell (the Bun.spawn adapter), so its
  correctness rests on adapter-level tests rather than the type system; a future
  change to how `NODE_OPTIONS` is composed must keep the flag-append behaviour
  intact.
- `INNER_GLOBAL_HEADROOM` is a sizing assumption: the "inner global never binds"
  guarantee (and the unreachable-branch 500 it justifies) holds only while the
  sum of per-tenant ceilings stays well under that headroom; configuring ceilings
  into the hundreds of thousands would require revisiting it.
- Admission counters are **process-local** and reset on supervisor restart, while
  in-flight runs survive on re-adopted workers (ADR-0065). For the window after a
  restart a tenant's surviving in-flight runs are not re-counted against its
  ceiling, so it can transiently exceed `maxConcurrentRuns` until those runs drain.
  The over-admission is bounded and per-tenant (it never starves *other* tenants,
  so SC-011's anti-starvation property is preserved); FR-032's exact bound is
  briefly soft. Accepted: reconstructing per-tenant `current` from the registry at
  re-adoption would add coupling for a transient, self-scoped relaxation.

## Related

- ADR-0037 — pure concurrency limiter: the `ConcurrencyState` ADT this admission
  layer extends/composes (the key-agnostic limiter reused at `K = TenantId`).
- ADR-0038 — pure circuit breaker: the sibling pure supervisor-state ADT pattern
  (injected clock, immutable transitions) admission follows.
- ADR-0070 — worker lifecycle: owns `liveWorkerCount()`, the authoritative
  enforcement point for the FR-033 live-worker bound, and the contained
  crash-restart that a heap-cap OOM triggers.
- ADR-0071 — crash policy: the contained crash → contained restart semantics a
  heap-cap OOM relies on (a runaway tenant OOMs its own worker, restarted in
  isolation).
- ADR-0073 — error taxonomy: the 429 (`tenant-over-quota` + Retry-After) vs 503
  (`worker-unavailable`) HTTP mapping, tenant-scoped with no cross-tenant bleed.
- ADR-0064 — overall multi-tenant single-host approach: fixes the single-pod /
  process-per-tenant deployment model this decision enforces within.
- `packages/host/src/supervisor/admission.ts` — `admitTenant` / `releaseTenant`
  (admission ADT: per-tenant ceiling + global live-worker bound, this decision in
  code).
- `packages/host/src/supervisor/lifecycle/spawn-port.ts` /
  `bun-spawn-adapter.ts` — `WorkerSpawnSpec.heapCapMb` →
  `--max-old-space-size` per-worker heap cap.
- `packages/host/src/__tests__/supervisor/admission.test.ts` (SC-011
  anti-starvation property test) and
  `packages/host/src/__tests__/integration/error-taxonomy-concurrent.test.ts`
  (429/503 under concurrency, zero cross-tenant bleed).
