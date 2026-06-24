# PR Remediation Plan — Pass 7

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host
**Findings:** 4 critical, 2 advisory · 1 advisory declined (pre-existing / framework-mandated)

Review cohort: code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead (all 6, full diff
vs `main`: 170 files / 32,604 insertions). Six prior remediation passes; agents
briefed on the codebase's deliberate defensive patterns. **code-reviewer and
architecture-tech-lead returned 0 findings** (concur with pass 6).

## Critical Fixes

### Fix 1: ADR-0072 Options-Considered repeats the superseded live-worker-bound design
- **Source:** comment-analyzer
- **File:** `docs/adr/0072-resource-enforcement-single-pod-admission-heap-cap.md:47-49`
- **Issue:** Option 1 (chosen) describes admission as "a pure ADT extending the
  existing concurrency limiter with a per-tenant ceiling **and a global
  live-worker bound**." `admission.ts` has NO live-worker axis; the ADR's own
  Decision body (lines 102-103, 128-133) states FR-033 is enforced **solely** by
  the lifecycle manager's `liveWorkerCount()`, NOT by admission. Residual fragment
  of the superseded 3-step design that pass 6 corrected in the Decision body but
  missed here.
- **Fix:** Drop the live-worker-bound clause; admission extends the limiter with a
  per-tenant ceiling only. Attribute the live-worker bound to the lifecycle
  manager, matching lines 102-103.

### Fix 2: ADR-0072 Related file-pointer repeats the same false attribution
- **Source:** comment-analyzer
- **File:** `docs/adr/0072-...:233-235`
- **Issue:** The `admission.ts` pointer reads "(admission ADT: per-tenant ceiling
  **+ global live-worker bound**, this decision in code)." False — `admission.ts`
  models no live-worker bound (grep: zero `liveWorker` refs). Contradicts ADR line
  129 ("Admission deliberately does NOT model the live-worker bound").
- **Fix:** Replace "+ global live-worker bound" with "+ inner concurrency".

### Fix 3: adr/README.md numbering-integrity count is stale (omits ADR-0074)
- **Source:** comment-analyzer
- **File:** `docs/adr/README.md:106`
- **Issue:** States "Verified 2026-06-19: all **73** ADRs present (**0001–0073**)"
  and "ADRs **0064–0073** cover the multi-tenant single-host runtime." But this PR
  adds ADR-0074 (74 files exist, `0001–0074`), and the README's own index table
  lists 0074. The integrity line is contradicted by its own index.
- **Fix:** Update count to 74 / range `0001–0074`, bump verified date to
  2026-06-20, extend the multi-tenant narrative range to `0064–0074`, and append
  0074 (per-tenant HITL queue-depth enforcement) to that narrative.

### Fix 4: `buildWorkerSpawn` env-merge / ordering / UDS-dir / heap-cap untested
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/supervisor/lifecycle/bun-spawn-adapter.ts:63-117`
- **Issue:** This pure, exported function (its doc says it exists to be "exercised
  deterministically in tests") is the seam where the supervisor's `spec.extraEnv`
  becomes the worker's `process.env`. The manager test asserts `spec.extraEnv` is
  *set* on the spec, but nothing verifies `buildWorkerSpawn` *merges* it into the
  child env, nor the four invariants that regress silently here:
  1. **Cross-tenant isolation (security):** `extraEnv` is applied BEFORE the
     mandatory `TENANT_ID`/`FUGUE_SECRETS_REF`/`WORKER_UDS_DIR` bindings, so a
     stray/hostile `extraEnv.TENANT_ID` cannot override the tenant binding.
  2. **Socket-mismatch (C7):** `WORKER_UDS_DIR = dirname(spec.udsPath)`.
  3. **Heap cap (AD-9):** `NODE_OPTIONS` is APPENDED, not replaced.
  4. **The `extraEnv` merge itself** (`FUGUE_MAX_QUEUED_RUNS` + `FUGUE_REDIS_ACL_*`).
- **Fix:** Add `packages/host/src/__tests__/supervisor/lifecycle/bun-spawn-adapter.test.ts`
  — unit tests calling `buildWorkerSpawn(spec, inheritedEnv)` directly (no
  Bun.spawn) asserting all four invariants + inherited-env passthrough + unset
  heap cap.

## Advisory Fixes

### Fix 5: real `purgeKeyspace` scan+del best-effort loop untested
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/main-supervisor.ts:504-531`
- **Issue:** The grace-purge orchestrator test uses a *fake* `purgeKeyspace`; the
  real scan+del loop is inlined in the composition root and carries a non-trivial
  best-effort invariant (a single failing `del` must NOT abort enumeration — keep
  the first error, continue, return it only after attempting every key) with zero
  coverage. A regression here wedges reclamation of a deregistered tenant's
  footprint (FR-030).
- **Fix:** Extract the loop into a pure, exported `purgeTenantKeyspace(redis,
  tenant)` leaf (`supervisor/lifecycle/purge-keyspace.ts`), call it from
  main-supervisor, and unit-test it: full deletion across paginated cursors, scan
  failure aborts, del failure keeps going + returns first error.

### Fix 6: `tenantConfig` does not enforce non-empty `agentClientIdsByDag` values
- **Source:** type-design-analyzer
- **File:** `packages/host/src/supervisor/registry/tenant-registry.ts:212`
- **Issue:** `tenantConfig` (the smart constructor both the HTTP register path and
  Redis hydration path go through) validates `realm`/`clientId` non-empty but
  copies `agentClientIdsByDag` without validating its VALUES are non-empty —
  asymmetric with the env-side `AGENT_CLIENT_MAP` (`domain/config.ts:191`,
  `z.string().min(1)`, "dagId → non-empty Keycloak client id"). `{ "lead-desk":
  "" }` parses into a registered tenant. Inert today (no runtime consumer yet) but
  the parse boundary should carry the invariant before the consumer is wired.
- **Fix:** In `tenantConfig`, reject any `agentClientIdsByDag` value with
  `.length === 0` → `config-invalid` (the HTTP boundary already maps this to 400),
  mirroring the `realm`/`clientId` check.

## Declined (documented)

### Decline 1: `CheckpointWriter.write` swallows a Redis write failure
- **Source:** silent-failure-hunter (ADVISORY; the agent itself rated this "not a
  defect introduced by this PR and not a correctness regression")
- **File:** `packages/host/src/adapters/node-context-factory.ts:180-208`
- **Why declined:** (a) the `Promise<void>` signature is dictated by the
  framework's `CheckpointWriter` interface (`packages/framework/src/types/node.ts`),
  so the host adapter structurally cannot propagate the error; (b) the swallow is
  pre-existing (the `-` side of the diff already had it) — this PR only *added* a
  consecutive-failure warn→error escalation, an improvement; (c) the durable HITL
  source of truth is the `RunStore`, which IS fail-closed. Observability-only, not
  a regression introduced by this PR.

## Validation Commands
```bash
cd packages/host && bun run typecheck
cd packages/host && bun run test
```
