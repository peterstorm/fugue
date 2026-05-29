# PR Remediation Plan (v5)

**Date:** 2026-05-29
**Branch:** feat/fugue-host
**Findings:** 3 critical, 7 advisory (5 fixed, 5 deferred with rationale)

Review run by: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-agent.
Scope: `packages/framework/src` + `packages/host/src` (source). code-reviewer reported a fully clean pass.

## Critical Fixes

### Fix 1: Remove dead async-result TTL config
- **Source:** type-design-analyzer
- **File:** `packages/host/src/domain/config.ts:72,124`
- **Issue:** `FugueYamlSchema.asyncResultTtlMs` and `HostConfigSchema.ASYNC_RESULT_TTL_MS` are validated but never consumed — there is no async-result feature, FR-041 is absent from `requirements.md`, and `applyFugueYaml` deliberately drops the per-DAG value (silent parse-don't-validate violation). The inline comment ("intentionally not mergeable") contradicts the FR-041 docstring.
- **Decision:** User chose **remove the dead config** (not wire / not keep as placeholder).
- **Fix:** Delete both schema fields, fix the `applyFugueYaml` comment, update `config.test.ts` assertions. Leave the unrelated `async-result-expired` HostError variant (separate, harmless, exhaustiveness-tested).

### Fix 2: Test auth fail-closed 503 branch
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/http/middleware/auth.ts:110-125`
- **Issue:** The security-relevant fail-closed branches (token-store `err` → 503; `hashToken`/resolve throw → 503 + server log) had no test. Distinguishes "fail closed" from accidentally returning 401/allowing through.
- **Fix:** Add tests with a token-store fake returning `err(redis-unavailable)` and one that throws; assert 503, `next()` not called, and (throw case) logger.error invoked.

### Fix 3: Test run-dag createContext-throws path
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/http/handlers/run-dag.ts:195-199`
- **Issue:** The timer-leak-prevention branch (clear timeout + markFailure + rethrow when `createContext` throws) was never exercised.
- **Fix:** Add a test injecting a throwing `createContext`: assert 500 + concurrency token released; plus a per-DAG `failureThreshold:1` variant proving `markFailure` runs (breaker opens → 503).

## Advisory Fixes

### Fix 4: Thread warningSink into manifest handler
- **Source:** silent-failure-hunter
- **File:** `packages/host/src/http/handlers/manifest.ts:40`
- **Issue:** `buildManifest` omitted the `warningSink` the CLI `describe` path supplies, so a Zod schema `zodToJsonSchema` can't render degrades to `null` in the HTTP response with no server-side log.
- **Fix:** `buildManifest(registered, warningSink?)`; convert `manifestHandler` → `createManifestHandler(deps)` (matches the codebase's handler-factory pattern) routing warnings to `deps.logger.warn`. Update router + manifest test.

### Fix 5: Test per-DAG concurrency 429 (scope=dag)
- **Source:** pr-test-analyzer
- **File:** `packages/host/src/http/handlers/run-dag.ts:153-155`
- **Fix:** Pre-occupy a per-DAG limit of 1 with global headroom; assert 429 `dag-concurrency-exceeded` + `details.scope === "dag"` + `Retry-After`.

### Fix 6: Test modelOverride (Azure single-deployment routing)
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/llm/openai-client.ts:190…`
- **Fix:** Using the existing fetch-stub, assert `body.model === modelOverride` when set, and falls back to `req.model` when unset.

### Fix 7: ResolvedDagRegistration.config carry-through
- **Source:** type-design-analyzer
- **File:** `packages/host/src/domain/dag-registration.ts:81-84,126-138`
- **Issue:** `resolveDefaults` claims to resolve config but drops `cacheTtlMs`/`checkpointTtlMs`/`circuitBreaker`; `dag-factory` works around it by reading `registration.config` directly. A future caller trusting `resolved.config` silently loses three fields.
- **Fix:** Carry the three optional fields through `ResolvedDagRegistration.config` (host-level TTL defaulting still happens in `dag-factory`), and document that the resolved type preserves rather than host-defaults them.

### Fix 8: Break ports↔domain type-import cycle
- **Source:** architecture-agent
- **File:** `packages/host/src/ports.ts:154-171` + `packages/host/src/domain/circuit-guard.ts:22-25`
- **Issue:** `CircuitPort`/`CircuitConfig` are domain concepts living in `ports.ts`; `ports.ts` imports `CircuitState` from domain while `circuit-guard` imports the port types back from ports — a domain→ports→domain cycle inverting the documented layering.
- **Fix:** Move both type definitions into `domain/circuit-guard.ts` (their only consumer beyond `run-dag`, which already imports from circuit-guard). Remove the now-unused `CircuitState` import from `ports.ts`. Type-only; no runtime change.

## Deferred (with rationale)

### CircuitPermit staleness vs force-reset (FR-092)
- **Source:** architecture-agent (ADVISORY)
- **Reason:** Narrow, self-healing (one stray failure count, never an open circuit). A proper fix needs a generation/epoch token threaded through `CircuitState` + `forceReset` + permit + `markFailure`, with property-test updates — a design change beyond a remediation pass.
- **Recommendation:** Track as a follow-up; add an epoch compared at mark time.

### circuitBreakers Map unbounded-growth (defensive)
- **Reason:** Safe today — `checkCircuit` is only reached after `lookupDag` succeeds, and sync prunes unknown ids. The risk is a future handler calling `checkCircuit` before id validation.
- **Recommendation:** Add a note on `CircuitPort`; optionally have `checkCircuit` only `set` on state change.

### RouterDeps god-object
- **Reason:** Style/wiring-surface preference. Handler factories already declare tight dep interfaces; testability is intact.

### Registry deep-freeze
- **Reason:** Documented, intentional performance tradeoff (outer freeze + ReadonlyMap cast). Not a defect.

### git-sync runBunInstall / hasLockfileChanged / timeout integration tests
- **Reason:** Integration-only (real `Bun.spawn`); lower value than the request-path branches fixed above.

## Validation Commands
```bash
bun run --cwd packages/framework typecheck && bun run --cwd packages/host typecheck
bun test packages/framework packages/host
```
