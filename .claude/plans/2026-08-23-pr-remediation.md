# PR Remediation — 2026-08-23

## Review authority

- Branch: `feat/f6-file-durable-runtime`
- Reviewed HEAD: `89fb82adba0954503d4d21f6852fda21ab737733`
- Merge base with `origin/main`: `6c316cb53a9b7dfd88f2908b26108979eddbb04a`
- Review run: `.claude/reviews/review-and-fix-runs/review-20260823T051143Z-cc16951f`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260823T051143Z-cc16951f/result.json`
- Frozen scope: the exact 443 paths in `result.json.scope`; remediation changes are limited to finding paths, their in-scope tests/docs, and the support paths listed below.
- Planned support paths outside the frozen review scope:
  - `.claude/plans/2026-08-23-pr-remediation.md`
  - `packages/http-auth/src/http-status.ts`

## Surviving critical findings — mandatory

### `code-reviewer-1` — persisted DAG context is cast instead of parsed

**Evidence:** `packages/host/src/hitl/run-store-job.ts:161` accepts any record-shaped `context` and casts it to `DagMachineContextPersisted`. All three refutation lenses upheld the finding; current tests intentionally accept `{}`.

**Fix:**

1. Add a framework-owned, pure parser for the complete persisted DAG context, including required Maps/Sets, branded node IDs, topology edges/adjacency, retry state, human-gate state, routing confidence, `initialInput`, and the optional DAG fingerprint.
2. Represent persisted topology edges without predicate closures so the durable type tells the truth.
3. Use the parser in `makeRunStoreJobLike`; reject malformed context before constructing `JobLike`.
4. Replace empty-context fixtures with real compiled persisted contexts and add table/property coverage proving missing or wrong-shaped required fields are rejected.

### `silent-failure-hunter-1` — checkpoint-write errors replay side effects

**Evidence:** `packages/host/src/hitl/adapters/run-executor.ts:165` returns the checkpoint `HostError`; `processRun` sends that error to queue retry while the last durable checkpoint may precede already-executed side effects. All three panel lenses upheld the replay path.

**Fix:**

1. Convert a captured post-transition checkpoint failure into a non-retriable terminal run failure on the executor outcome channel rather than the queue-retry error channel.
2. Preserve the checkpoint failure kind and diagnostic in the durable `FrameworkError` and non-throwing error log.
3. Let `processRun` persist `status: failed`; update ADR-0060 and comments that currently prescribe retry from the last checkpoint.
4. Pin executor/service regressions proving the failure is terminalized and not returned for queue replay.

### `comment-analyzer-1` — production Bot routing comment claims a default fallback

**Evidence:** `packages/host/src/hitl/adapters/bot/messages-handler.ts:145` says unmapped teams fall back to the default, while the notifier only reads a team reference and fails closed.

**Fix:** State that the default is retained only as a back-compat/operational reference and is never a review-delivery fallback.

### `comment-analyzer-2` — mapped-team Bot test repeats the fallback claim

**Evidence:** `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts:248` describes the stored default as a fallback contradicted by notifier behavior.

**Fix:** Rewrite the assertion comment to describe independent back-compat storage with no delivery fallback.

### `comment-analyzer-3` — conversation-store test claims callers fall back

**Evidence:** `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts:647` claims a missing team reference falls back to default, while delivery fails closed.

**Fix:** Rewrite the comment to state absence means no per-team route and must be handled fail-closed by the notifier.

## Advisory dispositions

### Accepted — `code-reviewer-2`: corrupt active metadata omitted from reconciliation

The claim is sound and the fix is local. Keep corrupt metadata conservatively counted, but include its valid `RunId` in `listActiveRunIds` so reconciliation emits `inspection-failed` while continuing healthy runs. Add Redis-store and service-level regression coverage.

### Accepted — `type-design-analyzer-1`: registry exposes live mutable configs

The runtime-read-only Map facade does not protect nested `TenantConfig` objects. Snapshot and recursively freeze each config and nested mapping/admission record when building a registry. Add regression coverage showing mutation attempts cannot alter lookup, lifecycle, team ownership, or paths.

### Dismissed as duplicate — `architecture-tech-lead-1`: persisted context cast

This is the same defect and location as mandatory critical `code-reviewer-1`. It receives no separate change; the critical fix and tests fully disposition it.

### Accepted — `architecture-tech-lead-2`: durable queue trigger is trusted by generic type

Add a pure `RunTrigger` parser using `tryRunId` and `tenantId`, compare the parsed tenant to the queue-bound tenant, and reject malformed/cross-tenant data before lock-key construction or lease issuance. Add malformed payload tests in the existing queue suite.

### Accepted — `code-simplifier-1`: duplicated HTTP retry-status policy

Create one internal pure `isRetriableHttpStatus` helper in `packages/http-auth/src/http-status.ts`; reuse it from token minting and the authenticated client while preserving the existing client export and behavior. Run both auth and client suites.

### Accepted — `code-simplifier-2`: repeated fake-route branding JSDoc

Keep the raw-vs-shaped invariant and example at `shapedRoute`/`SHAPED_ROUTE`; trim the fake factory comment to its own responsibility and refer to `shapedRoute` instead of repeating the full invariant/example.

## Refuted critical audit

No critical findings were refuted (`result.json.refuted_critical_findings` is empty).

## Validation

Targeted gates:

```bash
bun test packages/framework/src/__tests__/context-serialization-roundtrip.test.ts
bun test packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-executor.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-queue.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts \
  packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts
bun test packages/http-auth/src/__tests__/auth.test.ts \
  packages/http-auth/src/__tests__/client.test.ts \
  packages/http-auth/src/__tests__/index.test.ts
```

Package and full relevant gates:

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun run --cwd packages/http-auth typecheck
bun run --cwd packages/framework test
bun run --cwd packages/host test
bun run --cwd packages/http-auth test
bun run check:docs
```

After a green implementation baseline, run the required `distill` apply-mode pass one move at a time and re-run the covering tests after each accepted simplification.
