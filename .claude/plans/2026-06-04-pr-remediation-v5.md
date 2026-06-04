# PR Remediation Plan — v5

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Cycle:** 8th review (v1–v7 prior); 103 files, 8282 insertions vs `main`
**Findings:** 1 critical, 14 advisory (after dedup) → 3 fixed, 11 deferred (intentional / out-of-scope)

## Review Cohort

6-agent parallel review (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent). Five reported
0 critical. Each was briefed on the documented architectural intent so deliberate
patterns (fail-closed boot validation, never-throw observers, boot-failure
cleanup, ports/adapters split, pure xlsx parser) were not re-flagged.

## Root-Cause Insight

Three independent findings (comment-analyzer CRITICAL, code-reviewer A2, the
generated `__doc_check_dir__/check.ts` compile failure) share **one** root cause:
`parseWorkbook` returned `{ rows: readonly T[] }`, which is not assignable to a
node `outputSchema` of `z.object({ rows: z.array(RowSchema) })` — Zod's `z.array`
infers a **mutable** `T[]`. Since the documented primary usage is
`return parseWorkbook(...)` inside a `createFetchNode`, the `readonly` return was
the odd-one-out that didn't compose with the framework's own node-output
convention. Widening the return to `{ rows: T[] }` fixes all three at the source
(the rows are freshly allocated and owned by the caller, so `readonly` bought no
real safety here, while costing every consumer an ergonomic `.readonly()`).

## Critical Fixes

### Fix 1: `parseWorkbook` return type breaks the documented node pattern
- **Source:** comment-analyzer (CRITICAL), code-reviewer (A2)
- **File:** `packages/xlsx/src/index.ts:97`
- **Issue:** `Promise<Result<{ rows: readonly T[] }>>` is not assignable to a
  `z.object({ rows: z.array(RowSchema) })` output schema (mutable `T[]`), so the
  leading inline example in `docs/llm-document-source.md:95` and the generated
  doc-check `check.ts:20` fail to typecheck (`TS2322`).
- **Fix:** Return `{ rows: T[] }`. Makes the docs correct as written (no doc edit
  needed) and removes the consumer footgun. Verified: `check.ts:20` `TS2322` gone.

## Advisory Fixes

### Fix 2: xlsx test reads `.message` on an over-wide error type
- **Source:** code-reviewer (A1)
- **File:** `packages/xlsx/src/__tests__/xlsx.test.ts:121`
- **Issue:** `if (!r.ok)` narrows to `FrameworkError`; the `retry-exhausted`
  variant has no `message`, so `r.error.message` is a `TS2339` error. Escaped the
  gate because xlsx has no `typecheck` script (see Deferred).
- **Fix:** Guard `r.error.kind === "node-crash"` before reading `.message`
  (matches the correct pattern at line 62), with an explicit `else throw` so a
  wrong error kind fails loudly instead of silently passing.

### Fix 3: undocumented error-cell row-skip behavior
- **Source:** silent-failure-hunter (A1)
- **File:** `packages/xlsx/src/index.ts` (JSDoc on `parseWorkbook`)
- **Issue:** A row whose cells are *all* error cells (`#REF!`, `#DIV/0!`)
  normalises to all-`null` and is silently skipped as "blank", undocumented.
- **Fix:** Document the behavior on `parseWorkbook` (error-only rows are skipped;
  a row mixing an error cell with real values is kept and fails validation unless
  the column is nullable). Behavior is intentional tolerance; now stated.

## Validation Commands
```bash
cd packages/xlsx && bunx tsc --noEmit   # 0 errors in src/ and src/__tests__/
bun test packages/xlsx                   # 30 pass
bun run --filter @fugue/framework typecheck   # exit 0
```

## Deferred — Intentional Design (not defects)

### HTTP capability classifies all non-2xx as retriable `transient`
- **Source:** architecture-agent (A1)
- **File:** `packages/framework/src/http/http-capability.ts:120-127`
- **Why deferred:** This is a deliberate, documented design. `transient` carries
  `httpStatus` *specifically* so node authors branch on status
  (`errors.ts:83-88`), it is asserted in `http-capability.test.ts:144-150`, and
  demonstrated in `apps/customer-summary/.../fetch-customer-http.ts` (404→null).
  Reclassifying 4xx as non-retriable `node-crash` would **remove** the documented
  `httpStatus`-branching feature (`node-crash` carries no `httpStatus`), trading
  one design for another rather than fixing a defect. A generic HTTP client also
  can't know which 4xx are deterministically fatal (eventual-consistency 404s
  exist), so delegating to the node author via `httpStatus` is defensible.

### `extractClients` rebuilt per request on the unsorted handle array
- **Source:** silent-failure-hunter (A3), architecture-agent (A2)
- **File:** `node-context-factory.ts:252`, `capability-manager.ts:294`
- **Why deferred:** Correct today — boot validates the same `shared.capabilities`
  reference (`topoSortHandles` rejects dupes/null clients), and the single
  correlation point is documented at the call site (lines 248-251). The findings
  are a per-request allocation nit plus a latent-trap-on-future-refactor. Hoisting
  the precomputed client record onto `SharedInfra` is a reasonable follow-up but
  adds surface for a micro-optimization with no current correctness impact.

### `queryRaw` escape hatch, `missing-capability` redundant scalars, unrefined config strings
- **Source:** type-design-analyzer (3 advisories)
- **Why deferred:** Each is documented and contained. `queryRaw`'s `unknown[]`
  bypass is a deliberate, sign-posted parse-don't-validate escape hatch.
  `missing-capability`'s `nodeId`/`capability` scalars mirror `missing[0]`;
  both (only) constructors derive them from `missing[0]`, grep confirms no raw
  literals, and the redundancy is a documented backward-compat surface. Config
  strings follow the codebase's fail-at-boot (not at-factory) convention, with
  path-confinement enforced at use in `resolveWithinRoot`.

## Deferred — Out of Scope (separate infra task)

### New packages lack a `typecheck` script → skipped by the gate
- **Source:** code-reviewer (process note)
- **Detail:** `xlsx`, `document-source`, `adapter-fs/ms-graph/pg` have only
  `build`/`test`, so `bun run --filter '*' typecheck` silently skips them — which
  is how Fixes 1 & 2 escaped. Wiring `tsc --noEmit` cleanly is blocked on two
  environmental issues that surface when tsc runs standalone in these packages:
  (a) the untracked generated `src/__doc_check_dir__/` is picked up by
  `include: ["src"]`, and (b) a zod-version-resolution mismatch against the
  framework's committed (stale) `dist/.d.ts`. Resolving these (source-based
  cross-package resolution / excluding the doc-check scratch dir) is a
  build-infrastructure change deserving its own PR; adding a failing gate now
  would be a net negative. **Recommendation:** dedicated follow-up to stop
  committing `dist/`, resolve `@fugue/*` via source, then add `typecheck` scripts.

## Deferred — Optional Completeness

- `pr-test-analyzer` A1: node-specific `extractWitness` value formatting not
  directly asserted (generic mechanism covered in `freshness-emission.test.ts`).
- `pr-test-analyzer` A2: live-server test exercises GET/POST/PUT but not
  PATCH/DELETE (same `executeRequest` path — structural, not behavioral, gap).
