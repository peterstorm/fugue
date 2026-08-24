# PR Remediation Plan — Adjudicated Standalone Review (round 43)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `1ccaa3b6ec171e891847f8c24f0f33cda4e9402c`

**Exact scope:** all 483 paths in the canonical `result.json.scope` array

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T095816Z-afb1f78a7d1e`

**Canonical result:** `<review-run>/result.json` (digest `3dfdbb14bc352dd17c55ff6caf10b146ae605a215ab9397a90d8c49950930036`, 39,722 bytes)

**Adjudication:** 7 reviewers → 3 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `blast-radius`) → **3 surviving / 0 refuted**; 9 advisories dispositioned independently below.

The canonical `result.json.scope` array is the exact frozen scope and sole path authority. No reviewer transcript, finding, or panel verdict was reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — `fsRoot` accepts host paths outside the tenant mount**
   `packages/host/src/supervisor/registry/tenant-registry.ts:294`
   Replace syntax-only absolute-path validation with a tenant-owned-root invariant: `fsRoot` must be the canonical `/srv/<tenantId>` root or a canonical descendant. Reject `/`, host paths, sibling-tenant paths, traversal, aliases, and NUL bytes. Add example and fast-check properties proving cross-tenant paths are always rejected and canonical owned paths are accepted. Update the deployment contract and ubiquitous language.

2. **`code-reviewer-2` — `dagsRoot` accepts DAG code outside the tenant bundle**
   `packages/host/src/supervisor/registry/tenant-registry.ts:307`
   Apply the same tenant-owned-root parser to DAG bundles: `dagsRoot` must be `/dags/<tenantId>` or a canonical descendant. This makes arbitrary host code and another tenant's bundle unrepresentable in `ActiveTenantConfig`. Pin the worker-discovery isolation invariant in tests and deployment docs.

3. **`architecture-tech-lead-1` — durable HITL resume loses prior freshness witnesses**
   `packages/framework/src/dag-runtime/executor.ts:269`
   Move the resource→latest-witness projection into `DagMachineContextPersisted`. Each wave starts from the persisted projection; freshness emission returns the updated projection on `wave-done` and any post-wave `node-failed`; the pure transition folds it into context; persistence parses/serializes it; human intervention reads it from machine context. Add a suspend/new-executor/resume regression proving pre-suspension witnesses survive, plus parser/transition coverage for the new required persisted field.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-1` — timed-out git child exit rejection is coerced to exit code 0.** Sound cleanup defect. Treat an exit-wait rejection as forced-kill cleanup, emit a diagnostic, and test the hostile promise seam.
- **`silent-failure-hunter-2` — PID-1 worker signal failures lose pid/errno.** Sound operational observability gap. Collect failed pid/error pairs and emit one warning alongside the existing summary; add a focused regression.
- **`pr-test-analyzer-1` — Redis `recordWrite` success/TTL behavior is unpinned.** Sound adapter-contract gap. Assert SCRIPT LOAD and EVALSHA arguments, including key, score, member, and `FRESHNESS_TTL_SECONDS`.
- **`pr-test-analyzer-2` — corrupt worker reconciliation lacks a throwing-logger regression.** Sound best-effort boundary gap. Prove a throwing corruption logger cannot block pruning or replace the successful reconciliation result.
- **`comment-analyzer-1` — corrupt-checkpoint test cites stale line numbers.** Remove brittle line anchors and name the service branch/contract instead.
- **`comment-analyzer-2` — completed-status test cites stale line numbers.** Remove brittle line anchors and name the completed-outcome fold instead.
- **`code-simplifier-1` — SharePoint path segmentation is duplicated.** Extract one local `pathSegments` helper used by cache walking and invalidation.
- **`code-simplifier-2` — bootstrap rotation rewraps an unchanged `Result`.** Return the second `store.store` result directly.
- **`code-simplifier-3` — worker registry persistence rewraps an unchanged `Result`.** Return `registry.put(record)` directly after the no-record early success.

### Deferred

None.

### Dismissed

None.

## Refuted critical findings audit

None. All three critical findings survived unanimously under reproduction, intent, and blast-radius. The authoritative panel outcomes and raw evidence remain in `result.json.panel.outcomes` and the three captured `refutation-slot:*` transcripts.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0025-freshness-witness-contract.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `packages/host/docs/multi-tenant-deployment.md`
- `packages/host/src/supervisor/registry/tenant-registry.ts`
- `packages/host/src/supervisor/registry/parse-tenant-config.ts`
- `packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts`
- `packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`
- `packages/host/src/__tests__/supervisor/registry/parse-tenant-config.test.ts`
- `packages/framework/src/dag-runtime/types.ts`
- `packages/framework/src/dag-runtime/machine.ts`
- `packages/framework/src/dag-runtime/executor.ts`
- `packages/framework/src/dag-runtime/wave-execution.ts`
- `packages/framework/src/dag-runtime/transition.ts`
- `packages/framework/src/dag-runtime/persistence.ts`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts`
- `packages/framework/src/__tests__/dag-transition.test.ts`
- `packages/framework/src/__tests__/dag-transition-property.test.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/framework/src/__tests__/human-intervention-event.test.ts`
- `packages/framework/src/__tests__/non-retriable-fast-fail.test.ts`
- `packages/framework/src/__tests__/retry-policy.test.ts`
- `packages/framework/src/__tests__/wave-execution-errors.test.ts`
- `packages/host/src/adapters/git-sync.ts`
- `packages/host/src/__tests__/git-sync.test.ts`
- `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/adapter-ms-graph/src/path-resolving.ts`
- `packages/host/src/supervisor/bootstrap/run-bootstrap.ts`
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts`

Four remediation-owned paths are outside the frozen review scope and must be registered as support paths: `docs/adr/0025-freshness-witness-contract.md`, `packages/framework/src/dag-runtime/transition.ts`, `packages/host/docs/multi-tenant-deployment.md`, and `packages/host/src/__tests__/supervisor/registry/parse-tenant-config.test.ts`. Every other planned path is inside the frozen scope.

## Validation

Focused baseline and regression gates:

```bash
bun test packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts \
  packages/host/src/__tests__/git-sync.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
bun test packages/framework/src/__tests__/human-intervention-event.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts \
  packages/framework/src/__tests__/dag-transition.test.ts \
  packages/framework/src/__tests__/dag-transition-property.test.ts \
  packages/framework/src/__tests__/redis-freshness-index.test.ts
bun test packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
bun run --filter @fuguejs/ms-graph typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
