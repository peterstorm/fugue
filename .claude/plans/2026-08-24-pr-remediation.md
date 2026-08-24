# PR Remediation Plan — Adjudicated Standalone Review (round 41)

**Branch:** `feat/f6-file-durable-runtime`
**Review HEAD (frozen source):** `f9eaf9e0858a2ea214531622245f9a71f48e4710`
**Exact scope:** all 482 paths in the canonical `result.json.scope`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T081944Z-183545583`
**Canonical result:** `<review-run>/result.json` (digest `d98804efd5939779459fe9421a6c8e3cb042d99d65368e645bda5e4fb33ffc8f`)
**Adjudication:** 7 reviewers → 5 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **5 surviving / 0 refuted**; 8 advisories dispositioned independently below.

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — freshness diagnostics escape the Result boundary**
   `packages/framework/src/checkpoint/redis-freshness-index.ts:127`
   Add one framework logger helper that cannot throw, route freshness degradation diagnostics through it, and add a regression proving the fifth Redis failure still returns the original typed `cache-error` when the configured logger throws.

2. **`pr-test-analyzer-1` — supervisor Redis WATCH implementation lacks behavioral coverage**
   `packages/host/src/main-supervisor.ts:170`
   Eliminate the private supervisor copy by extracting the complete ioredis-backed `RedisPort` construction into the existing shared Redis adapter. Both worker/single-tenant connectivity and supervisor composition will use that implementation. Extend its fake-client contract suite to cover WATCH conflicts, queued command errors, guarded `UNWATCH` cleanup, and transaction serialization.

3. **`type-design-analyzer-1` — aborted RunLease authority can be laundered**
   `packages/host/src/hitl/ports.ts:61`
   Replace the globally exported issuer/token projection pair with a closure-backed `RunLeaseAuthority` factory that returns separately narrowed issuer and verifier capabilities. Composition creates one authority and passes only issuance to the queue and only verification to stores. A newly created authority cannot recognize a lease from another authority, so a lease holder cannot recover its token or reissue authority. Update production wiring, in-memory adapters, tests, `CONTEXT.md`, and ADR-0060.

4. **`comment-analyzer-1` — worker-registry fail-closed header contradicts best-effort prune**
   `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts:18`
   Correct the module contract to distinguish mandatory Redis operations from deliberately best-effort stale-entry pruning; keep runtime behavior unchanged.

5. **`architecture-tech-lead-1` — supervisor `RedisPort.del` drops additional keys**
   `packages/host/src/main-supervisor.ts:251`
   Resolve through the shared Redis adapter from finding 2. Its existing multi-key `DEL` implementation forwards every key in one command; retain and strengthen the adapter contract test so supervisor composition inherits the atomic behavior.

## Advisory dispositions

### Accepted

- **`code-reviewer-1` — purge warning logger can starve later tenants.** Sound availability defect with a small in-scope fix. Make warning emission best-effort and add a two-tenant sweep regression proving a throwing logger cannot stop later purges.
- **`silent-failure-hunter-2` — malformed OpenAI tool-call recovery can be replaced by a logger throw.** Sound Result/recovery-boundary defect. Reuse the non-throwing framework logger helper and add a malformed-arguments regression.
- **`silent-failure-hunter-3` — Zod introspection fallback can be replaced by a logger throw.** Sound totality defect. Reuse the non-throwing framework logger helper and add an introspection-failure regression.
- **`pr-test-analyzer-2` — purge lease release is not behaviorally pinned on failed exits.** Sound concurrency-safety coverage gap. Record `releasePurge` calls and assert release after partial footprint failure and hard-delete failure.
- **`type-design-analyzer-2` — `RunTimestampMs` admits negative and fractional values.** Sound value-object invariant gap. Parse only non-negative safe integers, use the smart constructor at persisted metadata ingress, and add constructor/persistence regressions.
- **`comment-analyzer-2` — `startedAt` comment misstates idle-eviction behavior.** Sound documentation defect. State that `startedAt` preserves uptime/diagnostic continuity; idle timing restarts from adopted activity.
- **`code-simplifier-1` — supervisor duplicates Redis optimistic-transaction machinery.** Sound and directly coupled to critical findings 2 and 5. Consolidate behind the existing adapter seam rather than patching the duplicate.

### Deferred

None.

### Dismissed

- **`code-simplifier-2` — consolidate worker/tenant registry Redis test fakes.** Dismissed: these fakes are local fixtures for different adapter contracts and expose subsystem-specific state/operations. Sharing a wide test fake would couple otherwise independent suites without reducing production state space or addressing a correctness finding.

## Refuted critical findings audit

None. All five critical findings survived unanimously across reproduction, intent, and security. Canonical panel evidence is retained in `result.json.panel.outcomes` and the three `refutation-slot:*` raw transcripts.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `packages/framework/src/logger.ts`
- `packages/framework/src/checkpoint/redis-freshness-index.ts`
- `packages/framework/src/llm/openai-types.ts`
- `packages/framework/src/llm/zod-schema.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/__tests__/llm-tool-call.test.ts`
- `packages/framework/src/__tests__/zod-schema.test.ts`
- `packages/host/src/adapters/redis-connectivity.ts`
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
- `packages/host/src/main-supervisor.ts`
- `packages/host/src/host.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/types.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- existing HITL tests that issue or verify leases
- `packages/host/src/supervisor/lifecycle/grace-window-purge.ts`
- `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/grace-window-purge.test.ts`

The engine reported `packages/framework/src/logger.ts` outside the frozen review scope; it is the support path required for the shared no-throw diagnostic helper. Every other planned path is inside the frozen scope.

## Validation

Focused regression gates:

```bash
bun test packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/llm-tool-call.test.ts \
  packages/framework/src/__tests__/zod-schema.test.ts
bun test packages/host/src/adapters/__tests__/redis-connectivity.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-queue.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/grace-window-purge.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
```

After the implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
