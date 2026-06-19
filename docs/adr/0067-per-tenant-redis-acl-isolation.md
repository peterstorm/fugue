# ADR-0067: Per-tenant Redis isolation — one ACL user per tenant on one Redis server, with tenant-prefixed keys

> **Consolidated reference:** the operational "how to rekey and enable this" lives in
> [`docs/migrations/tenant-key-namespacing.md`](../migrations/tenant-key-namespacing.md).
> This ADR is the immutable "why" behind the isolation mechanism.

## Status

Accepted — mechanism designed, specced, adversarially tested, AND wired into the
runtime behind the `SUPERVISOR_REDIS_ACL_ENABLED` flag (default off; see
"Implementation status" under Decision). With the flag on, the supervisor mints a
per-tenant ACL credential at worker spawn and the worker authenticates as its own
`~fugue:<tenant>:*`-scoped user, so cross-tenant reads are refused by Redis with
NOPERM. With the flag off (default), isolation rests on the type-enforced
application-layer key prefixing and the worker uses the shared `REDIS_URL`
credential — enabling the ACL is a deliberate operational step (it requires an
ACL-capable Redis whose admin credential can run `ACL SETUSER`).

## Date

2026-06-19

## Context

The multi-tenant single-host design (plan AD-4) runs many tenants behind one
listener, with one OS process (worker) per tenant. Every worker shares a single
Redis server for its cache, checkpoint, token, team-index, and durable HITL
state. US2 makes the central security premise explicit and non-negotiable: a
**hostile, compromised, or RCE'd worker** — running fully attacker-controlled
code via a hostile DAG, a poisoned dependency, or a prompt-injection escape —
**must obtain zero bytes** of any *other* tenant's secrets, files, cache, or
checkpoint data (FR-009, FR-010, NFR-010, SC-001).

The problem is sharply scoped to the Redis data plane. Before this work, the
host's key schemes were not tenant-scoped: cache and checkpoint keys were
`fugue:<dagId>:…` (DAG-scoped only), and the token store and team index were
*global* (`fugue:tokens:*`, `fugue:teams:*`) — every tenant's tokens in one
namespace. Under a single shared Redis credential, any worker could read every
tenant's keys. The forces in tension are: (a) isolation must hold even when the
worker's own code is the adversary, so it cannot rest on application-layer
checks the attacker controls; (b) the deployment is a single pod serving 10–20
tenants (NFR-001), so per-tenant infrastructure that explodes operational cost
is off the table; and (c) the supervisor must hold *zero* tenant secrets
(FR-005, FR-006), so whatever credential enforces isolation cannot live in, or
transit, the supervisor.

The question this ADR settles: **by what mechanism is one tenant's Redis data
made unreachable from another tenant's worker, given a single shared Redis
server and an adversarial worker assumption?**

## Options Considered

1. **One Redis server; per-tenant ACL user scoped to `~fugue:<tenant>:*`, with
   tenant-prefixed keys and keyspace enumeration denied (chosen).**
   - Pros: isolation is enforced **by Redis itself**, on the server side, against
     the credential the worker authenticates with — not by application code the
     compromised worker could bypass. A `GET fugue:<other>:…` or `SCAN fugue:*`
     is refused with `NOPERM` before any byte of the foreign value is touched.
     One server keeps the single-pod model and per-tenant ops cost near zero. The
     credential is a per-tenant secret that flows only into the owning worker via
     the secrets channel (AD-6 / ADR-0069), so the supervisor never holds it
     (FR-005, FR-006). The ACL scope is a *pure* function of the `TenantId`
     (`buildAclSpec`), so it is unit-testable in isolation and adversarially
     testable end-to-end (SC-001).
   - Cons: correctness rests on an invariant that spans two modules — **every**
     host-produced key must carry the `fugue:<tenant>:` prefix, or the ACL
     pattern fails to contain a worker. It also requires denying keyspace
     *enumeration* outright (see Decision), which costs workers the convenience of
     `SCAN`/`KEYS` over their own namespace; they must enumerate via tenant-scoped
     index SETs instead. And it assumes a Redis/Valkey that honours ACL key
     patterns for value access (true on all supported versions).

2. **Separate Redis server (or logical DB via `SELECT n`) per tenant.**
   - Pros: a coarse, intuitively "complete" boundary — different connection,
     different data.
   - Cons: logical DBs (`SELECT n`) share **one** authentication and are
     explicitly *not* a security boundary in Redis — any authenticated client can
     `SELECT` any DB, so a compromised worker simply switches DBs. A separate
     *server* per tenant is a real boundary but explodes operations for 10–20
     tenants (NFR-001): N Redis processes to provision, monitor, back up, and
     upgrade, breaking the single-pod model the whole approach rests on. Rejected.

3. **Application-layer prefix enforcement only (one shared credential; the host
   code refuses cross-tenant keys).**
   - Pros: no ACL provisioning machinery; the prefix discipline already exists in
     `cache-keys.ts`.
   - Cons: defeats the US2 threat model entirely. A compromised worker executes
     arbitrary code in-process — it bypasses the host's key-building functions and
     issues raw Redis commands on the shared credential directly. Isolation that
     lives in the code the attacker controls is no isolation. Rejected as the
     *sole* mechanism (the prefix discipline is retained, but only as the thing
     that makes the *server-enforced* ACL pattern sound — option 1).

There were genuine alternatives; this is a deliberate choice of the only option
that holds under an adversarial-worker assumption while preserving the single-pod
operational model.

## Decision

**One Redis server backs all tenants. Each worker authenticates as a per-tenant
Redis ACL user scoped to EXACTLY one key pattern `~fugue:<tenant>:*`, granted the
data plane minus dangerous/admin/scripting categories, with keyspace
ENUMERATION denied outright. Every host-produced key is prefixed
`fugue:<tenant>:`, so the ACL pattern contains the worker completely. A
compromised worker's cross-tenant read is refused by Redis with `NOPERM`, not by
application code.**

> **Implementation status (2026-06-19).** This mechanism is WIRED into the runtime,
> gated by `SUPERVISOR_REDIS_ACL_ENABLED` (default off):
> - **Flag ON** — at each worker spawn the supervisor calls `apply` over its admin
>   connection (`main-supervisor.ts` → `worker-lifecycle-manager.ts` `provisionRedisAcl`),
>   minting a fresh 256-bit password for the per-tenant user and injecting it into the
>   worker's spawn env (`FUGUE_REDIS_ACL_USERNAME`/`FUGUE_REDIS_ACL_PASSWORD`,
>   `redis-acl.ts`). The worker authenticates to Redis as that scoped user
>   (`worker-main.ts`), so the present-tense Decision below is literally true: a
>   cross-tenant read is refused with NOPERM by Redis. The credential transits ONLY
>   the spawn env (bounded, unretained, never-logged — AD-6); `revoke` (`ACL DELUSER`)
>   runs in the grace-window purge.
> - **Flag OFF (default)** — no ACL user is provisioned; the worker connects with the
>   shared `REDIS_URL` credential and the LIVE per-tenant isolation is the
>   application-layer key prefixing below (load-bearing and type-enforced: `TenantId`
>   is a required hard-branded argument on every key builder). Enabling the flag is a
>   deliberate operational step (requires an ACL-capable Redis whose admin credential
>   can run `ACL SETUSER`); see
>   [`docs/migrations/tenant-key-namespacing.md`](../migrations/tenant-key-namespacing.md).

The mechanism is split into a pure spec and an imperative provisioner:

- **The pure ACL spec — `packages/host/src/supervisor/secrets/redis-acl.ts`
  (`buildAclSpec(TenantId)`).** A deterministic, total, I/O-free description of
  the per-tenant user. It contains **no credential** (the password is minted at
  apply time), so the spec can be logged and inspected freely. It emits the
  ordered `ACL SETUSER` rule tokens: `reset` (clean slate, idempotent
  re-provisioning), `on`, `resetchannels` (no cross-tenant pub/sub), the single
  key pattern `~fugue:<tenant>:*`, then `+@all` followed by `-@admin -@dangerous
  -@scripting` and explicit single-command denials.

- **The provisioner — `packages/host/src/supervisor/secrets/redis-acl-provisioner.ts`
  (`apply` / `revoke`).** The imperative shell that carries the spec's tokens over
  the supervisor's **admin** Redis connection (`RedisAclAdminPort`, distinct from
  the data-plane `RedisPort`), mints a 256-bit password from injected randomness,
  and issues `ACL SETUSER <username> <…rules> ><password>`. It is **fail-closed**:
  on any non-ok admin response it returns `err(redis-unavailable)` and returns
  *no* credential for a user that may not exist. The minted credential
  (`AppliedAclCredential`) is returned to the caller for immediate handoff to the
  SecretsSource channel (AD-6 / ADR-0069); the provisioner **never** persists or
  logs it, so it flows only into the owning worker and never lodges in the
  supervisor (FR-005, FR-006).

- **The key scheme — `packages/host/src/domain/cache-keys.ts` and
  `packages/host/src/adapters/token-store.ts`.** Every key routes through the
  single `tenantPrefix(t) = `` `fugue:${t}:` `` chokepoint, and `TenantId` is a
  **required, hard-branded** argument on every builder, so a bare string cannot
  emit an unscoped key. Cache, checkpoint, token, team, and HITL keys all live
  under `fugue:<tenant>:…`; the migration that retrofitted this is
  `docs/migrations/tenant-key-namespacing.md`.

**Key invariants:**

- **Exactly ONE key pattern.** `buildAclSpec` emits `~fugue:<tenant>:*` and
  nothing else — never `~*`, never `allkeys`, never a second pattern. The user's
  reach is the intersection of "this one pattern" and "the data-plane commands".

- **The pattern cannot widen.** This single-pattern guarantee is sound only
  because `TenantId` (`domain/tenant.ts`, `TENANT_ID_REGEX =
  ^[A-Za-z0-9_-]{1,64}$`) forbids `:` (the key delimiter) and every glob
  metacharacter (`*`, `?`, `[`, `]`). A tenant id containing `:` could forge a
  sibling's namespace; one containing a glob could widen its own ACL pattern over
  a sibling's keyspace. `buildAclSpec` and `markTenant` both **re-assert**
  `TENANT_ID_REGEX` and throw `internal-invariant-violated` if a cast bypassed the
  `tenantId` smart constructor — a malformed id can never reach an ACL pattern.

- **Keyspace enumeration is DENIED — the load-bearing, version-independent
  reasoning.** A key-pattern ACL reliably gates commands that access a key's
  *value*, but it does **not** reliably scope commands that *enumerate* the
  keyspace across Redis/Valkey versions: `SCAN` / `SCAN MATCH` / `RANDOMKEY` can
  return — and `DBSIZE` counts — keys *outside* the user's pattern on many
  servers. That matters acutely here because the key **names themselves encode
  sensitive data**: `fugue:<tenant>:teams:<team>` reveals team names,
  `fugue:<tenant>:tokens:<hash>` reveals token hashes, and the `<tenant>` segment
  *is* the deliberately-unprobeable tenant roster (FR-040). A scoped worker that
  could enumerate the keyspace would defeat the isolation premise even without
  reading a single value. We therefore deny `scan`, `keys`, `randomkey`, and
  `dbsize` outright rather than trust the (historically false) assumption that the
  key ACL filters their results. Workers enumerate their **own** keys via
  tenant-scoped index SETs read with `SMEMBERS` — a single-key read the key ACL
  *does* constrain (`adapters/token-store.ts` `listTeams`). The supervisor's
  registry hydrate `SCAN`s on the **unrestricted admin** connection, never this
  user.

- **Least-privilege, fail-closed command scoping.** Dangerous capabilities are
  removed by *category* (`-@admin`, `-@dangerous`, `-@scripting`) so a future
  Redis command added to one of those categories is denied by default, not
  silently granted; explicit single-command denials (`config`, `acl`, `flushall`,
  `flushdb`, `debug`, `shutdown`, the enumeration commands, `eval`/`evalsha`/
  `script`/`function`, `module`, `cluster`, `slaveof`/`replicaof`/`failover`,
  `swapdb`, `migrate`, `restore`) survive any category re-classification. `@scripting` is denied
  because Lua can be used to escape key-ACL checks in some configurations.

- **Fail-closed apply.** Every admin command returns `Result`; on any `!ok` the
  provisioner aborts, returns `err`, and never hands back a credential for a user
  that may not have been created — it never half-provisions silently.

This decision is the data-plane layer of the three-layer isolation story; the
adversarial test `__tests__/integration/isolation-cross-tenant-read.test.ts`
provisions *through the real `buildAclSpec`* and asserts that a cross-tenant
`GET`/`SET` and a `SCAN fugue:*` return `NOPERM` with zero victim bytes, while
own-tenant access still succeeds — and includes a non-vacuity meta-test proving a
widened spec (`~*`, or `+@all` ordered after `-scan`) *would* leak, so the
harness is enforcing the real spec, not its own logic.

## Consequences

**Positive:**

- Cross-tenant reads and writes are refused **by the Redis server** against the
  worker's own credential, so isolation survives full worker compromise (US2,
  FR-009, FR-010, SC-001) — the attacker controls the worker's code but not the
  ACL the server enforces.
- Integrity, not just confidentiality, is protected: a `SET fugue:<other>:…` is
  refused, so a hostile worker cannot *poison* another tenant's cache or
  checkpoint state either.
- One Redis server preserves the single-pod model and keeps per-tenant
  operational cost to "one `ACL SETUSER`", scaling to 10–20 tenants (NFR-001)
  without N Redis processes.
- The supervisor holds zero secrets: the ACL credential is minted at apply time
  and handed straight to the owning worker's secrets channel, never retained or
  logged by the provisioner (FR-005, FR-006).
- The ACL scope is a pure function of `TenantId`, so it is unit-testable
  (`redis-acl.test.ts`) and the whole boundary is adversarially testable end to
  end (`isolation-cross-tenant-read.test.ts`, SC-001) with a non-vacuity guard.
- Per-DAG cache/checkpoint isolation is preserved *beneath* the tenant prefix, so
  the older intra-tenant guarantee (FR-013) still holds.

**Negative:**

- The boundary is only as sound as the key-prefix discipline: **every**
  host-produced key (cache, checkpoint, token, team, and all HITL stores) must
  carry `fugue:<tenant>:`. A future subsystem that emits an unprefixed key would
  silently fall outside every tenant's ACL pattern. The single `tenantPrefix`
  chokepoint plus the required hard-branded `TenantId` argument make this
  hard to violate accidentally, but it remains a cross-module invariant guarded by
  review and the migration's verification checklist rather than a single type.
- Workers lose `SCAN`/`KEYS` over their own namespace and must maintain
  tenant-scoped index SETs to enumerate, since enumeration is denied outright.
  This is the deliberate cost of the version-independent enumeration-denial
  stance; it adds a small amount of bookkeeping to any feature that needs to list
  keys.
- The mechanism assumes a Redis/Valkey deployment whose ACL key patterns gate
  value access as documented; a non-conforming server (or a misconfigured
  `aclfile`) would weaken the boundary. The adversarial isolation test guards the
  *spec*, but the runtime server's ACL behaviour is a deployment assumption.
- Re-provisioning rewrites the user from a clean `reset` baseline each time; the
  password is rotated on every `apply`, so any cached connection holding an old
  credential is invalidated — correct for security, but worker reconfiguration
  must re-pull the credential rather than reuse a stale one. (With
  `SUPERVISOR_REDIS_ACL_ENABLED` on, `apply` runs on EVERY spawn, so a worker that
  is evicted and later re-spawned gets a freshly rotated password automatically;
  with the flag off, `apply` is not invoked and this rotation does not occur.)

## Related

- ADR-0064 — overall multi-tenant single-host approach (supervisor + process-per-
  tenant workers): the topology this isolation mechanism secures.
- ADR-0069 — per-tenant secrets behind a `SecretsSource` port: the channel the
  minted ACL credential flows through into the owning worker (the consumer of
  `apply`'s returned `AppliedAclCredential`), realizing FR-005/FR-006.
- ADR-0073 — the resolved `Tenant` principal: supplies the hard-branded
  `TenantId` whose `TENANT_ID_REGEX` shape is what makes the single
  `~fugue:<tenant>:*` pattern unable to widen.
- `docs/migrations/tenant-key-namespacing.md` — the one-time rekey that puts
  every host-produced key under `fugue:<tenant>:` so the ACL pattern contains a
  worker; includes the operational steps to enable the ACL and verify SC-001.
- `packages/host/src/supervisor/secrets/redis-acl.ts` — `buildAclSpec`, the pure
  per-tenant ACL spec (this decision in code), with the enumeration-denial banner.
- `packages/host/src/supervisor/secrets/redis-acl-provisioner.ts` — `apply` /
  `revoke` over the admin connection; the fail-closed, credential-handoff shell.
- `packages/host/src/domain/cache-keys.ts`,
  `packages/host/src/adapters/token-store.ts` — the `fugue:<tenant>:` key scheme
  the ACL pattern matches.
- `packages/host/src/__tests__/integration/isolation-cross-tenant-read.test.ts`,
  `packages/host/src/__tests__/supervisor/secrets/redis-acl.test.ts` — the
  adversarial (SC-001) and unit guards, provisioned through the real
  `buildAclSpec`.
