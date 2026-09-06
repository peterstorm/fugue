# PR Remediation Plan — 2026-09-01 r9

## Authority

- Branch: `feat/f3-budget-capability-surface`
- Reviewed HEAD: `d3dd54978450c7d75097989aed9c505e9761970f`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-01T14-54-55Z-standalone-review-01a05b28-r9`
- Canonical result: `.claude/reviews/review-and-fix-runs/2026-09-01T14-54-55Z-standalone-review-01a05b28-r9/result.json`
- Result digest: `e139db63edca312e92408628141596ad23b5094c689b229097624efd956d8738`
- Policy: `all`, no file filter, not dry-run.

## Exact frozen scope (162 paths)

- `.claude/plans/2026-08-30-f3-budget-capability-remediation.md`
- `.claude/plans/2026-08-30-f3-budget-capability-surface.md`
- `.claude/plans/2026-08-30-pr41-remediation-round2.md`
- `.claude/plans/2026-08-30-pr41-remediation-round3.md`
- `.claude/plans/2026-08-30-pr41-remediation-round4.md`
- `.claude/plans/2026-08-30-pr41-remediation-round5.md`
- `.claude/plans/2026-08-30-pr41-remediation-round6.md`
- `.claude/plans/2026-08-30-pr41-remediation-round7.md`
- `.claude/plans/2026-08-30-pr41-remediation-round8.md`
- `.claude/plans/2026-08-30-pr41-remediation-round9.md`
- `.claude/plans/2026-08-31-pr-remediation.md`
- `.claude/plans/2026-09-01-pr-remediation.md`
- `CONTEXT.md`
- `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts`
- `docs/adr/0082-budgets-are-denominated-in-spend-not-tokens.md`
- `docs/adr/0083-spend-durability-lives-in-a-ledger-port.md`
- `docs/adr/README.md`
- `docs/features.md`
- `docs/plans/2026-08-27-f3-budget-capability.md`
- `docs/spikes/2026-08-02-graph-engineering-findings.md`
- `packages/framework/CHANGELOG.md`
- `packages/framework/README.md`
- `packages/framework/docs/adapter-authoring.md`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/budget-capability.test.ts`
- `packages/framework/src/__tests__/budget.test.ts`
- `packages/framework/src/__tests__/build-described-dag.test.ts`
- `packages/framework/src/__tests__/capability-validation.test.ts`
- `packages/framework/src/__tests__/cli/cli.test.ts`
- `packages/framework/src/__tests__/conditional-edges-routing.test.ts`
- `packages/framework/src/__tests__/cost.test.ts`
- `packages/framework/src/__tests__/dag-fingerprint-resume.test.ts`
- `packages/framework/src/__tests__/dag-retry-trace-outcome.test.ts`
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`
- `packages/framework/src/__tests__/define-router.test.ts`
- `packages/framework/src/__tests__/errors.test.ts`
- `packages/framework/src/__tests__/executor.test.ts`
- `packages/framework/src/__tests__/extensible-capabilities.test.ts`
- `packages/framework/src/__tests__/file-boundary-error.test.ts`
- `packages/framework/src/__tests__/file-journal.test.ts`
- `packages/framework/src/__tests__/file-spend-store.test.ts`
- `packages/framework/src/__tests__/freshness-witness-conflict-detected.test.ts`
- `packages/framework/src/__tests__/freshness-witness-no-conflict.test.ts`
- `packages/framework/src/__tests__/guardrail.test.ts`
- `packages/framework/src/__tests__/hitl-suspend-resume.test.ts`
- `packages/framework/src/__tests__/human-emission.test.ts`
- `packages/framework/src/__tests__/llm-fake-client.test.ts`
- `packages/framework/src/__tests__/llm-retry.test.ts`
- `packages/framework/src/__tests__/llm-with-tools-factory.test.ts`
- `packages/framework/src/__tests__/make-node-context-merge.test.ts`
- `packages/framework/src/__tests__/node-side-effects-propagation.test.ts`
- `packages/framework/src/__tests__/observer-crash-isolation.test.ts`
- `packages/framework/src/__tests__/ontrace-run-end-ordering.test.ts`
- `packages/framework/src/__tests__/pass-2-remediation.test.ts`
- `packages/framework/src/__tests__/pass-3-remediation.test.ts`
- `packages/framework/src/__tests__/per-node-minting.test.ts`
- `packages/framework/src/__tests__/predicate-malformed-event-sequence.test.ts`
- `packages/framework/src/__tests__/route-decided-evidence.test.ts`
- `packages/framework/src/__tests__/route-emission.test.ts`
- `packages/framework/src/__tests__/run-dag-as-worker-job.test.ts`
- `packages/framework/src/__tests__/run-telemetry-ordering.test.ts`
- `packages/framework/src/__tests__/second-dag.test.ts`
- `packages/framework/src/__tests__/span-enrich.test.ts`
- `packages/framework/src/__tests__/spend.test.ts`
- `packages/framework/src/__tests__/state-machine-runner.test.ts`
- `packages/framework/src/__tests__/tool-dispatch.test.ts`
- `packages/framework/src/__tests__/validate-dag.test.ts`
- `packages/framework/src/__tests__/wave-execution-errors.test.ts`
- `packages/framework/src/dag-runtime/executor.ts`
- `packages/framework/src/dag-runtime/human-emission.ts`
- `packages/framework/src/dag-runtime/post-wave-context.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/dag-runtime/run-node.ts`
- `packages/framework/src/dag-runtime/types.ts`
- `packages/framework/src/dag-runtime/wave-execution.ts`
- `packages/framework/src/describe/build-described-dag.ts`
- `packages/framework/src/executor/dag-input-edge.ts`
- `packages/framework/src/executor/define-dag.ts`
- `packages/framework/src/executor/define-diamond.ts`
- `packages/framework/src/executor/define-fan-out.ts`
- `packages/framework/src/executor/define-linear-dag.ts`
- `packages/framework/src/executor/define-router.ts`
- `packages/framework/src/executor/define-sources.ts`
- `packages/framework/src/executor/index.ts`
- `packages/framework/src/executor/validate-dag.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/boundary-error.ts`
- `packages/framework/src/file/spend-store-codec.ts`
- `packages/framework/src/file/spend-store.ts`
- `packages/framework/src/index.ts`
- `packages/framework/src/llm/cost.ts`
- `packages/framework/src/llm/index.ts`
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts`
- `packages/framework/src/shared/make-node-context.ts`
- `packages/framework/src/shared/validate-dag.ts`
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/testing.ts`
- `packages/framework/src/tracing/semantic-conventions.ts`
- `packages/framework/src/tracing/span-enrich.ts`
- `packages/framework/src/types/budget-capability.ts`
- `packages/framework/src/types/budget.ts`
- `packages/framework/src/types/capability-broker.ts`
- `packages/framework/src/types/capability-handle.ts`
- `packages/framework/src/types/dag-internals.ts`
- `packages/framework/src/types/dag.ts`
- `packages/framework/src/types/errors.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/llm.ts`
- `packages/framework/src/types/node.ts`
- `packages/framework/src/types/spend.ts`
- `packages/host/README.md`
- `packages/host/docs/deployment.md`
- `packages/host/docs/multi-tenant-deployment.md`
- `packages/host/src/__tests__/capability-manager.test.ts`
- `packages/host/src/__tests__/config.test.ts`
- `packages/host/src/__tests__/domain/cache-keys.test.ts`
- `packages/host/src/__tests__/entrypoint-wiring.test.ts`
- `packages/host/src/__tests__/fixtures/host-boot-fakes.ts`
- `packages/host/src/__tests__/fixtures/redis-spend-fake.ts`
- `packages/host/src/__tests__/handlers/run-dag.test.ts`
- `packages/host/src/__tests__/hitl-reconciliation-lifecycle.test.ts`
- `packages/host/src/__tests__/integration/dag-isolation.test.ts`
- `packages/host/src/__tests__/integration/full-lifecycle.test.ts`
- `packages/host/src/__tests__/llm-meter.test.ts`
- `packages/host/src/__tests__/metered-llm.test.ts`
- `packages/host/src/__tests__/middleware/error-handler.test.ts`
- `packages/host/src/__tests__/node-context-factory.test.ts`
- `packages/host/src/__tests__/run-spend-authority.test.ts`
- `packages/host/src/__tests__/runtime-capabilities.test.ts`
- `packages/host/src/__tests__/spend-ledger-file.test.ts`
- `packages/host/src/__tests__/spend-ledger.test.ts`
- `packages/host/src/__tests__/spend-record.test.ts`
- `packages/host/src/adapters/__tests__/fixtures/log-capture.ts`
- `packages/host/src/adapters/__tests__/keycloak-broker.test.ts`
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
- `packages/host/src/adapters/keycloak-broker.ts`
- `packages/host/src/adapters/metered-llm.ts`
- `packages/host/src/adapters/node-context-factory.ts`
- `packages/host/src/adapters/redis-connectivity.ts`
- `packages/host/src/adapters/run-spend-authority.ts`
- `packages/host/src/adapters/runtime-capabilities.ts`
- `packages/host/src/adapters/spend-ledger-file.ts`
- `packages/host/src/adapters/spend-ledger-memory.ts`
- `packages/host/src/adapters/spend-ledger-redis.ts`
- `packages/host/src/domain/cache-keys.ts`
- `packages/host/src/domain/capability-manager.ts`
- `packages/host/src/domain/config.ts`
- `packages/host/src/domain/host-error.ts`
- `packages/host/src/domain/llm-meter.ts`
- `packages/host/src/domain/run-context.ts`
- `packages/host/src/domain/spend-record.ts`
- `packages/host/src/domain/tenant-id.ts`
- `packages/host/src/domain/tenant.ts`
- `packages/host/src/entrypoint-wiring.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/host.ts`
- `packages/host/src/http/handlers/run-dag.ts`
- `packages/host/src/http/middleware/error-handler.ts`
- `packages/host/src/index.ts`
- `packages/host/src/ports.ts`

## Mandatory surviving critical findings (2)

- **code-reviewer-1** — `packages/host/src/adapters/redis-connectivity.ts:303` — commitCheckpointAndRetainSpend can clear an in-flight appendSpend WATCH on the shared Redis connection, allowing the append to overwrite a concurrent ledger update.
  - Fix: run checkpoint/retention MULTI/EXEC through the same per-connection transaction serializer as WATCH-based operations; add a deterministic real-Redis interleaving regression proving an external mutation forces retry and both deltas survive.
- **comment-analyzer-1** — `packages/host/src/adapters/spend-ledger-redis.ts:10` — The Redis spend-ledger header says concurrent appends are lock-free and require no WATCH or retry loop, but `appendSpend` is serialized through `watchTail` and uses a WATCH/MULTI retry loop.
  - Fix: replace the stale lock-free/no-WATCH description with the actual locally serialized WATCH/read/MULTI/EXEC retry protocol and its cross-process conflict semantics.

## Refuted critical audit

None. All two panel-routed criticals were upheld by reproduction, intent, and blast-radius lenses.

## Advisory dispositions (14)

### Accepted (8)
- **pr-test-analyzer-1** — `packages/host/src/__tests__/metered-llm.test.ts:116` — No metered-boundary test proves that a valid non-empty ToolDef array reaches the inner sendWithTools client.
  - Disposition: Add a valid non-empty ToolDef boundary test that proves the immutable snapshot reaches the provider and settles.
- **pr-test-analyzer-2** — `packages/framework/src/__tests__/spend.test.ts:127` — No regression test requires parseSpend to keep revoked unpriced-model arrays inside its Result boundary.
  - Disposition: Make parseSpend own-data-array inspection total and add revoked/accessor-array regressions inside its Result boundary.
- **comment-analyzer-2** — `packages/framework/src/llm/cost.ts:157` — The `spendOfCall` comment calls the crossing behavior an unqualified "overshoot-by-one guarantee," although the one-call bound applies only to sequential admission.
  - Disposition: Qualify spendOfCall crossing behavior as sequential.
- **comment-analyzer-3** — `packages/framework/src/types/spend.ts:337` — The `pricedCall` comment calls the crossing behavior an unqualified "overshoot-by-one guarantee," although the one-call bound applies only to sequential admission.
  - Disposition: Qualify pricedCall crossing behavior as sequential.
- **comment-analyzer-4** — `packages/host/src/__tests__/spend-ledger.test.ts:193` — The order-independence test comment incorrectly says commutativity makes the append lock-free; commutativity guarantees order-independent totals, not safe concurrent read-modify-write behavior.
  - Disposition: Replace the false lock-free rationale with order-independent-total wording.
- **code-simplifier-1** — `packages/host/src/adapters/metered-llm.ts:36` — The private `snapshotDataObject` helper discards the record type it establishes, forcing four downstream type assertions.
  - Disposition: Give snapshotDataObject the record Result type it already proves and remove compensating assertions.
- **code-simplifier-2** — `packages/framework/src/dag-runtime/run-node.ts:69` — The generic own-data snapshot in `snapshotScopedCapabilities` is prematurely typed as `ScopedCapabilityHandle`, forcing alias parsing to cast it back to a raw record.
  - Disposition: Keep the capability-bag snapshot raw until every binding is parsed; introduce ScopedCapabilityHandle only after proof.
- **code-simplifier-3** — `packages/host/src/adapters/node-context-factory.ts:95` — `failureEscalator` exposes an unused per-instance threshold even though every caller supplies the same module constant.
  - Disposition: Close failureEscalator over the sole module policy constant and remove unused configurability.

### Deferred (3)
- **architecture-tech-lead-1** — `packages/host/src/adapters/node-context-factory.ts:469` — Node-context construction exposes a throwing Promise seam, so setup failures lose their typed domain identity before HTTP and HITL policy can classify them.
  - Disposition: Requires coordinated HTTP, HITL, composition, and error-classification contract migration; design together with the context-setup planner rather than partially changing the seam.
- **architecture-tech-lead-2** — `packages/framework/src/dag-runtime/run-node.ts:294` — Per-node broker contract enforcement is embedded in the execution shell, making authority invariants testable only through full node/DAG execution.
  - Disposition: A worthwhile deepening, but extracting the broker authority module changes a security-sensitive seam and its broad test surface; it needs a dedicated property-tested refactor rather than mixing with the Redis correctness repair.
- **architecture-tech-lead-3** — `packages/host/src/ports.ts:150` — The shared RedisPort is a wide vendor-shaped seam whose optional protocol clusters force consumers to perform runtime capability narrowing.
  - Disposition: Requires coordinated adapter, cache, HITL, spend, checkpoint, fake, and wiring migration; partial port splitting would increase rather than reduce coupling.

### Dismissed (3)
- **silent-failure-hunter-1** — `packages/host/src/adapters/node-context-factory.ts:224` — createNamespacedCache.set reports serialization and Redis write failures as ok, so callers cannot observe a failed cache write through its declared Result channel.
  - Disposition: Cache writes are explicitly best-effort: failures are guarded and logged, while propagating err would abort a DAG for a non-critical cache miss. The Result shape is framework-owned and documented as never producing an error branch here.
- **silent-failure-hunter-2** — `packages/framework/src/describe/build-described-dag.ts:126` — buildDescribedDag converts schema-serialization exceptions into a successful null schema, so clients cannot distinguish a broken schema from an absent schema.
  - Disposition: Describe intentionally has a best-effort schema surface: null is authoritative and the optional warningSink is the explicit diagnostic channel. Making schema serialization fatal would violate that established contract.
- **silent-failure-hunter-3** — `packages/framework/src/state-machine/runner.ts:105` — runStateMachine's no-op default logger silently discards callback diagnostics when callers omit logger.
  - Disposition: Logging is embedder-owned and optional; an implicit console fallback would violate ownership, while propagating diagnostic callback failures would alter state-machine control flow. Omitted logger deliberately means no diagnostics.

## Implementation sequence

1. Serialize checkpoint/retention transactions with all connection-scoped WATCH protocols and pin the cross-process interleaving on real Redis.
2. Make `parseSpend` total for hostile unpriced-model arrays and add parser regressions.
3. Add the non-empty ToolDef metered-boundary regression.
4. Correct the Redis, sequential-overshoot, and commutativity comments.
5. Apply the three behavior-preserving type/configuration simplifications.
6. Update durable concurrency documentation/changelog if needed to keep the shipped contract synchronized.
7. Run focused gates, full relevant suites, workspace typecheck, documentation validation, `git diff --check`, and final `distill` apply mode from green.

## Validation commands

- `bun run typecheck`
- `bun test packages/framework/src/__tests__/spend.test.ts`
- `bun test packages/host/src/__tests__/metered-llm.test.ts`
- `REDIS_URL=redis://127.0.0.1:6380 bun test packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
- Full `@fuguejs/framework` and `@fuguejs/host` suites with Redis available.
- Remaining workspace package test suites.
- `bun scripts/check-doc-links.ts`
- `git diff --check`

## Completed validation evidence

- All 12 workspace package typechecks passed.
- Framework suite: 3,423 passed, 0 failed across 189 files.
- Host suite: 2,522 passed, 1 external live-Entra test skipped, 0 failed; isolated signal lifecycle: 10 passed, 0 failed.
- Real/fake Redis transaction suite: 38 passed, 0 failed, including the deterministic checkpoint/WATCH/second-client interleaving.
- Focused `Spend` parser: 28 passed; metered LLM boundary: 49 passed.
- Remaining packages passed: http-auth 90, hitl-smoke 10, document-source 18, pg 73, oracle 79, fs 25, examples 23, ms-graph 142, xlsx 20, customer-summary 243.
- Documentation validation checked 19 shipped files; all links resolve and remain shipped.
- `git diff --check` passed.
- Final `distill` apply mode completed from the green baseline. The final parse-object compression retained 28/28 focused tests and framework typecheck; interface-level deepenings remain deferred as dispositioned.

## Installation

The plan is already inside the frozen scope. Regressions are planned inside reviewed test paths, so no support paths are currently expected. The registered remediation run remains the sole authority for path audit, temporary-index staging, verification, and index installation.
