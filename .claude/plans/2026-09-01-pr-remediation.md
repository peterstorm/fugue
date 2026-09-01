# PR Remediation Plan — 2026-09-01 (r7)

## Authority

- Branch: `feat/f3-budget-capability-surface`
- Reviewed HEAD: `595dc235e4330fae7620392a74578f7df9d6d8b5`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-01T12-39-05Z-standalone-review-01a05b28-r7`
- Canonical result: `.claude/reviews/review-and-fix-runs/2026-09-01T12-39-05Z-standalone-review-01a05b28-r7/result.json`
- Canonical result digest: `d4679b06ca17f903077c6c049d1de6953bc9563d34bdedb61356ef3a86e7685b`
- Policy: `all`; dry-run: no; push: yes.

## Frozen review scope

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

## Surviving critical findings — mandatory

### `type-design-analyzer-1` — createMeteredLlm retains the caller-owned LlmPricingModel object by reference, so a well-typed adapter can mutate a fixed model after composition and make a fixed deployment be priced as a different request model.

- Location: `packages/host/src/adapters/metered-llm.ts:135`
- Fix: Snapshot `LlmPricingModel` into a frozen composition-owned value before constructing the metered client. Add a regression that mutates the caller-owned fixed-model object and proves subsequent validation, pricing, and egress retain the original model.

### `type-design-analyzer-2` — snapshotOrigin treats every non-agent discriminant as user and never validates string fields, so malformed runtime authority input is returned as a typed InvocationOrigin instead of failing the run-start boundary.

- Location: `packages/framework/src/dag-runtime/run-dag-stateful.ts:157`
- Fix: Replace the permissive origin branch with an exhaustive own-data parser for `agent` and `user` variants. Return a typed validation failure from run-start authority snapshotting for unknown discriminants, missing/non-string fields, accessors, extras, and hostile reflection; add balanced-telemetry regressions.

### `comment-analyzer-1` — `ScopedCapabilityHandle` contains tagged `llm`/`non-llm` bindings rather than direct clients, so its documentation falsely says it mirrors `extractClients` and can replace a static client record.

- Location: `packages/framework/src/types/capability-broker.ts:42`
- Fix: Rewrite the `ScopedCapabilityHandle` contract documentation to describe tagged dispatch bindings that must be metered/unwrapped before context merge, not direct clients or an `extractClients` replacement.

## Advisory dispositions

- **ACCEPTED** `code-reviewer-3` — microUsd(Number.POSITIVE_INFINITY) returns zero despite the fail-closed saturation contract, allowing positive overflow supplied through the public constructor to be represented as no spend.
  - Reason/fix: Positive overflow representing zero spend violates fail-closed money semantics. Keep the implemented positive-infinity/unsafe-positive saturation and constructor/property regressions.
- **DISMISSED** `silent-failure-hunter-1` — State-machine telemetry failures can become completely silent because reportWithoutThrowing suppresses logger exceptions without a fallback and the default logger is a no-op.
  - Reason/fix: A library cannot guarantee a fallback after its embedder-owned logger fails. Implicit stderr writes add surprising global I/O, and an intentionally omitted logger is not a telemetry failure. Preserve transition authority and contain diagnostics rather than inventing a second sink.
- **DEFERRED** `pr-test-analyzer-1` — The shared SpendLedgerPort contract omits safe-integer saturation, so it does not detect that Redis accumulation can diverge from memory/file and become unreadable after resume.
  - Reason/fix: The divergence is real, but a complete fix changes the Redis atomic append protocol: HINCRBY cannot cap cumulative values atomically, while WATCH is connection-global and unsafe on the shared client and EVAL requires an ACL/deployment contract change. A test-only pin would knowingly leave an adapter red; redesign the atomic storage encoding with the Redis-port deepening.
- **ACCEPTED** `comment-analyzer-2` — The `judgeLlm` catalogue says judging never contends with generation, but both clients share the Run Spend Authority's reservation gate, budget, and ledger.
  - Reason/fix: Replace the false resource-isolation promise with the true distinction: a separate capability key/client binding that still shares run spend admission and accounting.
- **ACCEPTED** `comment-analyzer-3` — The ADR-0082 consequence still says every resumed slice starts from zero, although the implemented ledger hydration now carries spend between slices; the historical limitation needs an ADR-0083 follow-up note.
  - Reason/fix: Retain ADR-0082 as historical context but add an explicit ADR-0083 follow-up note explaining that current resumable slices hydrate cumulative spend.
- **DEFERRED** `architecture-tech-lead-1` — `createNodeContextForDag` exposes setup failure only by throwing, so HTTP and HITL callers assign different error taxonomies to the same context-construction fault.
  - Reason/fix: A typed context-setup Result changes the shared HTTP/HITL contract and error taxonomy; design it as one coordinated interface migration rather than an incidental patch.
- **DEFERRED** `architecture-tech-lead-2` — `createNodeContextForDag` concentrates tenant resolution, ledger selection and hydration, metering, identity binding, cache/checkpoint construction, and context assembly behind a ten-parameter orchestration seam.
  - Reason/fix: A pure setup plan and request value change the ten-parameter module interface and should land with the typed setup-result redesign.
- **DEFERRED** `architecture-tech-lead-3` — `RedisPort` is a vendor-shaped 16-operation superset whose optional protocol methods force consumers to re-parse capabilities and tests to bypass the type with assertions.
  - Reason/fix: Consumer-owned Redis ports require adapter, startup composition, ACL/protocol, and conformance-fixture migration and should include the saturation protocol decision above.
- **ACCEPTED** `code-simplifier-1` — spendOfHash redundantly sorts model names immediately before unpricedModels sorts and deduplicates them again.
  - Reason/fix: Remove the redundant local `sort`; `unpricedModels` remains the single canonical sort/dedup owner.
- **ACCEPTED** `code-simplifier-2` — The adjacent MintingAuthority/Invocation/invocationFor comments repeat the same authority-origin invariant and historical rationale across four blocks.
  - Reason/fix: Consolidate the repeated authority-origin history into concise constraint comments while preserving the dispatch invariant.

## Refuted critical audit

### `code-reviewer-1` — REFUTED; do not remediate

- Claim: Validated DAGs retain the caller-owned conditional predicate object, so post-validation mutation can change routing without invalidating the DAG fingerprint.
- Location: `packages/framework/src/shared/validate-dag.ts:41`
- reproduction: snapshotEdge copies the conditional predicate into a new frozen object, and the validated edge array uses those snapshots. Reassigning fields on the caller-owned predicate therefore cannot alter validated routing.
- intent: validateDagShape maps every conditional edge through snapshotEdge, which copies and freezes edge.when before storing the validated DAG; later mutation of the caller's predicate container cannot alter routing.
- security: validateDagShape maps every conditional edge through snapshotEdge, which creates and freezes a new predicate metadata object; mutating the caller's original when object therefore cannot alter validated routing.

### `code-reviewer-2` — REFUTED; do not remediate

- Claim: RunSpendAuthority re-applies the request Zod schema to provider output that LlmClient already parsed, so transforming schemas corrupt or reject successful responses.
- Location: `packages/host/src/adapters/run-spend-authority.ts:193`
- reproduction: settledLlmResult does not reapply request.schema; it copies the already-parsed output value directly into the normalized response. Transforming schemas therefore are neither rerun nor rejected here.
- intent: settledLlmResult explicitly preserves the LlmClient-owned parse by reading response.output and casting it to O; it never applies request.schema to provider output.
- security: settledLlmResult explicitly takes output.value as O without invoking request.schema; only the Result envelope, token usage, and error payload are parsed at this authority boundary.

## Authorized support paths outside frozen scope

- `packages/host/src/__tests__/integration/dag-isolation.test.ts` — supply the mandatory request-selected pricing policy in the existing `SharedInfra` fixture so the full host isolation suite exercises its intended cache/checkpoint behavior through the stricter composition parser.

## Implementation order

1. Parse and snapshot `InvocationOrigin` at run start with typed validation and balanced telemetry.
2. Snapshot the LLM pricing policy at composition and pin retained-model authority under caller mutation.
3. Correct the scoped-binding, judge capability, and ADR documentation.
4. Apply the two accepted distillation moves with focused tests green after each.
5. Revalidate all prior r5 remediation already present in the worktree; do not alter either refuted finding.
6. Run final `distill` apply mode, full validation, and registered remediation with the one isolation-fixture support path.

## Validation

- `bun run typecheck`
- Focused framework authority/executor tests and host metered-LLM tests after each move.
- Full framework suite with Redis available.
- Full host suite with Redis available, isolating the process-exit signal file if required.
- Real Redis spend transaction tests.
- Remaining workspace package tests.
- `bun scripts/check-doc-links.ts`
- `git diff --check`
- Final `distill` apply-mode pass after a green baseline.

### Completed evidence

- All 12 workspace package typechecks passed.
- Redis-backed framework suite: 3,421 passed, 0 failed across 189 files.
- Host suite excluding the process-exit signal file: 2,512 passed, 1 external live-Entra test skipped, 0 failed; isolated signal lifecycle: 10 passed, 0 failed.
- Redis spend-ledger/transaction suite: 85 passed, 0 failed.
- Remaining packages passed: http-auth 90, hitl-smoke 10, document-source 18, pg 73, oracle 79, fs 25, examples 23, ms-graph 142, xlsx 20, customer-summary 243.
- Documentation validation checked 19 shipped files; all relative links resolve and remain shipped.
- `git diff --check` passed.
- `distill` apply mode removed redundant spend-record sorting and compressed repeated authority comments; interface/protocol changes remained deferred as planned.

## Installation

- Start a fresh registered remediation run with `2026-09-01T12-39-05Z-standalone-review-01a05b28-r7` as immutable `sourceRun` and the authorized isolation-fixture support path above.
- Let the engine audit paths and atomically install the verified Git index.
- Commit the installed index and push without force.
