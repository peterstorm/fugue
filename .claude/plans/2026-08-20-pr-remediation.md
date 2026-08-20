# PR Remediation — 2026-08-20

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/review-20260820T042126Z-252116661`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260820T042126Z-252116661/result.json` (digest `214e1b1b51e64d9a5a70d1ad40d2ea1c2e4fb46741351ba88f9a136a98e49b1c`)
- Frozen review scope: the exact 378 paths in `result.json.scope`; no finding or remediation input was reconstructed outside that result.
- Planned support paths outside the frozen scope:
  - `.claude/plans/2026-08-20-pr-remediation.md`
  - `packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`
  - `packages/host/src/hitl/queue-backend.ts`
  - `packages/host/src/hitl/__tests__/queue-backend.test.ts`
  - `packages/http-auth/src/abort-classification.ts`
  - `packages/http-auth/src/__tests__/abort-classification.test.ts`

## Mandatory surviving critical findings

### `type-design-analyzer-1` — invalid persisted DAG IDs can acquire the `DagId` brand

`parseRunMetaRecord` currently applies `__brandDagIdUnchecked` after checking only `typeof string`, allowing a colon-bearing stored value to escape as `RunMeta.dagId` even though `DagId` excludes `:`.

Fix:

1. Parse `dagId` through the existing `tryDagId` smart parser at the shared file/Redis metadata boundary.
2. Return the parser diagnostic as the existing corrupt-metadata error path instead of minting an invalid brand.
3. Remove the unchecked brand import and stale compatibility commentary.
4. Add file-codec and Redis regression pins proving colon-bearing metadata is rejected while valid IDs still parse.
5. Update the checkpoint contract comments and `CONTEXT.md` only where needed to state that deserialization re-establishes the branded invariant.

Panel audit: reproduction and blast-radius upheld the finding; the intent lens dissented because the old string-only acceptance was deliberate compatibility behavior. The finding survived 2/3 and is mandatory. This pre-release branch’s documented “no backward-compat shims” invariant favors restoring the declared `DagId` domain.

### `comment-analyzer-1` — bare `SC-008` contradicts the citation qualification policy

Fix all three reviewed bare citations in `apps/customer-summary/src/observability-composition.ts` and its test to say `observability spec SC-008`, preserving behavior and making requirement searches unambiguous.

Panel audit: reproduction, intent, and blast-radius all upheld this finding.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-1` — tenant-event callback failures**
   - Accept: callback failure can escape the Redis pub/sub shell.
   - Fix: allow `void | Promise<void>`, invoke through a guarded helper, and report both synchronous throws and rejected promises with event context without letting either escape. Add regression tests for both modes.

2. **`silent-failure-hunter-2` — Oracle release failure after statement failure**
   - Accept: the statement error must remain primary, but the secondary release failure is operationally relevant.
   - Fix: emit the same credential-stripped release warning used by the successful-statement path, with wording that identifies the preserved statement failure. Extend the existing dual-failure test to pin the warning and credential stripping.

3. **`silent-failure-hunter-3` — libc candidate diagnostics discarded**
   - Accept: PID-1 already fails fast, but the final error lacks actionable candidate causes.
   - Fix: model candidate load as a small discriminated result carrying either a reaper or a sanitized diagnostic, aggregate failures in `resolveReaper`, and include each candidate/cause in the final startup error. Keep the injectable pure resolution loop and add tests for cause aggregation.

4. **`silent-failure-hunter-4` — logger failure erases cleanup warnings**
   - Accept: best-effort cleanup must remain non-throwing, but a broken configured logger should have a last-resort diagnostic.
   - Fix: after a logger throw, attempt a guarded `process.stderr.write`; swallow only the fallback’s own failure. Add focused tests for logger failure and stderr failure.

5. **`type-design-analyzer-2` — mutable `FileCheckpointCommit.data`**
   - Accept: public mutation can make the exposed snapshot disagree with proven `json`.
   - Fix: narrow `FileCheckpointCommit` to opaque proven bytes, retain detached decoded data in module-private storage, and expose a non-barrel internal accessor only to `file/job.ts`. Update tests to assert the public commit no longer exposes mutable decoded state.

6. **`type-design-analyzer-3` — Map/Set payloads survive `deepFreeze` mutable**
   - Accept: canonical event decoding restores Map/Set/Date, so the reader is not JSON-only and `Object.freeze` does not protect their internal slots.
   - Fix: make the shared deep-immutability transform return read-only Map/Set/Date proxies, recursively protect collection members, and block mutator methods while preserving read/serialization behavior. Add reader and job pins for Map/Set/Date mutation attempts.

7. **`comment-analyzer-2` — stale sync-loop re-export comment**
   - Accept: repository tests import DAG-factory helpers from their owner, not `sync-loop`.
   - Fix: remove the unused pass-through re-exports and stale comment, retaining only the imports used by sync orchestration. This follows the pre-release no-compat-shim invariant.

8. **`architecture-tech-lead-1` — ADR-0079 contradicts fail-closed implementation**
   - Accept: both adapters and tests withhold a conflict verdict on corruption.
   - Fix: amend ADR-0079’s Decision and Consequences to state typed fail-closed `cache-error`, remove warning-and-absent text, and align the operational guidance with ADR-0025 and ADR-0080.

9. **`architecture-tech-lead-2` — test-only atomic-write hook leaks through public options**
   - Accept: deterministic failure injection is implementation knowledge, not a production option.
   - Fix: keep public `FileFreshnessIndexOptions` clock-only; move hooks to an internal options type and a non-barrel `createFileFreshnessIndexForTesting` helper used by the focused test. Preserve closed option parsing and all failure semantics.

10. **`code-simplifier-1` — duplicated HITL queue wiring**
    - Accept: both host entry points duplicate the same feature gate, dynamic import, construction log, and safe close policy.
    - Fix: add one internal HITL queue wiring module with construction and non-throwing close operations, test configured/unconfigured and close-failure behavior, then use it from both entry points.

11. **`code-simplifier-2` — duplicated timeout/abort classification**
    - Accept: the subtle timeout-vs-caller-cancel rule is identical while only downstream error mapping differs.
    - Fix: extract a pure package-local classifier returning a closed `timeout | abort | other` verdict, test the signal/error matrix, and preserve each caller’s existing error text and retry mapping.

### Dismissed

12. **`code-simplifier-3` — centralize all `NodeContext` test literals**
    - Dismiss: the cited repository contexts intentionally vary capabilities, observers, tracers, and validation state. A broad shared default would hide test-specific dependencies and increase fixture coupling; the existing small local builders keep each test’s required context explicit. This is low-risk test duplication, not a correctness or interface defect.

## Refuted critical audit

`result.json.refuted_critical_findings` is empty. No critical finding is excluded from remediation. The intent-lens dissent on `type-design-analyzer-1` is retained above as panel evidence but did not meet the panel threshold for refutation.

## Planned touched paths

In frozen scope:

- `CONTEXT.md`
- `apps/customer-summary/src/observability-composition.ts`
- `apps/customer-summary/src/__tests__/observability-composition.test.ts`
- `docs/adr/0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md`
- `packages/adapter-oracle/src/index.ts`
- `packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts`
- `packages/framework/src/checkpoint/checkpointer.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/file/boundary-error.ts`
- `packages/framework/src/file/checkpoint-record.ts`
- `packages/framework/src/file/deep-freeze.ts`
- `packages/framework/src/file/event-log.ts`
- `packages/framework/src/file/freshness-index.ts`
- `packages/framework/src/file/job.ts`
- `packages/framework/src/__tests__/file-boundary-error.test.ts`
- `packages/framework/src/__tests__/file-checkpointer-codec.test.ts`
- `packages/framework/src/__tests__/file-event-record.test.ts`
- `packages/framework/src/__tests__/file-freshness-index.test.ts`
- `packages/framework/src/__tests__/file-job.test.ts`
- `packages/framework/src/__tests__/redis-checkpointer.test.ts`
- `packages/host/src/main.ts`
- `packages/host/src/worker-main.ts`
- `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts`
- `packages/host/src/supervisor/registry/redis-registry-adapter.ts`
- `packages/host/src/sync/sync-loop.ts`
- `packages/http-auth/src/auth.ts`
- `packages/http-auth/src/client.ts`

Support paths are listed under Authority and will be registered at remediation start.

## Validation

Run focused tests after each coherent move, then the complete gates:

```bash
bun test packages/framework/src/__tests__/file-checkpointer-codec.test.ts packages/framework/src/__tests__/redis-checkpointer.test.ts
bun test apps/customer-summary/src/__tests__/observability-composition.test.ts
bun test packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts
bun test packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts
bun test packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts
bun test packages/framework/src/__tests__/file-boundary-error.test.ts packages/framework/src/__tests__/file-event-record.test.ts packages/framework/src/__tests__/file-job.test.ts packages/framework/src/__tests__/file-freshness-index.test.ts
bun test packages/host/src/hitl/__tests__/queue-backend.test.ts
bun test packages/http-auth/src/__tests__/abort-classification.test.ts packages/http-auth/src/__tests__/auth.test.ts packages/http-auth/src/__tests__/client.test.ts
bun run check:docs
bun run typecheck
bun run test
```

After the full green baseline, run the mandatory `distill` apply-mode pass one move at a time, re-running covering tests after each accepted simplification. Then start registered remediation with every support path above; let the orchestration engine install the exact verified index before commit and push.
