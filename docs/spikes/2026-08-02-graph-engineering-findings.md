# Graph Engineering — Findings for Fugue and Loom

**Date:** 2026-08-02
**Branch:** main (at `d3bab59`)
**Status:** Research note — no work started
**Source:** ["Graph Engineering explained in 8min.."](https://youtu.be/mBePcvqLX88) (YouTube, ~8 min)

## Why this note exists

An explainer video on "graph engineering" describes how Claude Code's deep
research generates a fresh multi-agent DAG per request. Watching it against
Fugue's current source surfaced four concrete gaps in Fugue and five in Loom.
This note records the source material, the findings, and — importantly — what
we should deliberately *not* copy.

Every claim about our own code below was verified against the tree at
`d3bab59`; file/line references are included so they can be re-checked when
this note ages.

---

## Part 1 — What the video actually says

### The artifact

Claude Code's deep research does not run one agent. For each request it
generates a **~427-line JavaScript workflow** that acts as a runtime and
spawns **107 agents across 5 phases** (the video's narration says 108; the example widths below sum to 1 + 5 + 25 + 75 + 1 = 107, and this note uses the graph's own count). A different request produces a
different graph with different agent counts. The example graph:

```
1 scoping agent
  → 5 source-gathering agents      (one per subtopic; N chosen by the scoper)
    → 25 fetch agents               (5 per subtopic)
      → 75 verification agents      (3 per fetch — they VOTE on credibility)
        → 1 report writer
```

Execution flows one direction, no loops: a directed acyclic graph. The widths
(5, 25, 75) are **decided at runtime by an upstream node**, not by the author.

### The thesis

Agent graphs were tried in 2023 and did not stick — AutoGen (Microsoft),
LangChain's cyclic-graph work that became LangGraph, and Anthropic's five
workflow patterns (prompt chaining, routing, parallelization, orchestrator,
evaluator-optimizer). All correct, all premature.

Quoting LangChain via the video:

> "What changed wasn't the graph, but more in what the node can do."

In 2023 a node was a single LLM call. Today a node is Claude Code or Codex CLI
— a full agent with tools and a harness. Coding agents (Cursor, Cline, Roo,
Windsurf) spent the intervening years going prompt engineering → context
engineering → better harnessing: **all node depth, no edges.** So:

> "The bottleneck started to shift away from what the node can do, but into a
> graph and the edges that connect the nodes together."

The open engineering problem is now **decomposition**: given a genuinely
capable node, how should a task be structurally divided.

### The honest drawback: tokens

Per Anthropic's multi-agent research post, a single agent uses ~4× a normal
chat; a multi-agent system ~15×. Concretely for the 107-agent run: ~20k input
tokens per agent on Opus 5 ≈ **$10 of input alone — but ~$1 with prompt
caching.**

**Prompt caching is what makes fan-out economically viable.** It is a 10×
lever, not a micro-optimization. This matters for us directly (Fugue finding
4).

### Benefits, stated plainly

1. **Wall-clock** — agents work simultaneously.
2. **Separation of concerns** — each agent owns a context window and a system
   prompt, instead of one agent thrashing between goal, current task, and
   repeated re-summarization.

---

## Part 2 — Fugue findings

### Framing: we already do the safe version of this

`fugue compose` has an LLM author a closed `AuthoredDag` JSON, proves it
through the gauntlet (codegen → `defineDag` structural checks → `fugue lint` →
`fugue describe`), and generates graph code deterministically. The LLM never
hand-writes `defineDag`. That is "generate the graph per request" done without
letting a model emit 427 lines of runtime JS.

**The lesson to take from the video is dynamic *width*, not dynamic *code*.**
Fugue should not move toward on-the-fly arbitrary code generation — the
gauntlet exists precisely because that is unsafe.

### F1 — Runtime-width fan-out (highest leverage)

**Gap.** `DAG_SHAPES` is `["linear", "fan-out", "diamond", "router", "sources"]`
(`packages/framework/src/types/dag.ts:184`) and `DagDefInput.nodes` is a static
record keyed at author time (`packages/framework/src/types/dag.ts:152`).

**Fugue cannot express the video's graph.** The entire point of 5 → 25 → 75 is
that the scoper decides N at runtime. Today you would hard-code the widths, or
not build it.

**Proposal.** A `map` / scatter-gather node kind: one child sub-DAG applied
over a runtime array, with a **declared max width** and a typed reducer at the
gather. It stays acyclic and stays statically typed at the sub-DAG level, so
`defineDag`'s illegal-states-unrepresentable property survives.

Design consequences to work through before writing code:

- **Checkpoints** are keyed by `nodeId` today; a mapped node needs
  `nodeId + index` addressing so crash-resume can restart a partial fan.
  (`packages/framework/src/dag-runtime/persistence.ts`,
  `checkpoint/`.)
- **`describe` / Mermaid** should render a *plate* with a multiplicity
  annotation, not N boxes. The renderer is shared between `fugue visualize`
  and compose previews (`cli/visualize.ts` — `describedToMermaid`), so this is
  one change, not two.
- **`AuthoredDag`** needs a `widthFrom: <field>` reference added to its closed
  schema (`cli/authored.ts`) — a field reference, not an expression language,
  consistent with how routing predicates are already `{ field, equals }`.
- **Wave scheduling** (`dag-runtime/wave-execution.ts`,
  `wave-resolution.ts`) currently resolves waves over a static node set.

**Do not start F1 before F3 and F4.** Data-dependent width without a budget is
unbounded spend, and without prompt caching it is unbounded spend at 10× the
necessary rate.

### F2 — Quorum as a routing node, not a post-hoc alarm

**Gap.** `evalJudges` (`types/dag.ts:159`, `dag-runtime/eval-judges.ts`) run
*after* the output node and mark the trace ERROR on failure. That is an
assertion, not a decision — the graph has already finished by the time a judge
disagrees.

The video's 75 verifiers **vote**, and the vote changes what happens next.

**Proposal.** A `quorum` node kind: N independent judges over the same input, a
k-of-n threshold, and a verdict ADT — `Confirmed | Refuted | Split` — that
feeds an existing `router`. Verification becomes an edge instead of an alarm.

`NodeKind` is currently `"fetch" | "transform" | "llm" | "guardrail" |
"eval-judge"` (`packages/framework/src/types/node.ts:32`), so this is an
additive union member plus exhaustive-match updates.

Composed with F1 (fan a judge over a runtime `n`), F1+F2 give us the
deep-research shape natively.

### F3 — A cost/budget capability

**Gap.** Builtin capabilities are `llm, cache, prompts, judgeLlm, http, clock`
(`packages/framework/src/types/node.ts:183`). There is **no token or cost
budget**. The only `budget` matches in the source are `thinking.budgetTokens`
(`types/llm.ts:44,147`), which is unrelated.

**Proposal.** A `budget` capability with a per-run ceiling, `spend()` /
`remaining()`, and **fail-closed** exhaustion. This fits Fugue's existing
capability discipline exactly — nodes declare `requires`, the host brokers the
instance — and makes the video's 15× figure a typed, enforced runtime concern
instead of a billing surprise.

This is a **precondition for F1**, not a follow-up.

> **Superseded, 2026-08-27.** The premise above ("There is **no** token or cost
> budget") was already wrong when written: `llmBudgetTokens` had shipped in W1,
> enforced per-run by the metered-llm decorator. The real gaps were narrower and
> different — a ceiling denominated in tokens rather than money (which prompt
> caching made actively misleading), no durability across a park/resume, no
> node-visible capability, and coverage of only one LLM client. See
> `docs/plans/2026-08-27-f3-budget-capability.md` §1 and ADR-0082. The proposed
> `spend()` was deliberately not built; see ADR-0082 for why.
>
> **Completed, 2026-08-30.** F3 now ships the seventh built-in `budget`
> capability (`spent()` / admission-safe projected `remaining()`), one Run
> Spend Authority shared by main, judge, and explicitly marked custom LLM
> clients, plus Redis/in-process/file ledger adapters. ADR-0083 records the
> durability and settled-call error policy.

### F4 — Prompt caching is entirely absent (10× economics gap)

**Gap.** Grepping `packages/framework/src` and `packages/host/src` for
`cache_control` / `cacheControl` / `promptCach` / `prompt_cach` returns **zero
hits.**

The video's $10 → $1 is *entirely* prompt caching on the shared prefix. The
moment nodes fan out over a shared system prompt and shared context — which is
exactly what F1 enables — Fugue's fan-out costs roughly 10× what it should.

**Proposal.** Surface cache-control on the shared prefix through the `llm`
capability. Worth doing before F1 ships, not after.

### F5 — Positioning

The video accidentally argues Fugue's case. A generated 427-line JS runtime
has no crash-resume, no HITL gate, no capability scoping, and no replay.

The README currently leads with "DAG-shaped, durable runtime for LLM-bearing
workflows." A sharper line, in the video's own frame: *the bottleneck moved
from the node to the edges — and edges need to be durable and typed.*

### Suggested order

```
F4 (prompt caching)  ─┐
F3 (budget capability)─┴→ F1 (runtime-width fan-out) → F2 (quorum node)
```

F5 is independent and cheap.

---

## Part 3 — Loom findings

Loom is already a graph engine, but **every width is a constant**: 8–12 tasks,
4–5 waves, 4–6 parallel tasks per wave, 5 reviewers per task, and 3 designers ×
3 judges in panel mode.

### L1 — The review gate has no vote, and we have been paying for it

**This is the highest-value item on either list**, because the failure mode is
already documented and recurring in this repo.

Loom's wave gate spawns 5 reviewers per task (`code-reviewer`,
`silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`,
`comment-analyzer`). That produces five independent opinions merged by whoever
reads them. Nothing adjudicates a plausible-but-wrong finding.

We have been working around this with prompt patches rather than structure:

- a **delta review strategy** for multi-pass PRs, specifically to avoid
  re-surfacing known false positives;
- an **explicit architectural-intent briefing** telling review agents that
  Fugue's never-throw / fail-closed / ADT / idempotency patterns are deliberate
  design, not defects.

Both are bandages over a missing verification stage.

**Proposal.** Add a k-of-n adversarial verify stage after the reviewers: each
finding gets N skeptics *prompted to refute it*, and a majority refutation
kills the finding. This is the video's 75-verifier vote applied to the exact
problem we keep hand-patching.

### L2 — Promote panel mode from a Phase-3 flag to an engine primitive

`/loom --panel` already implements the video's pattern correctly: lens-diverse
fan-out (`simplicity-first`, `type-driven-fp`, `risk-security-first`,
`performance-first`, `codebase-conventionist`), schema-checked judge JSON with
exact candidate coverage and score-bound validation, deterministic tie-breaks,
then synthesis.

That machinery is built, tested, and sitting behind a flag in **one phase**.
The same primitive works for:

- **decompose** — competing task graphs judged against interview criteria;
- **the review gate** — L1 is literally panel mode pointed at findings.

### L3 — Replace task-count caps with a budget

"8–12 tasks, 4–5 waves, 4–6 per wave" are arbitrary constants standing in for a
cost concern. The honest version is a token/agent budget that decompose sizes
against. Widths should follow the work, not a constant — same reasoning as F3.

### L4 — Loop-until-dry for discovery-shaped phases

Waves are counted. But review and spec-check are **discovery**-shaped, and
"run the 5 reviewers once" systematically misses the tail. The right
termination for those phases specifically is: keep going until K consecutive
rounds surface nothing new.

Note this applies to the *discovery* phases only — not to implementation waves,
where the task graph is known up front.

### L5 — Surface usage headroom per wave *(revised)*

Loom spawns a lot of agents and reports nothing about what that consumes.

**Originally written as "surface token spend," which is wrong for this setup.**
Loom runs on **subscription auth**, not per-token API billing — there is no
dollar figure to report, and the video's 15× *cost* framing does not transfer.
The real ceiling is the rate limit and the usage window.

So the useful signal at the gate is **usage-window headroom**, not spend — and
only if the harness exposes it. The same correction applies to L3: the budget
that should replace loom's task-count caps is denominated in quota, not cost.

Note this cuts the other way on Pi, which can call several subscriptions: the
fan-out ceiling is much higher there, and the spare capacity is better spent on
**model diversity across verifiers** than on more agents against one model. See
the adversarial-review-panel plan's *Cost model* section.

---

## Part 3b — Reusing the panel-mode machinery for adversarial review

Loom has an **open PR** building architecture panel mode (PR #17,
`feat/architecture-panel-mode-plan`, 37 files, +3946/-61). Since L1 proposes
exactly the pattern that PR implements, this section audits what is *actually*
reusable.

> **Update 2026-08-02:** the PR was reviewed against this plan and the review's
> findings were implemented on the branch — see "Review outcome" at the end of
> this section. The reusability analysis below still stands; the aggregation gap
> it depended on is now closed.

**Verdict: the validation kernel is highly reusable; the domain content is
not; and there is one hard prerequisite that blocks the whole thing.**

### What the panel PR built

| Artifact | LOC | What it is |
|---|---|---|
| `engine/src/core/panel-contract.ts` | 343 | Pure functional core — all parsing and validation |
| `engine/src/handlers/helpers/panel-contract.ts` | 190 | Imperative shell — path binding, symlink rejection, canonical stdout |
| `agents/arch-judge-agent.md` + `commands/templates/phase-arch-judge.md` | — | Adversarial judge: headless, pure JSON, one criterion |
| Finalize aggregation (`phase-arch-finalize.md` §2) | — | Deterministic total-score ranking with a 4-level tie-break |

### Directly reusable

**1. `parseJudgeVerdict` — the single most reusable artifact.**
(`core/panel-contract.ts:253`.) It validates untrusted judge JSON against an
expected criterion and an expected item set, enforcing:

- criterion identity (exact string match);
- **exact coverage** — every expected item ranked exactly once, no foreign
  items, no duplicates, explicit "missing candidate" errors;
- integer scores bounded 0–10;
- non-increasing score ordering;
- `fatal_flaw: string | null` with non-empty-after-sanitization;
- non-empty `strongest_idea`;
- brace-stripping sanitization (`sanitizeProse`) so validated prose is safe to
  substitute into a template.

Substitute *candidates → findings* and this is precisely the contract an
adversarial review verdict needs. Exact coverage is what stops a verifier from
hallucinating a finding or silently dropping one it did not bother to check.

**2. The manifest principle.** The panel's core discipline, stated in its own
docs: *an exact manifest — not directory discovery — defines the item set.*
Judges read `manifest.candidates[].path` and never scan a directory. The
review analogue is: **fix the finding set in a manifest before verifiers
spawn**, so a verifier can neither invent findings nor skip them. This is the
structural fix for our false-positive problem, and it is the part worth
copying most literally.

**3. The reject-and-retry-once protocol.** Validate raw agent output at a CLI
seam (`bun engine/src/cli.ts helper panel-contract verdict …`), emit canonical
JSON on success, and on failure re-spawn *only the invalid agent* with
field-level diagnostics, exactly once, then stop. This transfers verbatim.

**4. `ParseResult<T>` and the run-boundary hardening.** `ParseResult` is
already generic. The shell's path handling — run root must be inside cwd,
every path component checked for symlinks, artifacts must be non-empty regular
files resolving inside their run-scoped directory — is domain-agnostic and
path-parameterizable.

### Not reusable as-is

- **`parseInterviewDigest`** (`:73`) is architecture-specific: 14 labeled
  fields, `PRIMARY_AXES`, `TESTABILITY_BARS`, `CODEBASE_MATURITIES`. The
  *pattern* transfers (labeled field at column 0, exactly once, non-empty,
  enum-validated); the content does not.
- **`PANEL_LENSES`** — `simplicity-first`, `type-driven-fp`,
  `risk-security-first`, `performance-first`, `codebase-conventionist` are
  *design* lenses. Review needs its own set (e.g. does-it-reproduce,
  security-refuter, intent-checker). But `selectPanelLenses`'s signal-driven
  selection (`:135` — flagged sensitive boundaries pulls in the risk lens)
  transfers directly: a task touching auth should pull in the security
  refuter.
- **The scoring model.** A panel judge emits a 0–10 score with a non-increasing
  ordering invariant. A *refutation* verdict is a different shape — an ADT
  (`refuted | upheld | uncertain`) plus reasoning — and the ordering invariant
  does not apply at all. So `parseJudgeVerdict` must become a **family**:
  shared identity/coverage/sanitization checks, with the per-item payload
  validator as a parameter. That is a real refactor, not a copy-paste.

### The hard prerequisite — findings have no identity

Panel mode's contract works because candidates have **stable identities**
(`candidate-<lens>.md`) fixed by a manifest before judges spawn.

**Review findings have no identity today.** In
`engine/src/handlers/subagent-stop/store-reviewer-findings.ts`, findings are
scraped out of an agent transcript by regex —

```
/^[\s\-*]*\*{0,2}CRITICAL(?!_COUNT):?\*{0,2}\s*(.*)/
```

— and accumulated into `critical_findings?: string[]` /
`advisory_findings?: string[]` on the task (`engine/src/types.ts:133-134`).
Plain strings. No id, no file, no line, no category.

**You cannot run a k-of-n vote on unidentified strings.** There is nothing for
verifier 1 and verifier 2 to agree they are talking about the same finding, and
nothing for the aggregator to key a tally on.

So the real prerequisite is: **give findings identity.** Reviewers emit a
finding manifest — stable id, file, line, category, claim — written to a run
directory exactly as the candidate manifest is. Note this fix is independently
valuable: identified findings are also what the delta-review strategy and the
architectural-intent briefing are hand-rolling around today.

### Sequencing

1. **Land the panel PR first.** Refactoring `panel-contract.ts` while it is
   under active remediation invites conflict — plan against its final shape.
2. **Give findings identity** — finding manifest + structured record replacing
   `string[]`. The prerequisite, and useful on its own.
3. **Generalize `panel-contract.ts` into a panel kernel** — manifest binding,
   coverage validation, sanitization, retry protocol; item-payload validation
   becomes a parameter. Architecture panel becomes the first instantiation, the
   review panel the second. This is L2 (promote panel to an engine primitive)
   made concrete.
4. **Add the refuter verdict type and a `references/review-lenses.md`.**
5. **Wire the verify stage into `commands/wave-gate.md`** between Step 3
   (reviews) and Step 4 (GH comment).

Steps 3–5 are what make L1 real. Step 2 is the one that cannot be skipped.

### Review outcome (2026-08-02)

The PR was reviewed against this plan. The review found **one significant gap
plus three minor items; all were implemented on the branch.** Full suite green
afterwards: 1740 tests (up from 1708), `tsc --noEmit` clean, linter clean on
every changed file, panel-mode smoke script 10/10.

**The significant one — aggregation was the only unvalidated handoff, and it was
the one the review panel needed most.** The PR hardens four untrusted LLM
handoffs into typed, fail-closed parsers. But the step that decides *which
candidate wins* — total score, then tie-breaks — existed only as prose in
`phase-arch-finalize.md` §2, performed by a model doing arithmetic by hand.
Grepping `engine/src/` for `totalScore|aggregate|rankCandidates|tieBreak` found
nothing. Two hazards came with it:

- the tie-break referred to verdicts **positionally** ("the first verdict", "the
  second verdict"), coupling the finalize template to the criteria order in
  `commands/loom.md` with nothing enforcing agreement; and
- nothing validated the verdict **set** — the coverage rule enforced *within* a
  verdict had no analogue one level up, so two verdicts sharing a criterion
  would silently produce a wrong tie-break.

This mattered for L1 because **a k-of-n refutation tally is aggregation.** Left
in prose, adversarial review would have inherited an unvalidated vote count —
defeating the point of adding verification at all.

Implemented:

| Change | Where |
|---|---|
| `deriveJudgeCriteria(digest)` — criteria derived in code, not loom.md prose | `core/panel-contract.ts` |
| `aggregateVerdicts(verdicts, criteria, candidates)` — matches verdicts to criteria **by name**, rejects duplicate/missing/unexpected criteria, re-checks per-verdict candidate coverage, ranks by total → each criterion in order → lexical filename | `core/panel-contract.ts` |
| `serializeRankings` — canonical output; per-criterion scores as an array of pairs, never object keys (criteria are free text) | `core/panel-contract.ts` |
| `criteria` and `aggregate` CLI operations; `aggregate` re-reads and re-validates every verdict from disk rather than trusting the judge step | `handlers/helpers/panel-contract.ts` |
| `verdict` now rejects a `--criterion` outside the derived set | `handlers/helpers/panel-contract.ts` |
| New Step 4.5 (aggregate); finalize template §2 reads the ranking instead of computing it, via a new `{panel_ranking}` variable | `commands/loom.md`, `phase-arch-finalize.md` |

The generalized tie-break is equivalent to the documented one: with the total
tied and every earlier criterion tied, the remaining criterion is forced to tie
too (the total is their sum), so walking criteria in order reproduces
primary-axis-then-testability exactly — with no positional special cases, for
any K. That matters for reuse: the review panel's K is per-finding, not 3.

Minor items, also fixed: `JudgeRanking.score` could hold `NaN` on the error path
(unreachable, but the ordering scan compares with `<`, always false against NaN
— a trap for exactly the reuse step 3 plans); `parseInterviewDigestJson` now
rejects embedded line terminators instead of mis-blaming a different field; and
two comments pointing at loom.md as the criteria source were corrected.

**Deliberately not done: the §2 seam extraction (step 3 above).** Extracting a
kernel for a consumer that does not exist yet is speculative generality, and the
review panel's real blocker is findings having no identity (step 2). The seam
list stands as written; the extraction stays a separate change.

It is now planned in
`claude-plugins/loom/.claude/plans/2026-08-02-adversarial-review-panel.md`.
Two things that plan concluded, which revise the seam table above:

- **No `PanelKind` framework.** Extract shared *primitives* (~4 functions), not
  a parameterized descriptor. The two panels differ in item identity (closed
  ordered lens enum vs open unordered finding ids), criteria semantics, and
  aggregate output type (a total order vs a per-item verdict). A descriptor
  general enough to cover both would buy indirection, not type safety.
- **The envelope is shared only because of a specific design choice:** the
  review panel spawns N verifiers each covering ALL findings (one per lens),
  not N verifiers per finding. That makes a review verdict structurally
  identical to an architecture verdict — one verdict per criterion covering
  every item exactly once — so `parseVerdictEnvelope` is reusable verbatim.
  Had we gone per-finding, there would be nothing worth extracting.

---

## Part 4 — What we should deliberately not do

- **Fugue must not adopt on-the-fly generation of arbitrary runtime code.** The
  gauntlet and the closed `AuthoredDag` schema are the point. Take dynamic
  *width*; leave dynamic *code*.
- **Loom's phase spine must stay fixed.** Fresh-graph-per-request is right for
  research and wrong for spec→ship, where the phases *are* the contract.
  Dynamism belongs at the widths (L3), not the spine.
- **Do not treat the 15× token figure as a reason to avoid fan-out.** It is a
  reason to build F3 (budget) and F4 (caching) first. With caching the same run
  is ~$1.

---

## Appendix — verification log

Claims about our tree, and how they were checked at `d3bab59` (loom-side line anchors re-verified 2026-08-12 against `feat/architecture-panel-mode-plan` post-refactor; the one `main`-only row is marked):

| Claim | Evidence |
|---|---|
| Shapes are a closed static set | `packages/framework/src/types/dag.ts:184` |
| Nodes are a static author-time record | `packages/framework/src/types/dag.ts:152` |
| `NodeKind` has no map/quorum member | `packages/framework/src/types/node.ts:32` |
| Eval judges run post-output, mark trace ERROR | `packages/framework/src/types/dag.ts:159` |
| No budget/cost capability exists | `packages/framework/src/types/node.ts:183` (`llm, cache, prompts, judgeLlm, http, clock`); only `budget` matches are `thinking.budgetTokens` at `types/llm.ts:44,147` |
| No prompt-cache plumbing | grep for `cache_control`/`cacheControl`/`promptCach`/`prompt_cach` over `packages/framework/src` + `packages/host/src` → 0 hits |
| Compose keeps the LLM inside a closed schema | `packages/framework/src/cli/compose.ts:1-24`, `cli/authored.ts:1-18` |
| Mermaid renderer is shared | `cli/visualize.ts` (`describedToMermaid`), used by both `fugue visualize` and compose previews |
| Loom caps and review cohort | `loom/README.md` — Phase 4 decompose limits, wave-gate review agent table, panel-mode section |
| Panel PR is open, not merged | `gh pr view` → PR #17, OPEN, base `main`, 37 files, +3946/−61 |
| Aggregation existed only as prose (pre-fix) | `grep -rn "totalScore\|aggregate\|rankCandidates\|tieBreak" loom/engine/src/` returned only `lint-wave-gate.ts` hits; rule stated in `commands/templates/phase-arch-finalize.md` §2 |
| Positional verdict coupling (pre-fix) | `phase-arch-finalize.md` §2 "the first verdict"/"the second verdict" vs criteria order in `commands/loom.md` Step 4 |
| Post-fix state | 1740 tests pass / 0 fail; `bunx tsc --noEmit` exit 0; `hooks/scripts/lint-file.sh` clean on all changed files; `scripts/smoke-panel-mode.sh` PASS 10 / FAIL 0 |
| Judge verdict validation invariants | `loom/engine/src/core/panel-contract.ts:415-433` (`parseJudgeVerdict`) |
| Manifest-not-directory-discovery rule | `loom/engine/src/core/panel-contract.ts:301` (`parsePanelManifest`); restated in `agents/arch-judge-agent.md` step 2 and `commands/templates/phase-arch-judge.md` step 2 |
| Signal-driven lens selection | `loom/engine/src/core/panel-contract.ts:240` (`selectPanelLenses`) |
| Panel constants (3 designers, 3 judges, 5 lenses) | `loom/engine/src/config.ts:184,187,195,202` |
| Judge criteria derivation (K=3, fixed order) | `loom/commands/loom.md:276-280` |
| Deterministic finalize tie-break | `loom/commands/templates/phase-arch-finalize.md` §2 |
| **Findings are unidentified strings** (`main` only) | `loom/engine/src/handlers/subagent-stop/store-reviewer-findings.ts` (regex `extractFindings`); `loom/engine/src/types.ts:133-134` — true against loom `main`; the panel branch has since given findings identity (`core/findings.ts`, parsing moved to `core/review-output.ts`) |

Transcript note: the video's auto-captions garble several product names —
"Kline, Rue, Winster" are Cline, Roo, and Windsurf; "Menace" is Manus. The
video also contains a ~1-minute sponsor segment (Zo Computer) with no bearing
on the technical content.
