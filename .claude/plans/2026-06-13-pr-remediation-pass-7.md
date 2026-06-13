# PR Remediation Plan — Pass 7

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 1 critical, 6 advisory (across 6-agent review)

Branch already passed 6 prior remediation passes. This pass addresses the
genuinely-new findings from a fresh 6-agent review of the full branch diff
(140 files, 5925 insertions).

## Critical Fixes

### Fix 1: Non-compiling type in `dag-type-system.md`
- **Source:** comment-analyzer
- **File:** `packages/framework/docs/dag-type-system.md:41` and `:158`
- **Issue:** The doc uses `NodeDef<unknown, unknown, unknown>`. `NodeDef`'s 3rd
  param is `E extends FrameworkError` (`node.ts:380`); `unknown` violates that
  constraint → `TS2344`. Line 41 additionally misstates the real `DagDef.nodes`
  type, which is `readonly NodeDef<unknown, unknown>[]` (`dag.ts:196`). A doc
  whose purpose is teaching the exact type machinery ships a non-compiling
  example.
- **Fix:** Replace both occurrences with `NodeDef<unknown, unknown>`. The
  adjacent `NodeDef<any, any, any>` variance-leak claim is accurate (`any`
  satisfies the constraint; matches `dag-internals.ts:16`) and stays.

## Advisory Fixes (applied)

### Fix 2: Direct test table for `objectSchemaRequiredKeys`
- **Source:** pr-test-analyzer + type-design-analyzer
- **File:** `packages/framework/src/llm/zod-schema.ts:79`
- **Issue:** Only covered transitively via one optional-`$input` case; the
  `[]` (all-optional object) and `null` (unverifiable) branches have no direct
  pin, so a refactor could silently regress them.
- **Fix:** Add an `objectSchemaRequiredKeys` describe block in
  `fan-in-keys.test.ts` mirroring the `objectSchemaKeys` table, covering:
  populated-required, `[]` all-optional, `null` for non-object / non-schema.

### Fix 3: B3 stays silent on a manual router-shaped DAG
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/cli/lint-checks.ts:79`
- **Issue:** `detectShapeHelper`'s conditional-edge guard
  (`edges.every(e => e.kind === "unconditional")`) is only covered implicitly.
  A regression that wrongly matched a router as a fan-out/diamond wouldn't be
  caught by an explicit B3 test.
- **Fix:** Add a test building a manual router (conditional + default edges) via
  `defineDag` and assert no `shape-helper-hint` advisory is emitted.

## Deferred

### isSource/inputSchema correlation (type-design-analyzer, ADVISORY)
- **Reason:** Making it a discriminated `NodeDef` (`isSource:true ⇒ inputSchema:
  ZodVoid`) ripples through every `NodeDef<unknown, unknown>` use site and the
  `EdgeDefInput` inference. The illegal pairing is only reachable by bypassing
  the sanctioned `createSourceNode` constructor and is caught precisely at
  definition time (`validate-dag.ts:249`). Cost/benefit favors the runtime gate.
- **Recommendation:** Revisit if `NodeDef` is reworked for other reasons.

### Bare-`string` domain fields on host-emitted error variants (type-design, ADVISORY)
- **Reason:** Intentional per ADR-0054 — no vendor literal crosses the framework
  boundary. `policy-refusal.scope` / `downstream-denied.resource` are widened to
  `string` at the boundary on purpose; the host retains the typed `DownstreamScope`.
- **Recommendation:** No change; documented design.

### No `frameworkError` factory for infra-unreachable/policy-refusal/downstream-denied (type-design, ADVISORY)
- **Reason:** These kinds are emitted by the host broker, not framework node
  code, so they have no framework-side factory by design.
- **Recommendation:** Confirm the host has its own parse-don't-validate
  constructor (out of scope for this branch).

### `objectSchemaRequiredKeys` passes required-but-nullable `$input` (type-design, ADVISORY)
- **Reason:** Cosmetic. The check enforces *presence* (`required`), which is
  the actual invariant; `.nullable()` keeps the key required, and the runtime
  Zod parse handles null. The message accurately names what fires it
  (`.optional()/.nullish()`). Adding nullability nuance risks confusing more
  than it clarifies.
- **Recommendation:** No change.

## Validation Commands
```bash
bun run typecheck
bun test
bun scripts/check-doc-links.ts
```
