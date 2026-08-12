# Deep Research — Making Fugue better for LLMs, graphs, and its newest consumer: Loom

**Date:** 2026-08-12
**Branch:** main (at `d3bab59`)
**Status:** Research note — no work started on the findings proposed here
**Sources:** prior spike [`2026-08-02-graph-engineering-findings.md`](2026-08-02-graph-engineering-findings.md) (F1–F5 / L1–L5), vault `graph-engineering-loops-vs-graphs.md` (2026-08-05, 12-point rubric), the loom `feat/.../2026-08-09-orchestration-automation` plan, and a fresh verify of the Fugue tree against Loom's current engine.

## Why this note exists

The August 2 spike produced a Fugue roadmap (F1–F5) and a Loom roadmap (L1–L5) *as two parallel lists*. Ten days later that framing is no longer accurate: **Loom is now a concrete consumer of Fugue 0.4.0 and has already shipped most of its own side of the list (on its unmerged `feat/architecture-panel-mode-plan` branch — PR #17, open as of 2026-08-12; not on loom `main`)**, while driving its orchestration *directly through Fugue's public API*. The two-track model has collapsed into one system. This note re-derives the Fugue roadmap from Loom's actual, in-repo usage — which is stronger evidence than either of the earlier gap analyses alone, because it is no longer hypothetical.

Two headline facts drive everything below (both verified in-tree):

1. **Fugue `main` is frozen at 2026-07-16** (`d3bab59`). The journal confirms **0 commits on fugue during 2026-07-29 → 08-12**, the exact window of the graph-engineering analysis (08-02), the vault rubric (08-05), the Loom orchestration-automation plan (08-09), and Loom's 73+ commit push. While Loom sprinted *on top of* Fugue, Fugue did not move at all. The F1–F5 proposals have not shipped.
2. **Loom 0.4.0 integration is real and explicit.** Loom's orchestration-automation plan builds a "Fugue program runtime" on `@fuguejs/framework@0.4.0` — `Machine`, `JobLike`, `runStateMachine`, `replayEvents`, `defineDag`/shape helpers, `runDag`, `runResumableDagJob`, `createHumanReviewNode`, capability, conditional-edge and tracing APIs — and its AD-1 section states the constraint verbatim:

   > *"Use only Fugue 0.4.0's shipped public APIs. Agent-call nodes, nested subgraphs, cross-node loops, and dynamic fan-out remain explicit absent boundaries."*

That sentence is the single most important datum in this research: **Loom is actively building around the exact four primitives Fugue's own roadmap wants to ship.** The convergence is real, and it is being gatekept by Fugue's absence.

---

## Part 1 — State of play (verified 2026-08-12)

| Fact | Evidence | Implication |
|---|---|---|
| Loom's refutation panel (**L1**) built — branch only | branch `README.md` Step 3.5; findings carry identity (`${agent}-${ordinal}`); k-of-n verify over ALL criticals; shared envelope validator `core/panel-kernel.ts` — all on `feat/architecture-panel-mode-plan` (PR #17, open as of 2026-08-12) | The false-positive workaround is structurally resolved on the Loom side — on the branch; loom `main` still regex-scrapes plain-string findings |
| Findings identity exists (branch) | `engine/src/types.ts`, `core/findings.ts` (branch) — derived ids, never agent-chosen; loom `main` still carries `critical_findings?: string[]` (`types.ts:133`) | The "hard prerequisite" from the 08-02 spike is **done on the branch** |
| Loom drives programs through Fugue 0.4.0 | `engine/src/orchestration/fugue-program-runtime.ts`, `engine/src/orchestration/dags/*.ts` import `@fuguejs/framework` | Loom is now a real, in-repo consumer |
| Loom builds its own durable journal | `ProgramJournal` port + file-backed checkpoint + dedup (T7/RunDirHandle) | Fugue ships **no** non-Redis durable `JobLike`/checkpoint — see Finding F6 |
| Loom works around the 4 absent primitives | `wave-gate-operations.ts`: "Roster-sized work stays a VALUE inside these static nodes. There is no dynamic fan-out, because Fugue 0.4.0 has none" | Dynamic fan-out / agent node / subgraph / loop are the binding constraints |
| Fugue main frozen | `git log -1` = 07-16; journal "fugue: 0 commits" | F1–F5 unshipped; roadmap now stale against a real consumer |
| Conditional edges, HITL, Machine, replay all present | ADR 0015/0028/0029, CONTEXT.md, `Machine`/`replayEvents` public | The base you'd build the four primitives on is strong and proven by a second project |

---

## Part 2 — The 12-point capability rubric, fresh scorecard

Composite of ADK 2.0 + LangGraph + Anthropic's workflow patterns (from the 2026-08-05 vault note), re-graded with the 08-12 facts.

**Numbering note.** F-numbers are append-only: the 08-02 spike froze F1–F5 (F4 = prompt caching, F5 = positioning). Items added since are F0 (agent node), F6 (non-Redis durable `JobLike`), F7 (roster/`NonEmpty`), F8 (nested subgraph — drafted as "F4" in early versions of this note), F9 (bounded loop — drafted as "F5"), F10 (path-dependent capability scoping — the addendum's "M5a").

| # | Capability | Fugue (now) | Loom (now) | Binding consumer need |
|---|---|---|---|---|
| 1 | Conditional routing | ✅ ADR 0015/0028/0029 | ✅ refutation route (critical→panel / clean→finalize) | done |
| 2 | Fan-out / fan-in | ✅ static helpers only | ⚠️ parallel waves (implicit) | **F1 dynamic width** |
| 3 | Cross-node loop | ❌ ADR 0015: "out of scope" | ⚠️ machine resumed across resumes, not a back-edge | **F9 bounded loop** |
| 4 | Retry / error policy | ✅ retriabilityOf, exhaustive | ✅ machine attempt 1/2 | done |
| 5 | Durable state / crash-resume | ✅ but **Redis-only** | ⚠️ hand-rolled file journal | **F6 non-Redis durable** |
| 6 | Dynamic nodes / orchestrator-workers | ❌ | ❌ roster = value, no scatter | **F0 agent node + F1** |
| 7 | Human-in-the-loop | ✅ HITL suspend/resume | ✅ advisory decision gate (`createHumanReviewNode`) | done |
| 8 | Nested workflows | ❌ | ❌ four programs shell-sequenced | **F8 nested subgraph** |
| 9 | Capability scoping | ✅✅ best-in-class | ✅ capability-free validation/routing nodes | done |
| 10 | Observability / tracing | ✅ but prose bytes allowed | wants ids/hashes/counts, **no prose bytes** | **T1 tracing content policy** |
| 11 | External anchors | ✅ eval-judge/guardrails/freshness | ✅✅ evidence ledger | done |
| 12 | Optimizer / compile step | ❌ | ❌ | open (speculative, largest payoff) |

The column that matters: the four `❌` cells (3, 6, 8 + the dynamic half of 2) are *exactly* the four boundaries Loom's plan names as absent. Every remaining gap Loom closes itself.

---

## Part 3 — What Loom now needs from Fugue (reversed requirements)

This is the new evidence. Each row is a requirement Loom actually wrote into its plan, satisfied today only by a defensive value or a hand-rolled adapter — the concrete surface Fugue should ship.

### C1 — Agent node (spawn semantic workers) — **F0, highest value**
Loom's orchestrator returns `ExternalAction { kind: "spawn-batch" }` and Fugue has no way to represent an agent. A node that *is* a delegated sub-agent (own context budget, model tier, lifecycle, tool scope) is the one pattern a static DAG cannot express today, and it is the entire point of the graph-engineering thesis ("the bottleneck moved from the node to the edges"). Loom's `spawn-batch` is literally an agent node re-emitted as a side effect because Fugue lacks the node kind.

### C2 — Dynamic fan-out over a runtime roster — **F1**
Loom: `wave-gate-operations.ts` — *"Roster-sized work stays a VALUE inside these static nodes… pretending otherwise would mean generating a graph per wave."* Fugue needs a `map`/scatter-gather node: one child sub-DAG applied over a runtime array with a declared max width and a typed reducer. Loom's roster batches (N reviewers, N verifiers, N tasks) are precisely this shape. Keeps illegal-states-unrepresentable at the sub-DAG level; needs `nodeId + index` checkpoint addressing, a Mermaid *plate*, and an `AuthoredDag widthFrom:` field reference.

### C3 — Nested subgraph / program composition — **F8**
Loom built **four** operation DAGs (panel, wave-gate, standalone-review, remediation) and shell-sequences them. Its plan *deliberately rejects* a workflow registry/DSL (FR-004) — the fix is not a DSL, it is a subgraph node so each program registers as one reusable shape composed under the type system. This is the vault's "convergence thesis" quantified.

### C4 — Bounded cross-node loop (evaluator-optimizer) — **F9**
Loom implements retry as *machine state across resumes* ("retry is machine state across resumes, not a back-edge"). With Fugue nodes non-deterministic, generate→critique→revise→re-judge has no expression. A **bounded** back-edge (ADR 0015 explicitly reserves it to "a separate state-graph runtime") unlocks the single highest-value agent pattern for both repos. The wave executor is already BSP/Pregel — a bounded back-edge is closer than "out of scope" implies.

### C5 — Durable non-Redis `JobLike` / file checkpoint — **F6 (new, consumer-driven)**
Loom hand-rolled a `ProgramJournal` (append→checkpoint, idempotent dedup key, atomic rename) because Fugue's durable runtime requires Redis/BullMQ. A first-class file/JSON `JobLike` + checkpoint + freshness-index adapter would collapse an entire Loom subsystem and make Fugue's crash-resume usable for single-machine/embedded consumers. **No prior note named this gap** — it is pure signal from a second project.

### C6 — Roster and `NonEmpty` as first-class values — **F7**
Loom invented `ExactRoster`/`CompleteRoster` with a `__proof` phantom brand (`parseCompleteRoster` is its only constructor, proving length/identity/uniqueness/order/binding). Fugue should consider a `NonEmpty<T>` / roster primitive so the illegal-empty-batch state is unrepresentable in the framework itself, not re-derived per consumer.

### T1 — Tracing content policy: ids/hashes/counts, never prose bytes (trait, not only for Loom)
Loom's plan: *"Traces contain ids, hashes, counts, route labels… not prose/context bytes."* Fugue's LLM spans currently carry content; a consumer-grade trace should offer content hashing with opt-in body retention. This is a small surface change that certifies Fugue for adversarial/audited environments.

### Design principle loaned back — **compose primitives, never a DSL**
Loom's rejection of a generic registry is guidance inbound: every gap above should be shipped as a composable node/shape primitive under `defineDag`'s type system, not as a workflow language. Fugue's superpower is that illegal graphs are *unrepresentable*; a DSL would spend exactly that.

---

## Part 4 — Re-verified Fugue gap audit against the current tree (`d3bab59`)

| Old finding | Current proof | Status |
|---|---|---|
| F1 static shapes | `types/dag.ts:184 DAG_SHAPES = ["linear","fan-out","diamond","router","sources"]`; `NodeKind = "fetch"\|"transform"\|"llm"\|"guardrail"\|"eval-judge"` | **Unshipped** |
| F2 quorum | eval-judges run post-output and mark the trace (assertion, not a routing decision) | **Unshipped** |
| F3 budget capability | capabilities `llm, cache, prompts, judgeLlm, http, clock`; no cost/token ceiling; only `budgetTokens` is `thinking.*` | **Unshipped** |
| F4 prompt caching | grep `cache_control`/`promptCach`/`cacheControl` → **0 hits** | **Unshipped** (10× economics lever) |
| F5 positioning | README still "DAG-shaped, durable runtime" | **Unshipped** (independent, cheap) |
| **new F6** non-Redis durable | checkpoint/ = in-memory + `redis-checkpointer`; queue/ = in-memory + `queue-bullmq/` — **no file/JSON JobLike** | **New** |
| MCP adapter | only oracle adapter; no `@fuguejs/mcp` | **Unshipped** |
| Memory capability | no episodic/semantic/procedural capability | **Unshipped** |

Nothing on the F-list moved. The roadmap is intact, it is just *not yet acted on*.

---

## Part 5 — The convergence thesis, as a build order

The 08-05 vault note argued: *"loom's lifecycle becomes a fugue DAG… Six of loom's seven gaps close by shipping four fugue node/shape primitives."* Twelve days later Loom closed its seven gaps largely on its own (via machines, values, and shell sequencing) **without waiting for a single Fugue primitive**. The honest conclusion is subtler and more valuable:

- **Loom's adaptive workarounds are the specification for Fugue's primitives.** Every defensive value, every `CompleteRoster`, every `ProgramJournal`, every `spawn-batch` action is a prototype of a Fugue feature Loom could not use.
- **Fugue can now ship four primitives with a known, in-repo consumer to validate them:** F0 agent node, F1 map/fan-out, F8 subgraph, F9 bounded loop — each directly retireable Loom machinery (C1–C4).
- **The ordering constraint from the old roadmap still holds:** F4 prompt-caching before F1 dynamic width (the 10× economics – fan-out over shared context without caching is unbounded at ~10× the necessary rate). F3 budget before F1 as well (data-dependent width without a ceiling is unbounded spend).
- **Add F6 early**: shipping a file-backed durable runtime unblocks Loom *now* at near-zero design risk, and it composes with everything.

**Checkpoint address space — close the gap before F1.** The width-bearing primitives each touch checkpoint addressing separately: F1 needs `nodeId + index`; F8 gives a subgraph "its own checkpoint namespace"; F6 adds a file/JSON backend with a freshness index. Nothing yet composes them, and sequencing F6 first would pre-decide the address model. The composite key is `(namespace, nodeId, index, attempt)`, backend-agnostic, with the file adapter as the first consumer — F6 should land as a *backend*, not as the address-space decision. Crash-resume of a partial fan inside a mapped subgraph instance (F1 × F8) is the case to property-test first.

### Recommended order
**F6 (file `JobLike`/checkpoint)** → **F4 (prompt caching)** → **F3 (budget)** → **F1 (dynamic fan-out/map)** → **F2 (quorum)** → **F0 (agent node)** → **F9 (bounded loop)** → **F8 (nested subgraph)** → **[MCP adapter, memory capability, optimizer axis]** → **F5-positioning** (anywhere).

Rationale: F6 is the cheap immediate unblock for the one real consumer; F4+F3 are the un-argued preconditions for F1 (both from the earlier spike and from Loom's rate-limit-denominated L3 budget thinking); F0/F9/F8 are the four named boundaries loom currently works around, in unlock-more order; MCP/memory/optimizer remain the ecosystem breadth steps; prompt-caching economics make even a local DeepSeek fan-out viable.

---

## Part 6 — Deliberately *not* recommended

- **Do not ship a workflow DSL / generic registry.** Loom rejected it (FR-004); it would spend `defineDag`'s illegal-unrepresentable superpower. Ship composable primitives.
- **Do not force Loom's phase spine into a Fugue graph.** The vault recall is decisive: *"Loom's phase spine is a contract; keep it fixed and move dynamism to widths/termination, not structure."* Dynamism belongs in fan-out/budget/loop-counts, not in the phase order.
- **Do not blink on the "edges are the bottleneck" framing.** Fugue's own conditional-edge work was a decade ahead of the discourse; the still-missing edge primitives (fan-out, loop, subgraph, agent edge) are the real frontier.
- **Do not build agent-call as "one more `llm-with-tools`."** A delegated sub-agent needs its own context budget, model tier, lifecycle, and tool scope — an additive union member plus exhaustive match, but not a re-skin of a single-model tool loop.

---

## Appendix — verification log (claims above, and how checked)

| Claim | Evidence |
|---|---|
| Fugue main frozen at 07-16 | `git -C /home/peterstorm/dev/agentic/fugue log -1 --format=%ci` = `2026-07-16`; journal 2026-08-12 "fugue: 0 commits" |
| Loom engine pins fugue 0.4.0 | `/home/peterstorm/dev/claude-plugins/loom/engine/package.json:22` `@fuguejs/framework: 0.4.0` |
| Loom imports public fugue APIs | `grep -rn "@fuguejs/framework" loom/engine/src/orchestration/…` (transform, defineDag, DAG_INPUT, Machine, JobLike, runStateMachine, createHumanReviewNode…) |
| Four absent boundaries named by Loom | `2026-08-09-orchestration-automation.md` AD-1 + Security §"Known boundary: no Agent node, nested subgraph, cross-node loop, or dynamic fan-out" |
| Dynamic fan-out settled as value | `loom/engine/src/orchestration/dags/wave-gate-operations.ts:20-22` |
| No non-Redis durable runtime | `ls fugue/packages/framework/src/{checkpoint,queue,queue-bullmq}`; only in-memory + redis backends |
| Loom hand-rolled ProgramJournal | `loom/engine/src/orchestration/fugue-program-runtime.ts` `ProgramJournal` port + dedup + atomic checkpoint |
| Findings identity shipped (branch) | branch `loom/README.md` Finding identity section; `engine/src/core/findings.ts`; `engine/src/types.ts` (`${agent}-${ordinal}`) — `feat/architecture-panel-mode-plan` only |
| Refutation panel (L1) shipped (branch) | branch `loom/README.md` Step 3.5; `core/panel-kernel.ts`; `review-verifier-agent` — `feat/architecture-panel-mode-plan` only |
| F-gaps unshipped | grep/F2/F3/F4 counts at `fugue/packages/framework/src` as recorded in Part 4 |

---

## Related

- Prior spike: `docs/spikes/2026-08-02-graph-engineering-findings.md`
- Vault: `graph-engineering-loops-vs-graphs.md` (2026-08-05), `fugue-outcome-branching.md` (2026-05-10), `ai-engineering-gap-analysis-chatbot-fugue-loom-cortex.md` (2026-08-11), `loom-as-a-harness.md` (2026-08-11)
- Loom: `.claude/plans/2026-08-09-orchestration-automation.md`, `engine/src/orchestration/**`, `README.md`
- Fugue: `docs/adr/0015-conditional-edges.md`, `packages/framework/src/{types,node,checkpoint,queue,queue-bullmq}`
