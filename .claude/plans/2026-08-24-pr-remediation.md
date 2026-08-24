# PR Remediation Plan — Adjudicated Standalone Review (round 45)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `7eed504a068e863c909fcedfd34ca2a744995e4e`

**Exact scope:** the complete canonical `result.json.scope` array (all paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T121057Z-5b73271a`

**Canonical result:** `<review-run>/result.json` (digest `26d1b61109b42214d2231830da640ca845fa210e66031f97c7be0aad7d36a973`, 40,266 bytes)

**Adjudication:** 7 reviewers → 2 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `blast-radius`) → **2 surviving / 0 refuted**; 11 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — reroutes preserve stale freshness-completion authority**
   `packages/framework/src/dag-runtime/wave-execution.ts:253`
   In the pure backward/current-wave reroute transition, filter `freshnessCompletedNodeIds` by the same pre-target-wave predicate used for outputs and retries. Preserve completion proof only for nodes whose work survives the reroute; target/later nodes must re-emit freshness bookkeeping when re-executed. Add pure transition coverage for both removal and preservation, plus an execution regression proving a rerouted freshness-tracked node emits its updated witness.

2. **`silent-failure-hunter-1` — default executor-error classification is not total**
   `packages/framework/src/state-machine/runner.ts:8`
   Route arbitrary executor-thrown values through the framework's existing total `safeErrorMessage` renderer. Add hostile-value regressions (throwing coercion/message access and revoked proxy) proving FR-006 still constructs and delivers the typed `ERROR` event rather than leaking a secondary diagnostic exception.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-2` — confidence extractor failures can be masked by coercion.** Sound boundary defect. Use `safeErrorMessage` in `route-emission.ts` and pin a hostile thrown value as a node-attributed `node-failed` result.
- **`silent-failure-hunter-3` — malformed-JSON logging can replace the intended 400.** Sound response-authority defect. Make diagnostics best-effort and total; add a throwing-logger request regression.
- **`silent-failure-hunter-4` — readiness logging can replace the not-ready fallback.** Sound health-boundary defect. Reuse one non-throwing application-log helper and prove a rejecting probe still yields the documented readiness response when logging throws.
- **`pr-test-analyzer-1` — retrying-state freshness-abort merge lacks a regression.** Add a focused `retrying + node-failed` transition test proving both witness projection and completion proof are immutably folded before retry policy runs.
- **`comment-analyzer-1` — `tenantConfig` invariant JSDoc is incomplete.** Update the smart-constructor contract to name tenant-owned `fsRoot`/`dagsRoot` and non-empty per-DAG client IDs.
- **`comment-analyzer-2` — SC-003 comment is remediation history, not current design.** Replace the deleted-test/pass-number narrative with a concise current coverage pointer and invariant statement.
- **`architecture-tech-lead-1` — ambiguous freshness-record acknowledgement duplicates `write-attempted`.** Preserve ADR-0079's singleton port contract, but order observer emission after the existing durable own-write acknowledgement check. Add an exact-count regression to the ambiguous-commit scenario. This fixes the evidenced duplicate without widening the port or contradicting the accepted file-singleton ADR.
- **`code-simplifier-1` — Foundry translation carries speculative dead machinery.** Collapse `translateSpanForFoundry` to an explicit identity function and remove the empty map/unreachable Proxy branch; retain the identity tests.
- **`code-simplifier-2` — `recordSuccess` duplicates the non-open reset.** Collapse closed/half-open with a single exhaustive union branch; existing unit/property tests pin behavior.
- **`code-simplifier-3` — `attemptReset` duplicates identical no-op branches.** Collapse closed/half-open with a single exhaustive union branch; existing reference-equality tests pin behavior.

### Deferred

- **`type-design-analyzer-1` — side-effect profiles omit explicit replay-safety acknowledgement.** The claim is sound, but `idempotencyKey` currently supplies tracing/dedup metadata rather than runtime idempotency enforcement, and the accepted authoring contract deliberately permits gradual adoption. Introducing an explicit `idempotent | unsafe` ADT would be a public authoring-surface redesign across built-in nodes and consumers and requires an ADR defining what runtime guarantee each variant actually provides. Defer to a dedicated pre-1.0 type-design cycle rather than imply safety through a type that the executor cannot yet enforce.

### Dismissed

None.

## Refuted critical findings audit

None. Both critical findings survived unanimously under reproduction, intent, and blast-radius. The authoritative panel outcomes and raw evidence remain in `result.json.panel.outcomes` and the three captured `refutation-slot:*` transcripts.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `docs/adr/0025-freshness-witness-contract.md`
- `packages/framework/src/dag-runtime/human-resolution.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/dag-runtime/route-emission.ts`
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/tracing/azure-monitor-exporter.ts`
- `packages/framework/src/tracing/azure-monitor-exporter.test.ts`
- `packages/framework/src/__tests__/human-resolution.test.ts`
- `packages/framework/src/__tests__/conditional-edges-reroute.test.ts`
- `packages/framework/src/__tests__/state-machine-runner.test.ts`
- `packages/framework/src/__tests__/route-emission.test.ts`
- `packages/framework/src/__tests__/dag-transition.test.ts`
- `packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts`
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts`
- `packages/host/src/supervisor/registry/tenant-registry.ts`
- `packages/host/src/domain/circuit-breaker.ts`

Two remediation-owned paths are outside the frozen review scope and must be registered as support paths at remediation start:

- `packages/framework/src/dag-runtime/human-resolution.ts` — the mandatory reroute fix lives at the pure transition that invalidates outputs/retries/completion proof.
- `packages/framework/src/tracing/azure-monitor-exporter.test.ts` — updates the accepted identity-test wording after removing the speculative `ATTR_MAP` machinery.

Every other planned path, including this plan, is inside the frozen review scope.

## Baseline evidence

Before editing production code, the 10 directly covering files passed: **262 tests, 0 failures**.

```bash
bun test \
  packages/framework/src/__tests__/human-resolution.test.ts \
  packages/framework/src/__tests__/state-machine-runner.test.ts \
  packages/framework/src/__tests__/route-emission.test.ts \
  packages/framework/src/__tests__/dag-transition.test.ts \
  packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts \
  packages/framework/src/__tests__/freshness-extraction-types.test.ts \
  packages/framework/src/__tests__/node-side-effects-propagation.test.ts \
  packages/framework/src/tracing/azure-monitor-exporter.test.ts \
  packages/host/src/__tests__/circuit-breaker.test.ts \
  apps/customer-summary/src/__tests__/server.test.ts
```

## Validation

Focused regression gate:

```bash
bun test \
  packages/framework/src/__tests__/human-resolution.test.ts \
  packages/framework/src/__tests__/conditional-edges-reroute.test.ts \
  packages/framework/src/__tests__/state-machine-runner.test.ts \
  packages/framework/src/__tests__/route-emission.test.ts \
  packages/framework/src/__tests__/dag-transition.test.ts \
  packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts \
  packages/framework/src/tracing/azure-monitor-exporter.test.ts \
  packages/host/src/__tests__/circuit-breaker.test.ts \
  apps/customer-summary/src/__tests__/server.test.ts
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
