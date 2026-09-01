# PR Remediation Plan — r8 adjudicated review

## Authority

- Branch: `feat/f3-budget-capability-surface`
- Review HEAD: `297e28e8c2a935608a8b113c62dadc93d7985f01`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-01T13-39-55Z-standalone-review-01a05b28-r8`
- Canonical result: `.claude/reviews/review-and-fix-runs/2026-09-01T13-39-55Z-standalone-review-01a05b28-r8/result.json`
- Canonical result digest: `11559416026dba83ec79057953a7777d50056c7f50d5d8f095e668720cd5fc14`

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

## Surviving critical findings (5)

### `silent-failure-hunter-1` — silent-failure-hunter

- Location: `packages/host/src/adapters/metered-llm.ts:100`
- Canonical claim: The request snapshot casts required fields without parsing their runtime types, so malformed model values can let provider egress occur and then crash spend settlement before the attempt is persisted.
- Fix: replace presence-only request casting with a total parser for required strings, branded node IDs, schema-like values, optional numeric/discriminated fields, and safely snapshotted arrays before provider egress; add malformed/stateful model regressions for both LLM operations and prove no provider call or untyped rejection occurs.

### `type-design-analyzer-1` — type-design-analyzer

- Location: `packages/framework/src/types/capability-broker.ts:47`
- Canonical claim: `ScopedLlmCapability` does not reject symbol-keyed augmented LLM members, so a fully well-typed broker can return an empty alias map while dispatch installs a facade without the symbol method guaranteed by the node context type.
- Fix: make `ScopedLlmCapability<T>` uninhabitable when `T` adds symbol-keyed operations, matching `CapabilityHandle<T>` and the string-enumerated runtime facade; add a compile-time type pin.

### `comment-analyzer-1` — comment-analyzer

- Location: `packages/framework/src/tracing/semantic-conventions.ts:4`
- Canonical claim: The header says OTel GenAI names are not re-exported, but this module exports GEN_AI_* constants for those names.
- Fix: correct the semantic-conventions header to state that standardized GenAI names are centralized and exported here for call-site use.

### `comment-analyzer-2` — comment-analyzer

- Location: `packages/framework/src/index.ts:5`
- Canonical claim: The barrel header says JSON serialization is not re-exported, but the same barrel publicly exports toJson, fromJson, and tryFromJson.
- Fix: clarify that documented JSON wrappers are public while low-level serialization primitives remain internal.

### `comment-analyzer-3` — comment-analyzer

- Location: `packages/host/src/domain/llm-meter.ts:5`
- Canonical claim: The LLM meter header assigns live meter ownership to metered-llm.ts, but createRunSpendAuthority now owns and threads both meter and reservation state.
- Fix: name `RunSpendAuthority` as the live meter/reservation owner and `metered-llm.ts` as its request-snapshotting decorator.

## Advisory dispositions (11)

### Accepted

- `code-reviewer-1` — duplicate manifestation of `silent-failure-hunter-1`; the mandatory total request parser will reject non-string/stateful models before egress and return typed validation.
- `code-reviewer-2` — Redis cumulative overflow violates the ledger domain ceiling and can make durable state unreadable. Replace uncapped increments with optimistic atomic read/saturate/write transactions.
- `silent-failure-hunter-2` — hostile/revoked arrays can escape the `Result` boundary. Snapshot arrays from own data descriptors inside the inspection fence and reject sparse/accessor/extra-key shapes.
- `pr-test-analyzer-1` — add shared-ledger and real Redis regressions proving cumulative overflow saturates identically and remains hydratable.
- `type-design-analyzer-2` — introduce a branded non-empty `LlmModelId` with a smart constructor and require it in fixed pricing policies, then migrate all trusted construction sites through the parser.
- `code-simplifier-1` — extract one internal Redis transaction-result checker parameterized by operation and expected command count after the saturating transaction is implemented.
- `code-simplifier-2` — pass `NodeId` directly to `settledLlmResult`; normalization needs no authority over the full metered request.
- `code-simplifier-3` — define the close-failure structure once and reuse it for failed-connect cleanup and shutdown cleanup.

### Deferred

- `architecture-tech-lead-1` — a typed context-setup ADT requires coordinated HTTP, HITL, circuit-breaker, and composition contract migration; it is an interface redesign rather than a local remediation.
- `architecture-tech-lead-2` — extracting a pure setup planner changes the ten-parameter context-factory seam and must be designed together with the typed setup result.
- `architecture-tech-lead-3` — consumer-owned Redis ports require coordinated adapter, fake, HITL, cache, and spend protocol migration; the accepted atomic saturation repair is achievable without widening this redesign.

### Dismissed

- None.

## Refuted critical audit

- None. The registered panel published zero `refuted_critical_findings`; all five critical findings reached the canonical surviving set.

## Implementation order

1. Make fixed model identity a parsed branded value and close the scoped symbol-operation type hole.
2. Replace presence-only LLM request snapshots with total pre-egress parsing and hostile-array fencing; add both-operation regressions.
3. Make Redis spend accumulation atomically saturating, share transaction-result validation, and add shared/real-adapter overflow regressions.
4. Apply the remaining accepted dependency/representation distillations.
5. Correct all three mandatory documentation headers and update the public changelog/context where the new model-id invariant lives.
6. Run focused tests after each move, then final `distill` apply mode and full workspace validation.
7. Start registered remediation with every changed path outside the frozen scope listed as a support path; install only the verified index, commit, and push without force.

## Authorized support paths outside frozen scope

- None planned. The plan, implementation files, regressions, changelog, and context documentation are all in the frozen r8 scope. Recompute before remediation and register any genuinely necessary support path explicitly.

## Validation

- `bun run typecheck`
- Focused framework extensible-capability tests.
- Focused host metered-LLM, spend-ledger, Redis-connectivity, Run Spend Authority, and capability lifecycle tests.
- Full framework and host suites with real Redis coverage.
- Remaining workspace package tests.
- `bun scripts/check-doc-links.ts`
- `git diff --check`
- Final `distill` apply-mode pass from a green baseline.

### Completed evidence

- All 12 workspace package typechecks passed.
- Redis-backed framework suite: 3,422 passed, 0 failed across 189 files.
- Host suite: 2,520 passed, 1 external live-Entra test skipped, 0 failed; isolated signal lifecycle: 10 passed, 0 failed.
- Real ioredis transaction suite: 37 passed, 0 failed, including concurrent append and cumulative saturation at `Number.MAX_SAFE_INTEGER`.
- Shared memory/Redis/file Spend Ledger contract: 53 passed, 0 failed, including cross-adapter saturation parity.
- Remaining packages passed: http-auth 90, hitl-smoke 10, document-source 18, pg 73, oracle 79, fs 25, examples 23, ms-graph 142, xlsx 20, customer-summary 243.
- Documentation validation checked 19 shipped files; all relative links resolve and remain shipped.
- `git diff --check` passed.
- Final `distill` apply mode replaced Redis parallel-array/index coupling with field/delta/total tuples; real-Redis tests and host typecheck remained green. Interface-level context/Redis-port redesigns remained deferred as planned.

## Installation

- Start a fresh registered remediation run with `2026-09-01T13-39-55Z-standalone-review-01a05b28-r8` as immutable `sourceRun`.
- Let the engine audit paths and atomically install the verified Git index.
- Commit the installed index and push without force.
