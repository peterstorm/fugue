# PR Remediation — describe-contract-hardening review run

**Branch:** `feat/describe-contract-hardening` (reviewed HEAD `e2e3fc9b` = origin/main `af67e579` + the deferred-design-passes commit)
**Scope (frozen, 10 files vs reviewed HEAD):** `packages/framework/src/describe/build-described-dag.ts`, `packages/framework/src/dag-runtime/topology.ts`, `packages/framework/src/dag-runtime/conditional.ts`, `packages/framework/src/dag-runtime/index.ts`, `packages/host/src/http/handlers/manifest.ts`, `packages/framework/src/__tests__/build-described-dag.test.ts`, `packages/framework/src/__tests__/cli/authored-map.test.ts`, `packages/framework/src/__tests__/dag-input-edges.test.ts`, `packages/framework/src/__tests__/mapped-describe-capabilities.test.ts`, `packages/framework/src/__tests__/_describe-helpers.ts` (new)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260915T100406Z-describe-hardening-review-1`
**Review outcome:** 0 surviving criticals, 0 refuted criticals, 18 advisories (pr-test-analyzer attempt-1 payload rejected as non-strict JSON; bounded attempt-2 retry admitted)

## Surviving-critical dispositions

None — zero criticals. No Declared Repair Groups, no selected checks, no Historical RED declarations. `defectFamily: {"kind":"not-required"}` at remediation start.

## Refuted-finding audit

None — no critical set was non-empty, so the Refutation Panel was not routed.

## Advisory dispositions (18 total: 15 accepted, 2 deferred, 1 dismissed)

| ID | Location | Disposition | Reason |
| --- | --- | --- | --- |
| `code-reviewer-1` | build-described-dag.ts:311 | accepted | waveIds identity mapping no-op; `waves: waves.value` directly (shared with type-design-analyzer-2, code-simplifier-2) |
| `code-reviewer-2` | build-described-dag.ts:198 | accepted | Reword the childNodes projection comment: the recursion is defensive — nested maps are rejected at map construction/validation, so nested-map describe is not a supported input path |
| `code-reviewer-3` | build-described-dag.test.ts:206 | accepted | Correct the prompt-union comment (a dropped node walk is caught only by the separate mapped-describe pin) + add a fixture passing both a `loadedPrompts` entry and an llm node, pinning the simultaneous union branch of `collectPromptNames` |
| `silent-failure-hunter-1` | manifest.ts:154 | accepted | Make `ManifestHandlerDeps.logger` required (drop the `= {}` default) so a degraded schema is always observable server-side by default; the only production caller (router.ts:128) already passes a required `LogPort`; the two no-arg test calls are updated (host test file is a support path) |
| `silent-failure-hunter-2` | build-described-dag.ts:166 | dismissed | Deliberate, documented, test-pinned last-resort guard (the hunter's own reason); the payload always carries the affected field as null (never omitted), so the degraded state stays visible; a second diagnostic channel would be a design change with no planned work |
| `pr-test-analyzer-1` | build-described-dag.ts:271 | accepted | Add the missing test for the outputSchema warning path: a node whose outputSchema fails to render, asserting the `{ field: "outputSchema", nodeId }` where arm and the null outputSchema |
| `pr-test-analyzer-2` | manifest.ts:63 | accepted | Add host handler tests pinning the new warning-delivery wiring: `onSchemaWarning` receives the formatted degradation and the injected logger receives it (host test file is a support path) |
| `type-design-analyzer-1` | topology.ts:209 | accepted | `computeIncomingByNode` returns `ReadonlyMap` — consistent with the sibling builders; verified safe: the machine-context field is already `ReadonlyMap<NodeId, IncomingSources>` (types.ts:368) and no consumer mutates the container |
| `type-design-analyzer-2` | build-described-dag.ts:311 | accepted | waveIds identity mapping (shared with code-reviewer-1, code-simplifier-2) |
| `type-design-analyzer-3` | conditional.ts:11 | accepted | Delete the backward-compat shim — zero in-repo importers, CONTEXT.md Key Invariant 8 forbids pre-release shims (shared with architecture-tech-lead-1, code-simplifier-1) |
| `type-design-analyzer-4` | manifest.ts:82 | accepted | Drop the redundant `sha: registered.sha as string` cast — `GitSha` is a branded subtype assignable to the declared `string` |
| `architecture-tech-lead-1` | conditional.ts:1 | accepted | Delete the shim + its mis-summarizing dag-runtime README row (support path) |
| `architecture-tech-lead-2` | build-described-dag.ts:226 | accepted | Expose the capability union beside the inventory it summarizes: `inventoryCapabilities(dag)` in runtime-node-inventory.ts (support path) and describe consumes it — the same-inventory-union invariant becomes structural rather than test-pinned |
| `architecture-tech-lead-3` | manifest.ts:44 | accepted | `buildManifest` returns `Result<DagManifestResponse, FrameworkError>`; `assembleManifest` runs `formatFrameworkError` at its single response-mapping place — the error mode stays typed at the seam (host test file is a support path) |
| `architecture-tech-lead-4` | authored-map.test.ts:1 | deferred | Splitting the 1,955-line module into per-concern test files is a large mechanical refactor best done in a dedicated deepen session; byte-pinning scaffold tests and 30s compile-and-execute timeouts make it regression-prone and the benefit is organizational |
| `code-simplifier-1` | conditional.ts:1 | accepted | Dead shim deletion (shared with architecture-tech-lead-1, type-design-analyzer-3) |
| `code-simplifier-2` | build-described-dag.ts:311 | accepted | waveIds identity copy (shared with code-reviewer-1, type-design-analyzer-2) |
| `code-simplifier-3` | build-described-dag.ts:235 | deferred | Interface-bound: deleting the cast requires restructuring the `NodeDef`/`DagNodeDef` generic type design (NodeDef is a single generic interface with a plain `kind` field, not a discriminated arm) outside the frozen scope; the reviewer's own recommendation is the deepen skill; today's shape is the correct parse-don't-validate reading |

## Accepted advisory fixes (implementation inventory)

- `packages/framework/src/describe/build-described-dag.ts` (in scope): `waves: waves.value` (drop the identity mapping + the `waveIds` intermediate); reword the childNodes projection comment (defensive recursion); `collectCapabilities` delegates to the new `inventoryCapabilities`
- `packages/framework/src/shared/runtime-node-inventory.ts` (support path): export `inventoryCapabilities(dag)` beside the inventory it summarizes
- `packages/framework/src/dag-runtime/topology.ts` (in scope): `computeIncomingByNode` returns `ReadonlyMap<NodeId, IncomingSources>`
- `packages/framework/src/dag-runtime/conditional.ts` (in scope): DELETE the file
- `packages/framework/src/dag-runtime/README.md` (support path): remove the `conditional.ts` row
- `packages/host/src/http/handlers/manifest.ts` (in scope): drop the sha cast; `buildManifest` returns `Result<DagManifestResponse, FrameworkError>`, `assembleManifest` maps the error at its single place; `ManifestHandlerDeps.logger` required
- `packages/framework/src/__tests__/build-described-dag.test.ts` (in scope): prompt-union comment + union fixture (loadedPrompts + llm node); outputSchema warning-path test
- `packages/host/src/__tests__/handlers/manifest.test.ts` (support path): warning-delivery tests (`onSchemaWarning` + logger injection); the two `createManifestHandler()` no-arg calls pass a logger for the required field

## Validation commands

```
PATH="/tmp/bun-1.4.2/bun-linux-x64:$PATH" REDIS_URL=redis://:fugue-test@127.0.0.1:6380 bun run verify
```
