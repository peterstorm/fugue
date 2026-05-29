# PR Remediation Plan v6

**Date:** 2026-05-29
**Branch:** feat/fugue-host
**Findings:** 1 critical, 1 advisory

## Critical Fixes

### Fix 1: Remove unused imports from host.ts
- **Source:** code-reviewer
- **File:** packages/host/src/host.ts:21,37
- **Issue:** `canServeRequests` and `getRegistry` are imported from `./domain/host-state.js` but never used in the file body. `buildSyncConfig` is imported from `./lifecycle/startup.js` but never used.
- **Fix:** Remove `canServeRequests`, `getRegistry` from the state import, and `buildSyncConfig` from the startup import.

## Advisory Fixes

### Fix 2: Expose CIRCUIT_BREAKER_COOLDOWN_MS as configurable env var
- **Source:** architecture-agent
- **File:** packages/host/src/domain/config.ts, packages/host/src/host.ts
- **Issue:** The circuit breaker cooldown (time before half-open probe) defaults to 30s via the framework constant but cannot be configured by operators. All other circuit breaker parameters (`THRESHOLD`, `WINDOW_MS`) are env-configurable.
- **Fix:** Add `CIRCUIT_BREAKER_COOLDOWN_MS` to HostConfigSchema and thread it into `circuitConfig` in host.ts.

## Validation Commands
```bash
bun run typecheck
bun test packages/framework/src packages/host/src
```
