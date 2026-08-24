# PR Remediation Plan — Adjudicated Standalone Review (round 47)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `5b228720e68be741e39e5fe15af89d303bd8d42a`

**Exact scope:** the complete canonical `result.json.scope` array (all 491 paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260824T133648Z-01a033fc`

**Canonical result:** `<review-run>/result.json` (digest `513476fa054c5e543d1c21159425a8b69afb9e273b5e8a390224be4a73fa4206`, 39,667 bytes)

**Adjudication:** 7 reviewers → 3 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **3 surviving / 0 refuted**; 7 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — aborted summarize failures discard their real cause**
   `apps/customer-summary/src/server.ts:239`
   Classify a timeout only when the run failure is explicitly abort-shaped and the request-owned timeout signal fired. Always include the underlying thrown/typed failure in the server-side timeout diagnostic. A non-abort failure racing with the timeout remains an internal failure, is logged with its real detail, and returns the generic 500 response. Add short injected-timeout regressions for typed abort and non-abort failures.

2. **`silent-failure-hunter-2` — synchronous readiness diagnostics escape the structured response**
   `apps/customer-summary/src/server.ts:281`
   Make the readiness probe shell catch both synchronous throws and rejected promises through one `try/await/catch` helper. Guard the synchronous tracing-exporter counter getter too; a getter failure becomes an observable degraded tracing signal rather than an unstructured handler rejection. Preserve readiness policy: Redis/LLM failures gate with 503, MLflow/exporter failures only degrade at 200. Add synchronous-throw and throwing-logger regressions.

3. **`architecture-tech-lead-1` — freshness retry acknowledgement is inferred from conflict lookup**
   `packages/framework/src/dag-runtime/freshness-emission.ts:177`
   Deepen `FreshnessIndex` with an explicit logical-write acknowledgement query keyed by `(runId, nodeId, executionEpoch, newWitness)`. Query acknowledgement before conflict detection; an acknowledged write suppresses duplicate observer/index work, while a missing acknowledgement follows the normal conflict-and-record path. Implement the contract in all three adapters: an exact member lookup for Redis, an indexed identity ledger for memory, and an acknowledgement-key set committed atomically inside the file resource singleton. Keep conflict selection latest-write-only. Extend the strict file codec and ADR-0079/CONTEXT contracts. Add the decisive interleaving regression: write A commits, acknowledgement is lost, write B supersedes A, retry A must be recognized and must not re-stamp itself as latest.

## Advisory dispositions

### Accepted

- **`code-reviewer-1` — multi-digit execution epochs sort incorrectly at equal timestamps.** Sound cross-adapter correctness bug. Encode execution epochs in Redis member bytes as fixed-width safe-integer decimal strings, strictly decode that grammar, and add 9→10 plus property coverage for numeric/lexicographic agreement.
- **`pr-test-analyzer-1` — no direct `buildRuntimeCapabilities` behavior test.** Sound shared-wiring gap. Add a focused plain-fake test proving always-on `http` and `clock` handles are present when optional adapters are unconfigured.
- **`type-design-analyzer-1` — tenant ceilings can store invalid numbers.** Sound illegal-state issue. Parse raw ceilings through a non-negative-safe-integer smart constructor before constructing `TenantConcurrencyState`; brand the stored ceiling type and add rejection/property coverage while retaining zero and drain-down behavior.
- **`type-design-analyzer-2` — Retry-After can store invalid numbers.** Sound HTTP-domain issue. Parse and brand `retryAfterSeconds` as a non-negative safe integer in the `tenantOverQuota` smart constructor, so malformed values cannot inhabit `HostError`; add rejection/property coverage.
- **`comment-analyzer-1` — bootstrap prompt regression comment embeds transient review metadata.** Keep the behavioral invariant and remove reviewer/run archaeology.
- **`code-simplifier-1` — Graph token acquisition uses nullable error state plus an empty-token sentinel.** Extract a private Result-returning token helper that preserves thrown causes and treats an empty token as a typed transient failure; keep `graphJson` at one orchestration altitude and pin both failure forms.
- **`code-simplifier-2` — reroute modules duplicate wave-index construction/filtering.** Reuse one pure `waveIndexByNodeId` helper from the existing wave-resolution module while preserving the current unknown-node filtering semantics; cover both reroute paths with existing behavior tests.

### Deferred

None.

### Dismissed

None.

## Refuted critical findings audit

None. All three critical findings survived unanimously under reproduction, intent, and security. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0025-freshness-witness-contract.md`
- `docs/adr/0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md`
- `docs/adr/0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts`
- `packages/framework/src/types/freshness.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/dag-runtime/index.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/checkpoint/redis-freshness-index.ts`
- `packages/framework/src/file/boundary-error.ts`
- `packages/framework/src/file/freshness-codec.ts`
- `packages/framework/src/file/freshness-index.ts`
- `packages/framework/src/dag-runtime/wave-resolution.ts`
- `packages/framework/src/dag-runtime/reroute.ts`
- `packages/framework/src/dag-runtime/human-resolution.ts`
- `packages/framework/src/__tests__/freshness-check.test.ts`
- `packages/framework/src/__tests__/freshness-index-result.test.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/__tests__/file-freshness-codec.test.ts`
- `packages/framework/src/__tests__/file-freshness-index.test.ts`
- `packages/framework/src/__tests__/file-boundary.test.ts`
- `packages/framework/src/__tests__/freshness-check-property.test.ts`
- `packages/framework/src/__tests__/human-resolution.test.ts`
- `packages/framework/src/__tests__/conditional-edges-reroute.test.ts`
- `packages/host/src/adapters/runtime-capabilities.ts`
- `packages/host/src/supervisor/admission.ts`
- `packages/host/src/domain/host-error.ts`
- `packages/host/src/__tests__/supervisor/admission.test.ts`
- `packages/host/src/__tests__/domain/tenant-error-taxonomy.test.ts`
- `packages/adapter-ms-graph/src/path-resolving.ts`
- `packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts`

Four remediation-owned support paths are outside the frozen review scope and must be registered at remediation start:

- `packages/framework/src/dag-runtime/wave-resolution.ts`
- `packages/host/src/__tests__/adapters/runtime-capabilities.test.ts`
- `packages/host/src/__tests__/domain/tenant-error-taxonomy.test.ts`
- `packages/host/src/__tests__/supervisor/admission.test.ts`

Every other planned path, including the plan, is inside the frozen review scope.

## Baseline evidence

Before production edits, **237 tests passed / 0 failed** across the focused app, framework freshness/reroute, host admission/error/wiring, and MS Graph suites:

- app server + prompt bootstrap: 43 passed
- framework freshness adapters/emission/retry: 116 passed
- framework human reroute: 14 passed
- host admission/error/entrypoint wiring: 42 passed
- MS Graph path resolution: 22 passed

## Validation

Focused regression gate:

```bash
bun test \
  apps/customer-summary/src/__tests__/server.test.ts \
  apps/customer-summary/src/__tests__/bootstrap-prompts.test.ts \
  packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts \
  packages/framework/src/__tests__/freshness-emission.test.ts \
  packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/freshness-check-property.test.ts \
  packages/framework/src/__tests__/freshness-index-result.test.ts \
  packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/file-freshness-codec.test.ts \
  packages/framework/src/__tests__/file-freshness-index.test.ts \
  packages/framework/src/__tests__/file-boundary.test.ts \
  packages/framework/src/__tests__/human-resolution.test.ts \
  packages/framework/src/__tests__/conditional-edges-reroute.test.ts \
  packages/host/src/__tests__/supervisor/admission.test.ts \
  packages/host/src/__tests__/domain/tenant-error-taxonomy.test.ts \
  packages/host/src/__tests__/adapters/runtime-capabilities.test.ts \
  packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
