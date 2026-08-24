# PR Remediation Plan — Adjudicated Standalone Review (round 48)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `566421738ea0ca4332e30f432b5ce6898f2b952a`

**Exact scope:** the complete canonical `result.json.scope` array (all 495 paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T153149Z-01a03465`

**Canonical result:** `<review-run>/result.json` (digest `fb8cd9f5ba475dfdffdae8d1e4b215820b04c8b9409a40ef37403d82a46e1926`, 40,636 bytes)

**Adjudication:** 7 reviewers → 4 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **4 surviving / 0 refuted**; 7 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — throwing application logger escapes `/summarize` outer catch**
   `apps/customer-summary/src/server.ts:282`
   Route the final unexpected-error diagnostic through `reportWithoutThrowing`, preserving the structured JSON 500 even when a custom logger transport throws. Add a regression whose checkpointer fails while the error logger throws.

2. **`silent-failure-hunter-1` — usage attribution logger replaces the modeled error**
   `packages/framework/src/llm/tool-use-loop.ts:116`
   Reuse `logFrameworkWithoutThrowing` for `llm.usage-unattributed`, so a diagnostic transport failure cannot replace the original `Result.err`. Add a prior-turn usage regression with a throwing framework logger.

3. **`silent-failure-hunter-2` — hostile thrown values escape tool-dispatch conversion**
   `packages/framework/src/llm/tool-use-loop.ts:248`
   Render caught tool-dispatch values with total `safeErrorMessage` rather than executable `String` coercion. Add a hostile `Symbol.toPrimitive` regression that remains a non-retriable typed node crash with accumulated usage.

4. **`silent-failure-hunter-3` — `appendToolResults` can throw after side effects**
   `packages/framework/src/llm/tool-use-loop.ts:256`
   Fence provider conversation mutation after dispatch and convert failures into a non-retriable `node-crash` carrying accumulated usage. Add a regression proving the loop returns an error instead of rejecting and does not continue to another provider turn.

## Advisory dispositions

### Accepted

- **`code-reviewer-2` — in-memory freshness acknowledgement identities are unbounded.** Sound resource-exhaustion issue that contradicts the adapter's documented per-resource cap. Prune acknowledgement keys in lockstep with the retained timestamp-newest write window, and add an overflow regression proving both entry and identity eviction semantics.
- **`pr-test-analyzer-1` — malformed persisted run/node IDs lack direct negative coverage.** Sound persistence-boundary gap. Add strict decoder cases for malformed and non-string `runId`/`nodeId` while keeping every other tuple field valid.
- **`pr-test-analyzer-2` — Redis value/kind rejection fixtures fail first on epoch shape.** Sound false-positive test issue. Rebuild those fixtures with valid fixed-width epochs so each test reaches the field it names; consolidate the strict field matrix to make this explicit.
- **`type-design-analyzer-1` — durable human-gate phases can represent blank prompts.** Sound illegal-state issue. Carry `NonEmptyString` from authored node config through compiled prompt maps, gate phases, callbacks, worker outcomes, and persisted parse seams. Reject blank durable prompt bytes and update affected tests/fixtures to construct valid branded prompts.
- **`code-simplifier-1` — `tenantConfig` repeats the config-invalid envelope.** Sound local simplification. Add a private tenant-bound invalid-result helper and leave each validation branch focused on its invariant.
- **`code-simplifier-2` — lifecycle equality is encoded as a compound negative boolean.** Sound ADT readability issue. Extract exhaustive discriminant-shaped lifecycle equality and keep `configEquals` at one structural-comparison altitude.

### Deferred

- **`architecture-tech-lead-1` — `/summarize` embeds checkpoint identity/resume policy.** The diagnosis is sound, but this is a behavior-preserving seam redesign spanning route orchestration, pure policy result types, and handler test ownership. It is not required for the four correctness fixes and should be performed as a dedicated deepen session rather than mixed into a security/error-boundary remediation, where the broad movement would increase review and regression risk without changing a current incorrect outcome.

### Dismissed

None.

## Refuted critical findings audit

None. All four critical findings survived unanimously under reproduction, intent, and security. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `packages/framework/src/llm/tool-use-loop.ts`
- `packages/framework/src/__tests__/tool-use-loop.test.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/__tests__/freshness-check.test.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/dag-runtime/types.ts`
- `packages/framework/src/dag-runtime/persistence.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/dag-runtime/executor.ts`
- `packages/framework/src/dag-runtime/retry-policy.ts`
- `packages/framework/src/executor/run-dag.ts`
- `packages/framework/src/dag-runtime/wave-resolution.ts`
- `packages/framework/src/dag-runtime/human-resolution.ts`
- `packages/framework/src/__tests__/dag-transition.test.ts`
- `packages/framework/src/__tests__/dag-transition-property.test.ts`
- `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts`
- `packages/framework/src/__tests__/wave-resolution.test.ts`
- `packages/framework/src/__tests__/human-resolution.test.ts`
- `packages/framework/src/__tests__/retry-policy.test.ts`
- `packages/framework/src/__tests__/hitl-suspend-resume.test.ts`
- `packages/framework/src/__tests__/pass-3-remediation.test.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/supervisor/registry/tenant-registry.ts`
- `packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts`

Four remediation-owned paths are outside the frozen review scope and must be registered as support paths at remediation start:

- `packages/framework/src/__tests__/hitl-suspend-resume.test.ts`
- `packages/framework/src/dag-runtime/retry-policy.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/executor/run-dag.ts`

Every other planned path, including the plan, is inside the frozen review scope.

## Baseline evidence

Before production edits, **149 tests passed / 0 failed** across the app server, framework tool-loop/freshness/Redis decoder, host tenant registry, and durable run-store checkpoint parser suites.

## Validation

Focused regression gate:

```bash
bun test \
  apps/customer-summary/src/__tests__/server.test.ts \
  packages/framework/src/__tests__/tool-use-loop.test.ts \
  packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/dag-transition.test.ts \
  packages/framework/src/__tests__/dag-transition-property.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts \
  packages/framework/src/__tests__/wave-resolution.test.ts \
  packages/framework/src/__tests__/human-resolution.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
