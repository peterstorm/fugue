# PR #56 remediation (review-and-fix)

- **Branch:** `refactor/deepen-deferred` (PR #56, stacked on `fix/draining-worker-overwrite`)
- **Scope:** the 52 files changed by the refactor commits (the final spec-renumbering commit's 94 docs-only files were not in the frozen scope). The 444k-unit diff exceeded the 240k read-coverage budget, so it was partitioned into three `--files` runs. The engine diffs against the merge base with `origin/main`, so shared lifecycle files also show #54/#55's already-reviewed changes.
  - A — brokering: `.claude/reviews/review-and-fix-runs/pr56-review-a` (14 files; policy `pr56-policy-a`)
  - B — host lifecycle / HITL / registry / customer-summary: `pr56-review-b` (15 files; policy `pr56-policy-b`)
  - C — framework: `pr56-review-c` (23 files; policy `pr56-policy-c`)

## Critical findings

None in any slice (0 surviving, 0 refuted). Defect-family accounting is `not-required` for each remediation.

## Advisory dispositions (DECLARED; full reasons in each published disposition)

**A (8):** accepted — token-cell clock-at-store test; `effectiveTtlMs` non-finite/non-positive lifetime → 0; `obtain` total (lookup inside the guard; comment-analyzer-1 and architecture-tech-lead-1); token-cache header; `parseScope` caller doc; ADR-0059 names `decideGate` as the ordering owner. Dismissed — non-empty `KeycloakLeg.credentials` brand (the planner is the only producer and already refuses an empty map).

**B (15):** accepted — re-adopted overdue-drain test; `setUpRedis` tests via a `RedisSeams` seam; `MaxQueuedRuns` parsed at construction; `drainOverdue` takes the draining variant (type-design-analyzer-2 and code-simplifier-2); `SignalFailureSeverity` and `hard-stop` docs; Tenant Config Fault glossary; `buildTenantConfig` maps the typed fault; `TenantSpawnConfig` redeclarations removed; host.ts doc paragraph. Deferred — tagged `WorkerRecord` (changes the persisted registry format; needs a compatibility decision). Dismissed — run-queue guard-clause style, `resolveContext` spread (would widen the context), behaviour-change note (belongs to #55).

**C (9):** accepted — stale-handle registration warns; `sendWithTools` diagnostics tests; `NodeStateRecord` declared once (type-design-analyzer-1 and code-simplifier-1); `QueueTable.entries()` snapshot; named dedup flag. Deferred — one shared clock guard across cache, freshness-index and file checkpointer (modules outside this PR). Dismissed — keyed `all()` combinator redesign, lint-checks recomputation.

## Refuted findings

None.

## Implementation

Fixes were made in three agent worktrees (commits `cebf47f6`, `d79cf91d`, `63059883`, each based on `a251fad3`) and applied uncommitted, one slice per remediation run, each slice installed and committed before the next. Notable additions beyond the advisories, each reported by the implementer: `store` never keeps an already-stale token entry; very large lifetimes are capped at `Number.MAX_SAFE_INTEGER` ms; a `MaxQueuedRuns` brand; a `RedisSeams` injection point in customer-summary; stale in-memory queue handlers are no longer retained.

## Validation (operator runs, not remediation evidence)

- All three slices applied together: `bun node_modules/@peterstorm/loom/scripts/lint-project.ts` → 0 violations.
- `nix develop --command bash -c 'REDIS_URL=redis://:fugue-ci-test-password@localhost:6389 bun run verify'` → exit 0 (host 2932 + 10, framework 4342, customer-summary 257; 0 failures).
