# PR #54 remediation (review-and-fix)

- **Branch:** `refactor/deepen-decomposed-shells` (PR #54, base `main`)
- **Scope:** `kind: all`, the 14 files of the PR diff (frozen in the review run)
- **Review run:** `.claude/reviews/review-and-fix-runs/pr54-review` (result digest `8aff9e5f…ab35`)
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr54-policy` (disposition digest `0dc3888f…fb61`)

## Critical findings

None. The engine reported 0 surviving and 0 refuted criticals, so the defect-family accounting is `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| silent-failure-hunter-1 | accepted | `Owned.set` silently overwrote a held resource; `set` now refuses a held cell (internal-invariant throw) |
| pr-test-analyzer-1 | accepted | WorkerTable tests now pin `reserve` over a crashed entry and `replace` over a live one |
| pr-test-analyzer-2 | accepted | full-lifecycle test now asserts a second shutdown after a failed close releases nothing again |
| type-design-analyzer-1 | accepted | same defect as silent-failure-hunter-1, fixed once |
| type-design-analyzer-2 | accepted | `reserve` takes only a `SpawningState`; both `reserve` and `replace` key on `state.tenant` |
| comment-analyzer-1 | accepted | `SignalFailureSeverity` doc now keys severity on whether a registry record could exist |
| architecture-tech-lead-1 | dismissed | each release-then-signal teardown already has one definition (`abortSpawn`, `hardStopAndForget`); a third wrapper removes no call site |
| architecture-tech-lead-2 | accepted | same defect as silent-failure-hunter-1, fixed once |
| code-simplifier-1 | accepted | pure `adoptedState` exported from worker-lifecycle-decisions.ts; the manager and the property tests share it |
| code-simplifier-2 | accepted | redundant orphan-risk comment in `persistLiveOrAbort` deleted |

## Refuted findings

None.

## Changed files

- `packages/host/src/lifecycle/owned.ts`, `packages/host/src/__tests__/lifecycle/owned.test.ts`
- `packages/host/src/supervisor/lifecycle/worker-lifecycle.ts` (`SpawningState`; `requestWorker` returns it)
- `packages/host/src/supervisor/lifecycle/worker-table.ts`, its test
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-decisions.ts` (`adoptedState`, severity doc), its test
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts`
- `CONTEXT.md` (Worker Table, Worker Lifecycle Decisions, `owned.ts` rows)
- Support paths outside the frozen scope: `packages/host/src/__tests__/integration/full-lifecycle.test.ts`, this plan

## Validation (operator runs, not remediation evidence)

- `bun run typecheck` (host): clean
- `nix develop --command bash -c 'REDIS_URL=redis://:fugue-ci-test-password@localhost:6389 bun run verify'`: exit 0 (host 2866 + 10 pass, 0 fail)
- `bun node_modules/@peterstorm/loom/scripts/lint-project.ts`: 0 violations
