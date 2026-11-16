# PR #55 remediation (review-and-fix)

- **Branch:** `fix/draining-worker-overwrite` (PR #55, stacked on `refactor/deepen-decomposed-shells`)
- **Scope:** `kind: all`, `--files` limited to the 7 files PR #55 changes. The engine diffs against the merge base with `origin/main`, so the shared lifecycle files also show #54's already-reviewed changes.
- **Review run:** `.claude/reviews/review-and-fix-runs/pr55-review`
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr55-policy` (disposition digest `1639068b…4629`)

## Critical findings

None. The engine reported 0 surviving and 0 refuted criticals, so the defect-family accounting is `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| silent-failure-hunter-1 | accepted | A drain that never ends kept the tenant unavailable forever; the liveness sweep now hard-stops a drain past `drainKillAfterMs` (`DRAIN_TIMEOUT_MS` + 15 s grace), decided by the pure `drainOverdue` |
| pr-test-analyzer-1 | accepted | Manager tests now pin the abort reason per call site: put-failure kill failure → orphan-risk error; readiness-timeout kill failure → warn only |
| type-design-analyzer-1 | accepted | `WorkerTable.reserve` consults `spawnClearance` and returns the refusal; admission no longer carries that check |
| type-design-analyzer-2 | dismissed | Narrowing `replace` needs re-typing every ADT transition's return; no transition the manager uses yields `spawning` |
| architecture-tech-lead-1 | accepted | Same as type-design-analyzer-1 |
| architecture-tech-lead-2 | accepted | Same as silent-failure-hunter-1 |
| architecture-tech-lead-3 | dismissed | WorkerTable as single owner of per-tenant state was settled in PR #54 |
| code-simplifier-1 | accepted | `decideAdoption`/`Adoption` folded into `adoptedState` |
| code-simplifier-2 | dismissed | ts-pattern `match` is the project idiom; a `Record` table is equivalent, not simpler |
| code-simplifier-3 | accepted | `holdsProcess` type guard beside the ADT replaces the inline live/draining tests |

## Refuted findings

None.

## Changed files

- In scope: `worker-lifecycle-decisions.ts` (+test), `worker-lifecycle-manager.ts` (+test), `worker-table.ts`, `spawn-port.ts`
- Support paths outside the frozen scope: `worker-lifecycle.ts` (`ProcessState`, `holdsProcess`), `main-supervisor.ts` (`drainKillAfterMs` wiring), `worker-table.test.ts`, `CONTEXT.md`, this plan

## Validation (operator runs, not remediation evidence)

- `bun run typecheck` (host): clean
- `nix develop --command bash -c 'REDIS_URL=redis://:fugue-ci-test-password@localhost:6389 bun run verify'`: exit 0 (host 2876 + 10 pass, 0 fail)
- `bun node_modules/@peterstorm/loom/scripts/lint-project.ts`: 0 violations
