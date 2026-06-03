# PR Remediation Plan (v5)

**Date:** 2026-06-03
**Branch:** feat/extensible-capabilities
**Findings:** 1 critical, 14 advisory (deduplicated from 6 review agents) — 10 fixed, 4 accepted as intentional.

Diff: 95 files, 7268 insertions. This is the fifth review cycle; v3/v4 already
remediated boot lifecycle leaks, capability typing, trust-boundary docs, the
HTTP capability error model, and ADR-0051 drift. v5 findings below are NEW or
remaining.

## Critical Fixes

### Fix 1: ADR-0052 "Remaining" section lists already-shipped work
- **Source:** comment-analyzer
- **File:** docs/adr/0052-document-source-capability.md:220-227
- **Issue:** "Remaining (gated on decisions not yet available)" lists `parseWorkbook` + the `xlsx`/`exceljs` dependency choice as unbuilt/undecided. `@fugue/xlsx` shipped in commit `4de99f8`: `parseWorkbook` exists, uses `exceljs`, fixture- and e2e-tested. The ADR tells a reader a delivered, tested feature is unbuilt.
- **Fix:** Move `parseWorkbook` + the `exceljs` choice into "Delivered"; keep only MSAL token wiring and the SharePoint-vs-OneDrive confirmation as genuinely remaining.

## Advisory Fixes (will fix)

### Fix 2: Connected capability handles leak on post-connect boot-failure paths
- **Source:** code-reviewer, silent-failure-hunter (related)
- **File:** packages/host/src/host.ts:136, :191
- **Issue:** After `connectAll` succeeds, two later boot-failure paths return an error without closing the connected handles: the `bootComplete` failure (`:136`) and the HTTP-server bind failure (`:191`). The connect-failure path at `:128` was deliberately written to close the connected prefix; these two paths regress that guarantee. Bounded in production by `main.ts` `process.exit(1)`, but leaks on in-process repeated `createHost` (tests, embedding, supervised retry).
- **Fix:** In both error branches, `await closeAll(sortedHandles, logger)` before returning. Order: capabilities close before `onShutdown` (mirrors the happy-path shutdown).

### Fix 3: xlsx duplicate header keys silently overwrite a column
- **Source:** silent-failure-hunter
- **File:** packages/xlsx/src/index.ts:119-123, 135
- **Issue:** Headers are collected into `headers[c]` and rows keyed by `obj[key] = val`. Two columns with the same normalized header text → the later column silently overwrites the earlier; a whole column of data vanishes with no error (same class as the already-fixed coerced-to-null silent loss).
- **Fix:** Detect a duplicate non-empty header during header construction and return `node-crash` naming the duplicated header. Blank headers stay skip-only (multiple blank columns are legitimately ignored).

### Fix 4: makeNodeContext custom-capability spread can shadow reserved fields
- **Source:** architecture-tech-lead, pr-test-analyzer (related)
- **File:** packages/framework/src/shared/make-node-context.ts:52-59
- **Issue:** `customEntries` is filtered against `BUILTIN_CAPABILITY_KEYS` only — not the always-present reserved fields (`logger`, `tracer`, `observer`, `runId`, `dagId`, `checkpointWriter`, `signal`, `contentFilter`). `Capability = keyof CapabilityRegistry` is open to augmentation, so an adapter registering a capability named `tracer`/`logger`/`observer` would clobber framework-guaranteed infrastructure via `Object.assign`. Low likelihood, high blast radius.
- **Fix:** Add a `RESERVED_CONTEXT_KEYS` set (built-in capability keys ∪ always-present field names) and filter `customEntries` against it.

### Fix 5: Redundant `dep as string` cast in topoSortHandles
- **Source:** type-design-analyzer
- **File:** packages/host/src/domain/capability-manager.ts:108
- **Issue:** `dep: Capability` is already `& string`; the cast is dead noise.
- **Fix:** `visit(dep)`.

### Fix 6: Misleading "no cast needed" comment in node-context-factory
- **Source:** architecture-tech-lead
- **File:** packages/host/src/adapters/node-context-factory.ts:248-251
- **Issue:** "so no cast is needed here" reads as if no unsafe correlation happens; the cast was centralized inside `extractClients`, not eliminated. Could mislead a maintainer into adding a second correlation point — exactly what `extractClients` warns against.
- **Fix:** Reword to point at the single `extractClients` trust boundary.

### Fix 7: FileMeta.sizeBytes uses `0` sentinel for "unknown"
- **Source:** type-design-analyzer
- **File:** packages/document-source/src/index.ts:99-100; packages/adapter-ms-graph/src/index.ts:306
- **Issue:** `sizeBytes: number` with doc "0 if unknown" conflates an empty file with absent size metadata — an invariant the type doesn't carry.
- **Fix:** `sizeBytes: number | null`; ms-graph `d.size ?? null`; fs keeps `s.size` (always known). Update the doc comment.

### Fix 8: ADR-0052 FileRef example omits the shipped `localPath` variant
- **Source:** comment-analyzer
- **File:** docs/adr/0052-document-source-capability.md:85-91
- **Issue:** Example shows 3 variants + a commented future one but omits `localPath`, contradicting the code and the ADR's own line 211 ("four variants incl. `localPath`").
- **Fix:** Add the `localPath` variant to the example.

### Fix 9: ms-graph README lists parseWorkbook as "pending"
- **Source:** comment-analyzer
- **File:** packages/adapter-ms-graph/README.md:95-96
- **Issue:** Groups `parseWorkbook` under "Out of scope (by design / pending)"; the "pending" framing is stale now that `@fugue/xlsx` ships it.
- **Fix:** Reword to "lives in `@fugue/xlsx`, not this adapter (by design)".

## Test Additions

- **T1** xlsx: `headerRow` option (custom header row) exercised — packages/xlsx/src/__tests__/xlsx.test.ts
- **T2** xlsx: numeric `sheet` index branch exercised
- **T3** xlsx: duplicate-header → `node-crash` (Fix 3 behavior)
- **T4** make-node-context: reserved-field shadowing prevented (Fix 4 behavior) + bag-sourced built-ins (`cache`/`llm`) reach context + custom-`null`-in-bag filtered → downstream `missing-capability`
- **T5** ms-graph: `graphGet` network-exception → transient; `arrayBuffer()`/`json()` body-read failure paths
- **T6** capability-tracing: extractor-failure on the async-reject path; documented `this`-rebinding limitation for class-based clients
- **T7** host: post-connect boot-failure closes connected handles (Fix 2); shutdown close-failure warning branch

## Accepted as intentional (no change)

- **errors.ts `httpStatus?: number` on `transient`** — deliberate cross-adapter reuse (pg/ms-graph map HTTP-ish statuses through it). Optional + documented. Not a leak; a pragmatic shared field.
- **`createFakeHttpCapability` route type `FakeHttpRoute | unknown`** — TS cannot express "this shape XOR anything-but-this-shape"; the union-with-unknown is inherent. Test-only helper, structural `"body" in route` detection documented. Changing to a discriminant would break the ergonomic, already-used call sites for no production gain.
- **`HttpBodyRequestOpts` non-discriminated from `HttpRequestOpts`** — the `executeRequest` `contentType` recovery cast is safe (body-bearing methods always pass the wider opts) and low-value to restructure.
- **xlsx formula/error cell → `null` (normalizeCell line 75)** — deliberate: the Zod row schema is the gate. Non-nullable columns reject `#REF!` loudly; nullable columns opt into treating an error cell as empty. Documented in JSDoc.

## Deferred (pre-existing, out of scope)

- **`run-dag handler > honors a per-DAG circuitBreaker.failureThreshold`** (packages/host/src/__tests__/handlers/run-dag.test.ts) — order/timing-dependent test-isolation flake: request 2 gets `503` instead of `500` because the per-DAG circuit breaker opens early under load. **Reproduces on the clean tree (stashed) and is unrelated to this PR** — none of the 6 review agents flagged it, and this branch touches no circuit-breaker or error-formatting code. The host package passes reliably in its own `bun test` run; the failure only surfaces under the parallel `bun run --filter '*'` orchestration. Belongs to a separate test-isolation fix, not this capability remediation.

## Validation Commands
```bash
bun run typecheck   # all packages: exit 0
bun run test        # per-package: all green except the pre-existing host flake above
```
