# PR Remediation — 2026-08-20

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260820T081916-1787213956439258441`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260820T081916-1787213956439258441/result.json`
- Canonical result digest: `6299f2dbecb11a53ee0a4fd147b456b8e87f517c519adf13eb0c30d8f2036209`
- Exact frozen scope: the literal paths in `result.json.scope`; the canonical result is the sole source of findings, adjudication, and scope.
- This plan supersedes the prior contents of this same-day plan path because the current standalone run reviewed that prior remediation state.
- Required support paths outside the frozen scope:
  - `packages/framework/src/dag-runtime/eval-judges.ts`
  - `packages/framework/src/dag-runtime/freshness-check.ts`
  - `packages/framework/src/nodes/index.ts`
  - `packages/framework/src/types/eval-judge.ts`
  - `packages/host/src/http/handlers/dag-access.ts`

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — evaluator outages pass quality gates**
   - Make `skipped-llm-failure` fail closed in `judgePassed`; only a real `passed` outcome satisfies the gate.
   - Rename the lying `failOpenResult` helper to `llmFailureResult`, update exports and comments, and retain the explicit unavailable outcome rather than conflating provider/schema failure with an orchestrator crash.
   - Keep run output behavior unchanged while ensuring root/judge spans and background `judgesPassed` report the unavailable evaluator as failed.
   - Update unit/integration regressions for no client, returned LLM error, thrown LLM error, and invalid structured output.

2. **`pr-test-analyzer-1` — URL-form-encoded credentials can leak from token errors**
   - Treat caught network error text as untrusted at the client-secret boundary and discard it instead of attempting incomplete representation-by-representation redaction.
   - Return only the trusted endpoint-host diagnostic, matching the module contract and existing response-parser handling.
   - Add a regression whose thrown error echoes the exact `application/x-www-form-urlencoded` body containing reserved-character client ID and secret; assert neither raw nor encoded credentials escape.

3. **`type-design-analyzer-1` — `Checkpointer.saveNode` permits mismatched identity**
   - Deepen the port to `saveNode(runId, state, opts?)`; `state.nodeId` becomes the one node identity used for canonical/composite addressing and persistence.
   - Update in-memory, Redis, and file adapters, all callers, tests, `CONTEXT.md`, and ADR-0075. The file boundary parser will return the parsed branded node ID with canonical options so unchecked bytes cannot escape validation.
   - Remove mismatch-only branches/tests that become impossible; retain hostile `state.nodeId`, options, serialization, path-safety, and typed-error coverage.

4. **`comment-analyzer-1` — `validateRedis` claims the helper exits**
   - Correct the helper documentation to state that it logs and returns the failed `Result`; `executeStartup`/the outer binary own refusal and process exit.
   - Preserve fail-closed startup behavior and existing tests.

5. **`comment-analyzer-2` — sync-cycle step list is stale**
   - Reorder the local numbered steps to match the pinned remote-mode behavior: pull, read SHA, compare, install if needed, load, freeze registry.
   - Preserve execution ordering and tests.

6. **`comment-analyzer-3` — configured Git adapter timeout excludes install**
   - Forward `createBunGitAdapter(timeoutMs)` into `runBunInstall` so the documented one-timeout interface and availability bound apply to every adapter operation.
   - Extend the stalled-install regression to invoke `adapter.install`, proving the configured adapter timeout is honored.

## Advisory dispositions

1. **`silent-failure-hunter-2` — dismissed.** The coherent untraced fallback is explicit observability-spec behavior, isolated Foundry construction already preserves MLflow where possible, the outer failure is logged, and dedicated tests pin degraded startup. Changing it to fail startup would contradict the reviewed specification rather than remediate a defect.
2. **`type-design-analyzer-2` — accepted.** Remove `FreshnessConflict.resource`; callers derive the resource from `conditionedOnWitness.resource`, shrinking the state space without loss. Update constructors/tests and comments.
3. **`comment-analyzer-5` — accepted.** Correct the filesystem security note: absolute paths are accepted only when lexical confinement keeps them under `rootDir`; escaping absolute paths remain rejected.
4. **`architecture-tech-lead-1` — deferred.** Splitting `createHost` into subsystem composers is architecturally sound but is a broad shell redesign with large fixture and shutdown-order risk, no demonstrated correctness defect, and no locality-preserving complete fix inside this remediation.
5. **`code-simplifier-1` — accepted.** Replace the throwaway `matchedWords` allocation with `words.some(...)`, preserving the single-match/stem rule and existing behavioral tests.
6. **`code-simplifier-2` — accepted.** Extract one guarded `expectedDagFingerprint` snapshot helper in the checkpoint core and use it from in-memory and Redis adapters; keep the file adapter's stricter complete-options parser.
7. **`code-simplifier-3` — accepted.** Add one handler-local DAG access guard shared by manifest and run handlers, preserving exact 401/403 payloads and existing endpoint tests.

## Refuted critical audit — retain, never fix

### `comment-analyzer-4` — path-resolving MS Graph header allegedly overclaims no throws

- **Disposition:** refuted; no remediation.
- **Intent evidence:** “Nothing throws” is scoped to path-resolution failures, whose document operations return `Result`; lifecycle `connect` is deliberately delegated and `CapabilityHandle` uses a thrown connect failure to abort boot.
- **Security evidence:** the path-resolution operations retain typed errors, while delegated `connect` fails startup closed on missing credentials rather than exposing an insecure active adapter.
- **Reproduction lens:** uncertain only because it did not establish the imported implementation’s throw behavior; the two evidence-bearing lenses met the panel threshold for refutation.

## Planned touched paths

- `.claude/plans/2026-08-20-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md`
- `packages/framework/src/types/eval-judge.ts`
- `packages/framework/src/nodes/eval-judge.ts`
- `packages/framework/src/nodes/index.ts` (support path)
- `packages/framework/src/dag-runtime/eval-judges.ts`
- `packages/framework/src/__tests__/eval-judge.test.ts`
- `packages/framework/src/__tests__/executor-eval-judge.test.ts`
- `packages/host/src/adapters/ms-graph-token.ts`
- `packages/host/src/__tests__/adapters/ms-graph-token.test.ts`
- `packages/framework/src/checkpoint/checkpointer.ts`
- `packages/framework/src/checkpoint/redis-checkpointer.ts`
- `packages/framework/src/file/checkpointer.ts`
- `packages/framework/src/file/checkpointer-codec.ts`
- Checkpointer callers and contract tests returned by `rg '\.saveNode\('` within the frozen scope
- `packages/host/src/lifecycle/startup.ts`
- `packages/host/src/sync/sync-loop.ts`
- `packages/host/src/adapters/git-sync.ts`
- `packages/host/src/__tests__/git-sync.test.ts`
- `packages/framework/src/types/freshness.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/__tests__/freshness-check-property.test.ts`
- `packages/adapter-fs/src/index.ts`
- `apps/customer-summary/src/validation/grounding.ts`
- `packages/host/src/http/handlers/dag-access.ts` (support path)
- `packages/host/src/http/handlers/manifest.ts`
- `packages/host/src/http/handlers/run-dag.ts`

## Validation

Focused baseline before remediation: 491 passed, 28 skipped, 0 failed across the directly affected framework, host, app, and filesystem suites.

Run focused gates after each coherent move, then full repository gates:

```bash
bun test packages/framework/src/__tests__/eval-judge.test.ts packages/framework/src/__tests__/executor-eval-judge.test.ts packages/framework/src/__tests__/pass-3-remediation.test.ts
bun test packages/host/src/__tests__/adapters/ms-graph-token.test.ts
bun test packages/framework/src/__tests__/redis-checkpointer.test.ts packages/framework/src/__tests__/redis-checkpointer-failure.test.ts packages/framework/src/__tests__/file-checkpointer.test.ts packages/framework/src/__tests__/composite-node-key.test.ts packages/framework/src/__tests__/boundary-imports.test.ts
bun test packages/framework/src/__tests__/freshness-check.test.ts packages/framework/src/__tests__/freshness-check-property.test.ts
bun test packages/host/src/__tests__/lifecycle/startup.test.ts packages/host/src/__tests__/sync/sync-loop.test.ts packages/host/src/__tests__/git-sync.test.ts packages/host/src/__tests__/handlers/manifest.test.ts packages/host/src/__tests__/handlers/run-dag.test.ts
bun test apps/customer-summary/src/__tests__/grounding.test.ts packages/adapter-fs/src/__tests__/fs-adapter.test.ts
bun run check:docs
bun run typecheck
bun run test
```

After the implementation is green, run the mandatory `distill` apply-mode pass one move at a time with covering tests. Then start registered remediation with all five support paths declared; the orchestration engine owns path audit, temporary-index staging, verification, and atomic index installation.
