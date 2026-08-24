# Adjudicated PR Remediation — 2026-08-20

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/20260820T173931Z-c3ff0f23-standalone-review`
- Canonical result: `.claude/reviews/review-and-fix-runs/20260820T173931Z-c3ff0f23-standalone-review/result.json`
- Result digest: `61414cd07e6d36434159b0389d430b7b1d3ee7e768e99ce550c1bfd5375bb939`
- Exact frozen scope: the 412 literal paths in `result.json.scope`; remediation will touch only those paths plus regression/support paths registered at remediation start.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — invalid Redis token grants are trusted**
   - File: `packages/host/src/adapters/token-store.ts:168`
   - Fix: add one pure `TokenGrant` parser and use it for both token values and reverse-index records. Require a non-empty team and label plus a finite timestamp, then construct the canonical team value. Corrupt records return `redis-unavailable`; authorization never consumes unparsed Redis bytes.
   - Regression: seed parseable malformed token JSON and prove `resolve` fails closed.

2. **`code-reviewer-2` — revocation can report success without deleting the bearer**
   - File: `packages/host/src/adapters/token-store.ts:285`
   - Fix: parse the complete reverse-index record with the same parser before any `SREM`/`DEL`; require its grant team to match the requested team. Corruption leaves every key untouched and returns a typed failure.
   - Regression: seed `{}` and mismatched records, then prove revocation fails and the original token remains resolvable.

3. **`silent-failure-hunter-1` — checkpoint loss is converted to DAG success**
   - File: `packages/host/src/adapters/node-context-factory.ts:184`
   - Fix: make checkpoint serialization and Redis write failures reject the `CheckpointWriter.write` promise after best-effort diagnostics. Treat `JSON.stringify(...) === undefined` as non-serializable. This restores the framework contract that `runDag` maps writer rejection to `checkpoint-write-failed`.
   - Regression: prove cyclic, `undefined`, and Redis-failed writes reject; successful writes and TTL behavior remain unchanged.

4. **`comment-analyzer-1` — false NFR-003 satisfaction claim**
   - File: `packages/host/src/sync/sync-loop.ts:20`
   - Fix: remove the `@satisfies NFR-003` assertion and replace it with a truthful limitation note: operation-level timeouts exist, but no cycle-level `poll interval + 5s` deadline is enforced.

## Advisory dispositions

1. **`code-reviewer-3` — accepted.** Token-store logging is secondary to the `Result` contract. Route all token-store warn/error calls through non-throwing helpers and add throwing-logger regressions so diagnostics cannot replace a typed failure.

2. **`code-reviewer-4` — accepted.** Timeout, cancellation, and repeated-401 diagnostics currently use `fullUrl`/raw `path`. Replace them with `RequestTarget.label` and add query-secret regressions for all three branches.

3. **`silent-failure-hunter-2` — accepted.** Prompt loading currently logs unreadable directories/files and returns a partial map. Return `Result<ReadonlyMap<...>, HostError>` from the internal prompt-load boundary; only `ENOENT` means absence, while any discovered unreadable prompt fails that DAG load with the real deployment error. Preserve per-DAG isolation in `loadAll`.

4. **`silent-failure-hunter-3` — accepted.** `onNoChange` without a registry is a state-machine invariant violation. Log it explicitly and retain the existing registry/state behavior for valid no-change callbacks. The HostState ADT makes a `syncing` state without a registry unrepresentable, so no valid `syncFailed` transition exists from the only no-registry phases (`booting`/`stopped`); the regression pins loud surfacing rather than fabricating state.

5. **`pr-test-analyzer-3` — dismissed as stale.** `packages/host/src/__tests__/metered-llm.test.ts` already covers pre-call budget refusal, partial usage on failed calls, settled-cumulative reporting, concurrent reservations/overshoot bounds, and reservation release after throws; `packages/host/src/__tests__/llm-meter.test.ts` additionally property-tests budget and reservation invariants. No missing behavior remains to add.

6. **`type-design-analyzer-1` — accepted.** Change `criteriaScores` to `Readonly<Record<string, number>>`, preventing mutation through the public result type without changing runtime behavior.

7. **`comment-analyzer-2` — accepted.** Remove the stale `(round-24 tda-4)` remediation-history tag while retaining the durable shared-implementation rationale.

8. **`code-simplifier-1` — accepted.** Extract one local Zod JSON-record transformer for absent/blank handling, `JSON.parse`, shape errors, and `z.NEVER`; keep scope-name validation at the `AGENT_CLIENT_SCOPES` call site. Existing config tests pin each field's diagnostics and parsed shape.

9. **`code-simplifier-2` — accepted.** Centralize the repeated 503 host-serving policy in the HTTP response module and reuse it from the DAG handlers and custom-route fallback. The helper owns the stable status/error/message/details contract rather than merely forwarding arbitrary parameters.

10. **`code-simplifier-3` — accepted.** Extract a pure common review-card body builder in the bot card module; bot and webhook transports append only their transport-specific controls. Existing card/notifier tests will pin both envelopes.

11. **`code-simplifier-4` — deferred.** The 1,100-line worker-lifecycle suite deliberately exposes scenario-local wiring variations, and the suggested fixture-builder refactor changes a broad test harness unrelated to any surviving defect. It has no production/correctness impact and should be handled as a dedicated distill pass with one scenario at a time, not mixed into security/durability remediation.

## Refuted critical audit — retained, never fixed

1. **`pr-test-analyzer-1` — Keycloak broker authorization-before-egress tests allegedly absent**
   - Reproduction panel: `packages/host/src/adapters/__tests__/keycloak-broker.test.ts` exercises an unassigned scope and proves both Keycloak and WIF egress counters remain zero while returning `policy-refusal`.
   - Intent panel: the same behavioral test directly proves the fail-closed ordering.
   - Security panel: unknown/unassigned scope produces zero endpoint and WIF egress.
   - Disposition: refuted by all three lenses; no remediation.

2. **`pr-test-analyzer-2` — live Keycloak endpoint tests allegedly absent**
   - Reproduction panel: `packages/host/src/adapters/__tests__/keycloak-token-endpoint-http.test.ts` covers client-credentials and exchange-v2 request bodies, credential-miss zero egress, HTTP denial, success, and transport rejection.
   - Intent panel: the live endpoint contract is behaviorally exercised across mint and exchange paths.
   - Security panel: subject proof, credential gating, denial mapping, and transport failures are covered.
   - Disposition: refuted by all three lenses; no remediation.

## Planned files

Production/review-scope paths:

- `.claude/plans/2026-08-20-pr-remediation.md`
- `packages/host/src/adapters/token-store.ts`
- `packages/host/src/adapters/node-context-factory.ts`
- `packages/host/src/sync/sync-loop.ts`
- `packages/http-auth/src/client.ts`
- `packages/host/src/adapters/module-loader.ts`
- `packages/host/src/sync/sync-callbacks.ts`
- `packages/framework/src/types/eval-judge.ts`
- `packages/framework/src/file/job.ts`
- `packages/host/src/domain/config.ts`
- `packages/host/src/http/response.ts`
- `packages/host/src/http/handlers/list-dags.ts`
- `packages/host/src/http/handlers/run-dag.ts`
- `packages/host/src/http/handlers/manifest.ts`
- `packages/host/src/http/router.ts`
- `packages/host/src/hitl/adapters/bot/card.ts`
- `packages/host/src/hitl/adapters/webhook-notifier.ts`

Regression/support paths (register if outside `result.json.scope`):

- `packages/host/src/__tests__/token-store.test.ts`
- `packages/host/src/__tests__/node-context-factory.test.ts`
- `packages/http-auth/src/__tests__/client.test.ts`
- `packages/host/src/__tests__/module-loader.test.ts`
- `packages/host/src/__tests__/sync-callbacks.test.ts`
- `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts`
- `packages/host/src/hitl/adapters/__tests__/webhook-notifier.test.ts`

## Validation

1. Focused regressions:
   - `bun test packages/host/src/__tests__/token-store.test.ts`
   - `bun test packages/host/src/__tests__/node-context-factory.test.ts`
   - `bun test packages/http-auth/src/__tests__/client.test.ts`
   - `bun test packages/host/src/__tests__/module-loader.test.ts`
   - `bun test packages/host/src/__tests__/sync-callbacks.test.ts`
   - `bun test packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts packages/host/src/hitl/adapters/__tests__/webhook-notifier.test.ts`
2. Package type gates:
   - `bun run --filter @fuguejs/framework typecheck`
   - `bun run --filter @fuguejs/http-auth typecheck`
   - `bun run --filter @fuguejs/host typecheck`
3. Full relevant tests:
   - `bun run --filter @fuguejs/framework test`
   - `bun run --filter @fuguejs/http-auth test`
   - `bun run --filter @fuguejs/host test`
4. Repository gates:
   - `bun run typecheck`
   - `bun run test`
