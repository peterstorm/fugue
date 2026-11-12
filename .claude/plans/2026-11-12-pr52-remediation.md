# PR #52 remediation — review-and-fix

- **Branch:** `feat/f1-pr-d-fan-scheduling` (PR #52, F1 PR-D1, ADR-0090)
- **Scope:** the whole PR diff against `main` (77 files). It exceeds the single-run review budget, so it was reviewed as four disjoint slices that together cover every changed file.
- **Runs root:** `.claude/reviews/review-and-fix-runs`
- **Result:** 0 surviving critical findings, 0 refuted critical findings, 40 advisories. No Refutation Panel ran, so there is no refuted-finding audit and no Declared Repair Group; `defectFamily` is `not-required`.

## Review and policy runs

| Slice | Scope | Review run | Result digest | Policy run (initial revision, DECLARED) | Disposition digest |
|---|---|---|---|---|---|
| A | production framework + host code, authored CLI (29 files) | `pr52-review-a` | `6a843ca1a018d3a4bcd5e56038faa1bb809ba7016cb3b7fa49f03befbd5bc9ea` | `pr52-policy-a` | `9a553766aba0f3825d6aec75867fb3354294cb3dfe59605e049965ad88bd81d7` |
| B | unit and property tests (13 files) | `pr52-review-b` | `69386aa7a587afd6c069f86e7ad28added246227dbf607a7040646cd04d9e69c` | `pr52-policy-b` | `6dd374bf031f502888b1010f9f743998563330a2bdbb28c6355bb97c3d28a3ec` |
| C | integration and host tests (14 files) | `pr52-review-c` | `6beffd10240696d46394dce619ba60080b3afaa7fdef6023c629a729cb0c7e73` | `pr52-policy-c` | `22dc5b0b871a945a1b6273665eb805a8b4cbbecc657e16522cc239f917b861f7` |
| D | docs, plan, spec, lint rules, manifest (21 files) | `pr52-review-d` | `51476ac5264adddaa551b11a37db67011116019d89a616bccb8e28e29b326e29` | `pr52-policy-d` | `7b9cd6d96719694ccd5b5d391bdea136e2588aa85b4daadbd585e14885b71c03` |

## Advisory dispositions

Every disposition below is a DECLARED decision, published before implementation.

### Slice A — `pr52-review-a`

| Advisory | Decision | Reason |
|---|---|---|
| `silent-failure-hunter-1` | accepted | Sound: the seed-save failure log names only the displaced refusal; include the displaced fan error so child failures stay visible. |
| `silent-failure-hunter-2` | accepted | The usd axis is the only one not floored at 0 despite the documented contract; floor it so a measurement cannot fail a saved child. |
| `pr-test-analyzer-1` | accepted | Cheap table test pins the forged non-object scheduling branch of the snapshot gate. |
| `type-design-analyzer-1` | accepted | Every producer now freezes a parsed scheduling, so the optional field only keeps dead fallbacks alive; make it required and delete the stale PHASED comment and the three fallbacks. |
| `architecture-tech-lead-1` | accepted | Every producer now freezes a parsed scheduling, so the optional field only keeps dead fallbacks alive; make it required and delete the stale PHASED comment and the three fallbacks. |
| `architecture-tech-lead-2` | accepted | Mint the operator cap once in host composition and pass the branded FanConcurrencyCap into the executor deps; removes the second mint site. |
| `architecture-tech-lead-3` | deferred | Extracting a bounded-pool interpreter is an interface redesign of the fan shell; current behaviour is correct and fenced. Follow-up deepen session. |
| `code-simplifier-1` | accepted | Every producer now freezes a parsed scheduling, so the optional field only keeps dead fallbacks alive; make it required and delete the stale PHASED comment and the three fallbacks. |
| `code-simplifier-2` | accepted | brandOperatorFanCap is a pass-through; it disappears once the executor takes the branded cap. |
| `code-simplifier-3` | deferred | Reshaping RefusalDecision belongs with the already-deferred FanState/phase-union deepening of fan-machine.ts; doing it alone would churn the machine twice. |
| `code-simplifier-4` | dismissed | The duplication is deliberate and documented: the wire parse must be looser than the seed parse. The reviewer itself advises acting only on drift, and none exists. |
| `code-simplifier-5` | accepted | Build the scheduling block as lines; output bytes are pinned by the in-place ordering tests. |

### Slice B — `pr52-review-b`

| Advisory | Decision | Reason |
|---|---|---|
| `architecture-tech-lead-1` | deferred | A shared machine-driver harness across three suites is a test-architecture change; fold into the follow-up that also shares fixtures. |
| `code-simplifier-1` | accepted | Reuse ceilingsOfRemaining instead of a second definition of canonical seed ceilings. |
| `code-simplifier-2` | accepted | State the gate law as one biconditional assertion and inline the two one-use helpers. |
| `code-simplifier-3` | accepted | The parsed-DAG block repeats the preceding assertion and its comment overstates it; delete it. |
| `code-simplifier-4` | accepted | Hoist the duplicated base config so constructor and validator tests share one fixture. |
| `code-simplifier-5` | deferred | A shared sample/crash fixture module touches about eight test files; bundle with the deferred machine-driver harness. |
| `code-simplifier-6` | dismissed | Removing or merging these tests saves little and risks weakening per-arm assertions; the overlap costs nothing at runtime. |
| `code-simplifier-7` | dismissed | The named unit examples document the contract next to the property; tabulating them is taste, not a defect. |

### Slice C — `pr52-review-c`

| Advisory | Decision | Reason |
|---|---|---|
| `pr-test-analyzer-1` | accepted | Real gap: every host test uses a cap equal to the framework default, so a dropped dependency would pass; add a non-default cap test. |
| `architecture-tech-lead-1` | deferred | The golden recorder keeps its own wrapper so it can drive the pre-change runner; unifying it with the harness needs a typed trace sink. Only the childDag copy is shared now (code-simplifier-3). |
| `architecture-tech-lead-2` | dismissed | AS-031 is a spec acceptance scenario about the documented operator contract; the regex check is its executable form and stays with the scenario. |
| `code-simplifier-1` | accepted | One file-local makeExecutor states the required cap once instead of at about 25 call sites. |
| `code-simplifier-2` | accepted | Move tenfold, range, errorOf and refusalOf into fan-test-harness.ts; both suites already depend on it. |
| `code-simplifier-3` | accepted | Export childDag from the harness so the golden trace and the harness provably exercise the same child. |
| `code-simplifier-4` | accepted | One helper for the repeated rejection assertion; every spelling is kept. |

### Slice D — `pr52-review-d`

| Advisory | Decision | Reason |
|---|---|---|
| `code-reviewer-1` | accepted | The plan's ADR-0087 references now point at the unrelated xlsx ADR; replace them with ADR-0090. |
| `code-reviewer-2` | accepted | The manifest change is a leftover of this Loom run and would replace main's package checks on merge; restore main's manifest so the PR does not touch it. |
| `silent-failure-hunter-1` | accepted | The comma-only pattern misses kind-last literals; widen it to a closing brace while excluding ts-pattern match sites, verified by running the linter. |
| `silent-failure-hunter-2` | accepted | The plan's ADR-0087 references now point at the unrelated xlsx ADR; replace them with ADR-0090. |
| `silent-failure-hunter-3` | deferred | The root binds the budget capability for every budgeted DAG; a null budget on a budgeted DAG is a hypothetical composition bug, and signalling it needs a fan-start schema change. Follow-up. |
| `comment-analyzer-1` | accepted | The count is wrong: the table lists four settings. |
| `comment-analyzer-2` | accepted | Qualify the byte-identical claim everywhere: a budgeted C=1 fan still projects, may refuse earlier and writes a seed (ADR-0090 section 10). |
| `comment-analyzer-3` | accepted | Replace 'resumable' with the precise behaviour: non-retriable, seed persisted, continuing needs a larger budget. |
| `comment-analyzer-4` | accepted | The plan's ADR-0087 references now point at the unrelated xlsx ADR; replace them with ADR-0090. |
| `comment-analyzer-5` | accepted | Remove the branch and not-yet-merged wording, which becomes false on merge. |
| `architecture-tech-lead-1` | accepted | The comma-only pattern misses kind-last literals; widen it to a closing brace while excluding ts-pattern match sites, verified by running the linter. |
| `architecture-tech-lead-2` | accepted | The plan's ADR-0087 references now point at the unrelated xlsx ADR; replace them with ADR-0090. |
| `architecture-tech-lead-3` | accepted | The manifest change is a leftover of this Loom run and would replace main's package checks on merge; restore main's manifest so the PR does not touch it. |

## Accepted fixes

**Framework production (slice A)**

- `run-mapped-fan.ts` `persistSeed`: the seed-save failure log also names the fan error the write error displaces (primary child failure and count of others), not only the refusal.
- `fan/spend-window.ts`: make the usd floor at 0 explicit like the other axes. Verification showed the reviewer's premise was wrong — `microUsd` already clamps a negative value to 0 and never throws — so this is expression-only; a property test now pins never-throws and per-axis `max(0, after − before)`.
- `types/dag.ts`: `MapNodeDef.mapping.scheduling` becomes required; remove the stale PHASED comment and the fallbacks in `schedulingOf`, `describeScheduling` and `validate-dag.ts` that the optional field kept alive (the forged-snapshot gate stays).
- `cli/authored-codegen.ts`: build the scheduling block as lines; emitted bytes unchanged.

**Host production (slice A)**

- Mint `FanConcurrencyCap` once, in the host config parse (`domain/config.ts`), so no plain number exists past it; `createRunExecutor` and the sync path take the branded cap; delete `brandOperatorFanCap` and the second mint in `host.ts`.

**Tests (slices A, B, C)**

- `map-node.test.ts`: table test for a forged non-object `scheduling`; hoist the duplicated `base` fixture.
- `fan-overshoot.property.test.ts`: `seedFor` reuses `ceilingsOfRemaining`.
- `fan-overshoot.property.test.ts` (where the gate law lives): one biconditional assertion; inline the one-use helpers.
- `fan-fingerprint.test.ts`: delete the redundant parsed-DAG block and its comment.
- `fan-test-harness.ts` exports `tenfold`, `range`, `errorOf`, `refusalOf`, `childDag`; the fan suites import them.
- `run-executor.test.ts`: file-local `makeExecutor`; new test proving a non-default operator cap reaches the fan.
- `config.test.ts`: one helper for the repeated rejection assertion.
- New tests for the usd floor and the displaced-failure log.

**Docs and configuration (slice D)**

- Plan `2026-10-02-f1-pr-d-fan-scheduling.md`: ADR-0087 → ADR-0090.
- `.loom/verification-manifest.json`: restore the version on `main`.
- `inv-2-fan-errors-via-factory.json`: match kind-last literals too; verify with the linter.
- Host README: "four concurrency settings".
- Qualify "byte-identical at C=1" wherever it appears: a budgeted C=1 fan still projects, may refuse earlier and writes a seed.
- `docs/features.md`: the refusal is non-retriable, persists a seed, and continuing needs a larger budget.
- ADR-0090 status and the F1 plan header: remove branch / not-yet-merged wording.

## Validation

```
bun run typecheck
REDIS_URL=redis://localhost:6379 bun run test
bun run check:docs
Loom linter, full tier, over the changed files
```

Local Bun is 1.3.13 while `main` requires 1.4.2, so `bun run verify` stops at its prerequisite check and the `scripts/` tests that need 1.4.2 fail locally for that reason alone.

## Registered remediation

One schema-v2 remediation run sourced from `pr52-review-a`, `defectFamily: {"kind":"not-required"}`. Every touched path outside slice A (this plan, and the files of slices B, C and D) is declared in `supportPaths` at start, because a run authorises one frozen scope and the working tree holds all four slices' fixes.
