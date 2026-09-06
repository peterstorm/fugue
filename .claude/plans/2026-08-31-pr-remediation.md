# PR Remediation Plan — F3 Budget Capability Surface

- **Branch:** `feat/f3-budget-capability-surface`
- **Reviewed HEAD:** `3088a7d8c4224d181ee9cc9487193bcf62348690`
- **Review run:** `.claude/reviews/review-and-fix-runs/2026-08-31-222831-f3-budget-review`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/2026-08-31-222831-f3-budget-review/result.json`
- **Result digest:** `95a38bb2722a9ce588732254ddd4cd0a63de7462f43bc4d0979233a3dfd3e4bf`
- **Policy:** `all`, not dry-run; commit and push after registered remediation succeeds.

## Frozen review scope

The exact engine-owned scope is:

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
- `packages/framework/src/testing.ts`
- `packages/framework/src/types/budget-capability.ts`
- `packages/framework/src/types/capability-handle.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/node.ts`
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

## Mandatory surviving criticals

1. **`code-reviewer-1` — total Redis model-name encoding.** Replace `encodeURIComponent` with a canonical reversible ASCII encoding over UTF-16 code units, including empty strings and lone surrogates. Add arbitrary-code-unit round-trip properties, an explicit lone-surrogate regression, and a new-ledger hydration regression representing resume.
2. **`silent-failure-hunter-1` — malformed provider Result escapes settlement.** Parse the LLM client's runtime return at the Run Spend Authority shell. Accessor throws, non-Result shapes, malformed errors, and malformed usage become a typed non-retriable `node-crash`; every delegated attempt is settled, released, metered as one call, and persisted without a raw rejection.
3. **`pr-test-analyzer-1` — failures without usage bypass call ceilings.** Record every delegated LLM attempt with zero token usage when no trustworthy usage is available. Add calls-only tests proving a typed failure and a hostile/malformed result consume the first call and the next attempt is refused before provider egress.
4. **`type-design-analyzer-1` + `architecture-tech-lead-1` — augmented LLM composer can ignore authority.** Remove the adapter-executed `composeRunClient` callback. Replace it with a declarative alias-to-standard-operation map interpreted by the host into a frozen, null-prototype facade whose only functions delegate to the metered client. Add type pins, hostile boot-client tests, context integration tests, and authoring/domain docs.
5. **`comment-analyzer-1` — stale Redis fake protocol comment.** Rewrite the fake documentation around one-hash marker assignment, numeric addition, absent-hash `HGETALL`, and transactional append semantics.
6. **`comment-analyzer-2` — stale tenant lifecycle comments.** Rewrite `TenantRegistryView` and `markTenant` documentation in present tense around the shipped registry adapter and current test fakes.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-2`** — Fence a throwing `hGetAll` in `createRedisSpendLedger.read` and return the port's typed `HostError`; add a regression.
- **`silent-failure-hunter-3`** — Replace substring-based before-execute abort recognition with a dedicated kernel control-flow error and a type guard; prove unrelated errors containing the old text retain node-crash taxonomy.
- **`pr-test-analyzer-2`** — Extend unpriced headroom tests to prove the nested model list is frozen and mutation-resistant.
- **`type-design-analyzer-4`** — Parse `HostError.kind` through a compile-time exhaustive kind table before the variant switch; make the switch's fallback accept only `never`.
- **`comment-analyzer-4`** — Correct the in-memory ledger storage description to the actual token/call/cost/model-set representation.
- **`comment-analyzer-5`** — Clarify that the threshold failure itself escalates to error.
- **`comment-analyzer-6`** — Remove the non-durable review-round identifier while retaining the non-empty retry-backoff invariant.
- **`code-simplifier-1`** — Use the existing `map` combinator for successful file spend record transformations.
- **`code-simplifier-2`** — Use `mapErr` in the file-ledger anti-corruption adapter so error translation is the visible responsibility.
- **`code-simplifier-3`** — Settle every call through one record/release/persist sequence, leaving one reservation-release point before ledger I/O.
- **`code-simplifier-4`** — Reuse `NO_SPEND` in Run Spend Authority tests instead of reconstructing it with unsafe casts.

### Deferred

- **`architecture-tech-lead-2`** — Defer the pure `NodeContextPlan`/typed creation-result deepening. The finding is sound, but it is a coordinated interface migration across HTTP, HITL, identity, ledger selection, and context construction; partial conversion would add another error mode rather than reduce one. No part is required by the surviving correctness defects.
- **`architecture-tech-lead-3`** — Defer decomposition of the broad Redis command port into consumer-owned ports. The spend ledger already narrows and receiver-binds its required capabilities; a complete split affects unrelated cache, checkpoint, lease, registry, token, and HITL adapters and needs its own architecture migration and adapter conformance pass.

### Dismissed

- **`type-design-analyzer-2`** — Dismiss token/call headroom branding for this remediation. The public result is already a discriminated union coupling `unit`, ceiling subtype, and amount, and `remainingFor` exhaustively selects named `projected.tokens`/`projected.calls`; adding count brands would migrate the entire public `Spend`, ceiling, persistence, and config surface without closing an observed defect.
- **`type-design-analyzer-3`** — Dismiss a branded `Spend` at `SpendLedgerPort.add`. The port is an internal typed seam whose sole production producer is `RunSpendAuthority.record` via `spendOfCall`; external bytes are parsed at Redis/file reads, Redis writes reject invalid integer axes, and a forged structural value requires an explicit type-boundary violation. Branding every aggregate would add pervasive casts while not strengthening an actual untrusted boundary.

## Refuted critical audit — retain, never fix

- **`comment-analyzer-3`** — “`computeCostUsd` claims it warns once globally.”
  - **Intent panel:** surrounding comments establish per-invocation semantics; per-span/per-call paths avoid `computeCostUsd` because using it there would emit one line per invocation, and the function emits exactly one warning during an unknown-model invocation.
  - **Security panel:** the JSDoc assigns frequency to call sites, not process-wide model-name deduplication. No production authorization, metering, or outcome defect exists.
  - **Disposition:** refuted; no code or comment change.

## Planned support paths outside frozen scope

The registered remediation must authorize these paths at start:

- `.claude/plans/2026-08-31-pr-remediation.md`
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/types/budget.ts`
- `packages/framework/src/types/spend.ts`
- `packages/framework/src/__tests__/state-machine-runner.test.ts`
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`

## Validation

Baseline targeted suite passed before remediation: **249 tests, 0 failures**.

After each coherent move, run the directly covering tests. Final validation:

```bash
bun test \
  packages/framework/src/__tests__/extensible-capabilities.test.ts \
  packages/framework/src/__tests__/budget-capability.test.ts \
  packages/framework/src/__tests__/dag-runtime-stateful.test.ts \
  packages/framework/src/__tests__/state-machine-runner.test.ts \
  packages/host/src/__tests__/capability-manager.test.ts \
  packages/host/src/__tests__/run-spend-authority.test.ts \
  packages/host/src/__tests__/spend-record.test.ts \
  packages/host/src/__tests__/spend-ledger.test.ts \
  packages/host/src/adapters/__tests__/redis-connectivity.test.ts \
  packages/host/src/__tests__/metered-llm.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts
bun run typecheck
bun test
bun run check:docs
```

Then run the mandatory `distill` apply pass from a green baseline, rerun the covering tests after each simplification move, start registered remediation with the exact support paths above, resume to `done`, commit the installed index, and push without force.

## Completed implementation evidence

- Final full test suite: **4,613 passing test cases, 0 failures** (`bun test`, exit 0; log `/tmp/fugue-review-fix-final-tests.log`).
- Full workspace typecheck: every workspace package exited 0.
- Documentation links: 19 shipped documents checked; no dangling or escaping links.
- Whitespace/error-marker audit: `git diff --check` clean.
- Targeted suites were rerun after each coherent change, including authority settlement, capability facade, Redis/file ledger codecs, state-machine control flow, HostError parsing, and budget snapshot immutability.

### Distill apply pass

Green baseline established before simplification. Moves applied one at a time with covering tests kept green:

1. Replaced hand-built successful file-codec `Result` branches with `map`.
2. Replaced file-ledger success/error reconstruction with `mapErr` translation.
3. Collapsed Run Spend Authority settlement to one record/release/persist path and removed repeated `NO_SPEND` reconstructions in tests.
4. Replaced an asserted untrusted `TokenUsage` cast with guarded field snapshots.
5. Removed stale comment noise and the obsolete review-round identifier.

Skipped opportunities: the `NodeContext` creation interface and broad Redis command port require the separately deferred `deepen` migrations; token/call public count branding and a branded internal ledger delta were dismissed for the evidence-based reasons above. No new wrongness remained after the cross-adapter arbitrary-model-string contract was aligned.
