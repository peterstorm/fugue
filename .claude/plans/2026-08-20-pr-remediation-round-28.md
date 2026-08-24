# PR Remediation — 2026-08-20 — Round 28

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/20260820T131742Z-01a01f4c-standalone-review`
- Canonical result: `.claude/reviews/review-and-fix-runs/20260820T131742Z-01a01f4c-standalone-review/result.json`
- Canonical result digest: `88347f3611d5078ecc4a1748637ae27fb53f46a3d833339db7ab96940950eedc`
- Exact frozen scope: the literal 408 paths in `result.json.scope`; the canonical result is the sole source of review findings, adjudication, and scope.
- Required support paths outside the frozen scope:
  - `.claude/plans/2026-08-20-pr-remediation-round-28.md`
  - `packages/host/src/__tests__/lifecycle/redis-probe.test.ts`

This round uses a unique plan path rather than overwriting the earlier same-day remediation authority at `.claude/plans/2026-08-20-pr-remediation.md`.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — hostile connect rejection can bypass cleanup**
   - Render both connect and cleanup failures with the existing total `safeErrorMessage` helper before logging or constructing the typed `ConnectFailure`.
   - Add a revoked-proxy rejection regression proving the failing handle closes and `connectAll` resolves to `Err` rather than rejecting.

2. **`code-reviewer-2` — eval-judge prompt assembly escapes the total result seam**
   - Move rubric resolution, prompt assembly, and the LLM call under one guarded result boundary.
   - Use `safeErrorMessage` for prompt-provider, serialization, LLM, span, and malformed-error diagnostics; make skipped-event diagnostics secondary and non-throwing.
   - Add cyclic input, throwing prompt provider, and hostile rejection regressions proving `EvalJudgeResult` is always returned.

3. **`silent-failure-hunter-1` — Redis probe misclassifies callback/logger failures as ping failures**
   - Narrow the ping `try` to `redis.ping()` only.
   - Invoke callbacks and diagnostics through non-throwing helpers so callback faults never trigger the opposite connectivity transition and logger faults never suppress the real transition.
   - Add regressions for throwing `onAlive`, `onDead`, and logger paths.

4. **`silent-failure-hunter-2` — graceful-drain registry removal is detached**
   - Make the exit watcher await `removeRecord(tenant)` and route all watcher rejection through a tenant-attributed non-throwing terminal catch.
   - Add a registry-remove rejection regression proving no process-level unhandled rejection and an attributed error record.

5. **`comment-analyzer-1` — `thinking` is incorrectly documented as Anthropic-only**
   - Correct the option documentation to provider-neutral reasoning/thinking behavior consistent with the request contract and OpenAI mapping.

## Advisory dispositions

1. **`silent-failure-hunter-3` — accepted.** Malformed thin-init values currently alter restart/shutdown behavior without operator evidence. Return immutable structured warnings alongside the safe defaults and emit each warning during PID-1 startup; preserve the never-refuse-start policy.
2. **`silent-failure-hunter-4` — accepted.** An empty final catch makes broker audit loss invisible. Reuse the supervisor audit sink’s direct-stderr floor, guarded so auditing remains never-throw, and add a double-failure regression.
3. **`pr-test-analyzer-3` — dismissed.** `packages/host/src/__tests__/supervisor/secrets/env-file-secrets-source.test.ts` already pins malformed lines, duplicates, quote/escape handling, missing/unreadable files, and secret-value omission; integration isolation tests add further value-leak coverage.
4. **`pr-test-analyzer-4` — dismissed.** `packages/host/src/__tests__/worker-bootstrap.test.ts` already directly pins username-only, password-only, blank username, blank password, both blank, both absent, trimming, and secret omission for `parseAclCredential`.
5. **`type-design-analyzer-1` — accepted.** Replace publicly mutable observer counters with private state and readonly snapshot/getter views, retaining the existing read API while making external mutation unable to corrupt metrics.
6. **`type-design-analyzer-2` — deferred.** Splitting composite-capable checkpointers changes the central persistence port and all adapters/callers. The current behavior is documented and was recently deepened; no adapter disagreement or correctness failure was demonstrated, so this needs a dedicated interface-design round rather than a focused remediation.
7. **`comment-analyzer-2` — accepted.** Move the tool-node factory JSDoc immediately above `createLlmWithToolsNode` so generated and editor documentation binds to the factory.
8. **`comment-analyzer-3` — accepted.** Move the Bun init adapter factory JSDoc immediately above `createBunInitProcessAdapter`; keep reap-fault policy documentation with its own function.
9. **`comment-analyzer-4` — accepted.** Move the cache-error bypass audit documentation immediately above `findFileCacheErrorBypasses`.
10. **`architecture-tech-lead-1` — deferred.** Extracting the customer-summary resume orchestrator is architecturally sound but is a broad transport/application seam redesign with no demonstrated incorrect response. It requires a dedicated deepening with result-ADT design and test migration, not opportunistic remediation.
11. **`architecture-tech-lead-2` — accepted.** Thread the runtime event timestamp function through node execution context, distinct from the node-visible `ClockCapability`, and have guardrail/eval-judge sub-spans use it. Add a full DAG regression proving built-in sub-spans honor `RunOptions.now`.
12. **`code-simplifier-1` — accepted.** Delete unread `RunBuffer.createdAt`; `lastActivityAt` is the sole inactivity-eviction timestamp.
13. **`code-simplifier-2` — accepted.** Delete the matching unread `RunSummaryBuffer.createdAt` field in customer-summary observability composition.

## Refuted critical audit — retain, never fix

1. **`pr-test-analyzer-1` — filesystem adapter allegedly lacks boundary tests. Refuted.** Reproduction and intent lenses found `packages/adapter-fs/src/__tests__/fs-adapter.test.ts` directly covers traversal and absolute-root escapes, foreign references, preflight/mid-read aborts, and ENOENT/EACCES/EISDIR/EIO mappings. The security lens upheld only from incomplete supplied evidence; the panel threshold refuted the claim.
2. **`pr-test-analyzer-2` — Redis ACL provisioner allegedly lacks apply/revoke tests. Refuted.** Reproduction and intent lenses found `packages/host/src/__tests__/supervisor/secrets/redis-acl.test.ts` invokes production apply/revoke, inspects SETUSER/DELUSER, verifies password shape and entropy rejection, and proves admin failure yields `Err` without a credential; the real-server suite additionally exercises production apply. The security lens upheld only from incomplete supplied evidence; the panel threshold refuted the claim.

## Planned touched paths

- `.claude/plans/2026-08-20-pr-remediation-round-28.md` (support)
- `packages/host/src/domain/capability-manager.ts`
- `packages/host/src/__tests__/capability-manager.test.ts`
- `packages/framework/src/nodes/eval-judge.ts`
- `packages/framework/src/__tests__/eval-judge.test.ts`
- `packages/host/src/lifecycle/redis-probe.ts`
- `packages/host/src/__tests__/lifecycle/redis-probe.test.ts` (support)
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/worker-lifecycle-manager.test.ts`
- `packages/framework/src/nodes/llm-with-tools.ts`
- `packages/host/src/main-thin-init.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts`
- `packages/host/src/adapters/broker-audit.ts`
- `packages/host/src/adapters/__tests__/broker-audit.test.ts`
- `packages/framework/src/observer/buffered.ts`
- `packages/framework/src/__tests__/buffered-observer.test.ts`
- `apps/customer-summary/src/observability-composition.ts`
- `packages/framework/src/types/node.ts`
- `packages/framework/src/dag-runtime/run-node.ts`
- `packages/framework/src/nodes/guardrail.ts`
- `packages/framework/src/__tests__/guardrail.test.ts`
- `packages/framework/src/__tests__/event-timestamp-monotonic.test.ts`
- `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts`
- `packages/framework/src/scripts/check-imports.ts`

## Validation

Focused pre-remediation baseline: 264 passed, 0 failed across 11 directly affected suites.

Run focused gates after coherent fixes, then full repository gates:

```bash
bun test packages/host/src/__tests__/capability-manager.test.ts packages/framework/src/__tests__/eval-judge.test.ts packages/host/src/__tests__/lifecycle/redis-probe.test.ts packages/host/src/__tests__/supervisor/lifecycle/worker-lifecycle-manager.test.ts
bun test packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts packages/host/src/adapters/__tests__/broker-audit.test.ts
bun test packages/framework/src/__tests__/guardrail.test.ts packages/framework/src/__tests__/event-timestamp-monotonic.test.ts packages/framework/src/__tests__/buffered-observer.test.ts packages/framework/src/__tests__/buffered-observer-stale-sweep.test.ts apps/customer-summary/src/__tests__/observability-composition.test.ts
bun test packages/framework/src/__tests__/boundary-imports.test.ts
bun run check:docs
bun run typecheck
bun run test
```

After green implementation, run the mandatory `distill` apply-mode pass one move at a time with covering tests. Registered remediation then owns path audit, temporary-index staging, verification, and atomic index installation.
