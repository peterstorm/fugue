# PR Remediation — 2026-09-01

## Review authority

- Branch: `feat/f3-budget-capability-surface`
- Reviewed HEAD: `01625003440aaa10aa1bd9042f0b9f8182b3e881`
- Merge base: `af756b658852bbc72afc70efbf58505c4b2c439f`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-01T04-10-04Z-standalone-review-01a05b28`
- Canonical result: `.claude/reviews/review-and-fix-runs/2026-09-01T04-10-04Z-standalone-review-01a05b28/result.json`
- Review kind: `all`; files policy: full frozen branch diff; dry-run: false

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
- `CONTEXT.md`
- `docs/adr/0083-spend-durability-lives-in-a-ledger-port.md`
- `docs/adr/README.md`
- `docs/features.md`
- `docs/plans/2026-08-27-f3-budget-capability.md`
- `docs/spikes/2026-08-02-graph-engineering-findings.md`
- `packages/framework/CHANGELOG.md`
- `packages/framework/docs/adapter-authoring.md`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/budget-capability.test.ts`
- `packages/framework/src/__tests__/capability-validation.test.ts`
- `packages/framework/src/__tests__/cli/cli.test.ts`
- `packages/framework/src/__tests__/conditional-edges-routing.test.ts`
- `packages/framework/src/__tests__/cost.test.ts`
- `packages/framework/src/__tests__/dag-fingerprint-resume.test.ts`
- `packages/framework/src/__tests__/dag-retry-trace-outcome.test.ts`
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`
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
- `packages/framework/src/__tests__/tool-dispatch.test.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/dag-runtime/run-node.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/boundary-error.ts`
- `packages/framework/src/file/spend-store-codec.ts`
- `packages/framework/src/file/spend-store.ts`
- `packages/framework/src/index.ts`
- `packages/framework/src/llm/cost.ts`
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts`
- `packages/framework/src/shared/make-node-context.ts`
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/testing.ts`
- `packages/framework/src/types/budget-capability.ts`
- `packages/framework/src/types/budget.ts`
- `packages/framework/src/types/capability-handle.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/node.ts`
- `packages/framework/src/types/spend.ts`
- `packages/host/README.md`
- `packages/host/docs/deployment.md`
- `packages/host/src/__tests__/capability-manager.test.ts`
- `packages/host/src/__tests__/domain/cache-keys.test.ts`
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
- `packages/host/src/domain/spend-record.ts`
- `packages/host/src/domain/tenant-id.ts`
- `packages/host/src/domain/tenant.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/http/middleware/error-handler.ts`
- `packages/host/src/index.ts`
- `packages/host/src/ports.ts`

## Mandatory surviving critical findings

### C1 — Bind pricing to the provider-effective model

**Finding:** `code-reviewer-1`, `packages/host/src/adapters/run-spend-authority.ts:247`.

Introduce an explicit pricing-model policy (`request` or authority-owned `fixed`) for every LLM binding. Host composition binds Azure's configured override as fixed and ordinary clients as request-selected; LLM capability metadata carries the same policy. The metered boundary resolves and verifies the pricing model before egress, rejects a request that conflicts with a fixed binding, and uses the resolved model for the unpriced gate, settlement, persistence, and diagnostics. Add fixed-routing regressions proving a caller cannot name a cheaper model.

### C2 — Meter broker-minted custom LLM capabilities

**Finding:** `code-reviewer-2`, `packages/framework/src/dag-runtime/run-node.ts:317`.

Represent broker-delivered LLMs with explicit typed metadata rather than duck typing. Thread the host-owned run authority's minted-LLM decorator with the run's minting authority, parse hostile descriptors fail-closed, decorate each declared scoped LLM before merge, and reject a minted LLM when no run meter is available. Preserve raw delivery for non-LLM capabilities. Add framework and host regressions proving a broker-minted custom LLM shares the base run budget and ledger.

### C3 — Couple checkpoint and spend retention atomically

**Finding:** `code-reviewer-3`, `packages/host/src/adapters/node-context-factory.ts:393`.

Add a consumer-owned Redis operation that commits a checkpoint write and refreshes the run's spend-key retention in one `MULTI`/`EXEC`. Parse this operation once with the Redis spend capabilities, bind it to the selected run ledger, and make the namespaced checkpoint writer use it whenever Redis is authoritative. Keep non-expiring and non-Redis adapters honest. Add fake and Redis integration coverage showing later non-LLM checkpoints extend spend to the same deadline and transaction failures fail the checkpoint.

### C4 — Make unknown provider usage durable and fail closed

**Finding:** `silent-failure-hunter-1`, `packages/host/src/adapters/run-spend-authority.ts:136`.

Extend `Spend` with monotone usage-knowledge state. A settled attempt without trustworthy usage records one call plus an explicit unknown-usage marker; `addSpend` makes unknown absorbing; Redis and file encodings persist and strictly parse it. Admission remains evaluable for call-only ceilings but returns a typed fail-closed breach for token or USD ceilings once usage is unknown. Update ADR-0083 and ubiquitous language to match the adjudicated policy and add restart/hydration regressions.

### C5 — Fail a budgeted run when spend persistence is not acknowledged

**Finding:** `silent-failure-hunter-2`, `packages/host/src/adapters/run-spend-authority.ts:290`.

Make persistence return a typed result. Preserve best-effort logging for unbudgeted execution, but after a provider settlement return a non-retriable typed node failure when a declared budget's ledger append returns `Err` or throws. The provider call and in-memory spend remain recorded exactly once. Update ADR-0083 and add returned-error/thrown-error tests.

### C6 — Cover every malformed provider-result branch

**Finding:** `pr-test-analyzer-1`, `packages/host/src/__tests__/run-spend-authority.test.ts:209`.

Add table-driven hostile-result cases for primitives, invalid discriminants, malformed success usage, malformed error payloads, and malformed error usage. Each case must return typed `node-crash`, durably append exactly one call, and cause the next calls-limited attempt to refuse without provider egress.

### C7 — Parse token usage as non-negative safe integers

**Finding:** `type-design-analyzer-1`, `packages/host/src/adapters/run-spend-authority.ts:112`.

Replace the repeated finite/non-negative checks with one named non-negative-safe-integer predicate. Fractional, unsafe, non-finite, negative, accessor-throwing, and malformed values become unknown usage and follow C4's durable fail-closed path. Add boundary tests at `MAX_SAFE_INTEGER` and adjacent invalid values.

### C8 — Reject mixed LLM/non-LLM registry unions

**Finding:** `type-design-analyzer-2`, `packages/framework/src/types/capability-handle.ts:52`.

Classify capability clients with `Extract`/`Exclude`: wholly LLM entries require LLM metadata, wholly non-LLM entries forbid it, and mixed unions produce `never`. Add compile-time assertions proving a union containing `LlmClient` cannot construct a boot-scoped or broker-scoped unmetered handle.

### C9 — Correct the Redis spend-record integrity claim

**Finding:** `comment-analyzer-1`, `packages/host/src/domain/spend-record.ts:7`.

Restate the module contract accurately: one `HGETALL` prevents split-key reads, strict parsing protects present fields, and transactional append plus the explicit unknown marker—not missing-axis parsing—provides the accounting guarantee. Pin the empty-hash/zero-spend behavior in tests.

## Advisory dispositions

### Accepted

- **`type-design-analyzer-3` — private Ceilings brand.** Replace the public string brand with a module-private `unique symbol`; this directly enforces the constructor-only invariant with negligible migration risk.
- **`type-design-analyzer-4` — symbol-keyed LLM aliases.** Restrict alias keys to strings in the mapped type because runtime composition intentionally enumerates string properties only; add a compile-time regression.
- **`comment-analyzer-2` — TenantId provenance comment.** Point to `./tenant-id`, the actual brand/smart-constructor owner.
- **`comment-analyzer-3` — SharedInfra allocation comment.** Distinguish reused boot resources from per-run authorities/facades/adapters.
- **`comment-analyzer-4` — checkHealth accessor escape.** Read `healthCheck` inside the guarded block so the documented totality guarantee is true, with a throwing-accessor regression.
- **`comment-analyzer-5` — feature-guide TOC.** Add section 22 to the table of contents.
- **`architecture-tech-lead-3` — model-aware admission in the pure core.** Resolve pricing eligibility into a pure candidate value and let the domain admission command decide; the shell only selects policy and sequences provider/ledger I/O. This is naturally coupled to C1.
- **`code-simplifier-1` — redundant marker re-encoding.** Remove the unreachable round-trip comparison after canonical fixed-width lowercase-hex parsing; preserve behavior with codec properties.
- **`code-simplifier-2` — redundant model deduplication.** Sort the injective, unique hash-key-derived model list directly; preserve canonical output tests.
- **`code-simplifier-3` — repeated token predicate.** Fold into C7's named safe-integer parser.

### Deferred

- **`code-reviewer-4` — per-call micro-USD rounding.** Sound, but the complete fix requires a new finer-grained monetary representation and a coordinated Redis/file wire-schema migration. Mixing that independent public-value migration into this already cross-package authority/durability remediation would enlarge the compatibility and arithmetic proof surface substantially. Defer to a dedicated money-precision change that introduces exact sub-micro accumulation, migration/versioning, and monoid/property proofs together.
- **`architecture-tech-lead-1` — typed NodeContext construction.** Sound and already evidenced as a broad public-shell migration. Defer because converting every HTTP/HITL factory caller and error taxonomy is independent of the surviving accounting failures; this remediation will not add new raw exception sites.
- **`architecture-tech-lead-2` — split the vendor-shaped RedisPort.** Sound structural debt, but a full consumer-port decomposition spans cache, checkpoint, registry, lease, HITL, and spend adapters. Defer to a dedicated deepening so all consumers migrate atomically rather than adding a partial second taxonomy here. The new atomic checkpoint/spend operation remains consumer-owned and construction-proven.

### Dismissed

None.

## Refuted critical audit

The canonical result contains no `refuted_critical_findings`. The panel retained all nine critical findings. Two findings had an intent-lens refutation but survived the 2-of-3 panel threshold:

- `silent-failure-hunter-1`: intent cited ADR-0083's former zero-token policy; reproduction and security proved that token/USD ceilings then remain open. The surviving finding is mandatory, so ADR-0083 will be updated.
- `silent-failure-hunter-2`: intent cited ADR-0083's former output-preserving write-failure policy; reproduction and security proved resumable durable accounting can become stale. The surviving finding is mandatory, so budgeted execution will fail non-retriably and ADR-0083 will be updated.

## Planned validation

1. Focused framework tests for spend, budget, capability typing/validation, broker minting, and file spend storage.
2. Focused host tests for run authority, metered clients, node-context construction, spend records/ledgers, Redis connectivity, capability lifecycle, and runtime capabilities.
3. Redis-backed host integration tests for atomic append and checkpoint/spend retention.
4. `bun run --filter @fuguejs/framework typecheck`
5. `bun run --filter @fuguejs/host typecheck`
6. `bun run typecheck`
7. `bun run --filter @fuguejs/framework test`
8. `bun run --filter @fuguejs/host test`
9. `bun run test`
10. `bun run check:docs`
11. Distill apply-mode pass after a green baseline, rerunning focused tests after each accepted simplification.
