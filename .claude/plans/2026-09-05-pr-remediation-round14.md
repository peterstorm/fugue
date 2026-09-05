# PR #41 Remediation — Round 14

**Branch:** `feat/f3-budget-capability-surface` → `main` (PR #41, "feat: complete F3 budget capability surface")
**Review HEAD:** `d61681588cdcfa80a1a3a265efe39475ff8ac3b3` (working tree clean at review time)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-05T20-00-00Z-standalone-review-r14`
**Canonical authority:** that run's `result.json` (digest `4f9900644ad9c585ebda10356681001914dcd511da7fc92084f2bb4bd5e86a44`)

**Scope:** the frozen 173-file review scope — `packages/framework/src/**`, `packages/host/src/**`, their tests,
`docs/` ADRs and plans, `CONTEXT.md`, `.gitignore`, and the customer-summary example node.

**Panel outcome:** 2 surviving criticals, **0 refuted**, 9 advisories.

### A note on the counts

`result.json` lists 2 criticals and 9 advisories, but several are the **same finding counted twice** — each reviewer's
prose finding and its `Machine Summary` line were both parsed as findings. The distinct issues are:

| result.json ids | distinct issue |
|---|---|
| `type-design-analyzer-1`, `-2` | **CRITICAL** — `LlmClient` method-shorthand bivariance |
| `code-reviewer-1`, `-2` | A1 — `run-dag.ts` drops 5xx diagnostic detail at two call sites |
| `pr-test-analyzer-1`, `-2` | A2 — co-failed-siblings fence untested against a hostile clock |
| `comment-analyzer-1`, `-2` | A3 — `unionModels` doc comment describes code that isn't there |
| `architecture-tech-lead-1`, `code-simplifier-1` | A4 — own-data snapshot algorithm reimplemented 5× |
| `code-simplifier-2` | A5 — `executor.ts`'s `emitFailure` duplicates `nodeErrorEmitter` |

Every id is dispositioned below; the duplicates share one fix.

---

## Refuted-finding audit

**None.** The refutation panel ran all three lenses (reproduction, intent, blast-radius) over the critical and
**all three upheld it**, each with independent evidence:

- **reproduction:** confirmed `sendWithTools` uses genuine method-shorthand at `types/llm.ts:283-286`, and
  `tsconfig.base.json` sets `strict: true` (so `strictFunctionTypes` is on) — "no config or code fact found that
  closes the hole."
- **intent:** `types/llm.ts:185` already defines `TypedNodeContext<["llm"]>`, a narrower structural variant, so
  "the narrowing path the finding describes is a real, already-instantiated type in this codebase, not a
  hypothetical"; nothing in `llm.ts` documents the shorthand as a deliberate tradeoff.
- **blast-radius:** the production dispatch path at `nodes/llm-with-tools.ts:175` passes a plain `NodeContext`
  straight through, and `LlmClient` has four implementations (openai, anthropic, fake, host's metered decorator),
  "giving the hole a real multi-implementer surface rather than a narrow theoretical one."

---

## Surviving critical (mandatory)

### C1 — `packages/framework/src/types/llm.ts:277,283` (`type-design-analyzer-1` + `-2`)

`LlmClient` declares both members with TypeScript **method-shorthand** syntax:

```ts
sendStructured<O>(req: LlmRequest<O>): Promise<…>;
sendWithTools<O>(req: SendWithToolsRequest<O>, ctx: NodeContext): Promise<…>;
```

Method shorthand is checked **bivariantly** even under `strictFunctionTypes`; an arrow-typed `readonly` property is
checked contravariantly (soundly). So an implementation may narrow `ctx` to a type requiring fields beyond
`NodeContext`, still satisfy `LlmClient` structurally, and crash at runtime when the framework invokes it with the
plain `NodeContext` it built itself — with no compile-time signal.

This is not a general TypeScript nit: **the codebase already documents this exact hazard and defends against it**
one file over, for `CapabilityBroker.mintFor` (`types/capability-broker.ts:143-153`):

> "Declared as a readonly function property rather than method shorthand: method shorthand is checked bivariantly
> even under `strictFunctionTypes` … an implementation that narrowed `inv` or `requires` must not type-check."

`LlmClient` is the most-implemented port in the framework, so the undefended surface is larger than the one case
that was defended.

**Fix:** declare both members as `readonly` arrow-typed properties, matching `CapabilityBroker.mintFor` and every
other port in the codebase (`SpendLedgerPort`, `TenantRegistryView`, …).

**Already verified:** applying this change and running `bun run typecheck` across **all 12 workspace packages exits
0** — no existing implementation was relying on the bivariance, so this closes the hole with zero call-site fallout
and needs no support paths. A regression pin is added so the property syntax cannot silently regress.

---

## Advisory dispositions

All 9 ids **accepted** (5 distinct fixes). None deferred, none dismissed — each claim was verified against current
source, and each fix is complete and inside the frozen scope or on a declared support path.

### A1 — `packages/host/src/http/handlers/run-dag.ts:193,296` (`code-reviewer-1`, `-2`) — accepted

Round 13's own fix made `hostErrorResponse` log a server fault's `detail` instead of sending it, and its doc comment
says so ("its detail is logged instead"). But `logger` is an optional 5th parameter and **only the HITL call site
(line 237) passes `deps.logger`**. Verified: `dag-disabled` (line 193) and `circuit-open` (line 296) are both 503 →
`server-fault`, and both call `hostErrorResponse` without a logger. Since `logWithoutThrowingTo` calls
`logger?.[level]?.(…)`, an absent logger is a true no-op — it never throws, so even the stderr fallback never fires.
The reason a request was refused is then neither sent to the client nor logged anywhere.

**Fix:** thread `deps.logger` at both call sites. Also make the omission structurally hard to repeat rather than
relying on the next author remembering: the round-13 tests only covered the one path that happened to pass it.
**Regression test:** a `dag-disabled` and a `circuit-open` request must each keep internal detail out of the body
*and* produce a server-side log entry carrying it.

### A2 — `packages/framework/src/dag-runtime/wave-execution.ts:236` (`pr-test-analyzer-1`, `-2`) — accepted

Round 13's C1 fix fenced three `emit` sites; the regression suite drives a hostile clock through only two. The
co-failed-siblings loop (`failures.length > 1`, after `Promise.all` resolves) is unexercised — and it is the one
site whose throw would escape the async function body directly, discarding the primary `node-failed` event and its
`partialOutputs`.

**Fix:** add a test building a wave with **two** failing nodes plus a completing sibling, driven by the existing
`throwOnceClock`, asserting the `node-failed` event and its carried outputs survive.

### A3 — `packages/framework/src/types/spend.ts:330` (`comment-analyzer-1`, `-2`) — accepted

Verified: the doc comment says "The `?? a[0]` fallback is unreachable — `sorted` is built from `a`", but the code is
`canonicalModelNames([...a, ...b]) ?? a` — the fallback yields the whole array, and no local named `sorted` exists in
this function. The comment describes a version of the expression that isn't there.

**Fix:** rewrite to describe the actual expression and the actual reason the fallback is unreachable.

### A4 — own-data snapshot algorithm reimplemented 5× (`architecture-tech-lead-1`, `code-simplifier-1`) — accepted

Verified all five sites. The same "walk `getOwnPropertyDescriptors`, reject accessors and inherited members, require
an exact or dense own-data key set" algorithm is hand-rolled in:

- `framework/types/spend.ts` — `ownValue` (:184), `parseModelArray` (:213, a full dense-array walk)
- `framework/dag-runtime/run-node.ts` — `readOwnData`/`ownDataValue` (:166), whose comment claims to be "**ONE**
  encoding of the getter/proxy defence" — true only within that file
- `framework/dag-runtime/run-dag-stateful.ts` — `snapshotOrigin`'s local `hasExactly`/`dataValue` (:167)
- `host/adapters/metered-llm.ts` — `snapshotDataObject` (:41), `snapshotDataArray` (:72), and
  `snapshotPricingModel`'s own `hasExactly`/`dataValue` (:313)
- `host/adapters/run-spend-authority.ts` — `ownDataValue` (:111)

`run-spend-authority.ts` even *documents* sharing this boundary with `metered-llm.ts` but shares only the trivial
`isObjectLike` predicate. `parseModelArray` and `snapshotDataArray` are ~30-line near-duplicates differing only in an
element-type check and a `length <= 0` vs `< 0` bound.

The two reviewers split on the host half: the code-simplifier called it deepen territory because it needs a new
public export; the architecture reviewer — whose remit *is* module seams — recommends the full consolidation. **Taking
the architecture reviewer's scope**, since a framework-internal-only extraction would leave the host's three copies
diverging from the primitive they were meant to match.

**Fix:** extract one pure primitive, `packages/framework/src/types/own-data.ts`, exporting `readOwnDataProperty`,
`hasExactOwnKeys`, `snapshotOwnDataObject`, and `snapshotOwnDataArray`. It returns a **structured failure value**
(reason + offending key), never a rendered string, so every call site keeps its own wording and error type
(`string` vs `FrameworkError`) — no observable message changes. Ships with property tests (arbitrary getters,
Proxies, sparse arrays, prototype-chain properties) so the shared invariant is proven once rather than by
example three times over.

### A5 — `packages/framework/src/dag-runtime/executor.ts:120` (`code-simplifier-2`) — accepted

`post-wave-context.ts`'s `nodeErrorEmitter` doc says it is "THE one node-error emission" — and `executor.ts`'s
`emitFailure` builds a third identical copy, plus a `stack` field the shared one lacks (the divergence has already
started).

**Fix:** widen `nodeErrorEmitter` with an optional `stack` (backward-compatible for its two callers) and have
`executor.ts` use it, keeping only the `UnenrichedDagEvent` construction local.

**One thing this fix must not do quietly:** `nodeErrorEmitter` builds `timestamp: new Date(nowFn())` **unfenced**,
and `executor.ts`'s `emitFailure` is called from a `catch` handler. Routing a catch path through an unguarded clock
is precisely the C1 hazard round 13 fixed elsewhere, so the consolidated emitter is fenced with the same
`bestEffort` helper. That is a deliberate, documented part of this fix, not a silent extra.

---

## Support paths (outside the frozen review scope)

1. `.claude/plans/2026-09-05-pr-remediation-round14.md` — this plan.
2. `packages/framework/src/types/own-data.ts` — the A4 primitive (new file).
3. `packages/framework/src/__tests__/own-data.test.ts` — its property tests (new file).

The critical needs **no** support paths (verified: full typecheck clean). Every other touched path is inside the
frozen review scope.

---

## Validation commands

```bash
bun run typecheck                                  # all 12 packages
REDIS_URL=redis://localhost:6399 bun run test      # full suite, Redis-gated suites included
bun run check:docs && bun test scripts/
```

Remediation installs only after validation passes.

---

## Validation evidence (recorded after implementation)

`bun run typecheck` — **all 12 workspace packages exit 0.**

`REDIS_URL=redis://localhost:6399 bun run test` — **0 failures across every package:**

| package | pass | fail | vs. baseline |
|---|---|---|---|
| framework | 3488 | 0 | +32 |
| host | 2587 (+10) | 0 | +3 |
| customer-summary | 243 | 0 | — |
| ms-graph | 142 | 0 | — |
| http-auth | 90 | 0 | — |
| oracle | 79 | 0 | — |
| pg | 73 | 0 | — |
| fs | 25 | 0 | — |
| examples | 23 | 0 | — |
| xlsx | 20 | 0 | — |
| document-source | 18 | 0 | — |
| hitl-smoke | 10 | 0 | — |

`bun run check:docs` — 19 shipped doc files, all links resolve. `bun test scripts/` — 7 pass, 0 fail.

### Each fix verified to fail without its change

- **C1** — reverting `LlmClient` to method shorthand makes the variance pin fail typecheck:
  `TS2322: Type '"contravariant"' is not assignable to type '"BIVARIANT — the soundness hole has reopened"'`.
  The pin's first draft did **not** bite (a non-generic stand-in was unassignable for the wrong reason —
  signature arity, not variance); it was rewritten to preserve `<O>` and re-verified.
- **A1** — stashing the handler change fails both new tests (`logs the withheld detail when a disabled DAG is
  refused`, `… when an open circuit refuses a run`), 48 pass / 2 fail.
- **A2** — removing the co-failed-siblings `bestEffort` fence fails the new test with `error: clock failed`
  escaping `executeWave`, exactly the C1 hazard class.

### The extraction caught a real defect in itself

While migrating `types/spend.ts` onto the new primitive, the **existing** hostile-input test
(`keeps revoked and accessor-backed model arrays inside the Result boundary`) failed:
`TypeError: Array.isArray cannot be called on a Proxy that has been revoked`. The original `parseModelArray` had
its whole body inside a `try`; the extracted `snapshotOwnDataArray` had `Array.isArray` outside one. Fixed by
fencing the first inspection too, and pinned by a dedicated test — the first question asked of an untrusted value is
already a hazard. This is the consolidation earning its keep on its first day.

### Note on `hasExactOwnKeys`

The shared version rejects an object carrying an extra **symbol** key, where two of the former local copies
compared `keys.length` against a string-only list and would also have rejected it — same outcome, now pinned by a
test rather than incidental.
