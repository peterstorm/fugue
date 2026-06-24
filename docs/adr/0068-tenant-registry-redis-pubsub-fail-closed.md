# ADR-0068: Tenant registry — Redis-backed metadata with pub/sub propagation, fail-closed on outage

## Status

Accepted

## Date

2026-06-19

## Context

The multi-tenant single-host refactor (ADR-0064) turns the fugue host into a
**supervisor** that owns the single inbound listener, resolves an inbound
identity to a first-class `Tenant`, and routes each request over a per-tenant
Unix domain socket to a **worker** (`createHost` bound to exactly one tenant).
For that routing to happen, the supervisor needs a source of truth that, given a
tenant, yields the per-tenant **configuration** required to find or spawn the
right worker: the tenant's Keycloak client mapping, its filesystem root, its
admission limits, an eager-pin flag, and a **secrets reference** (never a secret
value — ADR-0069 / FR-005). US5 (FR-024) requires this registry to be mutable at
runtime — admins register, deregister, and reconfigure tenants live, without
redeploying the host — and those mutations must be idempotent (re-applying the
same register/deregister yields the same end state) and must propagate to the
process(es) that route on them. US6 layers a deregister-then-retain lifecycle on
top: a deregistered tenant must stop accepting new runs immediately while its
footprint is retained for a grace window, then hard-purged.

The hard force is **what happens when the backing store is unavailable.** The
spec is unambiguous: FR-022 requires that if the supervisor cannot resolve or
verify a tenant (registry or backing infra unavailable), it MUST **fail closed**
— refuse to start new runs (503-style) rather than route on stale or guessed
config; FR-023 requires that, when resolution fails closed, already-running
workers MUST continue serving their in-flight work; and SC-007 makes this
measurable: registry/infra unavailable ⇒ **100%** of new-run requests refused,
**zero** routed on stale/guessed config, in-flight runs on live workers continue
at **100%**. Routing a new run on last-known-good config during an outage is an
isolation/correctness hazard — the registry may have changed (a tenant
deregistered, an fsRoot or secrets reference reassigned) in a way the cache
cannot know — so a guessed route could land a run on the wrong worker, the wrong
filesystem, or a tenant that no longer exists. US7 adds the symmetric constraint:
the supervisor itself may restart, so the registry must survive a supervisor
restart (an in-memory-only structure does not), and the fail-closed posture must
distinguish "I cannot start a new run" from "kill the live workers."

The deferred question this ADR settles (spec §"DEFERRED TO ARCHITECTURE", FR-024)
is therefore: **what stores the tenant config, how do live mutations propagate
across the process, and how does the system behave when that store is down.**

## Options Considered

1. **Redis-backed registry with pub/sub propagation, fail-closed by reusing the existing degraded state machine (chosen).**
   - The pure registry ADT (`tenant-registry.ts`) owns idempotency, validation,
     and the fail-closed unknown-tenant lookup; a Redis adapter
     (`redis-registry-adapter.ts`) persists each config under
     `fugue:tenants:<id>`, announces every mutation on the `fugue:tenants:events`
     pub/sub channel, and wires Redis outages into the **existing**
     `degraded:redis-disconnected` machine (`host-state.ts` `redisDied`/
     `redisRecovered`, driven by `redis-probe.ts`).
   - Pros: Redis is **already** the host's backing store and liveness substrate
     (ADR-0003 event-sourcing via Redis streams), so this adds no new durability
     engine. Reusing `redisDied`/`redisRecovered` + the liveness probe gives the
     fail-closed semantics (FR-022/023, SC-007) essentially for free — the same
     `redis-unavailable` HostError every other adapter returns, which the
     supervisor maps to a non-leaking 404 `tenant-unknown` new-run refusal.
     Pub/sub gives live mutation propagation (FR-024)
     with no polling. The config survives a supervisor restart (US7) and supports
     re-adoption (ADR-0065's worker registry is the sibling that reuses the same
     posture). The "announce, then re-read" channel design keeps secrets off the
     bus structurally — the event carries only `{kind, tenant}`, never the body.
   - Cons: a Redis dependency on the new-run admission path (mitigated: in-flight
     work uses the in-memory snapshot, not Redis); a small write-then-publish
     two-step that must fail closed atomically-enough that memory never diverges
     from a write that did not land; eventual (not instantaneous) propagation —
     a reconfigure is visible to a worker only on its next spawn, not mid-run.

2. **In-memory-only registry.**
   - Pros: simplest possible; zero infra dependency on the resolve path; no
     serialization or pub/sub.
   - Cons: **lost on supervisor restart**, which directly breaks US7 (the
     supervisor must re-adopt live workers after restart — it cannot if it forgot
     who they are) and SC-006 re-adoption. Provides no runtime onboarding across
     a restart and no cross-process propagation if the topology ever grows. It
     also has no natural fail-closed story tied to the host's existing degraded
     machine — the very mechanism that makes FR-022/023 cheap. Rejected.

3. **Redis-backed, but route on stale/last-known config during an outage (fail-open).**
   - Pros: maximizes availability of new-run admission during a Redis blip; no
     503s while degraded.
   - Cons: directly violates FR-022 and SC-007 ("zero requests routed on
     stale/guessed config"). A registry that cannot positively confirm a tenant
     could route a new run onto a deregistered tenant, a reassigned fsRoot, or a
     stale secrets reference — an isolation/correctness hazard the feature exists
     to prevent. Rejected on safety grounds.

This was **not** a forced choice: an in-memory registry and a fail-open posture
were both genuinely available and simpler on their own axis. The decision is a
deliberate trade of new-run availability and simplicity for durability across
restart, live propagation, and a fail-closed correctness guarantee — anchored on
infrastructure (Redis + the degraded machine) the host already owns.

## Decision

**Store per-tenant config in a Redis-backed registry (`fugue:tenants:<id>`),
propagate every mutation over the `fugue:tenants:events` pub/sub channel, and
fail closed on outage by reusing the existing `redisDied`/`redisRecovered`
degraded state machine and `redis-probe.ts` — refusing 100% of new runs while
preserving in-flight work on live workers.**

The implementation is a functional core / imperative shell split:

- **Pure core — `packages/host/src/supervisor/registry/tenant-registry.ts`.**
  `TenantRegistry` is an immutable `ReadonlyMap<TenantId, TenantConfig>`.
  `TenantConfig` is a discriminated union on `status` —
  `ActiveTenantConfig` (`status:"active"`) vs `DeregisteredTenantConfig`
  (`status:"deregistered"` carrying a required `deregisteredAt` tombstone) — so
  "an active config with a tombstone" and "a deregistered config without an
  instant" are unrepresentable. `register` / `deregister` / `reconfigure` are
  total, pure, and idempotent transitions; `lookup` is the fail-closed query.
  No I/O, no clock: `now` is a parameter, every function returns a new registry.

- **Imperative shell — `packages/host/src/supervisor/registry/redis-registry-adapter.ts`.**
  `createRedisTenantRegistry` holds the in-memory snapshot, delegates every state
  decision to the pure core, then `persistAndAnnounce`s the committed record:
  `SET fugue:tenants:<id>` (via `serialize`, which spells out the persisted shape
  so it is visibly secrets-reference-only) followed by `PUBLISH
  fugue:tenants:events {kind, tenant}`. `subscribeTenantEvents` re-reads a
  changed tenant on each event. Workers observe a reconfigure on their **next
  spawn** (drain + respawn — no live hot-swap; the supervisor's no-hot-swap /
  next-spawn decision, ADR-0064).

- **The fail-closed seam.** New-run admission MUST resolve via
  `resolveForNewRun`, which returns the `redis-unavailable` HostError
  **internally** whenever the adapter's `degraded` flag is set. The supervisor
  deliberately maps that internal error to a **404 `tenant-unknown`** new-run
  refusal — *not* a 503 — so an outage is indistinguishable from an unknown
  tenant and cannot be used to probe which tenants exist (FR-040 non-leakage; 503
  is reserved for `worker-unavailable`). In-flight / status paths use
  `lookup` (the in-memory snapshot), which is **not** gated by `degraded`. The
  supervisor wires its Redis liveness probe edge to `markRedisDegraded(dead)`
  (`onRedisProbeEdge → registry.markRedisDegraded`), so the new-run gate closes
  the moment the probe sees Redis down — even before any registry write fails —
  and re-opens on recovery. `canServeRequests` is intentionally **not** widened
  to block on this: it stays `true` while degraded so in-flight work keeps being
  served (FR-023). The adapter never kills a worker; it only reads, writes, and
  publishes.

Key invariants:

- **Secrets-ref-only.** A registry entry carries a branded `SecretsRef`
  (ADR-0069), never a secret value. `serialize` is the single seam where config
  becomes bytes; it emits `secretsRef` and nothing sensitive. The pub/sub event
  carries only `{kind, tenant}` — nothing on the bus is ever a secret.
- **Idempotent ops (FR-027 / SC-009).** A re-applied identical `register` /
  `reconfigure` returns the **same registry reference** and the adapter suppresses
  the redundant re-persist + duplicate event. `deregister` of an absent or
  already-deregistered tenant is a no-op **success** that preserves the original
  `deregisteredAt`, so a retried deregister never bumps the grace-window clock.
- **Fail-closed lookups (FR-022).** `lookup` returns `err(tenantUnknown())` for
  an unknown **or** deregistered-but-retained tenant — never a guessed config,
  never the tombstone — and `resolveForNewRun` additionally returns
  `redis-unavailable` while degraded. A registry that cannot positively confirm
  an active tenant never routes a new run.
- **Deregister-then-purge.** `deregister` **tombstones-and-retains** (so
  in-flight work drains and the footprint survives the grace window, US6);
  `hardDelete` is the distinct final purge step that removes the
  `fugue:tenants:<id>` key and announces the absence. On any Redis failure the
  shell fails closed (degraded machine) and does **not** advance the in-memory
  view, so memory never diverges from a write that did not land.

## Consequences

**Positive:**

- The fail-closed correctness guarantee is proven, not asserted:
  `packages/host/src/__tests__/integration/fail-closed-registry-down.test.ts`
  wires the real Redis-backed registry over the in-memory Redis fake through the
  exact `resolveForNewRun` seam the binary uses, drives the probe edge to DOWN,
  and asserts that **100%** of new-run requests are refused, the proxy transport
  is hit **zero** times during the outage (no stale routing), and every tenant
  still resolves via `lookup` so in-flight work on live workers continues at
  **100%** — then re-admits on recovery. This is the executable witness for
  SC-007 / NFR-022.
- Reuses the host's existing Redis + degraded state machine (ADR-0003,
  `host-state.ts`, `redis-probe.ts`): no new durability engine, the same
  internal `redis-unavailable` HostError vocabulary as every other adapter (here
  mapped to a non-leaking 404 new-run refusal, see Decision), and durability
  across a supervisor restart that US7 / re-adoption (ADR-0065) depend on.
- Idempotency and the fail-closed unknown-tenant decision live entirely in a
  pure, dependency-free core that is trivially unit- and property-testable; the
  shell only persists and announces the result. Illegal lifecycle states are
  unrepresentable at the type level.
- The new-run refusal is `tenant-unknown` (404), identical to an unknown tenant,
  so an outage cannot be used to probe which tenants exist (FR-040 non-leakage) —
  also asserted by the fail-closed test.

**Negative:**

- Propagation is **eventual**, not instantaneous: a reconfigure takes effect only
  on a worker's next spawn (no live hot-swap), so an admin's reconfigure does not
  alter an already-running worker mid-run. This is a deliberate trade (it keeps
  "one worker = one immutable tenant config" true and avoids reopening the
  cross-tenant state surface), but operators must understand "drain + respawn for
  immediate apply."
- New-run admission now has a hard dependency on Redis liveness. A Redis outage
  refuses 100% of *new* runs by design — correct per FR-022, but it means Redis
  availability is the ceiling on new-run admission availability. (In-flight work
  is deliberately insulated via the in-memory snapshot.)
- The shell carries a write-then-publish two-step whose failure handling must
  keep the in-memory view from diverging from Redis; the "fail closed, do not
  advance memory on any step failure" rule is load-bearing and rests on the
  adapter tests
  (`packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`,
  `tenant-registry.test.ts`) rather than a transaction.
- A poisoned or corrupt persisted record / bus message is treated as best-effort
  skip (logged, never thrown). This keeps the subscriber and hydrate paths
  crash-proof, but a corrupt `fugue:tenants:<id>` record silently drops that
  tenant from the hydrated registry rather than surfacing loudly.

## Related

- ADR-0064 — overall multi-tenant single-host approach (supervisor + process-per-tenant workers); this registry is the supervisor's tenant source of truth. (The AD-N seed IDs are defined in the plan / plan-alignment, not in ADR-0064.)
- ADR-0065 — worker registry: the sibling Redis-backed registry (`fugue:supervisor:workers:<tenant>`) that reuses the same fail-closed posture and powers supervisor restart re-adoption (US7, SC-006).
- ADR-0069 — per-tenant secrets reference: the `SecretsRef` stored (never dereferenced) by this registry; the worker is the only process that can resolve it.
- ADR-0003 — event-sourcing via Redis streams: establishes Redis as the host's existing backing store and liveness substrate this decision reuses.
- `packages/host/src/supervisor/registry/tenant-registry.ts` — pure registry ADT, idempotent transitions, fail-closed `lookup` (this decision in code).
- `packages/host/src/supervisor/registry/redis-registry-adapter.ts` — Redis persistence + pub/sub + `resolveForNewRun` / `markRedisDegraded` fail-closed wiring.
- `packages/host/src/__tests__/integration/fail-closed-registry-down.test.ts` — SC-007 / NFR-022 witness: zero stale routing + in-flight survival under outage.
