# PR Remediation Plan

**Date:** 2026-05-26
**Branch:** feat/fugue-host
**Findings:** 0 critical, 5 advisory

## Advisory Fixes

### Fix 1: Remove unused `gitSha` import in host.ts
- **Source:** code-reviewer
- **File:** `packages/host/src/host.ts:1`
- **Issue:** `gitSha` is imported from `@fugue/framework` but never called. `sha` passed to `startSyncLoop` comes from `startupResult.value.sha`, not a local `gitSha()` call.
- **Fix:** Remove `gitSha` from the import destructure.

### Fix 2: Thread `clock` through `startSyncLoop` → `executeSyncCycle`
- **Source:** silent-failure-hunter
- **File:** `packages/host/src/sync/sync-loop.ts:258`
- **Issue:** `executeSyncCycle` accepts an optional `clock: Clock = Date.now` for deterministic testing, but `doSync()` inside `startSyncLoop` always calls it without a clock, making the loop's timestamp behavior untestable. `initialSync` correctly threads the clock, but `startSyncLoop` does not.
- **Fix:** Add optional `clock: Clock = Date.now` parameter to `startSyncLoop` (after `initialSha`). Pass it to `executeSyncCycle` in `doSync`. No callers break — parameter is optional with same default.

### Fix 3: Document fugue.yaml TTL gap in dag-factory.ts
- **Source:** silent-failure-hunter
- **File:** `packages/host/src/domain/dag-factory.ts`
- **Issue:** `ResolvedDagConfig` declares optional `cacheTtlMs` and `checkpointTtlMs`. `FugueYamlSchema` (in config.ts) defines these per-DAG overrides, and `createNamespacedCache` accepts a `defaultTtlSec`. But `loadResultToRegisteredDag` never populates them — `FugueYaml` is never loaded alongside `dag.ts` modules. The TTL override path silently has no effect.
- **Fix:** Add a `// TODO(fugue-yaml)` comment in `loadResultToRegisteredDag`'s `config` object documenting the gap. No behavior change — wiring `fugue.yaml` loading is a separate feature.

### Fix 4: Fix indentation of `get:` method in createNamespacedCache
- **Source:** code-reviewer
- **File:** `packages/host/src/adapters/node-context-factory.ts:71`
- **Issue:** The `return {` statement is indented 2 spaces inside the function body, but `get:` (the first property of the returned object) starts at column 0 — missing the 4-space indent.
- **Fix:** Indent `get:` and its body by 2 additional spaces to align with `set:`.

### Fix 5: Improve LLM client TODO in main.ts
- **Source:** architecture-agent
- **File:** `packages/host/src/main.ts`
- **Issue:** `createLlmClient` is a stub that always returns `err({ kind: "llm-unavailable" })`. Config validates that the API key is present, but the real client is never instantiated. `AnthropicLlmClient` and `OpenAILlmClient` are already exported from `@fugue/framework` — the host just needs to instantiate them with the vendor SDK.
- **Fix:** Update the TODO comment to reference the available framework exports and clarify what's needed to complete the wiring.

## Validation Commands
```bash
bun run typecheck
bun test packages/host
```

## Deferred
None.
