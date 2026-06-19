# PR Remediation Plan

**Date:** 2026-06-19
**Branch:** feat/multi-tenant-single-host
**Scope:** multi-tenant single-host runtime (152 files, 28,568 insertions)
**Findings:** 8 critical (deduped), 26 advisory — across 6 parallel review agents

The PR is exemplary: code-reviewer, silent-failure-hunter, and pr-test-analyzer each
returned **zero** critical bugs. All criticals come from architecture (2), type-design
(2), and comment-analyzer (2), plus one type-design finding that is a latent type-hole
already mitigated in production. After investigation, the actionable critical set is
below.

## Critical Fixes

### Fix 1: Cache/checkpoint keys diverge from the routed tenant (isolation consistency)
- **Source:** comment-analyzer (CRITICAL #2), confirmed by code investigation
- **File:** `adapters/node-context-factory.ts:312-334`, `host.ts:670`, `hitl/adapters/run-executor.ts:84`
- **Issue:** Cache/checkpoint Redis keys derive their tenant axis from `dag.team` while
  every other store (token, HITL, run-lock) uses `routedTenant` (= `Tenant.id`).
  `Tenant` carries `id` and `team` as independent fields, so when `id !== team` a
  tenant's cache/checkpoint keys land under `fugue:<team>:*` while the rest land under
  `fugue:<id>:*` — contradicting ADR-0067's single-namespace invariant. The
  `// T6 replaces this derivation` comment is stale (T6/worker shipped).
- **Fix:** Add an optional `routedTenant?: TenantId` param to `createNodeContextForDag`,
  authoritative when provided (production always provides it), falling back to the
  `dag.team` derivation only when absent (preserves existing fail-closed-derivation
  tests + the single-tenant `main.ts` path). Thread `routedTenant` from `host.ts` and
  through `RunExecutorDeps` for the HITL resume path. Update the stale comment. Add a
  test asserting `routedTenant` overrides `dag.team` for cache/checkpoint keys.

### Fix 2: Tenant-keyed integrity/path functions accept unbranded `string`
- **Source:** type-design (CRITICAL #2)
- **File:** `domain/tenant-header.ts:50,84-87`, `domain/config.ts:597`
- **Issue:** `signTenantHeader`/`verifyTenantHeader` parse the `<tenantId>.<hmacHex>`
  wire format by the first `.`, an invariant that only holds because `TenantId` forbids
  `.` — yet the signatures take plain `string`, so the parse-safety guarantee is not
  required by the type. `workerSocketPath` similarly takes `string` while its doc claims
  a `TenantId`-derived no-escape guarantee. All live callers already pass branded ids.
- **Fix:** Tighten the three signatures to `TenantId` so the brand makes the invariant
  load-bearing. Pure type narrowing — no behavior change.

### Fix 3: Concurrent cold-spawn double-spawns two workers on one UDS (split-brain)
- **Source:** architecture-tech-lead (CRITICAL #1), confirmed by code investigation
- **File:** `supervisor/lifecycle/worker-lifecycle-manager.ts:316-327`
- **Issue:** `ensureWorker` → `lazySpawn` has no in-flight coalescing. Two concurrent
  first-requests for a cold tenant both observe no `live` entry and both spawn a worker
  onto the same `workerSocketPath(udsDir, tenant)` — UDS bind contention, doubly-charged
  live slot, one orphaned process.
- **Fix:** Single-flight: coalesce concurrent `ensureWorker(tenant)` onto one shared
  in-flight `Promise<Result<EnsuredWorker>>` keyed by `TenantId`, cleared on settle.

### Fix 4: Failed re-adoption serves with an empty worker map (restart split-brain)
- **Source:** architecture-tech-lead (CRITICAL #2)
- **File:** `main-supervisor.ts:372-380`
- **Issue:** On `reconcileReadopt()` failure the supervisor logs a warning and serves
  with an empty in-memory map, racing lazy-spawn against still-live re-parented workers
  on the same UDS. `registry.hydrate()` 150 lines above already `process.exit(1)`s on
  Redis-down, so this is the one inconsistent fail-open in the startup path.
- **Fix:** Fail-closed — log error, `disconnect()`, `process.exit(1)` (mirrors the
  hydrate guard); thin-init restarts and retries the readopt once Redis is healthy
  (bounded by the supervisor restart budget).

### Fix 5: ADRs 0067/0069 describe Redis-ACL data-plane wiring as runtime-active
- **Source:** comment-analyzer (CRITICAL #1), code-reviewer (ADVISORY A1)
- **File:** `docs/adr/0067-per-tenant-redis-acl-isolation.md`, `docs/adr/0069-...md`
- **Issue:** Present-tense "Decision" prose ("each worker authenticates as a per-tenant
  Redis ACL user", credential "flows only into the owning worker") describes a mechanism
  whose provisioner (`apply`) has **no production caller** — the worker connects with the
  shared `REDIS_URL`; ACL enablement is a deferred operational step (a later wave, per
  `docs/migrations/tenant-key-namespacing.md`). The active isolation is the
  type-enforced app-layer `fugue:<tenant>:` key prefixing. The ACL credential handoff is
  a real feature scoped to a future wave, not part of this PR — so the correct
  remediation here is doc accuracy, not building the feature.
- **Fix:** Reframe the affected ADR sections as the intended/target design with an
  explicit "Status: not yet wired into the runtime — app-layer key prefixing is the
  active isolation; ACL credential handoff lands in a later wave" note.

### Fix 6 (verify-only): TenantRegistryView prototype-confusion type-hole
- **Source:** type-design (CRITICAL #1)
- **File:** `domain/tenant.ts:114-130`, production view `main-supervisor.ts:228`
- **Investigation:** The production view resolves via `active.find(c => c.team === team)`
  over Map-derived entries — it never indexes a plain object by the caller-influenced
  team, so a crafted `__proto__`/`toString` team cannot resolve to a function-valued
  tenant. **No live vulnerability.** The finding is that the *type* permits a future
  unsafe adapter; the dynamic-registry design (live snapshot per lookup) precludes the
  suggested static-Map sole-constructor without breaking live reconfiguration.
- **Action:** No behavioral change. Reinforce the inline note at the production view
  documenting why it is own-property-safe by construction.

## Advisory Fixes (high-value, low-risk)

### Fix A1: Validate `agentClientIdsByDag` value types at the trust boundary
- **Source:** code-reviewer (ADVISORY)
- **File:** `http/handlers/admin/tenants.ts:103`
- **Fix:** Parse-don't-validate — reject a registration body whose `agentClientIdsByDag`
  has any non-string value, instead of casting `as Record<string, string>`.

### Fix A2: Property-test the load-bearing prefix-containment invariant
- **Source:** pr-test-analyzer (ADVISORY)
- **File:** `__tests__/domain/cache-keys.test.ts:61`
- **Fix:** Add a `fast-check` property test over arbitrary `TenantId` pairs proving every
  builder output is prefixed `fugue:<tenant>:` and two distinct tenants are prefix-disjoint.

## Deferred (documented, out of scope for this remediation)

- **Redis-ACL runtime credential handoff** — a future-wave feature (T11), not a defect.
  Addressed as doc accuracy (Fix 5).
- **`retryAfterSecondsFor` exhaustiveness** (host-error.ts:241) — safe `undefined`
  default; full `.exhaustive()` is ~20 arms of high-churn/low-value. Deferred.
- **`markSecretsRef` empty-reject**, **`Team` brand**, **per-worker crash-loop budget**,
  **idle-evict SIGKILL follow-up**, **`emptyRegistry` frozen singleton**, **HITL resume
  `bindSubjectToken`** (correct fail-closed; clarifying comment added in passing) —
  legitimate hardening, none a live bug; tracked for a follow-up pass.

## Validation Commands
```bash
cd packages/host
bun run typecheck
bun test
```
