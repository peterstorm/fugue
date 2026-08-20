# PR Remediation — 2026-08-20

## Authority and exact scope

- Branch: `feat/f6-file-durable-runtime`
- Base: `6c316cb53a9b7dfd88f2908b26108979eddbb04a`
- Reviewed head: `29102088959dbe77c338b9fc711591b5256499b8`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/standalone-2026-08-20-163857-f6-file-durable-runtime`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-2026-08-20-163857-f6-file-durable-runtime/result.json`
- Canonical result digest: `126626e60d0abfaee4d2096a0234c2b3b317bdec1a4551f744178392607e8c63`
- Exact frozen scope: the 410 literal paths in `result.json.scope`, derived by the registered `all` review. That immutable array is the sole review authority.
- This file supersedes the prior same-day plan because the current run reviewed the prior remediation state, including that plan.
- Planned support path outside frozen scope: `packages/framework/src/__tests__/_file-resume-fixture.ts`.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — configured eval criteria can be omitted while the judge passes**
   - Enforce case-insensitive, unique, exact response coverage for every configured criterion.
   - Reject missing, duplicate, unexpected, or `failed_criteria`-inconsistent semantic responses as fail-closed evaluator outcomes before quality-gate evaluation.
   - Add pure regressions for omissions, duplicates, extras, contradictory failure declarations, and valid exact coverage.

2. **`silent-failure-hunter-1` — RunExecutor logging can replace the modeled failed outcome**
   - Guard setup/execution diagnostics so a throwing `LogPort` cannot escape the catch branch.
   - Add a regression proving a context-build failure plus hostile logger still settles as `ok({ kind: "failed" })` with the original durable error.

3. **`silent-failure-hunter-2` — HITL fallback logging can reject instead of re-parking**
   - Route every non-fatal decision lookup, pending-marker, notification, and post-commit clear diagnostic through a non-throwing helper.
   - Add hostile-logger regressions for each fallback contract.

4. **`comment-analyzer-1` — a synchronous compound audit sink throw aborts fan-out**
   - Invoke each sink behind its own promise boundary before `Promise.allSettled` so synchronous throws become isolated rejections.
   - Add a regression proving later sinks run, the compound resolves, and the violation remains observable.

## Advisory dispositions

1. **`code-reviewer-2` — accepted.** The caller-owned eval config currently changes runtime behavior after construction while `node.config` can disagree. Snapshot and freeze criteria, rubric, model, id, and normalized threshold once; make both the definition and closure use that immutable value.
2. **`pr-test-analyzer-1` — dismissed.** Its proposed regression would pin the undesirable behavior that a throwing `span.addEvent` changes the quality-gate result to `crash`. The accepted architecture finding below instead makes observability best-effort and adds the inverse regression: the judge outcome remains authoritative.
3. **`type-design-analyzer-1` — accepted.** The file checkpoint capability promises an exact `{ state, context }` data envelope. Enforce the closed own-key shape before minting and add missing/extra-field regressions.
4. **`comment-analyzer-2` — accepted.** `AuditRecord` is exported and structural, so reword `auditRecord` as the preferred construction seam rather than the only producer.
5. **`comment-analyzer-3` — accepted.** Correct `toJson` documentation to state its supported pre-scanned domain and its throw/undefined behavior outside that domain; do not widen this comment fix into an API migration.
6. **`architecture-tech-lead-1` — accepted.** Telemetry must not decide eval quality. Run each judge independently of tracer/span failures, make all trace decoration best-effort, avoid duplicate judge execution when hostile tracers reject after invoking the callback, and update tracing regressions.
7. **`architecture-tech-lead-2` — accepted.** A boot-scoped single-flight mint must not inherit one request’s cancellation. Keep the underlying shared refresh governed only by its own timeout and model request cancellation as waiter-specific; add concurrent cancellation regressions.
8. **`architecture-tech-lead-3` — accepted.** A corrupt existing team record is not a stale absent index member. Parse persisted team records through a pure typed parser and return `redis-unavailable` for malformed JSON or shape instead of `ok(partial)`; retain absent-key skipping.
9. **`code-simplifier-1` — accepted.** The two resume suites use the same state machine model. Extract one private test fixture so future invariant changes have one edit site and both suites continue testing the same model.
10. **`code-simplifier-2` — accepted.** Replace the checkpoint data-kind nested ternary with a named helper while implementing the exact envelope gate; preserve the existing error vocabulary.

## Refuted critical audit — retain, never fix

- None. The registered Refutation Panel upheld all four critical findings under reproduction, intent, and blast-radius lenses.

## Planned touched paths

- `.claude/plans/2026-08-20-pr-remediation.md`
- `packages/framework/src/nodes/eval-judge.ts`
- `packages/framework/src/dag-runtime/eval-judges.ts`
- `packages/framework/src/file/checkpoint-record.ts`
- `packages/framework/src/state-machine/serialize.ts`
- `packages/framework/src/__tests__/eval-judge.test.ts`
- `packages/framework/src/__tests__/pass-3-remediation.test.ts`
- `packages/framework/src/__tests__/file-job.test.ts`
- `packages/framework/src/__tests__/file-resume.test.ts`
- `packages/framework/src/__tests__/file-resume-proof.test.ts`
- `packages/framework/src/__tests__/_file-resume-fixture.ts` (support path outside frozen scope)
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/human-review-hook.ts`
- `packages/host/src/supervisor/audit/audit-sink-log-redis.ts`
- `packages/host/src/supervisor/audit/audit-port.ts`
- `packages/host/src/adapters/token-store.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/__tests__/human-review-hook.test.ts`
- `packages/host/src/__tests__/supervisor/audit/audit-sink.test.ts`
- `packages/host/src/__tests__/token-store.test.ts`
- `packages/http-auth/src/auth.ts`
- `packages/http-auth/src/__tests__/auth.test.ts`

## Validation

Baseline before remediation: 280 targeted tests passed across the ten directly affected suites.

1. `bun test packages/framework/src/__tests__/eval-judge.test.ts packages/framework/src/__tests__/pass-3-remediation.test.ts packages/framework/src/__tests__/file-job.test.ts packages/framework/src/__tests__/file-resume.test.ts packages/framework/src/__tests__/file-resume-proof.test.ts`
2. `bun test packages/host/src/hitl/adapters/__tests__/run-executor.test.ts packages/host/src/hitl/__tests__/human-review-hook.test.ts packages/host/src/__tests__/supervisor/audit/audit-sink.test.ts packages/host/src/__tests__/token-store.test.ts`
3. `bun test packages/http-auth/src/__tests__/auth.test.ts`
4. `bun run --filter @fuguejs/framework typecheck`
5. `bun run --filter @fuguejs/host typecheck`
6. `bun run --filter @fuguejs/http-auth typecheck`
7. `bun run typecheck`
8. `bun test`
