# PR Remediation Plan — pass 4 (advisory sweep)

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 0 critical, 6 advisory groups remediated (across 6 review agents)

A fourth 6-agent review of the whole branch (132 files, ~4967 insertions) after
three prior remediation commits (`4cdd63c`, `ba4840f`, `e365e51`). **Zero
critical** findings — the prior passes cleared the substantive issues. Several
agents independently converged on the same advisories (notably the `fixedClock`
mutable-`Date` leak, flagged by both the type-design and architecture agents).
At the user's direction, all worthwhile advisories were fixed; the one
acknowledged tradeoff (`join`/`assemble` typed `NodeDef<any,any,any>`) was left
as a conscious heterogeneous-node decision.

## Fixes applied

### Fix 1: `fixedClock(at)` leaked a shared mutable `Date` (real bug)
- **Source:** type-design-analyzer + architecture-tech-lead (independent)
- **File:** `packages/framework/src/types/clock.ts:42`
- **Issue:** `fixedClock = (at) => ({ now: () => at })` returned the *same*
  `Date` reference on every `now()`. `Date` is mutable, so a node doing
  `ctx.clock.now().setUTCHours(0)` poisoned the fixture for every later reader in
  the run — silently defeating the determinism the test clock exists to provide,
  and surfacing as order-dependent test flakiness. `systemClock` (fresh
  `new Date()` per call) didn't share this aliasing, so the two adapters had
  subtly different semantics.
- **Fix:** Capture `at.getTime()` once and mint a fresh `new Date(ms)` per call,
  matching `systemClock`'s value semantics. Doc updated to state the guarantee.

### Fix 2: stale "build it with `createFetchNode`" source-node comments (doc drift)
- **Source:** comment-analyzer
- **Files:** `packages/framework/src/executor/dag-input-edge.ts:7`,
  `packages/framework/src/types/errors.ts:136`
- **Issue:** Both comments described building a source entry node via
  `createFetchNode` without `inputSchema` — an impossible construction
  (`createFetchNode` requires `inputSchema` and never sets `isSource: true`;
  only `createSourceNode` does). Contradicted every other comment/doc and the
  `root-expects-input` runtime error message itself.
- **Fix:** Both now reference `createSourceNode` (which sets `isSource: true`).

### Fix 3: `isDirNonEmpty` swallowed all `readdir` errors as "empty" (real bug)
- **Source:** silent-failure-hunter
- **File:** `packages/framework/src/cli/new.ts:149`
- **Issue:** The `catch {}` assumed only ENOENT but caught everything. On
  EACCES/ENOTDIR the overwrite guard reported the target safe-to-write though it
  could not verify emptiness; the real error then surfaced only when the later
  `mkdir`/`writeFile` threw *out* of `runNew` — which is documented never to
  throw on author error — reaching the bin's top-level `.catch` as a raw stack,
  breaking the structured JSON contract LLM tooling parses.
- **Fix:** Narrowed to `if (code === "ENOENT") return false; throw e;` so a
  genuine "absent" still reads as empty, but an unverifiable directory surfaces
  loudly instead of being assumed-empty.
- **Incidental:** the loom `prefer-ts-pattern` lint hook gates edits to
  `new.ts`; the pre-existing `switch (arg)` in `parseNewArgs` was converted to a
  ts-pattern `match().otherwise()` (behavior-preserving) so the fix could land.

### Fix 4: three-way DAG-shape-set drift (hardening — illegal states)
- **Source:** type-design-analyzer
- **Files:** `packages/framework/src/types/dag.ts:184`,
  `packages/framework/src/cli/new-templates.ts:14`,
  `packages/framework/src/cli/types.ts:42`
- **Issue:** The closed shape set was written three independent times
  (`DagProvenance`, the `SHAPES` tuple, the `LintAdvisory.helper` union) with no
  compile-time link — adding a sixth shape meant editing all three by hand with
  no error if one was missed.
- **Fix:** Introduced canonical `DAG_SHAPES` in core (`types/dag.ts`);
  `DagProvenance` is now `(typeof DAG_SHAPES)[number]`. The CLI's `SHAPES`/`Shape`
  re-derive from it (names/runtime unchanged, dependency direction stays
  cli→core). `helper` is now `ShapeHelper`, derived from a
  `SHAPE_HELPER` map declared `satisfies Record<Shape, string>` — a missing or
  extra shape is now a compile error.

### Fix 5: undocumented dual time seams (doc note)
- **Source:** architecture-tech-lead
- **File:** `packages/framework/src/types/clock.ts:1`
- **Issue:** The capability `now(): Date` and the pervasive infra `now: () =>
  number` seam coexist with no documented relationship; wiring `fixedClock` does
  *not* pin event/observer timestamps, a latent footgun.
- **Fix:** Added a "Scope" paragraph to the `clock.ts` header clarifying the
  capability governs only node-visible time and that infra timestamps follow the
  separate `now` injection — a test needing both pinned must wire both.

### Fix 6: residual test-coverage gaps (tests)
- **Source:** pr-test-analyzer
- **Added** `packages/framework/src/__tests__/source-entry-shape-helpers.test.ts`
  — covers the `dagInputEdgeFor` source-entry branch directly (both branches)
  and per shape helper (linear/fan-out/diamond/router with a `createSourceNode`
  entry wire no `$input` edge).
- **Added** `packages/framework/src/__tests__/fan-in-keys.test.ts` — direct
  table tests for `objectSchemaKeys` (object keys, empty object, `z.unknown()`,
  union, primitives, non-Zod values, render-throw → `null`) and `fanInKeyCheck`
  (ok, order-independence, mismatch missing/extra, unverifiable).
- **Extended** `define-sources-fan-in.test.ts` — `defineSources` accepts an
  unverifiable (`z.unknown()`) join schema with ≥2 sources, deferring to the
  runtime parse.

## Deliberately not fixed (acknowledged tradeoff)
- `defineSources` `join`/`assemble` typed `NodeDef<any,any,any>` — the
  source-id ↔ fan-in-key invariant is recovered dynamically via the well-tested
  `assertFanInKeys` + runtime Zod parse. Both the type-design and architecture
  agents rated this acceptable and recommended no action; consistent with the
  framework's heterogeneous-node pattern.

## Validation
```bash
# framework
(cd packages/framework && bun run typecheck)   # clean
(cd packages/framework && bun test)            # 1604 pass, 34 skip, 0 fail
# host
(cd packages/host && bun run typecheck)        # clean
(cd packages/host && bun test)                 # exit 0
# examples
bun test --cwd packages/examples               # 21 pass, 0 fail
```
