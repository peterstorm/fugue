# PR Remediation Plan — Pass 6

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host
**Findings:** 1 critical, 1 advisory applied · 2 advisories declined (intentional / zero-value)

Review cohort: code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead (all 6, full diff
vs `main`: 169 files / 32,474 insertions). Five prior remediation passes; agents
briefed on the codebase's deliberate defensive patterns. Code/error/architecture
agents returned 0 findings.

## Critical Fixes

### Fix 1: ADR-0072 Decision section describes a non-existent admission gate
- **Source:** comment-analyzer
- **File:** `docs/adr/0072-resource-enforcement-single-pod-admission-heap-cap.md:99-133`, `:150-152`
- **Issue:** The "Decision / Layer 1" describes `admitTenant` as a **three-step**
  gate whose **step 2** is a "Global live-worker bound (FR-033)" check returning
  `worker-unavailable`, and claims `releaseTenant` "reverses ... the live-worker
  count" and that the supervisor "configures the admission `liveWorkers` axis".
  None of this exists: `admission.ts` `admitTenant` is a **two-step** gate
  (per-tenant ceiling → inner concurrency); there is no live-worker axis in
  `AdmissionConfig`; the module doc says that counter "was removed for that
  reason"; FR-033 is enforced **solely** by the lifecycle manager's
  `liveWorkerCount()` (`main-supervisor.ts:258`: "Admission does NOT model a
  live-worker bound"). The ADR is even internally inconsistent — lines 180-182
  already (correctly) call the lifecycle manager the "single authoritative
  enforcement point". It documents a superseded design removed during the
  remediation passes.
- **Fix:** Rewrite the Decision section to the actual two-step gate; fix the
  headline (drop "+ global live-worker bound" from the admission layer); correct
  `releaseTenant` (reverses inner slot + per-tenant counter only); state FR-033 is
  enforced solely by the lifecycle manager. Fix the mis-attributed anti-starvation
  sentence (`admitTenant` property test proves the per-tenant axis, not the
  live-worker bound).

## Advisory Fixes

### Fix 2: `FUGUE_MAX_QUEUED_RUNS` spawn-env handoff is untested
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts:352-354`
- **Issue:** `lazySpawn` injects `FUGUE_MAX_QUEUED_RUNS` into the worker spawn env
  when the registry supplies `maxQueuedRuns`, but the `tenantsView` fake in
  `worker-lifecycle-manager.test.ts` never populates `maxQueuedRuns`, so that
  branch is never exercised at the spawn seam. The sibling ACL credential
  injection on the same path IS asserted. A regression dropping/mis-stringifying
  this env would silently make every worker fall back to "unlimited", defeating
  ADR-0074's durable-path queue-depth admission, with no failing test.
- **Fix:** Extend the `tenantsView` fake to carry an optional `maxQueuedRuns`, and
  add a dedicated describe block (mirroring the ADR-0067 ACL-injection block) with
  two cases: env set to the stringified ceiling when configured; env absent when
  unset.

## Declined (documented)

### Decline 1: thread the brand through `brandedId` zod helper
- **Source:** type-design-analyzer (ADVISORY; the agent itself rated this "purely
  cosmetic ... Not a genuine defect")
- **File:** `hitl/adapters/run-store.ts:50/211`, `hitl/adapters/decision-store.ts:43/150`
- **Why declined:** In `run-store.ts` the object is cast `as RunMeta`; that cast
  is forced by the **deliberately loose** `error: z.looseObject({ kind })` field
  (`RunStatus.failed.error` is `FrameworkError`), per the module's own comment
  ("kept loose so a `FrameworkError` shape change never trips the reader").
  Threading the brand through `brandedId` does **not** remove the cast — the loose
  `error` still forces it. And because the whole object is cast to
  `RunMeta`/`HumanAction`, every downstream consumer already sees branded field
  types regardless. The change is observably zero-value and touches a load-bearing
  Redis deserialization boundary validated across five passes. Runtime
  parse-don't-validate is already correct via `.refine`.

### Decline 2: brand `KeycloakClientMapping.agentClientIdsByDag` values
- **Source:** type-design-analyzer (explicitly "intentional ... noted for
  completeness, not a defect")
- **File:** `supervisor/registry/tenant-registry.ts:67`
- **Why declined:** `AgentClientId` is a deliberate host-broker-side brand
  restored at one re-entry seam (`agentClientIdFromFrameworkOrigin`); the registry
  is config data the worker later resolves. Branding here would over-constrain.

## Validation Commands
```bash
cd packages/host && bun run typecheck
cd packages/host && bun run test
```
