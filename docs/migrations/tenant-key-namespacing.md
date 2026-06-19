# Migration: Tenant Key Namespacing

**Status:** required before enabling per-tenant Redis ACL (AD-4).
**Scope:** every Redis key the host produces — cache, checkpoint, token store, team index, AND the durable HITL stores (run/checkpoint, pending/decision, lock, bot conversation ref).
**Spec anchors:** FR-013 (per-tenant cache/checkpoint isolation preserved), US2 (hard cross-tenant isolation under compromise), SC-001 (cross-tenant read = zero bytes).

---

## Why

Single-host multi-tenancy (`.claude/plans/2026-06-18-multi-tenant-single-host.md`,
**AD-4**) gives each tenant's worker a **Redis ACL user scoped to one key
prefix**: `~fugue:<tenant>:*`, `+@all` within that keyspace. A compromised /
RCE'd worker that runs `SCAN fugue:*` or `GET fugue:<other>:...` is then
**refused by Redis** with a `NOPERM` error — isolation is enforced by Redis, not
by application code the attacker controls.

That ACL scoping is only **sound if no key escapes the tenant prefix.** Before
this migration the following key schemes were NOT tenant-scoped:

| Subsystem            | Old key scheme                                | Problem |
|----------------------|-----------------------------------------------|---------|
| Cache                | `fugue:<dagId>:cache:<key>`                  | shared across tenants — DAG-scoped only |
| Checkpoint           | `fugue:<dagId>:<runId>:<nodeId>`            | shared across tenants — DAG-scoped only |
| Token store          | `fugue:tokens:<hash>`                        | **global** — every tenant's tokens in one namespace |
| Team index           | `fugue:teams:<team>`                         | **global** — every tenant's teams in one namespace |
| HITL run / checkpoint| `fugue:hitl:run:<runId>`, `fugue:hitl:ckpt:<runId>` | **flat** — every tenant's HITL runs in one namespace |
| HITL pending/decision| `fugue:hitl:pending:<runId>␟<nodeId>`, `fugue:hitl:decision:<runId>␟<nodeId>` | **flat** — every tenant's gate state in one namespace |
| HITL run lock        | `fugue:hitl:lock:<runId>`                    | **flat** — every tenant's run locks in one namespace |
| HITL bot conv ref    | `fugue:hitl:bot:convref:default`, `fugue:hitl:bot:convref:team:<team>` | **flat** — every tenant's bot conversation refs in one namespace |

Under a single shared Redis credential, any worker could read every tenant's
keys. This migration prefixes **every** key with `fugue:<tenant>:` so the
per-tenant ACL pattern actually contains a worker.

---

## New key scheme

Every key is now `fugue:<tenant>:…`:

| Subsystem            | New key scheme                                              |
|----------------------|------------------------------------------------------------|
| Cache prefix         | `fugue:<tenant>:<dagId>:cache:`                            |
| Cache key            | `fugue:<tenant>:<dagId>:cache:<key>`                      |
| Checkpoint prefix    | `fugue:<tenant>:<dagId>:<runId>:`                         |
| Checkpoint key       | `fugue:<tenant>:<dagId>:<runId>:<nodeId>`                 |
| Token key            | `fugue:<tenant>:tokens:<hash>`                            |
| Team index           | `fugue:<tenant>:teams:<team>`                             |
| HITL run / checkpoint| `fugue:<tenant>:hitl:run:<runId>`, `fugue:<tenant>:hitl:ckpt:<runId>` |
| HITL pending/decision| `fugue:<tenant>:hitl:pending:<runId>␟<nodeId>`, `fugue:<tenant>:hitl:decision:<runId>␟<nodeId>` |
| HITL run lock        | `fugue:<tenant>:hitl:lock:<runId>`                        |
| HITL bot conv ref    | `fugue:<tenant>:hitl:bot:convref:default`, `fugue:<tenant>:hitl:bot:convref:team:<team>` |

The original `<dagId>`-prefixed structure is preserved **beneath** the tenant
prefix, so per-DAG isolation (the old FR-031 / SC-008 behaviour) still holds
*within* a tenant (FR-013). Likewise the HITL stores keep their `hitl:<kind>:`
structure **beneath** the tenant prefix. The migration is purely additive: one
new leading `fugue:<tenant>:` segment in front of every host-produced key, so
the end state is COMPLETE — cache, checkpoint, token, team, AND all HITL keys
live under `fugue:<tenant>:…`, and **no** host-produced key escapes the prefix.

### Code changes

- **`packages/host/src/domain/cache-keys.ts`** — `TenantId` is now a **required,
  hard-branded first argument** on `cacheKeyPrefix`, `buildCacheKey`,
  `checkpointKeyPrefix`, `buildCheckpointKey`. A plain `string` does not satisfy
  `TenantId`; the smart constructor `tenantId` (`domain/tenant.ts`) validates
  against `TENANT_ID_REGEX` = `^[A-Za-z0-9_-]{1,64}$` — **`:` and glob
  metacharacters (`*`, `?`, `[`, `]`) are rejected** so a tenant id can never
  inject an extra `:` segment to forge another tenant's namespace NOR craft a
  glob that widens its own `~fugue:<tenant>:*` ACL pattern over a sibling's
  keyspace. All four builders interpolate the tenant through a single
  `tenantPrefix(t) = ` `` `fugue:${t}:` `` helper, so the `fugue:<tenant>:`
  invariant has exactly one definition site.
- **`packages/host/src/adapters/token-store.ts`** — `createRedisTokenStore` takes
  a bound `TenantId`; all `tokens:*` / `teams:*` keys are derived from it. A
  store instance can only ever name its own tenant's keys.
- **`packages/host/src/hitl/adapters/*`** — the four durable HITL stores
  (`run-store` run/ckpt, `decision-store` pending/decision, `run-queue` lock,
  `bot/conversation-store` convref) each take a bound `TenantId` and force every
  key under `fugue:<tenant>:hitl:…`. A store instance can only ever name its own
  tenant's HITL keys.
- **`packages/host/src/adapters/node-context-factory.ts`** — threads the tenant
  into the namespaced cache/checkpoint adapters. Until the supervisor's resolved
  `Tenant` principal is wired (plan T6), the tenant is derived from the DAG's
  owning `team` and branded at this single seam.
- **`packages/host/src/host.ts`** — the single-tenant `createHost` entrypoint
  binds the token store to the constant `default` tenant, so all keys live under
  `fugue:default:`.

### Tenant-id constraint (security boundary)

`tenantId` (validating against `TENANT_ID_REGEX` = `^[A-Za-z0-9_-]{1,64}$`)
**rejects `:` AND glob metacharacters (`*`, `?`, `[`, `]`).** `:` is the
key-segment delimiter; a tenant id containing `:` could otherwise escape into a
sibling namespace (e.g. a tenant id `a:b` would make `fugue:a:b:...`
indistinguishable from tenant `a`'s key for DAG `b`). Glob metacharacters are
rejected because the same `TenantId` is interpolated into the
`~fugue:<tenant>:*` Redis-ACL pattern — a tenant id like `*` or `a*` would widen
that pattern over another tenant's keyspace. This is the parse-don't-validate
boundary for the tenant axis — mirroring `DAG_ID_REGEX`, which already forbids
colons in DAG ids for the same reason.

---

## Operational migration (one-time rekey)

Existing single-tenant deployments hold keys under the OLD scheme. The new code
reads/writes only the NEW scheme, so old data is invisible after upgrade. Choose
ONE of the following.

### Option A — Cold rekey (recommended for cache/checkpoint)

Cache and checkpoint data is regenerable: cache misses recompute, and a
single-tenant deploy with no in-flight HITL runs has no checkpoint state worth
keeping.

1. Drain in-flight runs (graceful shutdown / `SIGTERM`).
2. Pick the tenant id for the existing deploy. For a single-tenant `createHost`
   boot this is `default` (the constant `host.ts` uses). For a worker under the
   supervisor it is the worker's `TENANT_ID`.
3. Flush the old keys (single-tenant Redis only — do NOT flush a shared Redis):
   ```
   redis-cli --scan --pattern 'fugue:tokens:*'  | xargs -r redis-cli del
   redis-cli --scan --pattern 'fugue:teams:*'   | xargs -r redis-cli del
   # cache/checkpoint are dagId-prefixed; safe to drop — they regenerate:
   redis-cli --scan --pattern 'fugue:*:cache:*' | xargs -r redis-cli del
   ```
4. Deploy the new host. **Re-mint team tokens** (see Option B step 3 if you must
   preserve them) — they are the only non-regenerable data dropped here.

### Option B — Live backfill (preserve team tokens)

Team tokens are NOT regenerable (the plaintext token is shown once at mint). To
keep existing teams working, copy the global token/team keys into the tenant
namespace before cutover. Run against the single-tenant Redis, substituting the
deploy's tenant id (e.g. `default`):

```bash
TENANT=default

# Token keys: fugue:tokens:<hash> -> fugue:<TENANT>:tokens:<hash>
redis-cli --scan --pattern 'fugue:tokens:*' | while read -r k; do
  hash="${k#fugue:tokens:}"
  redis-cli --eval - "$k" "fugue:${TENANT}:tokens:${hash}" <<'LUA'
    local v = redis.call('GET', KEYS[1])
    if v then redis.call('SET', KEYS[2], v) end
    return 1
LUA
done

# Team index: fugue:teams:<team> -> fugue:<TENANT>:teams:<team>
redis-cli --scan --pattern 'fugue:teams:*' | while read -r k; do
  team="${k#fugue:teams:}"
  redis-cli --eval - "$k" "fugue:${TENANT}:teams:${team}" <<'LUA'
    local v = redis.call('GET', KEYS[1])
    if v then redis.call('SET', KEYS[2], v) end
    return 1
LUA
done
```

1. Run the backfill above (idempotent — re-runnable; it only copies).
2. Deploy the new host. Verify teams resolve (`GET /admin/teams` or an
   authenticated DAG run).
3. After a soak window, delete the old global keys. First a real sanity check —
   confirm the OLD delete-pattern does NOT match any NEW-scheme key (i.e. no key
   returned by the old `fugue:tokens:*` pattern contains the tenant segment
   `:${TENANT}:`, proving the delete below cannot touch tenant-namespaced data):
   ```bash
   # Must print NOTHING. Any line here would be a new-scheme key wrongly matched
   # by the old pattern — STOP and investigate before deleting.
   redis-cli --scan --pattern 'fugue:tokens:*' | grep ":${TENANT}:" || echo "sane: old pattern matches no tenant-namespaced key"
   ```
   ```
   redis-cli --scan --pattern 'fugue:tokens:*' | xargs -r redis-cli del
   redis-cli --scan --pattern 'fugue:teams:*'  | xargs -r redis-cli del
   ```
   (Old keys are `fugue:tokens:*` / `fugue:teams:*`; new keys are
   `fugue:<tenant>:tokens:*` and are NOT matched by those patterns — the leading
   segment is `fugue:<tenant>:`, not `fugue:tokens`.)

### Cache / checkpoint

Always treat as cold (Option A): they are dagId-namespaced regenerable data. A
checkpoint left under the old scheme simply causes the corresponding HITL run to
restart from its last reachable gate, which is the documented crash/resume
behaviour (AD-8).

---

## Enabling the Redis ACL (after rekey)

Once every key is tenant-prefixed, the supervisor can provision and manage the
per-tenant ACL user AUTOMATICALLY (ADR-0067). This is no longer a manual
`ACL SETUSER` step — set one flag:

```
SUPERVISOR_REDIS_ACL_ENABLED=true
```

With the flag on, at each worker spawn the supervisor mints a fresh 256-bit
password and runs (over its admin connection):

```
ACL SETUSER fugue-tenant-<tenant> reset on resetchannels ~fugue:<tenant>:* +@all -@admin -@dangerous -@scripting -keys -scan -randomkey -dbsize … ><minted-password>
```

then injects `FUGUE_REDIS_ACL_USERNAME`/`FUGUE_REDIS_ACL_PASSWORD` into the
worker's env so the worker authenticates as that scoped user. `ACL DELUSER` runs
in the grace-window purge on deregister.

**Prerequisite:** the supervisor's `REDIS_URL` credential must have ACL admin
rights (e.g. `+@admin`/`+acl`) on an ACL-capable Redis/Valkey. If it does not,
spawns fail closed (`worker-unavailable`) — leave the flag off until the admin
credential is provisioned.

Verify isolation (SC-001): connected as `fugue-tenant-<tenantA>`, the following must
return `NOPERM`, proving zero bytes escape the prefix:

```
SCAN 0 MATCH fugue:*
GET  fugue:<tenantB>:tokens:<anyhash>
```

---

## Verification checklist

- [ ] `bun run typecheck` green (a bare `string` no longer satisfies a key builder).
- [ ] `packages/host/src/domain/cache-keys.test.ts`: every builder output starts
      with `fugue:<tenant>:`; two tenants never collide; per-DAG isolation
      preserved within a tenant.
- [ ] `packages/host/src/__tests__/token-store.test.ts`: token/team keys
      tenant-prefixed; two tenants with an identical team + hash do not collide;
      revoke/list/resolve never cross tenants.
- [ ] `tenantId` rejects a `:`-containing id AND a glob-metacharacter id (`*`,
      `?`, `[`, `]`) — see `packages/host/src/domain/tenant.test.ts`.
- [ ] After rekey: `SCAN fugue:*` as a tenant ACL user returns `NOPERM`.
