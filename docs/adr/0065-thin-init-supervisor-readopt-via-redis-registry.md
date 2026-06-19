# ADR-0065: Process topology — thin init (PID 1) and supervisor re-adoption of live workers via a Redis worker-registry

## Status

Accepted

## Date

2026-06-19

## Context

The single multi-tenant pod runs one supervisor and N per-tenant workers in one
process tree (ADR-0064). The supervisor is the routing/admission/auth brain; it
is also the component most likely to be redeployed, restarted, or to crash —
operator maintenance touches it constantly. The workers, by contrast, hold the
live, in-flight work: each tenant's worker is bound to its own UDS and is
actively serving runs at any moment.

The spec makes the availability semantics non-negotiable. FR-019: when the
supervisor restarts, live workers MUST continue serving their in-flight work.
FR-020: after a restart the supervisor MUST re-adopt still-live workers and
resume routing to them. FR-021/NFR-021 (the spec carries both, with identical
text, and the integration test tags this guarantee as NFR-021): in-flight runs
MUST survive a supervisor restart.
SC-006 turns these into a measurable bar: after a supervisor restart while N
workers are live, **100%** of in-flight runs survive and the supervisor re-adopts
and resumes routing to **all N** previously-live workers. US7 frames the operator
intent: "restart the supervisor while tenant workers are live and keep in-flight
runs surviving — so supervisor maintenance does not cause tenant downtime."

Two forces collide here. The first is a hard OS fact: in a naive single-process
topology where workers are direct children of the supervisor, the supervisor
exiting (or being restarted) takes the workers down with it — they are orphaned
and reaped, or killed by the same SIGTERM that stops the supervisor. That
directly violates FR-019. The second is a state fact: the supervisor's in-memory
lifecycle map — "which tenant's worker is live, at which pid, on which UDS" — does
not survive the supervisor's own restart. Even if the workers keep running, a
fresh supervisor has *no memory* of them and would, by default, lazy-spawn a
brand-new worker per tenant on the next request — silently abandoning the live
ones and the runs in flight on them, violating FR-020/FR-021.

This ADR settles two coupled questions: (1) **what owns the process tree** so a
supervisor restart does not kill the workers, and (2) **what durable source of
truth** lets a fresh supervisor find and re-adopt the still-live workers rather
than respawn them. The spec deferred the re-adoption mechanism to architecture
(FR-020, deferral 3); this is that decision.

## Options Considered

1. **Thin init as PID 1, with a Redis worker-registry the restarted supervisor reconciles against (chosen).**
   - A minimal long-lived PID-1 process (`thin-init.ts`) owns the process tree:
     it parents the supervisor (and restarts it within a crash-loop budget), it
     does NOT kill its inherited children when the supervisor exits, and it reaps
     zombies. Workers thus survive a supervisor restart by standard Unix orphan
     re-parenting onto PID 1. A Redis-backed worker-registry
     (`fugue:supervisor:workers:<tenant>`) is the durable record of which worker
     is live (pid, UDS path, startedAt, health). A fresh supervisor runs a
     deterministic reconcile (`reconcileReadopt`): enumerate the registry,
     UDS-liveness-probe each entry, re-adopt the ones that answer, prune the dead.
   - Pros: satisfies FR-019/FR-020/FR-021/SC-006 directly — workers outlive the
     supervisor and the new supervisor *finds* them rather than guessing. The
     registry + per-worker UDS probe is an authoritative "who is alive" source, so
     re-adoption is a deterministic reconcile, not a heuristic. Decouples
     supervisor maintenance from tenant uptime. The registry self-heals (dead
     entries pruned on reconcile) and stays within the project's existing Redis +
     fail-closed degraded machinery — no new infrastructure. The pure restart
     policy (`decideSupervisorRestart`) is unit-testable without spawning
     processes; thin-init owns process topology only, no business logic.
   - Cons: introduces a third Redis-backed source of truth (alongside the tenant
     registry and token store) whose availability the reconcile depends on — a
     Redis outage during a restart degrades re-adoption (the adapter fails closed
     to `redis-unavailable`/503 and the supervisor lazy-spawns fresh). Requires a
     dedicated PID-1 process and a SIGCHLD-driven reap loop for re-parented
     grandchildren — real process-management code that must be correct under the
     OS's re-parenting semantics. Two processes (init + supervisor) to reason about
     instead of one.

2. **Supervisor as PID 1, directly parenting the workers.**
   - The supervisor is the long-lived process and workers are its direct children.
   - Pros: one process, no separate init; simplest possible topology; no
     re-parenting subtlety.
   - Cons: fatal — a supervisor restart (or crash) orphans/kills every worker,
     because the OS reaps the children of an exiting PID 1 or the restart's
     SIGTERM cascades to them. That breaks FR-019 (live workers must keep serving)
     and FR-021 (in-flight runs must survive) by construction. There is no
     re-adoption to do because there is nothing left to re-adopt.

3. **Stateless respawn — fresh supervisor lazy-spawns a new worker per tenant.**
   - Keep workers as long-lived processes (via some init) but carry no durable
     registry; on restart the supervisor simply spawns workers on demand as
     requests arrive, ignoring any that were already running.
   - Pros: no registry to maintain; no reconcile path; simplest supervisor logic.
   - Cons: abandons the still-live workers and the runs in flight on them —
     violates FR-020/FR-021 and fails SC-006's 100% bar outright. Risks two
     workers per tenant (the orphaned old one still bound to its UDS plus the
     freshly spawned one), i.e. UDS/port contention and double-charged resources.
     "Who is alive" becomes a guess rather than a fact.

4. **Push re-adoption out to the orchestrator (systemd/k8s).**
   - Let an external supervisor (systemd units, a k8s controller) own worker
     lifecycle and re-attachment.
   - Pros: reuses mature external machinery; no in-process registry.
   - Cons: pushes lifecycle out of the process and couples the design to a
     specific platform; clustering/orchestration is explicitly out of scope for
     the single-host topology (ADR-0064). It does not solve the in-process
     re-adoption of a UDS-bound worker — the supervisor still needs an in-process
     record + probe to route to the right socket.

## Decision

**A thin init runs as PID 1 and never kills the workers on a supervisor restart;
the restarted supervisor RECONCILES against a Redis worker-registry — reading
each tenant's persisted worker record, UDS-liveness-probing it, and re-adopting
the live ones (`reconcileReadopt`) rather than killing and respawning — so 100%
of in-flight runs survive a supervisor restart.**

Topology and components:

- **`packages/host/src/supervisor/lifecycle/thin-init.ts`** — the minimal PID-1
  process. It (1) parents the supervisor and restarts it on exit within a
  crash-loop budget; (2) does NOT kill its inherited children when the supervisor
  exits, so workers re-parented onto PID 1 keep running; (3) reaps zombies via a
  SIGCHLD-driven loop so the pod never accumulates dead PIDs. The restart POLICY
  is the pure, unit-testable `decideSupervisorRestart` (sliding crash-loop
  window); the `runThinInit` shell only spawns, waits, reaps, and applies the
  decision. On supervisor exit it logs "supervisor exited; restarting (workers
  preserved)".

- **`packages/host/src/supervisor/lifecycle/worker-registry-redis.ts`** — the
  durable worker-registry. Key layout:
  `fugue:supervisor:workers:<tenant>` → JSON `{ pid, udsPath, startedAt, health,
  eagerPin }`. `put`/`get`/`remove` track records on spawn/drain/evict/crash.
  `reconcileReadopt()` is the deterministic SC-006 reconcile: SCAN the supervisor
  keyspace `fugue:supervisor:workers:*` (de-duplicating by `TenantId` across
  cursor pages so a tenant cannot be double-adopted), deserialize each record
  defensively, UDS-liveness-probe each via the injected `UdsLivenessProbe`,
  ADOPT the ones that answer, PRUNE (delete) the dead/corrupt entries so the
  registry self-heals. It returns `{ adopted: AdoptableWorker[], pruned:
  TenantId[] }`.

- **`packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts`** —
  consumes the reconcile: for each adopted record it calls `adoptLive(...)` into
  the pure lifecycle ADT (sourcing `eagerPin` from the authoritative tenant
  registry, falling back to the persisted record value, never defaulting to
  false — AD-7), inserting the worker into the fresh supervisor's in-memory map
  so routing resumes to the *existing* UDS without a respawn.

Key invariants:

- **Workers are not the supervisor's children in the kill-on-death sense.** A
  supervisor exit (clean or crash) never kills a worker; PID-1 thin-init holds
  the re-parented children alive and only reaps them once *they* exit.
- **The registry is the source of truth for "who is alive."** Re-adoption is a
  deterministic reconcile (enumerate → probe → adopt/prune), not a guess. The
  supervisor's in-memory map is reconstructed from durable state on every restart.
- **The UDS probe is the liveness oracle.** Only a worker that *answers* its UDS
  is adopted; a non-answering or probe-throwing worker is treated as dead, pruned,
  and lazy-respawned on next request — fail-closed.
- **Persisted records carry no secret** (the supervisor holds none; FR-005) —
  only routing/liveness metadata. `startedAt` is preserved across re-adoption so
  idle-evict math stays honest.
- **Fail-closed on Redis failure.** Any Redis read/scan/write failure in the
  registry returns the same `redis-unavailable` HostError (→ 503) every Redis
  adapter returns and drives the host's existing degraded machine; the adapter
  never builds a parallel degraded state and never throws.

`packages/host/src/__tests__/integration/supervisor-restart-readopt.test.ts`
proves SC-006: it stands up a first supervisor that spawns and registers N=5 live
workers, shuts it down, then stands up a SECOND supervisor over a FRESH lifecycle
manager bound to the SAME Redis worker-registry and a UDS probe. The second
supervisor starts with an empty in-memory map (`liveWorkerCount() === 0`),
reconciles, and adopts all N (`adopted === all ids`, `pruned === []`), routes a
run to each surviving tenant, and — the 100% survival proof — spawns ZERO new
workers (`second.spawned.length === 0`).

## Consequences

**Positive:**

- Supervisor maintenance is decoupled from tenant uptime: the supervisor can
  restart, redeploy, or crash-loop (within budget) without dropping a single
  in-flight run — FR-019/FR-021 hold by construction, and SC-006's 100% bar is
  met (proven by the integration test).
- Re-adoption is deterministic, not heuristic: the registry record plus a UDS
  liveness probe is an authoritative "who is alive," so the new supervisor *finds*
  its workers rather than guessing or blindly respawning (FR-020).
- The registry self-heals — dead and corrupt entries are pruned on every
  reconcile — so transient worker deaths during a supervisor outage do not leave
  permanent ghost records.
- Reuses existing infrastructure: the worker-registry is the same Redis +
  fail-closed degraded pattern as the tenant registry (ADR-0068) and token store,
  with no new dependency. The restart policy is pure and unit-tested independently
  of process spawning.
- Re-parenting + reaping is owned by a single minimal PID-1 module, keeping the
  supervisor free of process-tree concerns.

**Negative:**

- Re-adoption depends on Redis: a Redis outage at the moment of a supervisor
  restart degrades the reconcile — the registry fails closed to 503 and the
  supervisor lazy-spawns fresh workers, so previously-live workers (and their
  in-flight runs) may be abandoned during that window. Redis availability is now
  load-bearing for the restart-survival guarantee, not just for routing.
- Real process-management code: thin-init must correctly re-parent and SIGCHLD-reap
  grandchildren under the OS's orphan-re-parenting semantics, and never kill its
  inherited children on supervisor exit. A bug here either leaks zombies or, worse,
  kills the very workers this design exists to preserve.
- A third Redis-backed source of truth (worker-registry) joins the tenant registry
  and token store, each with its own keyspace and lifecycle to keep consistent.
  The persisted `health` enum and `eagerPin` must not drift from the lifecycle
  ADT (mitigated: `WorkerHealth` is `Extract`ed from `WorkerPhase`, and `eagerPin`
  is authoritatively re-sourced from the tenant registry on re-adopt).
- Two processes (init + supervisor) instead of one — slightly more operational
  surface to observe and reason about than a single-process pod.

## Related

- ADR-0064 — single multi-tenant pod topology (the overall approach this process
  topology realizes).
- ADR-0066 — UDS/IPC transport, which the re-adoption liveness probe and the
  resumed routing use to reach each worker.
- ADR-0068 — tenant registry: the sibling Redis-backed source of truth; this
  ADR's worker-registry reuses the same fail-closed degraded pattern and supplies
  the authoritative `eagerPin` consulted during re-adoption.
- ADR-0070 — worker lifecycle ADT (lazy-spawn / idle-evict / drain / crash) whose
  `adoptLive` transition the reconcile drives, and whose `WorkerPhase` the
  persisted `WorkerHealth` is derived from.
- `packages/host/src/supervisor/lifecycle/thin-init.ts` — PID-1 init + pure
  `decideSupervisorRestart` (this decision in code).
- `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts` — the Redis
  worker-registry + `reconcileReadopt` over the UDS probe.
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` — the
  `reconcileReadopt` consumer that re-adopts records into the live map.
- `packages/host/src/__tests__/integration/supervisor-restart-readopt.test.ts` —
  the passing SC-006 proof (100% adopted, zero respawn).
