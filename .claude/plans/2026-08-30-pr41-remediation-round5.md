# PR #41 remediation — review-and-fix round 5

Date: 2026-08-30

Branch: `feat/f3-budget-capability-surface`

Reviewed revision: `f66728ead794cf5b5b75c9a1938f5585a09f0b85`

Review run: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round5`

Authoritative result: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round5/result.json`

Frozen scope: the 82 paths listed in the authoritative result.

Registered support paths outside that scope:

- `.claude/plans/2026-08-30-pr41-remediation-round5.md` — this disposition and validation record.
- `packages/framework/src/index.ts` — required public barrel export for the `RunScopedLlmComposer` type introduced at the reviewed `CapabilityHandle` seam.

## Binding approach

Apply `rules/architecture.md`, `rules/typescript-patterns.md`, `code-implementer`, and `ts-test-engineer`: pure spend/reservation state stays in the functional core; Redis, provider calls, hooks, and diagnostics remain in the imperative shell; expected failures use `Result`; snapshots and domain state are immutable. Apply `deepen` only where the reviewed metering seam is unsound, and run `distill` in apply mode after a green focused baseline.

## Surviving critical findings — all mandatory

1. **`code-reviewer-1` — unpriced Redis append can fail open after partial failure.**
   - Change `spend-ledger-redis.ts` so every unpriced-model marker is persisted before any numeric increment. A partial append may then conservatively over-report unknown pricing, but can never rehydrate unpriced spend as priced.
   - Update ordering comments and add a regression in `spend-ledger.test.ts` where `SADD` fails, numeric writes never run, and a subsequent read remains unpriced/fail-closed.

2. **`code-reviewer-2` — subtype self-calls bypass metering.**
   - Replace the falsely transparent generic Proxy with a narrow standard `LlmClient` decorator exposing only the two provider operations.
   - Add an explicit adapter-authored run-scoped client composition hook for augmented LLM capabilities. The hook receives the metered standard surface and must construct the augmented facade; subtype-only provider aliases therefore delegate explicitly through the metered methods rather than being target-bound behind the authority.
   - Update capability extraction/factory wiring and tests. Pin an alias method that calls the supplied metered `sendStructured` and prove it invokes the shared authority and budget gate.

3. **`code-reviewer-3` and `silent-failure-hunter-1` — hostile `origin` access escapes the Result fence and unbalances telemetry.**
   - Snapshot `authority`, `broker`, `mintFor`, `origin`, and all origin fields inside the same guarded parse boundary.
   - Convert any accessor failure into a validation `Err`; retain the existing `prepareDagRun` path that emits `run-end(error)`.
   - Add focused hostile-origin getter coverage.

4. **`pr-test-analyzer-1` — missing Redis `SADD` partial-write regression.**
   - Covered by critical fix 1; assert both operation order and hydration behavior.

5. **`comment-analyzer-1` — public overshoot guarantee is overstated.**
   - Qualify `docs/features.md`: learned-size reservations constrain warm bursts; cold or larger concurrent calls can exceed the learned projection until settlement updates it.

## Advisory dispositions

### Accepted

1. **`code-reviewer-4` — inherited built-in getters execute before ownership check.**
   - Check `Object.hasOwn(init, key)` before reading `init[key]`; add an inherited throwing-getter regression.

2. **`silent-failure-hunter-2` — thrown/rejected cache reads escape graceful degradation.**
   - Fence `RedisPort.get` invocation and await; log through the existing failure escalator and return a miss.

3. **`silent-failure-hunter-3` — thrown/rejected cache writes escape best-effort semantics.**
   - Fence `RedisPort.set` invocation and await; log through the existing failure escalator and return `ok(undefined)`.

4. **`silent-failure-hunter-4` — throwing `onBackground` hook rejects a completed DAG.**
   - Construct the guarded background promise once, invoke the hook behind a diagnostic guard, and preserve completed output. Ensure the background promise is observed if the hook throws so no rejection becomes unhandled.

5. **`pr-test-analyzer-2` — Redis construction test does not pin `sAdd`/`sMembers`.**
   - Include both required methods in the construction parser’s derived diagnostics and explicit guard; test each missing primitive.

6. **`pr-test-analyzer-3` — `remaining()` snapshot freshness/immutability is unpinned.**
   - Add parity assertions for fresh, deeply frozen `remaining()` values and mutation isolation.

7. **`type-design-analyzer-1` — `LlmMeter` is structurally forgeable.**
   - Brand `LlmMeter` with a private unique symbol and construct it only through `meterOf`/`emptyMeter`/`accumulate`, matching `ReservationState`.

8. **`comment-analyzer-2` — node-context factory header is stale.**
   - State that shared underlying clients are reused while per-run metering decorators and budget state are allocated.

9. **`comment-analyzer-3` — authoritative feature plan has stale settlement order.**
   - Correct the plan to `record → release → await ledger append`, including the reason admission headroom does not wait for persistence.

10. **`code-simplifier-1` — repeated authority dependency literals.**
    - Add a test-local factory that always allocates a fresh ledger and accepts only varying limits/logger fields.

11. **`code-simplifier-2` — repeated node-context construction boilerplate.**
    - Add a test-local context factory with default run identity, signal, identity, and agent map; use it in the capability/budget cases touched by this remediation without weakening assertions.

12. **`code-simplifier-3` — repeated BullMQ/Redis unsafe test stubs.**
    - Centralize the repeated minimal job and script-Redis fixtures behind typed test builders, preserving all observable assertions.

### Deferred

1. **`architecture-tech-lead-1` — split pure capability graph rules from lifecycle I/O.**
   - Sound deepening, but not a local F3 remediation: it moves the public/import seam for `topoSortHandles`, `connectAll`, `closeAll`, `checkHealth`, and `extractClients` across host boot wiring and a broad capability-manager test suite. Record for a dedicated module-migration change with import-boundary validation rather than mixing it into budget hardening.

### Dismissed

None.

## Refuted critical audit

No critical finding was refuted. All six published critical records survive; two are duplicate reports of the same hostile-origin defect and one is the regression gap for the Redis defect, so implementation has four distinct correction tracks.

## Validation

Focused validation after implementation:

```bash
bun test \
  packages/host/src/__tests__/spend-ledger.test.ts \
  packages/host/src/__tests__/metered-llm.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/run-spend-authority.test.ts \
  packages/host/src/__tests__/llm-meter.test.ts \
  packages/framework/src/__tests__/executor.test.ts \
  packages/framework/src/__tests__/make-node-context-merge.test.ts \
  packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts
bun run typecheck
bun run check:docs
git diff --check
```

Then run the full workspace suite:

```bash
bun run test
```

After a green baseline, run the mandatory `distill` apply pass one move at a time and rerun covering tests after each move. Start registered remediation only after all validation is green; register both support paths listed above. Loom must install the exact verified index before commit and push.
