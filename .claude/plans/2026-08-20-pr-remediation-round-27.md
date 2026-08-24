# PR Remediation — 2026-08-20 (Round 27)

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-2026-08-20-122951-f6-file-durable-runtime`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-2026-08-20-122951-f6-file-durable-runtime/result.json`
- Result digest: `5c7a664d9f6b280d83aa25775d11f01ce776efeee8556c810a097516d5a485de`
- Exact frozen review scope: the 407 literal paths in `result.json.scope`; no remediation input was reconstructed outside that result.
- This round uses a suffixed plan because `.claude/plans/2026-08-20-pr-remediation.md` and rounds 25–26 are prior remediation records.
- Planned support path outside the frozen scope:
  - `.claude/plans/2026-08-20-pr-remediation-round-27.md`

## Mandatory surviving critical findings

1. **`code-reviewer-1` — wave-level catch erases typed and non-retriable failures**
   - Preserve runtime-recognized `FrameworkError` values unchanged.
   - Classify unexpected thrown values as non-retriable `node-crash` authoring/runtime defects using the total framework renderer.
   - Pin typed-error identity, hostile diagnostics, and non-retriable classification at `executeWave` level.

2. **`code-reviewer-2` — guardrail `failed` cannot cross assemble-response input parsing**
   - Replace the partial guardrail object schema with a Zod discriminated union covering `skipped`, `validated`, and `failed` exactly.
   - Add a regression that parses the failed variant through the node input schema and reaches the degraded response.

3. **`silent-failure-hunter-1` — tenant hydrate commits a partial registry after corruption**
   - Change persisted tenant parsing from `TenantConfig | undefined` to a typed corruption `Result`.
   - Abort hydrate on the first corrupt record with an existing host configuration-load error, preserving the prior in-memory snapshot and without misclassifying corruption as a Redis outage.
   - Rewrite corruption tests to prove no valid sibling is partially committed and every malformed field fails the hydrate boundary.

4. **`comment-analyzer-1` — HTTP client header misclassifies all 4xx**
   - Document `408`/`429` as transient alongside network/5xx and keep other 4xx as non-retriable.

5. **`comment-analyzer-2` — runNodeShared event-sequence header is false**
   - Document checkpoint `node-skipped`, pre-span assembly/validation failures, and the normal span lifecycle accurately.

6. **`code-simplifier-1` — shared losslessness walk hardcodes event-record operation for cycles**
   - Use the parameterized operation label in circular-reference diagnostics.
   - Add checkpoint-serializer coverage proving checkpoint cycles are attributed to `serializeFileCheckpoint`.

## Advisory dispositions

### Accepted

1. **`code-reviewer-3` — sibling error JSON serialization can reject a wave**
   - Accepted because it is a real totality defect adjacent to mandatory finding 1. Use the framework's total error summarizer and add a hostile cyclic sibling regression.

2. **`silent-failure-hunter-4` — checkpointer probes caught errno twice**
   - Accepted because the code already captures the authoritative `ErrorCodeProbe`; using it removes nondeterministic/hostile getter reinspection with a local, low-risk fix and regression.

3. **`pr-test-analyzer-1` — throwing connect-failure logger can skip cleanup**
   - Accepted because diagnostics are secondary and the current logger call can mask the primary error before the failing handle is closed. Guard diagnostics and add a throwing-logger cleanup regression.

4. **`pr-test-analyzer-2` — throwing no-LLM logger violates eval-judge's never-throw seam**
   - Accepted because the public node contract explicitly promises an `EvalJudgeResult` for this path. Guard the diagnostic and pin `skipped-llm-failure` under a hostile logger.

5. **`comment-analyzer-3` — topology header names deleted modules**
   - Accepted as a precise, behavior-neutral correction to current `topology`/`route-emission`/`reroute` ownership.

6. **`comment-analyzer-4` — HTTP client test header repeats the 4xx drift**
   - Accepted with mandatory finding 4 so production and test contracts state the same `408`/`429` exception.

7. **`comment-analyzer-5` — runNodeShared claims wave-execution is its sole caller**
   - Accepted with mandatory finding 5. Clarify that it is the only production caller while tests invoke the seam directly.

8. **`code-simplifier-2` — resume proof repeats checkpoint-path corruption wrapping**
   - Accepted as a behavior-preserving local helper that keeps envelope gates at one abstraction altitude without changing the public interface.

### Deferred

1. **`architecture-tech-lead-1` — node-factory sub-spans bypass runtime timestamps**
   - Deferred because `NodeContext.clock` is explicitly the node-visible business clock and `types/clock.ts` explicitly distinguishes it from runtime observer timestamp injection. Node factories currently receive no always-present runtime timestamp seam. A complete fix requires a deliberate `NodeContext`/runtime interface deepening (and should also address the remaining tool-dispatch ambient timestamp); substituting optional `ctx.clock` here would conflate the two documented clock domains and still retain an ambient fallback.

### Dismissed

1. **`silent-failure-hunter-2` — corrupt worker `get` returns absence**
   - Dismissed because the only caller intentionally performs the same lazy-spawn recovery for absence and corruption; the adapter emits a corruption warning and prunes the record before returning. A distinct caller state would enlarge the interface without changing behavior or observability.

2. **`silent-failure-hunter-3` — reconcile prune failures do not fail reconciliation**
   - Dismissed because the adapter's explicit multi-tenant FR-020 contract requires best-effort pruning so live adopted workers are returned even when cleanup fails. Each failed delete is warned; turning cleanup failure into reconciliation failure would violate the documented availability policy.

## Refuted critical audit

- Count: 0. `result.json.refuted_critical_findings` is empty; there are no refuted findings to fix or omit from the final report.

## Validation

Run focused regressions after each remediation cluster, then all relevant package and repository gates:

```bash
bun test packages/framework/src/__tests__/wave-execution-errors.test.ts packages/framework/src/__tests__/file-checkpointer.test.ts packages/framework/src/__tests__/file-job.test.ts packages/framework/src/__tests__/file-resume-proof.test.ts packages/framework/src/__tests__/eval-judge.test.ts
bun test apps/customer-summary/src/__tests__/assemble-response.test.ts
bun test packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts packages/host/src/__tests__/capability-manager.test.ts
bun test packages/http-auth/src/__tests__/client.test.ts
bun run typecheck
bun run test
bun run check:docs
```

After a green implementation baseline, run `distill` in apply mode over the implementation one move at a time, rerunning covering tests after each move. No interface redesign is planned beyond the mandatory typed persisted-record parse result.
