# PR Remediation — 2026-08-20 (Round 26)

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/review-20260820T054803Z-25d8c70c`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260820T054803Z-25d8c70c/result.json`
- Result digest: `52c768efa0fbd311ea0c165592472900547135c305833b1befa3d700fb610301`
- Exact frozen review scope: the 390 literal paths in `result.json.scope`; no remediation input was reconstructed outside that result.
- This round uses a suffixed plan because `.claude/plans/2026-08-20-pr-remediation.md` is the immutable prior round's plan.
- Planned support paths outside the frozen scope:
  - `.claude/plans/2026-08-20-pr-remediation-round-26.md`
  - `apps/customer-summary/src/dag/nodes/assemble-response.ts`
  - `apps/customer-summary/src/__tests__/assemble-response.test.ts`
  - `apps/customer-summary/scripts/guardrail-smoke.ts`
  - `apps/customer-summary/scripts/smoke-full.ts`
  - `packages/host/src/__tests__/capability-manager.test.ts`

## Mandatory surviving critical findings

1. **`code-reviewer-1` — hosted summaries emit `placeholder` as `customerId`**
   - Remove constructor-time customer identity from `createSummaryDag` and `createAssembleResponseNode`.
   - Add an explicit `DAG_INPUT → assemble-response` edge and parse `$input.customerId` in the assembly node, making identity request-derived for every response variant.
   - Update all callers and assembly tests; add a hosted-registration execution regression asserting the requested ID is returned.

2. **`code-reviewer-2` — throwing cleanup logger aborts `closeAll`**
   - Separate handle-close outcome collection from diagnostics.
   - Render hostile thrown values with the framework's total renderer and guard `info`/`warn` calls so diagnostics cannot stop reverse-order best-effort cleanup.
   - Add hostile-logger regressions for successful and failed closes.

3. **`silent-failure-hunter-1` — every thrown node failure becomes retriable**
   - Preserve a thrown runtime-recognized `FrameworkError` on the typed channel.
   - Classify unexpected thrown values as non-retriable `node-crash` authoring defects.
   - Use total error renderers for thrown values and malformed `Result.error` payloads; add execution-level tests proving no retry classification and typed-error preservation.

4. **`pr-test-analyzer-1` — MS Graph JSON-parse error can leak the client secret**
   - Sanitize arbitrary token-boundary diagnostics and make the non-JSON error identify only the endpoint host, never parser-controlled bytes.
   - Add a 200/`json()`-rejection regression whose rejection contains the configured secret, plus network-path secret hygiene.

5. **`comment-analyzer-1` — Foundry mapper header falsely claims no logging/determinism**
   - Correct the module header to describe pure mapping plus diagnostic logging for deliberately dropped non-finite telemetry.

6. **`comment-analyzer-2` — Foundry flush comment names stale caller**
   - Correct the adapter contract to identify guarded graceful shutdown in `shutdown.ts`.

7. **`comment-analyzer-3` — Foundry fallback comment falsely guarantees MLflow co-selection**
   - Correct the comment to distinguish an existing MLflow leg from the explicit Foundry-only fallback to MLflow.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-2` — unsafe node error formatting**
   - Accepted because it shares the critical node-run failure boundary. Replace `String`/`JSON.stringify` diagnostics on untrusted values with total framework renderers and pin hostile values.

2. **`silent-failure-hunter-3` — Redis audit sink logger can violate never-throw**
   - Accepted because the claim is sound and the local fix is low risk. Route failure diagnostics through a guarded helper with a guarded stderr floor; apply it to Redis and compound sink contract-violation logging. Add hostile-logger tests.

3. **`pr-test-analyzer-2` — MS Graph capability wiring lacks a behavioral pin**
   - Accepted. Add injectable production/test seams to the builder and assert derived/overridden scope plus timeout propagation into both token-provider and adapter configs without network calls.

4. **`type-design-analyzer-1` — in-memory checkpoint metadata can store invalid `nodeCount`**
   - Accepted using the reviewer's boundary-reparse option rather than a repository-wide brand migration. Re-establish the non-negative safe-integer invariant in `InMemoryCheckpointer.setMeta`, return the existing typed `cache-error`, and add invalid-value regressions.

5. **`comment-analyzer-4` — placeholder comment misstates request identity**
   - Accepted and superseded by the mandatory identity fix: remove the placeholder and rewrite the registration commentary around the explicit DAG-input edge.

6. **`comment-analyzer-5` — remediation-round IDs in durable FS comments**
   - Accepted. Remove process-history labels while retaining the permanent hostile-value rationale.

7. **`code-simplifier-1` — duplicate `DagMachineContext` fixtures**
   - Accepted. Extend the existing context fixture module with a runtime-context factory and use it from `wave-resolution` and `human-resolution`, preserving per-test overrides.

8. **`code-simplifier-2` — duplicate freshness no-op match arms**
   - Accepted. Collapse `none` and `external-call` into one exhaustive handler.

9. **`code-simplifier-3` — nested ternary in `muslArchName`**
   - Accepted. Replace with a readable closed mapping/switch and retain existing behavior/tests.

### Deferred

1. **`silent-failure-hunter-4` — Redis command errors omit driver cause**
   - Deferred because `HostError.operation` is rendered through operational and potentially client-facing paths, while ioredis messages may contain credential-bearing Redis URLs. A complete fix requires an internal-only diagnostic field plus one credential-redaction policy shared by the supervisor and existing Redis adapter; embedding raw causes during this remediation would trade observability for secret leakage.

2. **`architecture-tech-lead-1` — `/summarize` route owns run policy**
   - Deferred as a sound but broad seam redesign. Extracting checkpoint compatibility and run preparation changes the app orchestration interface and needs dedicated decision/property-test work; none of the surviving correctness fixes depends on it.

3. **`architecture-tech-lead-2` — Foundry summary observer duplicates buffering**
   - Deferred as a sound framework interface deepening. Adding a summary-emission hook changes `BufferedObserver`'s public seam and app composition lifecycle; it should be designed and validated independently rather than coupled to comment/error remediation.

### Dismissed

1. **`type-design-analyzer-2` — require `OracleReadSql` at the public capability API**
   - Dismissed because the current capability is intentionally deep: callers supply ordinary SQL while all three methods parse into `OracleReadSql` before the lower execution seam. Requiring the brand publicly would move parser/error handling into every caller without strengthening the actual driver boundary; runtime-forged values must still be parsed there.

## Refuted critical audit

- Count: 0. `result.json.refuted_critical_findings` is empty; no refuted finding will be fixed or omitted from reporting.

## Validation

Run targeted checks after each remediation cluster, then the complete relevant gates:

```bash
bun test apps/customer-summary/src/__tests__/assemble-response.test.ts apps/customer-summary/src/__tests__/host-migration.test.ts apps/customer-summary/src/__tests__/summary-dag.test.ts
bun test packages/framework/src/__tests__/wave-execution-errors.test.ts packages/framework/src/__tests__/redis-checkpointer.test.ts packages/framework/src/__tests__/wave-resolution.test.ts packages/framework/src/__tests__/human-resolution.test.ts packages/framework/src/__tests__/freshness-emission.test.ts
bun test packages/host/src/__tests__/capability-manager.test.ts packages/host/src/__tests__/adapters/ms-graph-token.test.ts packages/host/src/__tests__/adapters/documents-capability.test.ts packages/host/src/__tests__/supervisor/audit/audit-sink.test.ts packages/host/src/__tests__/supervisor/lifecycle/bun-init-process-adapter.test.ts
bun run typecheck
bun run test
bun run check:docs
```

After a green baseline, run `distill` in apply mode over the implementation, one behavior-preserving move at a time, and rerun covering tests after each move.
