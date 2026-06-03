# PR Remediation Plan (v2)

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 0 critical, 7 actionable advisory (6-agent verification cohort). Prior pass (`2026-06-04-pr-remediation.md`) confirmed intact. User elected full ("all 7") sweep.

## Fixes

### Fix 1: Wire built-in `http` capability into the production host (architecture)
- **File:** packages/host/src/main.ts:188
- **Issue:** `sharedInfra.capabilities: []`; `createHttpCapability` is exported but wired nowhere, so `ctx.http` is always `null` in deployment and a `requires: ["http"]` DAG fails boot-time validation — contradicting ADR-0051 ("ships with the framework") and the `capability-handle.ts:71` JSDoc.
- **Fix:** Construct `createHttpCapability()` into `sharedInfra.capabilities`. Add a host integration test asserting a `requires: ["http"]` DAG boots green.

### Fix 2: `missing-capability` — non-empty `missing` tuple (type-design)
- **File:** packages/framework/src/types/errors.ts:103-106
- **Issue:** `missing: readonly Pair[]` permits an empty array alongside populated `nodeId`/`capability` scalars — a representable-but-never-constructed illegal state.
- **Fix:** Type `missing` as a non-empty tuple `readonly [MissingCapability, ...MissingCapability[]]`; construct via destructuring in both factories so the scalars are provably `missing[0]`.

### Fix 3: Assert HTTP request body transmission + Content-Type branch (pr-test-analyzer)
- **File:** packages/framework/src/__tests__/http-capability.test.ts
- **Issue:** No test verifies `executeRequest` serializes/sends the body for any verb; Content-Type defaulting untested.
- **Fix:** Add an echo-body server route; assert POST + PUT round-trip the JSON body and the defaulted `Content-Type: application/json`.

### Fix 4: fs `omits mimeType` vacuous-assertion guard (pr-test-analyzer)
- **File:** packages/adapter-fs/src/__tests__/fs-adapter.test.ts:117
- **Fix:** Add `expect(isOk(m)).toBe(true)` before the `if (m.ok)` block.

### Fix 5: fs 0-byte file metadata assertion (pr-test-analyzer)
- **File:** packages/adapter-fs/src/__tests__/fs-adapter.test.ts
- **Fix:** Feed a 0-byte file; assert `sizeBytes === 0` (distinguishes empty-file from `null` unreported).

### Fix 6: xlsx README doc/code drift (comment-analyzer)
- **File:** packages/xlsx/README.md:21,31
- **Fix:** `rows: T[]` → `rows: readonly T[]` to match the source signature.

### Fix 7: make-node-context directional comment (comment-analyzer)
- **File:** packages/framework/src/shared/make-node-context.ts:29
- **Fix:** "handled explicitly above" → "in the `base` object below".

## Deferred (no change)
- Both silent-failure advisories ("no change recommended" — intentional SAS-URL diagnostics, documented cache `err` branch).
- `FileRef` raw-string validation (deferred branding, out of scope).
- `TypedNodeContext`/`extractClients` trust boundary (single documented cast).
- `withTracedCapability` `this`-binding (documented; closure clients unaffected).
- pg real-`Pool` lifecycle (Testcontainers follow-up, test header flags it).

## Validation
```bash
bun run typecheck
bun test
```
