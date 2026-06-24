# PR Remediation Plan — Pass 2

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host (PR #27, stacked on #25)
**Review scope:** NEW multi-tenant work vs `origin/feat/keycloak-entra-wiring` (50 source files, ~22.8k insertions)
**Findings:** 0 critical, 10 advisory (after dedup across the 6-agent cohort)

Second remediation pass. The prior pass (`2026-06-20-pr-remediation.md`) fixed the one critical
(re-adopted-worker crash detection) plus 13 advisories. code-reviewer and silent-failure-hunter
returned CLEAN this pass; the residue is genuine but small. The "critical" label from the
comment-analyzer is doc-accuracy, not a security gap — reclassified as advisory.

## Fixes (applied)

### Fix 1 (D): Non-string persisted fields coerced instead of skip-as-corrupt
- **Source:** type-design-analyzer (parse-don't-validate inconsistency)
- **File:** `supervisor/registry/redis-registry-adapter.ts:195` (+ realm/clientId/fsRoot)
- **Issue:** `team: markTeam(String(o.team ?? ""))` coerces a non-string persisted `team`
  (e.g. number `42` → `"42"`) into a valid-looking team, the lone deserialize field that
  coerces rather than skips. realm/clientId/fsRoot share the `String(… ?? "")` pattern.
- **Fix:** Guard each string-typed field: a non-string value → `return undefined` (corrupt skip),
  matching the `id`/`secretsRef`/agent-map branches. Parse-don't-validate parity at the boundary.

### Fix 2 (M): Dual-writer `degraded` flag can fail-open under race
- **Source:** architecture-tech-lead (~78%, FR-022)
- **File:** `supervisor/registry/redis-registry-adapter.ts:297-307,360-368`
- **Issue:** One `degraded` boolean is written by both the write path (`dead()`/`alive()`) and the
  probe edge (`markRedisDegraded`). A successful write's `alive()` can clear a probe-asserted
  degraded state (last-writer-wins, no precedence) → a narrow window where a NEW run is admitted
  on possibly-stale config while Redis is actually down.
- **Fix:** Split into `writeDegraded` and `probeDegraded`. Gate `resolveForNewRun` on
  `writeDegraded || probeDegraded`. `alive()` clears only `writeDegraded`; `markRedisDegraded`
  sets only `probeDegraded`. Fail-closed becomes monotonic until the responsible signal recovers.

### Fix 3 (N): Admin handler → supervisor back-edge
- **Source:** architecture-tech-lead (~76%, dependency-direction hygiene)
- **File:** `http/handlers/admin/tenants.ts:43-44` imports `authenticateIdentity`/`AuthDeps` from
  `supervisor/supervisor.ts`.
- **Issue:** A handler-layer module imports from the supervisor orchestration module (back-edge);
  importing the handler transitively pulls in the whole `Bun.serve` supervisor factory.
- **Fix:** Extract `authenticateIdentity` + `AuthDeps` to a leaf `http/authenticate-identity.ts`
  (depends only on domain/ + middleware/auth + ports — no supervisor deps). The handler imports the
  leaf; `supervisor.ts` imports the leaf AND re-exports both for the 9 existing test/consumer
  imports (no churn, no behavior change).

### Fix 4 (L): Per-request O(N-tenants) linear scans in registry views
- **Source:** architecture-tech-lead (~80%, hot-path perf)
- **File:** `main-supervisor.ts:227-233` (`tenantForTeam`), `:323-330` (`spawnConfigFor`)
- **Issue:** Both views rebuild `activeTenants(snapshot())` and `.find()` on every inbound request /
  spawn — O(N) per request where N = total registered tenants, plus a fresh array per call.
- **Fix:** `spawnConfigFor` → direct id-keyed `snapshot().entries.get(tenant)` + active check (O(1)).
  `tenantForTeam` → reference-memoized `Map<Team, TenantId>` index, rebuilt only when the snapshot
  reference changes (registry transitions are immutable: new ref on change, same ref on no-op), so
  amortized O(1). Behavior-preserving (first-write-wins to match `.find`).

### Fix 5 (E): `as unknown as` double-cast at the token mint seam
- **Source:** type-design-analyzer (idiom)
- **File:** `domain/concurrency.ts:184`
- **Issue:** `{ dagId, acquiredAt } as unknown as AcquireToken<K>` — the double-cast is needed (the
  object literal lacks the `[__acquireTokenBrand]` symbol property), but reads as a brand bypass.
- **Fix:** Add a one-line comment marking this as the sole production mint seam (parity with the
  `acquire`-only brand contract documented at :241). No cast change (single `as` would not compile
  against the symbol-branded interface).

### Fix 6 (G–K): ACL credential handoff mislabeled "the SecretsSource channel"
- **Source:** comment-analyzer (doc/comment drift; the prior pass corrected the canonical statements
  but missed five satellite occurrences).
- **Correct wording:** the per-tenant Redis ACL credential transits the worker **spawn-env channel**
  (`FUGUE_REDIS_ACL_USERNAME`/`PASSWORD`), which is SEPARATE from the `SecretsSource` env-file port
  (verified: `worker-lifecycle-manager.ts` injects into spawn env; `worker-main.ts` reads it from
  env; `SecretsSource` resolves only tenant env-file secrets).
- **Files:** `secrets/redis-acl-provisioner.ts:69,73,135`, `secrets/redis-acl.ts:31`,
  `docs/adr/0069-…:228`, `docs/adr/0067-…:146`.

### Fix 7 (A,B,C): Test coverage gaps
- **Source:** pr-test-analyzer
- **A** `worker-lifecycle-manager.ts:417-425` — cold-spawn single-flight coalescing: concurrent
  `ensureWorker` burst must produce exactly one spawn.
- **B** `worker-lifecycle-manager.ts:638-640` — `livenessSweep` re-entrancy guard: overlapping ticks
  must not double-fire `onCrash`.
- **C** `redis-registry-adapter.ts:170,176,187-188` — three corrupt-record deserialize branches
  (blank/non-string secretsRef, deregistered-missing-`deregisteredAt`, non-string agent-map value)
  + the new non-string `team`/realm/clientId/fsRoot guards from Fix 1.

## Deferred (documented, not fixed)

- **(F) `fsRoot` confinement not type-carried** (type-design advisory): `tenantConfig` validates
  absolute/no-`..`/no-NUL at construction but does not brand `fsRoot` as a `ConfinedAbsPath`. The
  analyzer rated this CONTAINED — only `tenantConfig` builds the configs that reach `register`, so
  no caller bypasses the check today. Introducing the brand touches `tenantConfig`, the register
  signature, and the grace-window purge across the package; it is a hardening refactor, not a
  defect, and out of this pass's risk budget on a green PR. Recommend a dedicated follow-up if the
  delete-safety guarantee is to become type-level.

## Validation Commands
```bash
cd packages/host
bunx tsc --noEmit
bun test 2>&1 | tail -30
```
