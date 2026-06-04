# PR Remediation Plan — v8

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 0 critical, 4 advisory (6 agents). Net actionable: 2 fixes, 2 deferred.

10th review cycle (`main...HEAD`, 110 files / 8700 insertions). Four of six agents
returned **clean** (code-reviewer, silent-failure-hunter, pr-test-analyzer,
architecture-tech-lead). The v7 fixes (`Capability = Exclude<…, ReservedNonCapabilityKey>`,
ADR-0052 past-tense rework, adapter-authoring §2 source-first) are all verified still in
place. The branch is mature; remaining items are hygiene.

## Advisory Fixes (applied)

### Fix 1: `lastModified` ISO-8601 invariant unenforced across adapters
- **Source:** type-design-analyzer
- **Files:** `packages/adapter-ms-graph/src/index.ts:209`, ref `packages/document-source/src/index.ts:101-102`
- **Issue:** `FileMeta.lastModified` promises "ISO 8601 UTC", and the fs adapter honors it
  via `new Date(...).toISOString()`. The ms-graph adapter passed Graph's
  `lastModifiedDateTime` through an unvalidated `z.string()`, so the two adapters could
  emit different string formats for the same conceptual field. A freshness-witness consumer
  comparing `lastModified` across backends could mis-order.
- **Fix:** Tighten the Graph schema to `z.string().datetime()` so a non-ISO value fails
  closed at parse time (returning `Result.Err`) rather than propagating. Makes the type's
  documented promise true at the boundary. Existing fixture (`2026-05-30T12:00:00Z`) and all
  40 ms-graph tests pass unchanged.

### Fix 2 (doc): adapter-authoring.md §7 checklist contradicts §2 source-first
- **Source:** comment-analyzer
- **File:** `docs/adapter-authoring.md:182`
- **Issue:** Checklist item `dist/ builds (tsc --build) and bun test is green` contradicts
  the same doc's §2 ("do **not** add a TS project-`references` block … `tsc` for type
  verification, not resolution") and the real `build: "tsc"` script. `tsc --build` is
  project-references build mode the monorepo deliberately omits.
- **Fix:** Reword to `Types check (bun run typecheck) and bun test is green`.

## Deferred

### `node.ts:388` — `capabilities` bag admits `null` for custom capabilities
- **Source:** type-design-analyzer
- **Reason:** A `null` custom-cap entry is a representable no-op, but it fails closed at run
  start via `validateCapabilities` (treated as missing). Splitting nullability for built-in
  vs custom keys within one mapped type is awkward for marginal value over the existing
  fail-closed guard.

### `FakeHttpRoute` structural overlap with raw body objects
- **Source:** type-design-analyzer
- **Reason:** Test-support-only edge case (a raw body that is itself an object containing a
  `body` key). Same shape of finding as the `FakePgRoute` discriminated-union suggestion
  **rejected in v7** — adding a `kind` discriminant ripples through every fixture + README
  example for negligible blast radius (a mismatch fails the test's own assertion).
- **Recommendation:** Revisit only if a real consumer needs a `{ body: … }`-shaped raw
  payload, which would make the overlap a concrete (not theoretical) ambiguity.

## Validation Commands
```bash
bun run --filter '@fugue/ms-graph' typecheck   # exit 0
bun run --filter '@fugue/ms-graph' test        # 40 pass, 0 fail
```
