# PR Remediation Plan — Pass 8

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 1 critical, 9 advisory (6-agent review)

Branch had already passed 7 prior remediation passes; this is the 8th, triggered by a fresh full-cohort review of the branch vs `main` (141 files, 6084 insertions).

## Critical Fixes

### Fix 1: Stale `validateDagShape` check list in shipped doc
- **Source:** comment-analyzer
- **File:** `packages/framework/docs/dag-type-system.md:889`
- **Issue:** Lifecycle table claims `validateDagShape` checks "deps ↔ edges … optionalDeps partitioning". `deps`/`optionalDeps` were removed by ADR 0017 (the same doc's §6.5 says so, and `validate-dag.ts` performs no such checks). This stale, self-contradictory cell now ships to consumers.
- **Fix:** Replace with the checks `validateDagShape` actually performs: key/id consistency, edge endpoints, `$input`-edge well-formedness, edge uniqueness, conditional-predicate well-formedness, source/root invariant, else-totality, freshness-extractor consistency, output reachability.

## Advisory Fixes

### Fix 2: `runNew` partial-scaffold + dead branch (silent-failure-hunter)
- **File:** `packages/framework/src/cli/new.ts:198-209`
- **Issue:** `runNew` writes the prompt `.txt`, then calls `runPromptsSync` as a separate fallible post-step whose `ok: false` return is handled — but `runPromptsSync` never returns `ok: false` (dead branch), and the post-step breaks the all-or-nothing promise of the write batch.
- **Fix:** Compute the fresh-prompt registry in-memory (new prompt → `1.0.0`, `computePromptHash(body)`) and write `registry.json` inside the same atomic write batch, byte-identical to `runPromptsSync` output. Removes the dead branch and the `runPromptsSync` dependency.

### Fix 3 & 4: `defineSources` test coverage (pr-test-analyzer)
- **File:** `packages/framework/src/__tests__/define-sources-fan-in.test.ts`
- **Issue:** The empty-sources guard (`define-sources.ts:124`) and the assemble-optional-`$input` rejection (`define-sources.ts:168`) are not directly tested.
- **Fix:** Add two tests casting through `any` (matching the existing pattern in the suite).

### Fix 5: Brand laundering in `dagInputEdgeFor` (type-design)
- **File:** `packages/framework/src/executor/dag-input-edge.ts:17-23`
- **Issue:** Return type uses bare `string` endpoints with `as string` casts, discarding the `DagInputId`/`NodeId` brands.
- **Fix:** Type the return as `readonly { readonly from: DagInputId; readonly to: NodeId }[]`, drop the two casts.

### Fix 6: `NodeDef<any>` → `NodeDef<unknown>` (type-design + architecture) — REJECTED (false positive)
- **File:** `packages/framework/src/executor/define-sources.ts:36-40`, `dag-input-edge.ts:17-19`
- **Issue (claimed):** `NodeDef<any, any, any>` could be `NodeDef<unknown, unknown>` to avoid `any`'s assignability hole.
- **Verdict:** Attempted, then reverted — it does NOT compile. `NodeDef.run` is *contravariant* in its `input` param, so a concrete `NodeDef<void, …>` / `NodeDef<{…}, …>` is **not assignable** to `NodeDef<unknown, …>` (you cannot pass `unknown` where `void`/a concrete shape is expected). `validate-dag.ts` gets away with `NodeDef<unknown, unknown>` only because it *reads* already-stored entries (`Object.entries(...) as [...]`), never accepts concrete nodes as a parameter. The `any` here is a genuine, load-bearing variance leak. The eslint-disable comments were updated to explain exactly why. Confirmed by `bun run typecheck` (errors in `source-entry-shape-helpers.test.ts` and `examples/dags/08-multi-source-join.ts`).
- **Kept:** the brand-preserving *return type* of `dagInputEdgeFor` (`{ from: DagInputId; to: NodeId }[]`) — independent of the param type and a real improvement (drops two `as string` casts).

### Fix 7: Non-compiling `createLlmNode` example (comment-analyzer)
- **File:** `docs/library-ux.md:1239-1271`
- **Issue:** Example passes a `run:` field to `createLlmNode`, which `LlmNodeConfig` does not accept (would not compile).
- **Fix:** Rewrite using `createLlmWithToolsNode` (the idiomatic tool-calling factory); adjust surrounding prose so the `req`/`ctx` `sendWithTools` argument discussion still holds.

### Fix 8: Misleading README link label (comment-analyzer)
- **File:** `packages/adapter-fs/README.md:11`, `packages/xlsx/README.md:9`
- **Issue:** Link label reads `docs/llm-document-source.md` while the target lives in a different package.
- **Fix:** Update labels to `../document-source/docs/llm-document-source.md` to match the resolved target.

### Fix 9: Under-specified clock capability reference (comment-analyzer)
- **File:** `packages/framework/src/types/node.ts:241`
- **Issue:** `clock` capability `reference` says "createFetchNode with requires: ['clock']" but source/transform nodes may also require clock.
- **Fix:** Broaden to "any node factory with requires: ['clock']".

## Deferred

### zod-schema `| null` → 3-way union (type-design advisory)
- **File:** `packages/framework/src/llm/zod-schema.ts`
- **Reason:** `objectSchemaKeys`/`objectSchemaRequiredKeys` collapse "non-object (skip)" and "render-failed" into `null`. No current caller branches on the distinction, the render-failure path is already mitigated by a debug log, and introducing states no consumer reads is speculative generality (YAGNI). Revisit if a caller ever needs to surface render failures.
- **Recommendation:** Keep the debug log; promote to a 3-way union only when a caller needs the distinction.

## Validation Commands
```bash
bun run typecheck
bun run --filter @fuguejs/framework test
bun run check:docs
```
