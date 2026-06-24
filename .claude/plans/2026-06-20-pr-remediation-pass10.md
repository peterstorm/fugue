# PR Remediation Plan — Pass 10

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host
**PR:** #27 (multi-tenant single-host runtime)
**Findings:** 4 critical, 6 advisory (after 11-agent review; 7 of 11 agents found the code clean)

The review cohort (5 × code-reviewer by subsystem, 2 × silent-failure-hunter, type-design,
pr-test-analyzer, architecture-tech-lead, comment-analyzer) confirmed the supervisor lifecycle,
secrets/ACL, and silent-failure surfaces are clean after 9 prior passes. Remaining genuine findings
below — all verified against the actual code before planning.

## Critical Fixes

### Fix 1: Team↔tenant 1:1 conflict returns HTTP 500 instead of 4xx
- **Source:** code-reviewer (registry/routing)
- **File:** `packages/host/src/supervisor/registry/tenant-registry.ts:329,413`
- **Issue:** `register`/`reconfigure` return `{ kind: "config-invalid" }` for a team conflict.
  `config-invalid` is documented as a HOST config-LOAD fault → **500**. A caller-side team
  conflict (client error) therefore surfaces as 500 instead of a 4xx. The admin handler only
  translates `config-invalid`→`tenant-config-invalid` for the parse step (`tenants.ts:170-172`),
  not for registry results.
- **Fix:** Return `tenantConfigInvalid(...)` (→ 400) directly from the registry at both seams
  (the error kind reflects reality at the source; every consumer gets the right status for free).
  Update the two registry-test assertions (`tenant-registry.test.ts:171,206`).

### Fix 2: Deregister silently skips token revoke on case-mismatched team
- **Source:** code-reviewer (domain/http)
- **File:** `packages/host/src/http/handlers/admin/tenants.ts:150`
- **Issue:** `teams.ts` canonicalizes team names to `.trim().toLowerCase()` (token store keyed
  lowercase; revoke also lowercases). `tenants.ts:150` brands the tenant's `team` **verbatim**.
  A tenant registered with team `"Foo"` tombstones with `"Foo"`; `handleDeregister` then calls
  `tokenStore.revoke("Foo")` against a store keyed `"foo"` — an idempotent miss returning `ok`,
  so `revokeComplete: true` is reported while the token still works (FR-029 silent failure).
  `canAccessDag` compares `Team` with strict `===`, so the lowercase convention is load-bearing.
- **Fix:** Canonicalize the team at the tenant-registration trust boundary
  (`markTeam(o.team.trim().toLowerCase())`), mirroring `teams.ts`. Verified: no tenant-registration
  test registers a non-canonical team (the `Team-B`/`UPPER_CASE` cases are token-provisioning tests).

### Fix 3: Outbound OAuth/WIF/Graph fetch has no request timeout
- **Source:** code-reviewer (adapters/HITL)
- **File:** `packages/host/src/adapters/fetch-http-post.ts:85`, `fetch-graph-http.ts:74`
- **Issue:** Neither transport passes an `AbortSignal`; the init types don't even carry `signal`.
  A hung Keycloak/Entra/Graph endpoint blocks the broker's `await http.post`/`http.request`
  indefinitely (and stalls all single-flight waiters), never degrading to the retriable
  `infra-unreachable` the port contract promises.
- **Fix:** Add `signal?: AbortSignal` to `FetchLike`/`GraphFetchLike` init; add a `timeoutMs`
  param (default 30_000) to both factories; pass `signal: AbortSignal.timeout(timeoutMs)`. The
  existing `try/catch` already maps the resulting `AbortError` rejection to `infra-unreachable`.

### Fix 4: Stale security-doc claims contradict shipped code
- **Source:** comment-analyzer
- **File:** `docs/team-security-and-capabilities.md:200,207,324,553-557`
- **Issue:** Three claims contradict code this PR ships: (a) "JWKS verifier is a stub — 401 today"
  but `createRealmJwtVerifier` (jose `createRemoteJWKSet`) is wired at `host.ts:499` when
  `REALM_JWT_ISSUER` is set; (b) flat token keys `fugue:tokens:<hash>` but `token-store.ts` uses
  tenant-prefixed `fugue:<tenant>:tokens:<hash>`; (c) Graph transport "STUB ONLY" but `host.ts:328`
  wires `createFetchGraphHttp()` when Entra config present. The status matrix rows (553-557) are
  stale for the same reason.
- **Fix:** Update the affected lines/rows to reflect the wired-on-config state (verified against
  `host.ts:303-328,496-508` and `token-store.ts:42-53`).

## Advisory Fixes

### Fix 5: `.env.example` missing 7 operator-facing supervisor tunables
- **Source:** comment-analyzer
- **Fix:** Document `SUPERVISOR_MAX_LIVE_WORKERS`, `WORKER_IDLE_EVICT_MS`, `WORKER_HEAP_CAP_MB`,
  `FUGUE_SUPERVISOR_HMAC_KEY`, `WORKER_UDS_DIR`, `SUPERVISOR_GRACE_WINDOW_MS`,
  `SUPERVISOR_GRACE_PURGE_INTERVAL_MS` in the supervisor section.

### Fix 6: Imprecise ADR citation
- **Source:** comment-analyzer
- **File:** `tenant-registry.ts:276` — `(ADR-0061/0064)` → `(ADR-0064/0068)` (0068 is the tenant
  registry ADR; 0061 is per-team DAG image scoping, only tangential to routing determinism).

### Fix 7: Dead `restart` transition not annotated at its export
- **Source:** architecture-tech-lead
- **File:** `worker-lifecycle.ts:298` — the orchestrator uses delete-and-re-request (RESTART-AT-CAP),
  never `restart`. Annotate the export as deliberately production-unused so a maintainer doesn't
  wire it and reintroduce the crash-loop-at-cap bug. (Kept, not deleted — `worker-lifecycle.test.ts`
  exercises the transition.)

### Fix 8: `spawn`/`proc` same-instance intent invisible at the deps seam
- **Source:** architecture-tech-lead
- **File:** `main-supervisor.ts` — add a one-line note that production binds both ports to one
  `createBunSpawnAdapter` instance.

### Fix 9: Registry freeze inconsistency
- **Source:** type-design-analyzer
- **File:** `tenant-registry.ts:162,271` — `emptyRegistry` freezes; `registryOf`/`withEntry` don't.
  Freeze all producers for a uniform runtime-immutability guard.

### Fix 10: `PersistedIdentity.team` brand-drop undocumented
- **Source:** type-design-analyzer
- **File:** `hitl/types.ts` — add a one-line note that the `Team` brand is deliberately erased at the
  JSON persistence boundary and restored via `markTeam` in `toExecIdentity`.

## Deferred (documented, not fixed)
- `node-context-factory` best-effort cache `set` swallowing `!ok`: deliberate + documented (loses
  only a cache entry, never run/auth state). Not a data-loss bug.
- Audit `RawTenantId` separate type / `fsRoot` `ConfinedPath` brand: sound today (audit-only / single
  producer); larger type refactors out of scope for a remediation pass.
- Worker-side ACL-credential integration test reaching `createRedisConnectivity`: covered on both ends
  in isolation; a single end-to-end seam test is a nice-to-have — added if low-risk.

## Validation Commands
```bash
cd packages/host && bun run typecheck
cd packages/host && bun test
```

## Result

All 10 fixes applied. **7 regression tests added** to lock the behavior fixes:
- `tenant-registry.test.ts` — 2 assertions updated (`config-invalid` → `tenant-config-invalid`).
- `tenants.test.ts` — team-conflict → 400 (register + reconfigure); team canonicalized to
  lowercase so deregister revoke targets the canonical token key (no silent skip).
- `fetch-http-post.test.ts` / `fetch-graph-http.test.ts` — request deadline wired (AbortSignal
  passed on every call; a hung endpoint rejects once `timeoutMs` elapses).

- **Typecheck:** ✅ `tsc --noEmit` clean.
- **Tests:** ✅ 1765 pass, 0 fail (was 1758; +7) across 100 files, plus signals 10 pass, 0 fail.
  (The `async ctx init failed` stderr lines are a passing test's deliberate rejected-promise
  fixture, not a failure.)
