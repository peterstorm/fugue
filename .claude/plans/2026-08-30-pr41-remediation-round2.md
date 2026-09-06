# PR 41 Review-and-Fix Remediation — Round 2

## Authority

- **Branch:** `feat/f3-budget-capability-surface`
- **Review run:** `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round2`
- **Authoritative result:** `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round2/result.json`
- **Review revision:** `968d8c479e454988543560ee2a4374d95f18f036`
- **Disposition:** 5 surviving criticals are mandatory; all 15 advisories are accepted; 0 findings are refuted.
- **Constraints:** do not stage, commit, or push; do not modify review evidence; do not touch `.claude/worktrees/`; update existing in-scope tests; create no new file other than this plan.

## Exact Frozen Review Scope

- `.claude/plans/2026-08-30-f3-budget-capability-remediation.md`
- `.claude/plans/2026-08-30-f3-budget-capability-surface.md`
- `CONTEXT.md`
- `docs/adr/0083-spend-durability-lives-in-a-ledger-port.md`
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
- `packages/framework/src/dag-runtime/run-node.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/boundary-error.ts`
- `packages/framework/src/file/spend-store-codec.ts`
- `packages/framework/src/file/spend-store.ts`
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
- `packages/host/src/__tests__/llm-meter.test.ts`
- `packages/host/src/__tests__/metered-llm.test.ts`
- `packages/host/src/__tests__/middleware/error-handler.test.ts`
- `packages/host/src/__tests__/node-context-factory.test.ts`
- `packages/host/src/__tests__/run-spend-authority.test.ts`
- `packages/host/src/__tests__/spend-ledger-file.test.ts`
- `packages/host/src/__tests__/spend-ledger.test.ts`
- `packages/host/src/adapters/metered-llm.ts`
- `packages/host/src/adapters/node-context-factory.ts`
- `packages/host/src/adapters/run-spend-authority.ts`
- `packages/host/src/adapters/runtime-capabilities.ts`
- `packages/host/src/adapters/spend-ledger-file.ts`
- `packages/host/src/adapters/spend-ledger-memory.ts`
- `packages/host/src/adapters/spend-ledger-redis.ts`
- `packages/host/src/domain/capability-manager.ts`
- `packages/host/src/domain/host-error.ts`
- `packages/host/src/domain/llm-meter.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/http/middleware/error-handler.ts`
- `packages/host/src/index.ts`
- `packages/host/src/ports.ts`

The remediation plan is the only support path outside the frozen scope.

## Surviving Criticals — Mandatory Fixes

1. **`code-reviewer-1` — claimed capability delivery can fall back to static authority.**
   - In `run-node.ts`, determine undelivered broker claims from `minted.value` itself before merge, requiring `Object.hasOwn(minted.value, capability)` and a non-null own value.
   - Preserve the typed `missing-capability` failure and prevent `node.run`.
   - Add a regression where the base context already has the capability, `provides()` claims it, `mintFor()` returns `{}`, and the node never runs.

2. **`code-reviewer-2` — prototype pollution in context construction and scoped merge.**
   - Treat `__proto__`, `prototype`, and `constructor` as forbidden prototype-meta capability keys.
   - Reject them as typed merge failures at the scoped merge seam and omit/reject them at the applicable context-input seam without executing legacy setters.
   - Materialize accepted own capability properties with data-property semantics (null-prototype intermediate or `Object.defineProperty`), not `Object.assign` into `{}`.
   - Add `JSON.parse('{"__proto__":...}')` regressions proving the context prototype is unchanged and neither inherited nor polluted capabilities become visible.

3. **`silent-failure-hunter-1` — throwing/rejecting ledger append aborts paid output.**
   - Fence `SpendLedgerPort.add` inside persistence, convert both typed `Err` and thrown/rejected contract violations into exactly the `llm.ledger-write-failed` best-effort diagnostic, and never rethrow.
   - Preserve successful provider output and ensure no `llm.call-failed` diagnostic is emitted for ledger failure.

4. **`comment-analyzer-1` — file barrel comment claims a nonexistent export.**
   - Rewrite the comment beside `META_RECORD_NODE_ID` to describe only the actual export and its canonical source; do not add or invent an API.

5. **`comment-analyzer-2` — documented top-level capability precedence is false for null.**
   - Resolve each built-in by own-property/presence semantics: an explicitly present top-level value, including `null`, wins; only an absent or deliberately `undefined` top-level field falls back to the capability bag.
   - Add a regression proving explicit top-level `null` overrides a non-null bag value.

## Advisory Dispositions — 15 Accepted

1. **`code-reviewer-3` — frozen LLM clients break proxy invariants. Accepted** because immutable clients are valid public inputs and the generic decorator promises subtype preservation.
   - Proxy a separate extensible facade, intercept the two LLM methods, forward other reads/writes to the original receiver, cache bound subtype methods by original function, and preserve stable identity/private-field receivers.
   - Test a frozen object-literal client plus receiver-sensitive subtype behavior.

2. **`code-reviewer-4` — live HostError recognition is trap-prone and mutable. Accepted** because the HTTP exception seam must be total over hostile unknown values.
   - Replace the live-object type guard with a total parser returning a fresh HostError snapshot or `undefined`/Result; guard all reads, read once, validate every variant, and deep-freeze copied arrays/objects.
   - Make the error handler consume only parsed snapshots.
   - Test throwing getters, revoked proxies, mutation/time-of-check drift, and all valid variants.

3. **`silent-failure-hunter-2` — `JSON.stringify` may return undefined. Accepted** because handing non-strings to Redis violates the cache port and bypasses diagnostics.
   - Treat a non-string stringify result for top-level `undefined`, function, or symbol as non-serializable, emit the existing best-effort warning, return success, and never call Redis.

4. **`silent-failure-hunter-3` — logger failure erases 500 diagnostics. Accepted** because generic responses intentionally leave server diagnostics as the only incident evidence.
   - On logger failure, make a separately guarded stderr attempt using safe, trap-free bounded rendering; both logger and stderr failures remain secondary to the selected response.
   - Test logger failure and stderr failure isolation without introducing global-test races (prefer an injected/private sink seam if needed).

5. **`pr-test-analyzer-1` — malformed validation issue elements accepted. Accepted** because `issues` crosses an untrusted throwing boundary and is later trusted for output.
   - Parse each issue element into a fresh immutable snapshot and reject malformed arrays/elements; cover both validation variants.

6. **`type-design-analyzer-1` — negative reservation states are publicly constructible. Accepted** because a negative in-flight count is an illegal domain state that can affect admission.
   - Replace the exported structural constructor seam with an opaque/branded or equivalent closed ADT created only by legal transitions; keep pure immutable transitions and typed underflow.
   - Adapt tests to legal admission/release/learning transitions and add compile-time (`@ts-expect-error`) plus runtime/property invariant coverage.

7. **`type-design-analyzer-2` — memory ledger leaks mutable Spend references. Accepted** because append-only accounting requires stored and returned snapshots to be isolated.
   - Snapshot/deep-freeze seed values, deltas/folded totals, and reads using the framework spend snapshot constructor.
   - Test mutation attempts cannot alter later reads.

8. **`type-design-analyzer-3` — explicit null loses to capability bag. Accepted** because it is the same correctness defect as critical 5.
   - Covered by the presence/undefined precedence implementation and null regression under critical 5.

9. **`comment-analyzer-3` — Redis partial-write comment has the wrong order. Accepted** because operational failure documentation must match observable write order.
   - State cost-first (`micros`, then tokens, calls, model set) and describe later axes as potentially under-recorded after interruption.

10. **`comment-analyzer-4` — stale unbuilt-feature comment in production. Accepted** because roadmap state rots outside its source of truth.
    - Remove the follow-up/unbuilt-feature language and leave only the current health-check contract/consumer behavior.

11. **`comment-analyzer-5` — review-history test comment. Accepted** because durable tests should explain invariants, not remediation chronology.
    - Rewrite the section comment around authoritative injected ledgers, Redis-first selection, and honest in-process fallback behavior.

12. **`architecture-tech-lead-1` — reservation lifetime includes ledger latency. Accepted** because provider settlement and durable persistence are distinct lifecycle phases.
    - Consume/release the reservation immediately once usage is recorded in the in-process meter, before awaiting ledger append; ensure every admitted path releases exactly once, including no-usage errors and thrown provider calls.
    - Add a pending-ledger integration test proving `remaining()` and admission do not double-count settled spend, persistence occurs exactly once, and ledger failures remain best effort.

13. **`code-simplifier-1` — mutable health flag duplicates results. Accepted** because accumulated results are the source of truth.
    - Derive `overall` from `results.some(status === "unhealthy")` after collection and delete the synchronized flag.

14. **`code-simplifier-2` — node-context factory mixes policy and I/O altitudes. Accepted** because the public factory is a real lifecycle seam whose orchestration currently hides several independent policies.
    - Keep the public signature and extract private named helpers for tenant resolution, ledger selection/hydration, authority construction, and origin/token binding.
    - Keep pure decisions separate from I/O, make helpers deep (own policy/invariants rather than pass-through), and retain production plus existing fake adapters at the ledger seam.

15. **`code-simplifier-3` — retry policy is a long negative branch. Accepted** because retry semantics are mostly static data and must remain exhaustive.
    - Replace the long `ts-pattern` negative union with an exhaustive `satisfies Record<HostErrorKind, number | undefined | dynamic-marker>` table, preserving dynamic tenant-over-quota and exact current statuses/headers.

## Refuted-Finding Audit

The authoritative result contains **zero refuted critical findings** (`refuted_critical_findings: []`). Nothing is excluded from remediation on refutation grounds.

## Implementation Order and Focused Gates

Each conceptual move starts from its focused green baseline and reruns the focused suite after the change.

1. **Capability authority and safe context materialization**
   - Baseline/after: `bun test packages/framework/src/__tests__/per-node-minting.test.ts packages/framework/src/__tests__/make-node-context-merge.test.ts packages/framework/src/__tests__/capability-validation.test.ts packages/framework/src/__tests__/extensible-capabilities.test.ts`
   - Implement criticals 1, 2, and 5 plus advisory 8; then correct `file.ts` comment.

2. **Run-spend lifecycle and ledger failure fencing**
   - Baseline/after: `bun test packages/host/src/__tests__/run-spend-authority.test.ts packages/host/src/__tests__/metered-llm.test.ts`
   - Implement critical 3 and advisory 12, preserving paid outputs and releasing provider reservations before persistence latency.

3. **Metered facade compatibility**
   - Baseline/after: `bun test packages/host/src/__tests__/metered-llm.test.ts`
   - Implement advisory 1 with frozen/subtype regressions.

4. **HostError parse boundary and retry policy**
   - Baseline/after: `bun test packages/host/src/__tests__/middleware/error-handler.test.ts`
   - Implement advisories 2, 4, 5, and 15 with immutable snapshots and guarded diagnostics.

5. **Reservation ADT/invariants**
   - Baseline/after: `bun test packages/host/src/__tests__/llm-meter.test.ts packages/host/src/__tests__/run-spend-authority.test.ts`
   - Implement advisory 6 and adapt callers/tests through legal transitions.

6. **Defensive memory-ledger snapshots and Redis documentation**
   - Baseline/after: `bun test packages/host/src/__tests__/spend-ledger.test.ts`
   - Implement advisory 7 and correct advisory 9’s comment.

7. **Cache serialization and factory deepening**
   - Baseline/after: `bun test packages/host/src/__tests__/node-context-factory.test.ts`
   - Implement advisories 3 and 14, then rewrite advisory 11’s test comment.

8. **Capability-health distillation and production comment cleanup**
   - Baseline/after: `bun test packages/host/src/__tests__/capability-manager.test.ts`
   - Implement advisories 10 and 13.

9. **Green integration gate before distill**
   - `bun run typecheck`
   - `bun run check:docs`
   - `bun run test`
   - `git diff --check`

10. **Final distill apply mode**
    - Start only from green.
    - Apply one behavior-preserving move at a time (reuse before rewrite, remove dead/speculative code, flatten control flow, restore altitude); never weaken assertions or alter public interfaces.
    - Rerun the covering focused tests after every move, then rerun all final validation commands.

## Final Validation Commands

```sh
bun run typecheck
bun run check:docs
bun run test
git diff --check
git status --short
```

The final report must enumerate every modified artifact, focused/full pass markers, deepen moves, distill moves, skipped opportunities with reasons, and confirm no stage/commit/push or immutable-evidence/worktree mutation occurred.
