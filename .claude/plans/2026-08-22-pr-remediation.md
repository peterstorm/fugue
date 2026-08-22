# PR Remediation Plan — 2026-08-22

## Authority and exact scope

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T182240Z-01a02ab5`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T182240Z-01a02ab5/result.json`
- Result digest: `25612dd2cd6fd3c1d5e52c46fdd499c7f6187c576d2bd0223198a33f7b9bb511`
- Frozen review scope: exactly the 438 paths in the immutable `result.json.scope` array; no path outside that array is reviewed authority.
- Remediation support paths outside frozen scope: none. This plan and every planned production/regression path are members of the frozen scope.

## Surviving critical findings — mandatory

### `pr-test-analyzer-1` — denied DAG execution is not pinned side-effect-free

**Finding:** `POST /dags/:id/run` lacks a route-level negative authorization test proving a non-admin identity from another team receives `403` before either `hitl.startRun` or `executeDag` is invoked.

**Fix:** extend `packages/host/src/__tests__/handlers/run-dag.test.ts` with denied cross-team requests for both synchronous and HITL DAGs. Use recording fakes and assert `403`, `executeDag` call count zero, `hitl.startRun` call count zero, and no concurrency mutation.

### `architecture-tech-lead-1` — HITL lease ownership seam has disagreeing adapters

**Finding:** Redis writes atomically validate `RunLease.ownerToken`, while the in-memory run-store adapter and service fake accept any non-aborted same-run lease.

**Fix:** add one in-memory lease authority used to issue and validate leases, make `createInMemoryRunStore` require that authority for checkpoint/status writes, and migrate HITL service/executor tests to the production in-memory adapter plus the same authority. Add adapter-contract regressions proving a successor lease invalidates a still-live stale owner for both checkpoint and terminal writes, matching the Redis regression.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — lossless completed-output persistence.** Sound adapter-parity bug. Persist/read run metadata with the framework `toJson`/`fromJson` codec rather than plain JSON, retain strict `RunMetaSchema` parsing after decode, and add Map/Set/Date completed-output round-trip coverage.
2. **`code-reviewer-2` — ambiguous metadata publication.** Sound Redis failure ambiguity. Serialize metadata once and include an exact-value `compareAndDelete` of the metadata publication key in failed-create compensation. Add a write-then-error fake proving no metadata-only run survives.
3. **`code-reviewer-3` — mapped conversation persistence acknowledged despite failure.** Sound delivery gap. Return a retryable `503` when owner-team conversation persistence fails so Bot Framework can retry; add a handler regression proving the failure is caller-visible and default persistence cannot turn it into success.
4. **`type-design-analyzer-1` — HumanAction schema drift.** Sound compile-time coupling gap. Type the persisted-decision schema against `HumanAction` and preserve branded reroute parsing so a new action variant fails compilation until persistence handles it.
5. **`type-design-analyzer-2` — FrameworkError schema drift.** Sound compile-time coupling gap. Type the persisted-failure schema against `FrameworkError` so union changes cannot compile without updating the persistence parser; retain strict mandatory-field tests.
6. **`comment-analyzer-1` — local SHA comment drift.** Sound documentation defect. State that dev-mode SHA hashes modification times and sizes.
7. **`code-simplifier-1` — resume proof mixes envelope decoding with agreement logic.** Sound altitude issue. Extract a private pure checkpoint decoder preserving gate order, diagnostics, and `Result` behavior; run the full resume-proof suite after the move.
8. **`code-simplifier-2` — active-index prune/log duplication.** Sound local duplication. Extract one local prune-and-warn helper while preserving each branch’s conservative-count decision.

### Deferred

1. **`architecture-tech-lead-2` — framework-owned FrameworkError persistence codec.** The ownership concern is sound, but moving the parser into the framework changes a public cross-package seam and requires a coordinated persistence-version policy. This remediation accepts the overlapping compile-coupling advisory (`type-design-analyzer-2`) so drift fails the build, while deferring codec ownership to a dedicated framework persistence deepening.

### Dismissed

None.

## Refuted critical audit — retain, never fix

### `silent-failure-hunter-1`

**Claim:** `startRun` returns success after direct enqueue failure and strands the run.

**Panel evidence:**

- Reproduction: service tests reproduce initial enqueue failure and prove later wakeup, including after restart; `host.ts` starts and periodically runs reconciliation.
- Intent: durable run creation is the acceptance boundary; the queue is a wakeup trigger, and reconciliation owns delayed delivery.
- Security: the durable active record remains authoritative and discoverable, so the wakeup is delayed rather than lost.

No create compensation or caller-visible enqueue failure will be introduced.

### `silent-failure-hunter-2`

**Claim:** `recordDecision` returns success after direct resume enqueue failure and loses resume.

**Panel evidence:**

- Reproduction: `a stored decision whose direct wakeup fails completes after reconciliation` reaches terminal completion.
- Intent: the decision is durably accepted before enqueue; reconciliation re-enqueues suspended runs with stored decisions.
- Security: durable decision state remains authoritative, so direct enqueue failure delays rather than loses resume.

No decision rollback or false failure response will be introduced.

### `pr-test-analyzer-2`

**Claim:** the manifest route lacks cross-team negative authorization coverage.

**Panel evidence:**

- Reproduction: `manifest.test.ts` already sends another team through the real route and asserts `403`.
- Intent: the existing route-level test pins the intended cross-team denial, and `buildManifest` is pure.
- Security: authorization precedes manifest construction and no schema metadata is returned.

No duplicate manifest test will be added.

## Planned files

- `.claude/plans/2026-08-22-pr-remediation.md`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/decision-store.ts`
- `packages/host/src/hitl/adapters/bot/messages-handler.ts`
- `packages/host/src/adapters/git-sync.ts`
- `packages/framework/src/file/resume-proof.ts`
- `packages/host/src/__tests__/handlers/run-dag.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts`
- `packages/framework/src/__tests__/file-resume-proof.test.ts` (validation authority; edit only if extraction exposes a missing regression)

## Validation

1. Baseline and focused regressions:
   ```bash
   bun test packages/host/src/__tests__/handlers/run-dag.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/adapters/__tests__/run-executor.test.ts packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts packages/framework/src/__tests__/file-resume-proof.test.ts
   ```
2. Host typecheck: `bun run --filter @fuguejs/host typecheck`
3. Framework typecheck: `bun run --filter @fuguejs/framework typecheck`
4. Full workspace typecheck: `bun run typecheck`
5. Full workspace tests: `bun run test`
6. Documentation links: `bun run check:docs`
