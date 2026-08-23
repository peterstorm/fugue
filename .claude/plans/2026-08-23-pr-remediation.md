# PR Remediation — 2026-08-23 (round 35)

## Review authority

- Branch: `feat/f6-file-durable-runtime`
- Reviewed HEAD: `52351e3b5f37845bcc9126a730616a9aab01d779`
- Merge base with `origin/main`: `6c316cb53a9b7dfd88f2908b26108979eddbb04a`
- Review run: `.claude/reviews/review-and-fix-runs/review-20260823T084521Z-a9d607ed`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260823T084521Z-a9d607ed/result.json`
- Exact frozen scope: the 453 paths enumerated by `result.json.scope`.
- Planned remediation paths (all inside the frozen scope):
  - `.claude/plans/2026-08-23-pr-remediation.md`
  - `CONTEXT.md`
  - `docs/adr/0060-hitl-suspend-resume-primitive.md`
  - `packages/framework/src/dag-runtime/freshness-check.ts`
  - `packages/framework/src/dag-runtime/run-telemetry.ts`
  - `packages/framework/src/__tests__/freshness-check.test.ts`
  - `packages/framework/src/__tests__/freshness-check-property.test.ts`
  - `packages/framework/src/__tests__/run-telemetry-ordering.test.ts`
  - `packages/host/src/hitl/adapters/run-store.ts`
  - `packages/host/src/hitl/adapters/decision-store.ts`
  - `packages/host/src/hitl/ports.ts`
  - `packages/host/src/hitl/run-store-job.ts`
  - `packages/host/src/hitl/service.ts`
  - `packages/host/src/hitl/types.ts`
  - `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
  - `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- Planned support paths outside the frozen scope: none.

## Surviving critical findings — mandatory

### `code-reviewer-1` — publication uncertainty can acknowledge an undiscoverable run

**Evidence:** when metadata `SET NX` fails before committing and metadata compensation is unavailable, the current adapter returns `publication-uncertain` although only a checkpoint and active-index member remain. `get` cannot reconstruct the run and `listActiveRunIds` excludes checkpoint-only members, so the accepted run can be stranded.

**Fix:** persist a losslessly serialized creation intent containing both metadata and the initial checkpoint in the checkpoint key before metadata publication. On a genuinely ambiguous metadata acknowledgement, retain that confirmed intent. Execution and lifecycle reads parse the intent, reconstruct the complete record, and active-index reconciliation enumerates valid intent-backed members. Ordinary checkpoint writes replace the intent only after the lease-fenced `running` metadata write has established the published metadata. Add a regression for metadata failure-before-commit plus unavailable compensation proving `publication-uncertain` remains fetchable and reconcilable. Update ADR-0060 and `CONTEXT.md` with the durable creation-intent invariant.

### `comment-analyzer-1` — checkpoint failure contract contradicts terminal behavior

**Evidence:** `RunExecutorPort.run` says checkpoint I/O uses the enclosing `Err` channel, while `createRunExecutor` turns post-transition checkpoint persistence failure into an `ok({ kind: "failed" })` terminal safety outcome to prevent replaying side effects.

**Fix:** correct the port contract to distinguish pre-outcome host failures (retryable `Err`) from post-transition checkpoint failures (terminal `failed` outcome).

### `comment-analyzer-2` — in-memory freshness ordering claim is not enforced

**Evidence:** `recordWrite` appends in call order and overwrites `latest`, while `findConflict` assumes the tail is timestamp-latest. Out-of-order writes can therefore hide a newer conflicting write.

**Fix:** keep each resource's bounded entries sorted by `succeededAtMs` with stable arrival ordering for ties, derive `latest` from the sorted tail, and retain only the timestamp-newest bounded entries. Add example and property regressions proving arrival-order independence for distinct timestamps and correct `sinceMs` behavior.

## Advisory dispositions

### Accepted — `pr-test-analyzer-1`: hostile run-start logger regression

The claim is sound and reveals an uncontained secondary failure: the observer catch path calls `fwLogger().error` directly. Guard the diagnostic and add a regression where both observer dispatch and framework logging throw, proving `beginRunTelemetry` still returns its run-end closure.

### Accepted — `type-design-analyzer-1`: persisted phase numeric invariants

Negative/fractional wave, attempt, and delay values are outside the runtime-authored phase domain and can corrupt indexing/backoff behavior. Replace the finiteness-only parser with non-negative-integer parsers (positive integer for 1-based attempts) and add table-driven rejection tests.

### Accepted — `type-design-analyzer-2`: lifecycle transitions are under-modeled

Strengthen the pure lifecycle transition so `queued -> running`, `running -> running|suspended|completed|failed`, `suspended -> running`, and byte-identical terminal idempotence are the only legal transitions. Add exhaustive table/property coverage. This is combined with `architecture-tech-lead-1`.

### Accepted — `comment-analyzer-3`: “cheap” checkpoint getter is misleading

The getter performs serialization and parsing. Rewrite the comment to state the actual property: synchronous, Redis-free, validated detached snapshot access.

### Accepted — `comment-analyzer-4`: active-run enumeration comment omits corrupt metadata

Correct the port comment: valid corrupt-metadata members are surfaced conservatively for inspection, and valid creation-intent-backed members are surfaced for recovery; only unproven raw checkpoint remnants are omitted.

### Accepted — `architecture-tech-lead-1`: lifecycle invariant belongs in the pure core

The finding duplicates `type-design-analyzer-2`. Strengthening `transitionRunStatus` localizes lifecycle protocol knowledge without widening the persistence port; adapter parity tests will prove both stores enforce it.

### Dismissed — `code-simplifier-1`: speculative semantic-convention exports

Repository-wide reference evidence does not support the broad claim: every named semantic-convention constant except `NODE_KIND_TO_SPAN_TYPE` has live framework consumers. One unused map does not justify deleting a published telemetry vocabulary during correctness remediation, and no consumer-impact evidence was supplied.

### Accepted — `code-simplifier-2`: duplicated pending-review wire prefixes

Name each persisted prefix once and reuse it in formatting/parsing so writer and parser cannot drift.

### Accepted — `code-simplifier-3`: duplicated terminal-run predicate

Name the predicate once in `service.ts` and reuse it in worker and reconciliation guards. This is behavior-preserving and improves domain readability.

## Refuted critical audit

None. `result.json.refuted_critical_findings` is empty. The panel upheld all three critical findings; `code-reviewer-1` survived reproduction and blast-radius despite the intent lens noting ADR-0060's conservative uncertainty policy.

## Baseline evidence

Before implementation:

```text
bun test packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/freshness-check-property.test.ts \
  packages/framework/src/__tests__/run-telemetry-ordering.test.ts
# 20 pass, 0 fail

bun test packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
# 96 pass, 0 fail
```

## Validation

Targeted gates:

```bash
bun test packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/freshness-check-property.test.ts \
  packages/framework/src/__tests__/run-telemetry-ordering.test.ts
bun test packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
bun run check:docs
```

Package/full relevant gates:

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun run --cwd packages/framework test
bun run --cwd packages/host test
bun run typecheck
bun run test
bun run check:docs
```

After implementation is green, run the required `distill` apply-mode pass one move at a time and rerun covering tests after each accepted simplification.
