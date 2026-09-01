# PR Remediation Plan — 2026-09-01 (round 2)

- **Branch:** `feat/f3-budget-capability-surface`
- **Reviewed HEAD:** `9c287c917c414d1ce6c07dc0acad536c5839607c`
- **Review run:** `.claude/reviews/review-and-fix-runs/2026-09-01T07-04-18Z-standalone-review-01a05b28-r2`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/2026-09-01T07-04-18Z-standalone-review-01a05b28-r2/result.json`
- **Result digest:** `5cd2a7c5a26e78428a39cd9524d1f25aa3b1d0b692179242f7eaa30d6d78ef7e`

## Exact Frozen Scope

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
- `packages/framework/src/__tests__/spend.test.ts`
- `packages/framework/src/__tests__/tool-dispatch.test.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/dag-runtime/run-node.ts`
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
- `packages/framework/src/types/budget-capability.ts`
- `packages/framework/src/types/budget.ts`
- `packages/framework/src/types/capability-broker.ts`
- `packages/framework/src/types/capability-handle.ts`
- `packages/framework/src/types/errors.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/llm.ts`
- `packages/framework/src/types/node.ts`
- `packages/framework/src/types/spend.ts`
- `packages/host/README.md`
- `packages/host/docs/deployment.md`
- `packages/host/src/__tests__/capability-manager.test.ts`
- `packages/host/src/__tests__/domain/cache-keys.test.ts`
- `packages/host/src/__tests__/entrypoint-wiring.test.ts`
- `packages/host/src/__tests__/fixtures/host-boot-fakes.ts`
- `packages/host/src/__tests__/llm-meter.test.ts`
- `packages/host/src/__tests__/metered-llm.test.ts`
- `packages/host/src/__tests__/middleware/error-handler.test.ts`
- `packages/host/src/__tests__/node-context-factory.test.ts`
- `packages/host/src/__tests__/run-spend-authority.test.ts`
- `packages/host/src/__tests__/runtime-capabilities.test.ts`
- `packages/host/src/__tests__/spend-ledger-file.test.ts`
- `packages/host/src/__tests__/spend-ledger.test.ts`
- `packages/host/src/__tests__/spend-record.test.ts`
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
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

## Mandatory Surviving Critical Findings

### `code-reviewer-1` — packages/host/src/adapters/node-context-factory.ts:410
- **Finding:** Redis spend TTL is based on DAG node-checkpoint TTL, so a HITL run retained by longer HITL_RUN_TTL_SEC can resume after spend expires with a refilled budget.
- **Fix:** Thread the durable HITL run retention into context construction; use a spend TTL at least as long as every resumable HITL record while preserving the DAG checkpoint TTL as its own deadline. Add unit and Redis-backed expiry regressions.

### `code-reviewer-2` — packages/host/src/adapters/run-spend-authority.ts:117
- **Finding:** tokenUsageOf accepts cacheWriteTokens plus cacheReadTokens greater than tokensIn as known, allowing malformed clients to under-report token spend and keep token-only budgets open.
- **Fix:** Parse provider usage with the inclusive-input invariant `cacheWriteTokens + cacheReadTokens <= tokensIn` using subtraction to avoid overflow. Settle violations as durable unknown usage and prove token-budget refusal on the next call.

### `silent-failure-hunter-1` — packages/host/src/http/handlers/run-dag.ts:267
- **Finding:** The request deadline starts only after createContext resolves, so a hung Redis spend-ledger/context setup can hold the HTTP request and concurrency permit indefinitely without returning the configured timeout.
- **Fix:** Create the run identity in the HTTP shell and race one pipeline containing context construction plus DAG execution against the configured hard deadline, so setup hangs abort and release concurrency too.

### `silent-failure-hunter-2` — packages/host/src/http/handlers/run-dag.ts:303
- **Finding:** Late successful DAG completion after HTTP 408 is discarded without diagnostics, hiding completed side effects and making client retries prone to duplication.
- **Fix:** Emit a guarded warning when a DAG fulfills successfully after HTTP 408, naming the run and duplicate-side-effect/retry consequence; retain existing late error/rejection diagnostics.

### `silent-failure-hunter-3` — packages/host/src/host.ts:653
- **Finding:** A throwing logger escapes the reconciliation catch, so startup can reject or periodic void promises can become unhandled while the original reconciliation failure is lost.
- **Fix:** Route reconciliation diagnostics through the total logger helper so a throwing logger cannot reject startup or an interval-owned promise. Add startup and periodic regressions.

### `pr-test-analyzer-1` — packages/host/src/adapters/__tests__/redis-connectivity.test.ts:597
- **Finding:** No real-Redis integration test exercises appendSpend or commitCheckpointAndRetainSpend; the durability/retention proof relies only on FakeRedis transaction behavior.
- **Fix:** Add `REDIS_URL`-gated tests against real ioredis/Redis for additive hash appends, marker union, TTL, and atomic checkpoint-write/spend-retention behavior.

### `type-design-analyzer-1` — packages/framework/src/types/capability-broker.ts:53
- **Finding:** `ScopedLlmCapability<T>` makes `runScopedOperations` optional and unrelated to `T`, so a type-correct broker can deliver an augmented LLM without its required aliases and the runtime installs a plain `LlmClient` behind the augmented context type.
- **Fix:** Make every scoped LLM envelope carry a required alias map derived from its concrete client type; standard clients use an empty map and augmented clients cannot omit required aliases.

### `type-design-analyzer-2` — packages/framework/src/types/capability-broker.ts:56
- **Finding:** The raw non-LLM branch of `ScopedCapabilityHandle` has no discriminator, so a contract-violating broker can return an untagged `LlmClient` that `meterScopedLlmCapabilities` passes through unchanged, bypassing run spend metering.
- **Fix:** Replace raw broker values with a closed `llm | non-llm` scoped binding ADT. Parse and unwrap every binding at dispatch; reject untagged values before context merge.

### `type-design-analyzer-3` — packages/framework/src/types/spend.ts:99
- **Finding:** `Spend` permits negative or unsafe token and call counts, so a type-correct `SpendLedgerPort` can hydrate budget enforcement with a negative total and grant consumption beyond declared ceilings.
- **Fix:** Make `Spend` opaque and smart-constructed, add a hostile-value parser at ledger hydration, and use saturating non-negative safe-integer arithmetic so forged or overflowing totals cannot create budget headroom.

### `comment-analyzer-1` — packages/host/docs/deployment.md:116
- **Finding:** The deployment guide documents obsolete unscoped Redis key prefixes instead of the implemented `fugue:<tenant>:` namespace.
- **Fix:** Rewrite deployment Redis examples and ACL guidance to the implemented `fugue:<tenant>:` namespace.

### `comment-analyzer-2` — packages/framework/src/types/spend.ts:33
- **Finding:** `MicroUsd` documentation promises exact unbounded aggregation even though it is backed by JavaScript `number` and loses integer exactness beyond `Number.MAX_SAFE_INTEGER`.
- **Fix:** Replace the false unbounded-number claim with the enforced safe-integer/saturating fail-closed contract in code, ADR, and ubiquitous language.

### `comment-analyzer-3` — packages/framework/src/llm/cost.ts:137
- **Finding:** The settled-call JSDoc is attached to `spendOfUnknownCall` even though its claims and parameters describe `spendOfCall`.
- **Fix:** Attach settled-call documentation to `spendOfCall` and give `spendOfUnknownCall` its own accurate contract.

### `comment-analyzer-4` — packages/host/src/entrypoint-wiring.ts:60
- **Finding:** `redisOperationFailure` is documented as preventing configured-secret leakage even though its public default performs no redaction.
- **Fix:** Remove the unsafe empty-redaction default; require callers to pass derived Redis secret spellings and pin compile/runtime behavior.

## Advisory Dispositions

- **DISMISSED `silent-failure-hunter-4`** — Tracing hook and clock failures are silently discarded when the optional logger is absent or throws.
  - **Reason:** Observer/clock isolation is deliberate; when the optional diagnostic sink is absent or itself broken there is no trustworthy reporting channel, and allowing telemetry faults to alter execution would violate observer isolation.
- **DISMISSED `silent-failure-hunter-5`** — Shutdown logging failures are silently discarded by logSafely, making worker and infrastructure cleanup failures unobservable when the primary logger is broken.
  - **Reason:** `logSafely` deliberately makes cleanup total. A broken sole logger cannot reliably report its own failure; propagating it would strand later teardown and reduce correctness.
- **ACCEPTED `silent-failure-hunter-6`** — costRatesFor encodes an unknown model price as zero without warning, making unpriced span telemetry indistinguishable from genuinely free usage.
  - **Reason:** Unpriced span cost currently aliases free cost. Add an explicit priced/unpriced span attribute while retaining no-per-span-warning policy.
- **ACCEPTED `pr-test-analyzer-2`** — No synchronous createHost execution test proves meterMintedLlm reaches runDag for a broker-delivered custom LLM.
  - **Reason:** A shell-level createHost regression is practical and closes the composition proof for broker LLM metering.
- **ACCEPTED `pr-test-analyzer-3`** — No HITL resume test executes a broker-delivered custom LLM and proves it uses the resumed run's spend authority.
  - **Reason:** A resumed HITL broker-LLM regression is practical and validates fresh-slice authority wiring.
- **ACCEPTED `pr-test-analyzer-4`** — buildRuntimeDeps has no behavioral test for local/remote Git selection or assembled spend-ledger/pricing dependencies.
  - **Reason:** The existing runtime composition seam can be tested behaviorally with injected factories, covering Git selection and spend/pricing assembly without mocks.
- **ACCEPTED `type-design-analyzer-4`** — `UnpricedModels` guarantees only non-emptiness, not its documented sorted and deduplicated canonical form, so exported constructors accept values that violate the stated invariant.
  - **Reason:** Make `UnpricedModels` opaque and construct it only through canonical sort/dedup logic.
- **ACCEPTED `type-design-analyzer-5`** — `Breach` does not correlate USD ceilings with `MicroUsd` observations, so consumers lose unit safety when formatting or persisting breach data.
  - **Reason:** Split breach members by ceiling kind so USD observations are `MicroUsd` and token/call observations remain counts.
- **ACCEPTED `comment-analyzer-5`** — `disconnectRedisClients` says all failures are preserved, but it replaces each rejection with a new message-only `Error` and drops the original value, cause, and stack.
  - **Reason:** Preserve each rejection as `Error.cause` while retaining the aggregate human-readable message.
- **ACCEPTED `comment-analyzer-6`** — `UnpricedModels` is documented as canonically sorted and deduplicated, but its exported tuple type permits arbitrary order and duplicates.
  - **Reason:** Duplicate of type-design-analyzer-4; one opaque smart-constructor fix disposes both findings.
- **ACCEPTED `comment-analyzer-7`** — ADR-0082 documents `Breach` as only `reached | unpriced`, omitting the current `unknown-usage` variant.
  - **Reason:** Update ADR-0082 to include the later `unknown-usage` amendment.
- **ACCEPTED `comment-analyzer-8`** — The feature guide calls spend durable without distinguishing the in-process ledger, which survives slice resumes but not process restarts.
  - **Reason:** Qualify durability by Redis/file/process backends in the feature guide.
- **DEFERRED `architecture-tech-lead-1`** — NodeContext construction crosses its consumer seam as Promise<NodeContextForDag> while domain/setup failures are thrown as untyped Error values.
  - **Reason:** A typed context-construction Result requires coordinated HTTP, HITL, and composition API redesign beyond this correctness remediation; current setup/deadline failures remain contained at the shell.
- **DEFERRED `architecture-tech-lead-2`** — RedisPort exposes a vendor-shaped, cross-subsystem command surface instead of consumer-owned capability ports, forcing unrelated consumers and fakes to depend on commands they do not use.
  - **Reason:** Consumer-owned Redis port decomposition spans cache, checkpoint, spend, leases, sets, and HITL transactions; it warrants a dedicated deepening with conformance suites rather than an inline interface migration.
- **ACCEPTED `code-simplifier-1`** — The hostile LLM pricing parser uses a nested ternary and IIFE where explicit branches preserve the same validation behavior with less control-flow nesting.
  - **Reason:** Flatten the pricing parser into explicit branches while preserving the hostile-boundary contract.
- **ACCEPTED `code-simplifier-2`** — The run spend gate invents a private error/release union instead of using the project's existing Result type.
  - **Reason:** Use the project Result ADT for admission instead of a private error/release union.
- **ACCEPTED `code-simplifier-3`** — The unmetered broker LLM test asserts result.ok is false twice, so the final assertion is dead duplication.
  - **Reason:** Delete the duplicate assertion; no evidence is lost.

## Refuted Critical Audit

No canonical critical findings were refuted.

## Implementation Order

1. Close domain state spaces: opaque/canonical `Spend`, `MicroUsd`, `UnpricedModels`, unit-correlated breaches, and scoped broker binding ADTs.
2. Harden authority and shell boundaries: usage parsing, ledger hydration, HTTP whole-pipeline deadline, late completion diagnostics, reconciliation logging, Redis redaction.
3. Couple HITL/spend retention and prove Redis transactions against a real server.
4. Add host/HITL/runtime composition tests and accepted documentation corrections.
5. Run focused tests, full package tests, workspace typecheck/tests, documentation checks, `git diff --check`, then the required distill apply-mode pass one move at a time.

## Validation Commands

```bash
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
bun test packages/framework/src/__tests__/spend.test.ts packages/framework/src/__tests__/budget.test.ts packages/framework/src/__tests__/per-node-minting.test.ts
bun test packages/host/src/__tests__/run-spend-authority.test.ts packages/host/src/__tests__/node-context-factory.test.ts packages/host/src/__tests__/hitl-reconciliation-lifecycle.test.ts packages/host/src/__tests__/entrypoint-wiring.test.ts
bun run --filter @fuguejs/framework test
bun run --filter @fuguejs/host test
bun run typecheck
REDIS_URL=redis://127.0.0.1:<ephemeral-port> bun run test
bun scripts/check-doc-links.ts
git diff --check
```

## Remediation Support Paths Outside Frozen Scope

- `packages/framework/src/__tests__/span-enrich.test.ts`
- `packages/framework/src/tracing/semantic-conventions.ts`
- `packages/framework/src/tracing/span-enrich.ts`
- `packages/host/src/__tests__/handlers/run-dag.test.ts`
- `packages/host/src/__tests__/hitl-reconciliation-lifecycle.test.ts`
- `packages/host/src/adapters/__tests__/keycloak-broker.test.ts`
- `packages/host/src/adapters/keycloak-broker.ts`

## Final Validation Evidence

- Workspace typecheck: all 12 packages passed.
- Framework package: 3,355 passed, 52 Redis-gated skipped, 0 failed.
- Host package after final fix: covered again by the Redis-backed workspace run.
- Redis-backed workspace: 6,632 passed, 1 external live-Entra test skipped, 0 failed.
- Real Redis spend adapter: 35 passed, including concurrent append/marker/TTL and checkpoint-retention transactions.
- Documentation links: 19 shipped files checked.
- `git diff --check`: passed.

## Distill / Deepen Final Pass

- Applied: flattened hostile pricing parsing; reused the project `Result` ADT for admission; deleted the duplicate assertion; centralized single-model canonicalization; made huge finite USD conversion saturate rather than pass through intermediate `Infinity` to zero.
- Wrongness discovered and fixed: the initial safe-integer conversion would have mapped `Number.MAX_VALUE * 1_000_000` to zero. A regression now pins saturation at `Number.MAX_SAFE_INTEGER`.
- Deepening lens: new seams have production and test adapters (broker injection, run-id source, Redis transaction port), and the opaque Spend parser concentrates rather than redistributes invariants. The broader typed context-construction and RedisPort decomposition remain deliberately deferred as dispositioned above.
