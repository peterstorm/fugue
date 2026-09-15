# PR Remediation — 2026-09-15

Canonical remediation plan for this session. Built from the canonical
`result.json` of review run `20260915T052115Z-pr48-review-13`; nothing hand-built.

## Branch and scope

- **Branch:** `feat/f1-authored-map`
- **Reviewed HEAD:** `ff5df3a4ee14e2ff5d94e36ead032b9886d3c88b` (base `3ad7321c6068e0c173757b3b6d10dbe8e875292f`)
- **Exact scope:** the 39-file frozen review scope (changed-path union) recorded in the
  review run's `result.json` — plans, `.gitignore`, `.loom/verification-manifest.json`,
  CONTEXT.md, docs, and `packages/framework/src/{__tests__,cli,dag-runtime,describe,nodes,shared,types}`.
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260915T052115Z-pr48-review-13`
  (program `standalone-review`, protocol `loom-reviewer` v2, state `done`;
  supersedes terminal-blocked run `20260914T195806Z-pr48-review-12`).
- **Review outcome:** 0 surviving critical findings; 19 advisory findings; 0 refuted
  critical findings; no Refutation Panel ran (`panel: null` — critical set was empty).

## Surviving-critical dispositions

**None.** Zero surviving criticals: no repair group, check, manifest, or subprocess is
required. The remediation start still requires the explicit
`defectFamily: {"kind":"not-required"}` input.

## Declared Repair Groups

**None.** No surviving critical Finding IDs exist to account for.

## Selected check ID and Historical RED

**None.** Zero surviving criticals → no operator check is selected and no Historical RED
is declared. Validation below is development evidence, not P3 evidence.

## Advisory dispositions (parent policy: accepted / deferred / dismissed)

Every advisory triaged autonomously from the evidence, correctness impact, risk, and
reviewed scope. No user instruction overrides any individual advisory.

| ID | Reviewer | Location | Disposition | Reason |
| --- | --- | --- | --- | --- |
| `code-reviewer-1` | code-reviewer | `packages/framework/src/shared/build-input.ts:61` | accepted | Sound defense-in-depth asymmetry: a sole optional source's absent output (checkpoint corruption / framework ordering bug class) is silently swallowed into `ok(undefined)` while the parallel required-source branch returns a precise non-retriable error. Complete in-scope fix is practical: assert the selected optional source produced output, mirroring the required branch. Supported behavior unaffected (dispatch guarantees the output under correct wave ordering). |
| `code-reviewer-2` | code-reviewer | `packages/framework/src/shared/validate-dag.ts:98` | accepted | Sound: `{ ...captured.sideEffects }` yields `{}` for undefined, so a TS-bypassing dynamically-built node without sideEffects passes the mandatory soundness gate and the describe payload emits `sideEffects: undefined` against the documented string contract. Complete in-scope fix is practical: the gate rejects a sideEffects-less ordinary node with the same defensive posture applied to isSource/inputSchema and retry numerics. No supported authoring surface is affected (NodeDef type-requires the field; factories set it; maps are rejected by `snapshotMapping`). |
| `pr-test-analyzer-1` | pr-test-analyzer | `packages/framework/src/describe/build-described-dag.ts:223` | accepted | Missing test coverage on the `loadedPrompts` host-union branch of `collectPromptNames`; the sibling node-introspection branch is pinned. A cheap test seeding `loadedPrompts` pins the union so omissions on either surface stay visible. In-scope (`build-described-dag.test.ts`), practical. |
| `pr-test-analyzer-2` | pr-test-analyzer | `packages/framework/src/cli/authored.ts:715` | accepted | The GatherSchema gather-field `'__proto__'` rejection is the one `'__proto__'` emission surface without a direct test while its two siblings (schema field names, widthFrom) are pinned. A one-line test mutating `gather.field` to `'__proto__'` pins the third surface. In-scope (`authored-map.test.ts`), practical. |
| `type-design-analyzer-1` | type-design-analyzer | `packages/framework/src/shared/build-input.ts:41` | accepted | Sound type improvement: narrowing `buildNodeInput`'s `nodeId` parameter to the branded `NodeId` makes the validated-id precondition structural and removes the latent exception channel from the promised Err path. Both supported callers (`run-node.ts` execution, `freshness-emission.ts` witness extraction) already pass `NodeId` (machine-context ids), so no out-of-scope caller edits are needed. In-scope, practical. |
| `type-design-analyzer-2` | type-design-analyzer | `packages/framework/src/shared/validate-dag.ts:459` | accepted | Sound hardening: the retry numeric-domain and minConfidence guards interpolate raw caller-supplied values via `String()`, which throws on a non-stringifiable hostile as-cast instead of settling in the promised typed Err. Complete in-scope fix is practical: render through the existing total `safeErrorMessage` helper (the same file already uses it for caught causes; message-identical for every value that currently does not throw). |
| `comment-analyzer-1` | comment-analyzer | `packages/framework/src/types/dag.ts:154` | accepted | Stale pointer: `evaluatePredicate` is defined in `dag-runtime/routing.ts` (routing.ts:32); `conditional.ts` is a backward-compatibility re-export shim that itself deprecates the path the comment steers readers onto. Documentation fix: update the pointer to `dag-runtime/routing.ts`. |
| `comment-analyzer-2` | comment-analyzer | `packages/framework/src/dag-runtime/topology.ts:246` | accepted | `runDagInner` does not exist anywhere in the repository. The actual `computeIncomingByNode` callers are `compileDagToMachine` (machine.ts) and `wrapDagJobLike` (persistence.ts). Documentation fix: name the real callers. |
| `comment-analyzer-3` | comment-analyzer | `packages/framework/src/dag-runtime/topology.ts:138` | accepted | `outgoingOf` has zero call sites in the repository — only re-exported; the comment claims phantom consumers (validators, tests). Documentation fix: state the actual consumer situation (public re-export only). |
| `comment-analyzer-4` | comment-analyzer | `packages/framework/src/dag-runtime/topology.ts:146` | accepted | Factually incorrect doc: only nodes with at least one outgoing (non-`$input`) edge receive a bucket — sink nodes are absent, so `.get(sinkId)` returns undefined. Documentation fix: state the actual bucket coverage. |
| `comment-analyzer-5` | comment-analyzer | `packages/framework/src/dag-runtime/topology.ts:163` | accepted | Doc names a non-consumer: `seedInitialActiveSet` never consumes `computeUnconditionalAdj`'s output (only `expandActive` does, via wave-resolution.ts and reroute.ts), and the "Maps each node" phrasing shares the finding-4 absent-vs-empty overstatement. Documentation fix: correct the attribution and phrasing. |
| `architecture-tech-lead-1` | architecture-tech-lead | `packages/framework/src/describe/build-described-dag.ts:295` | deferred | Both proposed deepening options (project each map's child nodes/edges into the `DescribedMap` payload, or stop leaking child capabilities/prompts) alter the stable describe payload contract consumed by host tooling (`GET /dags/:id/manifest`, `fugue describe`). The current summary-by-reference choice is pinned by the existing `authored-map.test.ts` assertions and documented in `docs/features.md` (child nodes are not projected into outer waves). Changing a stable LLM-facing JSON contract is a cross-cutting design decision that must not ride along in a remediation pass; the finding is nonblocking (locality/leverage gap, not a supported-behavior defect). Deferred to a focused design pass with host-consumer coordination. |
| `architecture-tech-lead-2` | architecture-tech-lead | `packages/framework/src/cli/authored-codegen.ts:515` | accepted | Sound module-internal consolidation, verified shape-by-shape by two independent reviews: the per-shape wiring contract (linear/fan-out/diamond/router/sources) exists twice — in `buildAuthoredScaffold`'s `match(s)` and `emitChildStructure`'s `match(child.structure)`. Consolidate behind one internal parameterized emitter whose two real adapters are root emission and mapped-child emission; parameterize the naming adapter (node ref expression, fan-in const naming), the root-input expression, join requiredness, and fan-in comment emission. Byte-pinning scaffold tests (`toContain` assertions, `structuralProjection`, compile-and-execute) survive the refactor; `buildAuthoredScaffold`'s interface and the parser/codegen module seams are unchanged. |
| `code-simplifier-1` | code-simplifier | `packages/framework/src/dag-runtime/topology.ts:24` | accepted | Reuse-before-rewrite: the private `buildOutgoing` duplicates the exported `computeOutgoingByNode` in the same file with exactly one caller whose two differences (extra `$input` entry, pre-seeding) are unobservable there. Delegating to the exported builder is result-identical and concentrates the DAG_INPUT-skip subtlety in one place. |
| `code-simplifier-2` | code-simplifier | `packages/framework/src/shared/validate-dag.ts:84` | accepted | `captureNodeInput` copies the retry config twice through an intermediate `capturedRetry` variable; flattening to one conditional is result-identical (the accessor-once guarantee is preserved by the `{ ...node }` capture) and reads at one level. |
| `code-simplifier-3` | code-simplifier | `packages/framework/src/shared/validate-dag.ts:203` | accepted | One concept, two divergent spellings of the backoffMs tuple copy in the same file. Harmonizing on the capture's existing spelling (`[...backoffMs] as [number, ...number[]]`) is result-identical for every value that can reach the snapshot (the tuple type guarantees length ≥ 1 and the gate's retry-domain check rejects empty ladders before `snapshotNode` runs). |
| `code-simplifier-4` | code-simplifier | `packages/framework/src/cli/authored.ts:824` | accepted | `Object.freeze` is idempotent and returns the same object, so `Object.isFrozen(value) ? value : Object.freeze(value)` is a dead branch guarding nothing. `return Object.freeze(value) as DeepReadonly<T>` is result-identical. |
| `code-simplifier-5` | code-simplifier | `packages/framework/src/cli/authored.ts:155` | accepted | The free-text lexical chain (`z.string().min(1)` + SINGLE_LINE + NO_TEMPLATE_OPEN + NO_FUGUE_BODY_MARKER refinements) is spelled four times verbatim (enumValue, FieldSpecSchema description, nodePurpose, DAG description). A `freeText()` schema factory single-sources the free-text policy; each call site receives an equivalent schema so parse behavior including error messages is unchanged. |
| `code-simplifier-6` | code-simplifier | `packages/framework/src/__tests__/cli/authored.test.ts:1437` | accepted | The ~17-line `describedStub` DescribedDag literal is duplicated word-for-word across two adjacent `runNewFrom` tests (lines 1437 and 1469). One shared stub helper removes the second copy; no assertion is weakened (the stub is inert fixture data in both tests). |

**Totals:** 18 accepted, 1 deferred, 0 dismissed, 0 surviving criticals, 0 refuted.

## Accepted advisory fixes (implementation targets)

All accepted fixes touch files inside the frozen review scope; the only remediation-owned
support path outside it is this plan file.

1. `packages/framework/src/shared/build-input.ts` — (`code-reviewer-1`) assert a sole
   optional source produced output, mirroring the required-source branch's non-retriable
   node-attributed error; (`type-design-analyzer-1`) narrow the `nodeId` parameter to the
   branded `NodeId`, use it directly in the node-crash error path, drop the in-path
   `__brandNodeId` brand and its import.
2. `packages/framework/src/shared/validate-dag.ts` — (`code-reviewer-2`) reject a
   sideEffects-less ordinary node at the gate with a named validation error;
   (`type-design-analyzer-2`) render the retry-limits/defaultRetryLimit/minConfidence
   guard diagnostics through the total `safeErrorMessage` helper;
   (`code-simplifier-2`) flatten the `capturedRetry` intermediate;
   (`code-simplifier-3`) harmonize the `snapshotNode` backoffMs tuple-copy spelling with
   the capture's `[...backoffMs]` spelling.
3. `packages/framework/src/types/dag.ts` — (`comment-analyzer-1`) point the
   `evaluatePredicate` relocation comment at `dag-runtime/routing.ts`.
4. `packages/framework/src/dag-runtime/topology.ts` — (`comment-analyzer-2`) name the
   real `computeIncomingByNode` callers; (`comment-analyzer-3`) correct the `outgoingOf`
   consumer situation; (`comment-analyzer-4`) correct `computeOutgoingByNode`'s bucket
   coverage; (`comment-analyzer-5`) correct `computeUnconditionalAdj`'s consumer
   attribution and "Maps each node" phrasing; (`code-simplifier-1`) delegate
   `seedInitialActiveSet`'s DagDef branch to the exported `computeOutgoingByNode(dag)`
   and delete the private `buildOutgoing` duplicate.
5. `packages/framework/src/cli/authored.ts` — (`code-simplifier-4`) delete the dead
   `isFrozen` branch in `deepFreezeOwned`; (`code-simplifier-5`) extract the `freeText()`
   free-text schema factory and use it at all four verbatim call sites.
6. `packages/framework/src/cli/authored-codegen.ts` — (`architecture-tech-lead-2`)
   consolidate the root-DAG wiring and mapped-child structure emission behind one
   internal parameterized emitter with two thin adapters (root, mapped-child),
   parameterizing node ref expression, fan-in const naming, root-input expression, join
   requiredness, and fan-in comment emission.
7. `packages/framework/src/__tests__/build-described-dag.test.ts` — (`pr-test-analyzer-1`)
   add the loadedPrompts union test.
8. `packages/framework/src/__tests__/cli/authored-map.test.ts` — (`pr-test-analyzer-2`)
   add the gather-field `'__proto__'` pin.
9. `packages/framework/src/__tests__/cli/authored.test.ts` — (`code-simplifier-6`) extract
   the shared `describedStub` fixture helper.

## Refuted-finding audit

**None.** The Refutation Panel did not run (`panel: null`); the critical set was empty.
`refuted_critical_findings: []`.

## Validation commands

Development validation (not P3 evidence — the registered remediation runner freshly
observes each selected fixed check; with zero criticals no operator check is selected):

```bash
bun run check:verification-prerequisites
bun run typecheck
bun run check:docs
bun run test:scripts
bun run test
```

Scope discipline: `DECLARED` facts above are distinct from checks the engine will later
observe. Accepted advisories are never inserted into critical repair groups; refuted
criticals are audited and never fixed.
