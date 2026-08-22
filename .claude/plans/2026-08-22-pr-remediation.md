# PR Remediation Plan — 2026-08-22

## Authority and exact scope

- Branch: `feat/f6-file-durable-runtime`
- Review HEAD: `93caa862ffd1b2ffb55316ff870a7682a099ea6f`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T201712Z-01a02b1e`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T201712Z-01a02b1e/result.json`
- Result digest: `ccf927a83decc4b49ad58ae15683a8be60743b2b01cb9063079aed4ab8293ef4`
- Frozen review scope: exactly the 443 paths in the immutable canonical `result.json.scope` array. That array is the literal reviewed-path authority.
- Support paths outside frozen scope: none. The plan and every production/regression path below are members of `result.json.scope`.

## Surviving critical findings — mandatory

### `silent-failure-hunter-1` — HITL diagnostics disappear when the logger fails

**Finding:** `logWithoutThrowing` suppresses logger failures without an independent last-resort diagnostic channel.

**Fix:** retain the typed/durable outcome as authoritative, but make one guarded `process.stderr.write` fallback using total error/data rendering. Inject the fallback writer for deterministic coverage and prove that logger and fallback failures never escape.

### `pr-test-analyzer-1` — production enqueue-throw conversion lacks a regression pin

**Finding:** the `RunQueue` adapter's critical contract—backend enqueue rejection becomes `Err(redis-unavailable)` rather than a thrown post-acceptance failure—is not directly tested.

**Fix:** extend the real adapter fake to reject enqueue and assert `queue.enqueue` resolves to the typed error without throwing.

### `type-design-analyzer-1` — `RunStoreJob` aliases its live checkpoint envelope

**Finding:** the synchronous `data` getter returns the closure's mutable checkpoint object, and successful `updateData` stores the caller's object by reference. A caller can therefore mutate execution state without crossing `saveCheckpoint`.

**Fix:** introduce one checked serialization round-trip for checkpoint snapshots. Return a defensive snapshot from `data`, and install a detached snapshot after successful persistence. Add regressions for mutation of both getter results and post-`updateData` caller objects.

### `comment-analyzer-1` — buffered replay accounting is bypassed in production

**Finding:** `BufferedObserver` catches around `dispatchEvent`, but production `dispatchEvent` absorbs synchronous observer throws. `dispatchErrors` and `onReplayFailure` therefore only observe failures under strict-test mode.

**Fix:** factor a result-returning synchronous dispatch attempt beneath the public failure-isolating `dispatchEvent`. Keep the public production/strict contract unchanged; have `BufferedObserver` consume the explicit dispatch outcome so replay and run-end failures are counted/dead-lettered in production. Update regressions to run without `OBSERVER_STRICT`.

### `code-simplifier-1` — filesystem metadata retains an unreachable ref fallback

**Finding:** successful `pathFor` already proves `FileRef.kind === "localPath"`, but `getMetadata` re-tests the original union and retains an unreachable basename fallback.

**Fix:** make successful resolution return a local-path value carrying both the confined absolute path and authored stable id. Both content and metadata consume that narrowed value; delete the unreachable branch.

### `code-simplifier-2` — in-memory active-index inspection has divergent count/list rules

**Finding:** `countActiveRuns` and `listActiveRunIds` duplicate cleanup while only the list path prunes terminal records.

**Fix:** add one in-memory active-index inspection/prune helper used by both operations, mirroring the Redis adapter's single inspection path. Pin self-healing of a leaked terminal member.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — hydration can overwrite a concurrent mutation with a stale snapshot.** Reproduced: scan/read occurs outside the mutation gate, so a later serialized commit can replace a successful registration with pre-registration bytes. Serialize the entire hydrate read/parse/commit operation and add a delayed-scan concurrent-register regression.
2. **`pr-test-analyzer-2` — delayed re-enqueue failure is untested.** The lost-wakeup prevention branch is load-bearing and the test is local. Force backend enqueue rejection under lock contention and assert the worker throws for queue retry.
3. **`pr-test-analyzer-3` — successful lease renewal is untested.** The failure paths are covered, but the success contract must prove the exact lock key, owner token, and TTL. Add a deterministic long-running slice pin that completes only after renewal is observed.
4. **`type-design-analyzer-2` — lease owner token is an unvalidated string.** The capability constructor is already the single issuance seam. Brand the stored token and reject empty tokens there; production unpredictability remains supplied by `crypto.randomUUID`. Add a constructor-invariant regression.
5. **`comment-analyzer-2` — run-summary logger can violate the stated fail-tolerant tail.** Route the direct sink-failure warning through the existing non-throwing logger guard with total error rendering. Add a throwing-sink plus throwing-logger regression.
6. **`architecture-tech-lead-1` — lifecycle reads are coupled to checkpoint availability.** The concern is real: terminal metadata gets a fresh TTL during settle while the checkpoint may expire earlier. Deepen the port with a metadata-only lifecycle read while retaining checkpoint-required execution reads. Route status/auth polling through metadata; keep worker, decision, and reconciliation paths on the full execution record. Add terminal-without-checkpoint adapter coverage.
7. **`code-simplifier-3` — Graph path walk duplicates child lookup.** Collapse to one lookup per uncached segment and branch only around intermediate-prefix caching. Existing path-resolution tests cover behavior.
8. **`code-simplifier-4` — persisted-status parsing hand-rolls error rendering.** Reuse the already-imported total `safeErrorMessage` helper.

### Deferred

1. **`silent-failure-hunter-2` — Zod introspection failures collapse to `null`.** The runtime parser still fails closed; the lost behavior is definition-time diagnostics. A complete remedy requires changing the shared `objectSchemaKeys` / `objectSchemaRequiredKeys` contract from nullable arrays to an explanatory ADT and threading that through DAG definition and lint diagnostics. Defer to a focused schema-introspection interface deepening rather than add a parallel ad-hoc warning channel.

### Dismissed

None.

## Refuted critical audit — retain, never fix

The canonical `result.json.refuted_critical_findings` array is empty. No critical finding was refuted by the registered panel. Two surviving findings had minority refutation evidence, retained here for audit but not used to waive remediation:

- `silent-failure-hunter-1`: intent lens noted diagnostics are subordinate to typed/durable outcomes; reproduction and blast-radius lenses upheld total diagnostic loss. The fix preserves outcome precedence and adds only a guarded fallback.
- `code-simplifier-2`: blast-radius lens noted supported in-memory operations remove terminal ids synchronously; reproduction and intent lenses upheld the divergent self-healing contract. The fix unifies inspection without changing supported lifecycle behavior.

## Planned files

- `.claude/plans/2026-08-22-pr-remediation.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `packages/host/src/hitl/diagnostic-logging.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/types.ts`
- `packages/host/src/http/handlers/runs.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/framework/src/observer/dispatch.ts`
- `packages/framework/src/observer/buffered.ts`
- `packages/framework/src/__tests__/buffered-observer.test.ts`
- `packages/adapter-fs/src/index.ts`
- `packages/host/src/supervisor/registry/redis-registry-adapter.ts`
- `packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`
- `apps/customer-summary/src/observability-composition.ts`
- `apps/customer-summary/src/__tests__/observability-composition.test.ts`
- `packages/adapter-ms-graph/src/path-resolving.ts`

## Validation

1. Green baseline before implementation:
   ```bash
   bun test packages/host/src/hitl/__tests__/run-store-job.test.ts packages/host/src/hitl/adapters/__tests__/run-queue.test.ts packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/framework/src/__tests__/buffered-observer.test.ts packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts apps/customer-summary/src/__tests__/observability-composition.test.ts packages/adapter-fs/src/__tests__/fs-adapter.test.ts packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts
   ```
2. Focused regressions: repeat the command above after each cohesive move.
3. Package typechecks: `bun run --filter @fuguejs/framework typecheck`, `bun run --filter @fuguejs/host typecheck`, and relevant adapter/app typechecks.
4. Full workspace typecheck: `bun run typecheck`.
5. Full workspace tests: `bun run test`.
6. Documentation links: `bun run check:docs`.
7. Distill apply-mode pass after a green implementation; rerun focused tests after each accepted simplification.
