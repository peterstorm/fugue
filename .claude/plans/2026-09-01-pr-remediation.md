# PR Remediation Plan — 2026-09-01

## Authority

- Branch: `feat/f3-budget-capability-surface`
- Reviewed HEAD: `8ab1870870beaf0539d60d7ecaf8406bc3cd9e32`
- Standalone review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-01T09-16-20Z-standalone-review-01a05b28-r4`
- Canonical result digest: `960af11fdf5ac0d068cc94ec0290ea086a531b6651506d9f366f21e5f98f6a22`
- Arguments: default `all`; not dry-run; push enabled.

## Exact frozen review scope

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
- `docs/adr/0082-budgets-are-denominated-in-spend-not-tokens.md`
- `docs/adr/0083-spend-durability-lives-in-a-ledger-port.md`
- `docs/adr/README.md`
- `docs/features.md`
- `docs/plans/2026-08-27-f3-budget-capability.md`
- `docs/spikes/2026-08-02-graph-engineering-findings.md`
- `packages/framework/CHANGELOG.md`
- `packages/framework/docs/adapter-authoring.md`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/budget-capability.test.ts`
- `packages/framework/src/__tests__/budget.test.ts`
- `packages/framework/src/__tests__/capability-validation.test.ts`
- `packages/framework/src/__tests__/cli/cli.test.ts`
- `packages/framework/src/__tests__/conditional-edges-routing.test.ts`
- `packages/framework/src/__tests__/cost.test.ts`
- `packages/framework/src/__tests__/dag-fingerprint-resume.test.ts`
- `packages/framework/src/__tests__/dag-retry-trace-outcome.test.ts`
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`
- `packages/framework/src/__tests__/errors.test.ts`
- `packages/framework/src/__tests__/executor.test.ts`
- `packages/framework/src/__tests__/extensible-capabilities.test.ts`
- `packages/framework/src/__tests__/file-boundary-error.test.ts`
- `packages/framework/src/__tests__/file-spend-store.test.ts`
- `packages/framework/src/__tests__/freshness-witness-conflict-detected.test.ts`
- `packages/framework/src/__tests__/freshness-witness-no-conflict.test.ts`
- `packages/framework/src/__tests__/guardrail.test.ts`
- `packages/framework/src/__tests__/hitl-suspend-resume.test.ts`
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
- `packages/framework/src/__tests__/tool-dispatch.test.ts`
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

### `code-reviewer-1` — `packages/framework/src/types/spend.ts:102`

**Finding:** Per-call rounding can record a positive-cost LLM call as zero USD, allowing repeated sub-micro-dollar calls to bypass USD ceilings.

**Fix:** Round every positive priced call upward at the USD→micro-USD settlement boundary, saturate positive overflow, and add a repeated sub-micro-call budget regression.

### `code-reviewer-2` — `packages/host/src/adapters/metered-llm.ts:39`

**Finding:** The spend authority prices request fields separately from the original request sent to the provider, so stateful accessors can make the provider use a different model or cache policy than the one metered.

**Fix:** Parse and snapshot every LLM request field once into an immutable own-data request before admission and provider dispatch; add hostile accessor regressions for both operations.

### `code-reviewer-3` — `packages/framework/src/dag-runtime/run-node.ts:406`

**Finding:** The broker receives the live mutable node.requires array and the over-delivery check reuses it afterward, allowing the broker to add a capability declared by another node and inject it into this node.

**Fix:** Snapshot/freeze node requirements and broker provides claims before the awaited broker call, then validate returned authority only against those snapshots.

### `silent-failure-hunter-1` — `packages/host/src/host.ts:1258`

**Finding:** shutdown() performs unguarded logger and supervisor-stop calls before listener/resource teardown, so one throw aborts the remaining cleanup.

**Fix:** Fence logging, sync-loop stop, probe stop, state transitions, draining diagnostics, and listener stop independently so teardown always reaches every acquired resource.

### `silent-failure-hunter-2` — `packages/host/src/host.ts:1090`

**Finding:** shutdown() catches listener, HITL worker, capability, and infrastructure cleanup failures but still resolves successfully, falsely reporting a clean shutdown.

**Fix:** Collect every shutdown failure while attempting all cleanup, transition to stopped only after teardown attempts, and reject with AggregateError when shutdown was not clean.

### `silent-failure-hunter-3` — `packages/host/src/hitl/adapters/run-executor.ts:268`

**Finding:** The HITL run error handler calls checkpointFailure() without a fence, so a port throw masks the original slice failure and escapes the promised Result boundary.

**Fix:** Fence checkpointFailure inspection in the HITL catch path and preserve both the original slice failure and inspection failure in the returned terminal FrameworkError.

### `type-design-analyzer-1` — `packages/framework/src/types/dag.ts:223`

**Finding:** The DagDef brand does not prove validation because exported brandAsDagDef is a zero-check cast and barrel-exported withRetryLimits uses it to brand arbitrary retry keys and values.

**Fix:** Remove the exported unchecked DagDef branding seam and make retry-limit changes flow through full DAG validation with typed failure.

### `type-design-analyzer-2` — `packages/framework/src/executor/validate-dag.ts:492`

**Finding:** validateDagShape retains caller-owned NodeDef objects by reference, so a type-correct mutation through the original mutable object can invalidate a DagDef after it is branded.

**Fix:** Snapshot validated node definitions and their mutable arrays before branding so caller-owned post-validation mutation cannot change the DagDef.

### `comment-analyzer-1` — `packages/framework/src/dag-runtime/executor.ts:207`

**Finding:** buildDagExecutor's JSDoc falsely says it emits run-start and run-end observer events; those events are emitted by run-dag-stateful.ts, not executor.ts.

**Fix:** Move/correct buildDagExecutor JSDoc so it describes only executor-owned events.

### `comment-analyzer-2` — `packages/framework/src/llm/cost.ts:46`

**Finding:** JSDoc describing rate lookup is attached to isPricedModel, so API documentation describes a boolean predicate as returning rates or zeroes.

**Fix:** Attach rate-lookup JSDoc to costRatesFor and give isPricedModel predicate-specific documentation.

### `comment-analyzer-3` — `packages/host/src/ports.ts:114`

**Finding:** The RedisPort overview JSDoc is attached to RedisExpiry, so RedisExpiry is documented as a Result-returning cache/checkpoint interface.

**Fix:** Attach Redis port overview JSDoc to RedisPort, not RedisExpiry.

### `comment-analyzer-4` — `packages/host/src/ports.ts:354`

**Finding:** The SpendLedgerPort overview JSDoc is attached to SpendLedgerMetadata, so metadata is documented as the two-operation durability port.

**Fix:** Attach spend-ledger overview JSDoc to SpendLedgerPort, not SpendLedgerMetadata.

### `comment-analyzer-5` — `packages/host/src/domain/capability-manager.ts:355`

**Finding:** The extractClients trust-boundary JSDoc is attached to CapabilityClientDecorators, so the decorator type is documented as an extraction function.

**Fix:** Attach trust-boundary documentation to extractClients, not CapabilityClientDecorators.

### `comment-analyzer-6` — `packages/host/src/http/middleware/error-handler.ts:232`

**Finding:** The createErrorHandler JSDoc is attached to asError, so asError is documented as a Hono error-handler factory.

**Fix:** Attach Hono factory documentation to createErrorHandler, not asError.

### `code-simplifier-1` — `packages/host/src/http/handlers/run-dag.ts:155`

**Finding:** The body-parse catch bypasses the imported safeErrorMessage helper, so a thrown value with hostile string coercion escapes instead of producing the intended 400 HostError.

**Fix:** Use total safeErrorMessage normalization in the body-parse catch and add a hostile-coercion regression.

### `code-simplifier-2` — `packages/framework/src/dag-runtime/human-emission.ts:79`

**Finding:** The confidence-extractor catch interpolates the thrown value directly, so hostile coercion can make error handling throw instead of returning the typed node-crash Result.

**Fix:** Use total error normalization and guarded diagnostics in confidence extraction so the typed node-crash Result cannot be replaced.

## Advisory dispositions

- **DEFERRED — `silent-failure-hunter-4`** (`packages/framework/src/describe/build-described-dag.ts:255`): An omitted describe warning sink silently converts schema-serialization failures into null schemas. **Reason:** The claim is sound, but making an omitted sink observable requires a public describe-result/warning-channel redesign; null remains the conservative schema value and explicit sinks already receive the warning.
- **ACCEPTED — `silent-failure-hunter-5`** (`packages/host/src/http/middleware/error-handler.ts:301`): The HTTP error handler omits wrapped non-Error causes from operator diagnostics. **Reason:** Total cause rendering is local, preserves diagnostics for primitive/cross-realm failures, and is covered by the existing error boundary suite.
- **DISMISSED — `silent-failure-hunter-6`** (`packages/framework/src/state-machine/runner.ts:88`): The state-machine runner installs a no-op logger that silently discards caught telemetry failures. **Reason:** The logger is intentionally optional for library embedders; implicit console/stderr output would violate host ownership, while requiring a logger is a breaking API change without a correctness failure in transitions.
- **ACCEPTED — `silent-failure-hunter-7`** (`packages/framework/src/dag-runtime/human-emission.ts:79`): The human-intervention confidence catch can throw during error formatting or diagnostics before returning its typed failure. **Reason:** This overlaps mandatory code-simplifier-2 and will be fixed with total formatting plus best-effort diagnostics.
- **ACCEPTED — `silent-failure-hunter-8`** (`packages/host/src/http/handlers/run-dag.ts:155`): The request-body parse catch can throw while formatting a hostile non-Error value. **Reason:** This overlaps mandatory code-simplifier-1 and will be fixed at the same boundary.
- **ACCEPTED — `silent-failure-hunter-9`** (`packages/framework/src/dag-runtime/wave-execution.ts:114`): Wave invariant logging can throw before the intended non-retriable failure is returned. **Reason:** Guarding secondary invariant logging is local and preserves the authoritative non-retriable failure.
- **ACCEPTED — `type-design-analyzer-3`** (`packages/framework/src/types/spend.ts:99`): usdToMicros maps positive infinity to zero spend, so the money boundary conflates an overflowing positive cost with no cost instead of saturating or returning a typed parse failure. **Reason:** Positive infinity is positive overflow, not zero cost; saturating is the fail-closed money invariant and is a local fix.
- **ACCEPTED — `comment-analyzer-7`** (`packages/framework/src/types/node.ts:61`): The prompt comment's claim that withHumanReview is the only gateway is false because types/index.ts publicly exports nonEmptyString and asNonEmptyString. **Reason:** Correct the gateway claim to name the smart constructors actually exported.
- **ACCEPTED — `comment-analyzer-8`** (`packages/framework/src/types/errors.ts:632`): Function-specific retriabilityOf behavior is documented on the Retriability type alias rather than on the function. **Reason:** Move function behavior documentation onto retriabilityOf and leave the alias with type-level semantics.
- **ACCEPTED — `comment-analyzer-9`** (`packages/framework/src/dag-runtime/post-wave-context.ts:4`): The PostWaveContext rationale depends on temporary deepening-plan.md Step 3 provenance instead of remaining self-contained. **Reason:** Replace temporary-plan provenance with a self-contained locality rationale.
- **ACCEPTED — `comment-analyzer-10`** (`packages/framework/src/dag-runtime/executor.ts:79`): The OnHumanReviewHook comment retains the opaque round-38 cs-3 review identifier, which adds no durable rationale. **Reason:** Remove remediation archaeology while retaining the durable shared-hook rationale.
- **ACCEPTED — `comment-analyzer-11`** (`packages/host/src/adapters/redis-connectivity.ts:407`): The disconnectRedisQuietly comment retains the opaque round-38 cs-19 review identifier, which adds no durable rationale. **Reason:** Remove the opaque review identifier while retaining the cleanup rationale.
- **DEFERRED — `architecture-tech-lead-1`** (`packages/host/src/adapters/node-context-factory.ts:349`): Node-context setup failures cross a throwing seam and are classified differently by synchronous and HITL callers. **Reason:** A ContextSetupError Result requires coordinated HTTP, HITL, composition-root, and public contract migration; it is a dedicated architecture change, not a safe local remediation.
- **DEFERRED — `architecture-tech-lead-2`** (`packages/host/src/ports.ts:149`): RedisPort is a vendor-shaped 16-operation superset that couples unrelated consumers and forces optional-method capability probing. **Reason:** Splitting the 16-operation Redis seam requires coordinated adapter, consumer, fake, and conformance-suite migration across subsystems.
- **DEFERRED — `architecture-tech-lead-3`** (`packages/host/src/adapters/node-context-factory.ts:625`): createNodeContextForDag combines storage, durability policy, metering, identity, and context assembly behind a ten-parameter interface. **Reason:** Decomposing the context factory and replacing its positional contract should be done together with typed setup results and focused consumer-owned ports.
- **ACCEPTED — `code-simplifier-3`** (`packages/framework/src/dag-runtime/executor.ts:129`): The human-review hook failure and edit-validation failure duplicate the same node-error event assembly inside callHumanReviewHook. **Reason:** A local node-error event helper removes duplicated policy without widening interfaces.
- **ACCEPTED — `code-simplifier-4`** (`packages/framework/src/dag-runtime/executor.ts:79`): The OnHumanReviewHook documentation contains a review-round identifier that carries no durable constraint. **Reason:** Duplicate of comment-analyzer-10; one comment edit resolves both advisories.

## Refuted critical audit

- None. The registered panel published zero refuted critical findings.

## Planned support paths outside frozen scope

- `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts` — updates the worked LLM-tools example to the explicit `LlmWithToolsNodeDef` capability-bearing return type required by the safer `NodeDef` default.
- `packages/framework/README.md` — updates the shipped public-surface reference for the typed `withRetryLimits` Result contract and executor export.
- `packages/framework/src/__tests__/file-journal.test.ts` — removes a pre-lock readiness race exposed by full-suite validation so the crashed-writer stale-lock regression kills only after lock acquisition.
- `packages/framework/src/__tests__/human-emission.test.ts` — pins hostile confidence errors, logger failures, and clock failures without losing the typed result.
- `packages/framework/src/__tests__/validate-dag.test.ts` — pins immutable post-validation node/retry snapshots.
- `packages/framework/src/__tests__/wave-execution-errors.test.ts` — pins invariant failure authority under a throwing logger.
- `packages/framework/src/executor/index.ts` — publishes the validated `withRetryLimits` Result from the executor surface.
- `packages/framework/src/shared/validate-dag.ts` — moves the pure DagDef parser behind the shared inward-facing layer so `dag-runtime` can revalidate retry derivations without reversing the enforced dependency direction; `executor/validate-dag.ts` remains the public façade.
- `packages/host/src/__tests__/integration/full-lifecycle.test.ts` — updates the established capability-close lifecycle regression to require the new aggregated shutdown rejection while still proving all closes run.

## Validation

- All workspace package typechecks.
- Full Redis-backed workspace test suite.
- Framework standalone test suite for Redis-gated coverage accounting.
- Real Redis spend adapter transaction/TTL suite.
- Documentation link validation.
- `git diff --check`.
- Final `distill` apply-mode pass after a green baseline.

### Completed evidence

- All 12 workspace package typechecks passed.
- Redis-backed framework suite: 3,413 passed, 0 failed.
- Host suite excluding the process-exit signal file: 2,507 passed, 1 external live-Entra test skipped, 0 failed; the isolated signal suite added 10 passed, 0 failed.
- Real Redis spend-ledger/transaction suite: 85 passed, 0 failed.
- Remaining workspace packages passed in the workspace run: http-auth 90, hitl-smoke 10, document-source 18, pg 73, oracle 79, fs 25, examples 23, ms-graph 142, xlsx 20, customer-summary 243.
- Documentation validation checked 19 shipped files; all relative links resolve and remain shipped.
- `git diff --check` passed.
- `distill` apply mode reused the first captured property-descriptor map at the LLM request boundary, eliminating a second hostile-object observation; 44 metered-LLM regressions and host typecheck remained green. Interface-level context/Redis deepenings were skipped as explicitly deferred advisories.

## Installation

- Start registered remediation from the immutable standalone review run.
- Register every observed out-of-scope support path at remediation start.
- Resume until `verified-index-installed`, commit the installed index, and push without force.
