# PR Remediation Plan — Adjudicated Standalone Review (round 46)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `09fda55649c085cd1e50546f5b2e692100392aaa`

**Exact scope:** the complete canonical `result.json.scope` array (all 490 paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T124639Z-53ecda6a`

**Canonical result:** `<review-run>/result.json` (digest `19e604dcccbd5800d8d73fb865c0fdfc8b94caff377c34fbda2914f52cc1443c`, 40,775 bytes)

**Adjudication:** 7 reviewers → 2 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `blast-radius`) → **2 surviving / 0 refuted**; 13 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — same-valued reroute is mistaken for an acknowledgement retry**
   `packages/framework/src/dag-runtime/freshness-emission.ts:220`
   Introduce a durable non-negative freshness execution epoch on machine context. Initial execution uses epoch 0; a valid backward/current-wave reroute increments it in the pure transition before the replacement wave is checkpointed; ordinary node/freshness retries preserve it. Carry the epoch on `WriteAttemptedEvent`, `WriteEntry`, Redis members, and file singletons, and include it in own-write acknowledgement identity. This gives the index an explicit logical execution identity without timestamps or randomness: an ambiguously acknowledged bookkeeping retry deduplicates, while a same-valued reroute records and observes a distinct write. Update strict persistence/index codecs and ADRs. Add regressions for same-valued writer reroute, ambiguous acknowledgement, epoch persistence, and malformed durable epochs.

2. **`silent-failure-hunter-1` — termination swallows every supervisor signal failure**
   `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts:438`
   Inject the supervisor-signal seam into the private adapter config. Treat only an `ESRCH` code as the benign already-exited case; report every other failure with PID, signal, and a total error diagnostic while continuing the bounded shutdown path. Add focused tests proving `ESRCH` is silent and `EPERM`/hostile failures are observable without escaping `beginTermination`.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-2` — sweep failure logging can create an unhandled rejection.** Sound shell-boundary defect. Guard the catch-path logger so the original sweep failure remains contained even when diagnostics fail.
- **`silent-failure-hunter-3` — cache fallback diagnostics can replace graceful degradation.** Sound cache-contract defect. Reuse one local non-throwing reporter for escalated get/set failures, corrupt reads, and serialization failures; add throwing-logger regressions.
- **`comment-analyzer-1` — guardrail comment incorrectly promises value pass-through.** Correct the comment to state that the node always returns `Ok<GuardrailResult>`, while only validated results carry the original value.
- **`comment-analyzer-2` — Foundry summary comment contradicts cost behavior.** State that this channel carries node/retry/cache metrics and cost remains span-only.
- **`comment-analyzer-3` — MS Graph path-resolving header overstates non-throwing behavior.** Scope the guarantee to resolution/read methods and explicitly retain the stock adapter lifecycle contract.
- **`comment-analyzer-4` — run-node comment contains remediation archaeology.** Keep the one-emission/side-effect invariant and remove round/copy-count history.
- **`code-simplifier-1` — running/retrying transition branches duplicate wave handling.** Match the shared phase union once while preserving exact event behavior and exhaustive fallback.
- **`code-simplifier-2` — gate executor-error mapping is triplicated.** Extract one pure helper that maps executor errors through `handleHookCrash`; retain phase-local guards and behavior.
- **`code-simplifier-4` — parser JSDoc is attached to the wrong helper.** Remove/move the stale block so each helper has only its own contract.

### Deferred

- **`type-design-analyzer-1` — side-effect profiles omit explicit replay-safety acknowledgement.** Sound but requires a public authoring ADT and a runtime guarantee for each variant. The existing `idempotencyKey` is metadata, not enforced replay safety. Defer to a dedicated ADR/type-design cycle rather than encode a promise the executor cannot uphold.
- **`architecture-tech-lead-1` — broad vendor-shaped `RedisPort`.** Sound deepening opportunity but spans unrelated host bounded capabilities, adapters, wiring, and fakes. Defer to a dedicated interface-segregation migration; combining it with two mandatory correctness fixes would increase blast radius without helping either invariant.
- **`architecture-tech-lead-2` — HITL lifecycle policy remains interleaved with I/O.** Sound FC/IS opportunity but requires designing a command-plan ADT and migrating service tests. Defer to a dedicated HITL planner deepening round under ADR-0060 rather than redesign lifecycle orchestration inside this remediation.

### Dismissed

- **`code-simplifier-3` — tenant equality redundantly rechecks both discriminants.** The suggested removal was tested and rejected: TypeScript does not correlate `a.status === b.status` strongly enough to narrow `b`, so accessing `b.deregisteredAt` fails typecheck. Keeping the explicit second discriminant guard is clearer and assertion-free.

## Refuted critical findings audit

None. Both critical findings survived unanimously under reproduction, intent, and blast-radius. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0025-freshness-witness-contract.md`
- `docs/adr/0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md`
- `apps/customer-summary/src/observability-composition.ts`
- `packages/adapter-ms-graph/src/path-resolving.ts`
- `packages/framework/src/types/events.ts`
- `packages/framework/src/types/freshness.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/witness.ts`
- `packages/framework/src/dag-runtime/types.ts`
- `packages/framework/src/dag-runtime/machine.ts`
- `packages/framework/src/dag-runtime/persistence.ts`
- `packages/framework/src/dag-runtime/human-resolution.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/dag-runtime/transition.ts`
- `packages/framework/src/dag-runtime/run-node.ts`
- `packages/framework/src/nodes/guardrail.ts`
- `packages/framework/src/checkpoint/redis-freshness-index.ts`
- `packages/framework/src/file/freshness-codec.ts`
- `packages/framework/src/file/freshness-index.ts`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/_freshness-helpers.ts`
- `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts`
- `packages/framework/src/__tests__/dag-transition-property.test.ts`
- `packages/framework/src/__tests__/dag-transition.test.ts`
- `packages/framework/src/__tests__/file-boundary.test.ts`
- `packages/framework/src/__tests__/file-freshness-codec.test.ts`
- `packages/framework/src/__tests__/file-freshness-index.test.ts`
- `packages/framework/src/__tests__/freshness-check-property.test.ts`
- `packages/framework/src/__tests__/freshness-check.test.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/framework/src/__tests__/freshness-full-pipeline.test.ts`
- `packages/framework/src/__tests__/freshness-index-result.test.ts`
- `packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts`
- `packages/framework/src/__tests__/human-resolution.test.ts`
- `packages/framework/src/__tests__/non-retriable-fast-fail.test.ts`
- `packages/framework/src/__tests__/observer-property.test.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/__tests__/retry-policy.test.ts`
- `packages/framework/src/__tests__/wave-execution-errors.test.ts`
- `packages/framework/src/observer/foundry-event-mapping.test.ts`
- `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts`
- `packages/host/src/main-supervisor.ts`
- `packages/host/src/adapters/node-context-factory.ts`
- `packages/host/src/__tests__/node-context-factory.test.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/supervisor/registry/parse-tenant-config.ts`

One remediation-owned regression-support path is outside the frozen review scope and must be registered at remediation start:

- `packages/framework/src/__tests__/_freshness-helpers.ts` — adds the branded epoch fixture used by the mandatory freshness regressions.

Every other planned path, including the plan, is inside the frozen review scope.

## Baseline evidence

Before editing production code:

- Framework freshness/reroute/persistence baseline: **247 passed, 0 failed** across 10 files.
- Host lifecycle/cache/parser baseline: **170 passed, 0 failed** across 4 files.

## Validation

Focused regression gate:

```bash
bun test \
  packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts \
  packages/framework/src/__tests__/conditional-edges-reroute.test.ts \
  packages/framework/src/__tests__/freshness-emission.test.ts \
  packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/file-freshness-codec.test.ts \
  packages/framework/src/__tests__/file-freshness-index.test.ts \
  packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts \
  packages/framework/src/__tests__/human-resolution.test.ts \
  packages/framework/src/__tests__/dag-transition.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts \
  packages/host/src/__tests__/supervisor/registry/parse-tenant-config.test.ts
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
