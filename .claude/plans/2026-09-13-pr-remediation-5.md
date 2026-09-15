# PR #48 remediation plan — fifth canonical review

Date: 2026-09-13

Branch: `feat/f1-authored-map`

Reviewed HEAD: `945a2f731286fdbeaa8bb1fe64dd7e5db6c1467d`

Review run: `.claude/reviews/review-and-fix-runs/20260913T081455Z-pr48-review-5`

Canonical result digest: `485da5c08c16f2435d43f5013a63c25d12a10d86e9bb15bd7f42970c934dcb53`

## Exact scope

Repair all five surviving critical findings from the canonical result and apply the accepted in-scope advisories. Do not alter the operator-owned verification manifest or any review evidence. No critical finding was refuted.

## Surviving-critical dispositions

| Finding ID | Disposition | Declared Repair Group |
| --- | --- | --- |
| `code-reviewer-1` | repaired | `group.body-only-result-helpers` |
| `silent-failure-hunter-1` | repaired | `group.atomic-node-snapshot` |
| `silent-failure-hunter-2` | repaired | `group.atomic-node-snapshot` |
| `silent-failure-hunter-3` | repaired | `group.total-schema-description` |
| `type-design-analyzer-1` | repaired | `group.prototype-safe-collect-output` |

## Declared Repair Groups

### `group.body-only-result-helpers`

**Finding:** `code-reviewer-1`

**DECLARED root cause:** Generated executable placeholders imported only the failure helpers required by untouched bodies. Those imports are integrity-hashed structure, so a body-only success implementation has no `ok` binding and replacing every placeholder leaves the failure-only imports unused under `noUnusedLocals`.

**DECLARED invariant:** Every generated fetch, source, and transform scaffold exposes success and failure Result helpers through a stable generated namespace that is also used by machine-owned factory structure. Replacing every body region with documented success implementations preserves the integrity hash and passes the repository TypeScript compiler without import edits or unused bindings.

**Sibling accounting:**

- `packages/framework/src/cli/authored-codegen.ts` — **repaired**: emit a stable framework namespace for executable node factories and body Result helpers.
- `packages/framework/src/cli/identifiers.ts` — **repaired**: single-source the generated namespace spelling and collision assumptions.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: the registered regression compiles a fully body-implemented generated module and verifies unchanged structural integrity.
- `packages/framework/src/__tests__/cli/authored.test.ts` — **repaired**: update generated import/body contracts and root-scaffold completion coverage.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: document the stable generated Result-helper namespace and body-only workflow.
- `CONTEXT.md` — **repaired**: record the generated-body namespace contract in the ubiquitous language.

**Selected check:** `project:authored-map-regression`

**DECLARED Historical RED:** On reviewed HEAD `945a2f73`, replacing every generated executable body with documented `ok(...)` calls produced TS2304 because `ok` was not imported; adding it changed integrity-hashed structure, while complete replacement also left `err` and `frameworkError` imports unused under TS6133. Reference: canonical finding `code-reviewer-1`.

### `group.atomic-node-snapshot`

**Findings:** `silent-failure-hunter-1`, `silent-failure-hunter-2`

**DECLARED root cause:** `validateDagShape` validated caller-owned node and nested policy accessors, then reread those values while issuing the branded immutable snapshot. Stateful getters could therefore present one value to validation and another to snapshotting.

**DECLARED invariant:** The DAG trust boundary captures each node and every validated nested policy value exactly once into parser-owned data before validation. Validation and final freezing consume only that same capture, so retry and map-confidence policies cannot change between proof and issuance.

**Sibling accounting:**

- `packages/framework/src/shared/validate-dag.ts` — **repaired**: introduce one typed capture phase and validate/freeze only captured node values.
- `packages/framework/src/__tests__/validate-dag.test.ts` — **repaired**: reproduce stateful retry accessor substitution and assert the issued snapshot retains the validated value.
- `packages/framework/src/__tests__/conditional-edges-validator.test.ts` — **checked-unmodified**: the existing malformed-predicate regression still pins the pre-capture diagnostic after object-predicate snapshotting.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: mirror the map-confidence and retry capture invariants in the registered repair check.
- `CONTEXT.md` — **repaired**: define a `DagDef` as validation and issuance over one parser-owned capture.

**Selected check:** `project:authored-map-regression`

**DECLARED Historical RED:** On reviewed HEAD `945a2f73`, a retry getter could return a valid policy for validation and `{backoffMs:[NaN], jitterRatio:2}` for snapshotting, while a map confidence mode getter could pass as `none` and be issued as `value`. References: canonical findings `silent-failure-hunter-1` and `silent-failure-hunter-2`.

### `group.total-schema-description`

**Finding:** `silent-failure-hunter-3`

**DECLARED root cause:** `safeZodToJsonSchema` performed Zod capability detection before its containment `try`, so an accessor throw escaped both the Result-returning builder and its diagnostic sink.

**DECLARED invariant:** Omitted schemas remain silent `null`; every present schema candidate is inspected and serialized inside one containment region. Malformed values and throwing accessors yield `null` plus a best-effort warning, and warning-sink failures never escape.

**Sibling accounting:**

- `packages/framework/src/describe/build-described-dag.ts` — **repaired**: contain capability detection and distinguish omission from malformed supplied input.
- `packages/framework/src/__tests__/build-described-dag.test.ts` — **repaired**: exercise throwing `parse` accessors, malformed present values, omission, and throwing warning sinks.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: register a direct hostile-schema regression under the selected check.

**Selected check:** `project:authored-map-regression`

**DECLARED Historical RED:** On reviewed HEAD `945a2f73`, a Proxy whose `parse` getter threw caused `buildDescribedDag` itself to throw before returning either Result arm and before warning delivery. Reference: canonical finding `silent-failure-hunter-3`.

### `group.prototype-safe-collect-output`

**Finding:** `type-design-analyzer-1`

**DECLARED root cause:** `CollectedMapOutput<string, T>` described an arbitrary string-key dictionary, but the collect reducer returned an ordinary object inheriting `Object.prototype`; inherited keys such as `toString` therefore violated the public indexed-access type.

**DECLARED invariant:** Collect reducers return frozen null-prototype records whose every string lookup is either the gathered readonly array or `undefined`, exactly matching widened `CollectedMapOutput`.

**Sibling accounting:**

- `packages/framework/src/nodes/map.ts` — **repaired**: construct collected outputs as null-prototype singleton records.
- `packages/framework/src/types/dag.ts` — **checked-unmodified**: the widened indexed-access type is correct once the runtime dictionary has matching null-prototype lookup semantics.
- `packages/framework/src/__tests__/cli/authored-map.test.ts` — **repaired**: compile and execute widened inherited-key lookups, including a gathered field named `toString`.
- `packages/framework/docs/llm-dag-authoring.md` — **repaired**: state the dictionary lookup contract for dynamic collect fields.
- `CONTEXT.md` — **repaired**: record null-prototype collect-output semantics on the Map Node contract.

**Selected check:** `project:authored-map-regression`

**DECLARED Historical RED:** On reviewed HEAD `945a2f73`, `CollectedMapOutput<string, number>["toString"]` compiled as `readonly number[] | undefined` but evaluated to the inherited function, and a guarded `.map(...)` threw `TypeError`. Reference: canonical finding `type-design-analyzer-1`.

## Advisory dispositions

| Advisory ID | Disposition | Reason / accepted repair |
| --- | --- | --- |
| `silent-failure-hunter-4` | accepted | Present malformed describe schemas should warn instead of looking intentionally omitted; repaired with `group.total-schema-description`. |
| `silent-failure-hunter-5` | accepted | Catch unexpected `sendStructured` rejection at the compose shell and preserve the typed failure arm plus last proven draft. |
| `pr-test-analyzer-1` | accepted | Add a direct custom-reducer map describe/Mermaid regression for `gather: custom reducer`. |
| `type-design-analyzer-2` | accepted | Use child-local generated names for child collision checks so safe IDs such as `default` and `input` remain representable while sibling collisions still fail. |
| `comment-analyzer-1` | accepted | Describe `ComposeTurn` accurately as a normalized discriminated union; do not imply strict unknown-key rejection. |
| `comment-analyzer-2` | accepted | Qualify edge-source checks with the legal virtual `DAG_INPUT` source. |
| `comment-analyzer-3` | accepted | Separate module-load topology guarantees from lint and execution/schema checks. |
| `comment-analyzer-4` | accepted | Document the `fugue visualize --raw` non-JSON exception. |
| `comment-analyzer-5` | accepted | Qualify restart durability by requiring a durable `Checkpointer`. |
| `code-simplifier-1` | accepted | Compute runtime node inventory once and project capabilities/prompts from that authoritative snapshot. |
| `code-simplifier-2` | accepted | Populate graph membership and emit duplicate diagnostics in one ordered pass. |
| `code-simplifier-3` | accepted | Canonicalize the first terminal output once before comparisons. |

Deferred advisories: none.

Dismissed advisories: none.

## Refuted-finding audit

None. The Refutation Panel retained all five admitted critical findings. `code-reviewer-1` was upheld by reproduction and intent with security uncertain; the other four were unanimously upheld.

## Validation

Development validation, not registered P3 evidence:

```bash
bun test packages/framework/src/__tests__/cli/authored-map.test.ts \
  packages/framework/src/__tests__/cli/authored.test.ts \
  packages/framework/src/__tests__/cli/compose.test.ts \
  packages/framework/src/__tests__/cli/visualize.test.ts \
  packages/framework/src/__tests__/build-described-dag.test.ts \
  packages/framework/src/__tests__/validate-dag.test.ts
bun run --cwd packages/framework typecheck
bun scripts/check-doc-links.ts
REDIS_URL=redis://:fugue-test@127.0.0.1:6380 bun run verify
```

Registered evidence is produced only by Loom running `project:authored-map-regression` and freshly observing its configured JUnit report.
