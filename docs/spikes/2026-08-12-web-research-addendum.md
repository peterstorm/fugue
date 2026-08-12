# Web Research Addendum — pushing Fugue & Loom further

**Date:** 2026-08-12
**Companion to:** [`2026-08-12-fugue-loom-convergence-research.md`](2026-08-12-fugue-loom-convergence-research.md)
**Status:** Research note — no work started
**Scope:** New findings from vendor/authoritative sources that the prior spike and vault notes did not already cover. Distinct items only; known items (Cognition's "Don't Build Multi-Agents", the 12-point rubric, DSPy/GEPA, containment-not-succession) are marked [prior] and not re-derived.

---

## A — Fugue runtime / graph findings

### A1 — Path-dependent capability scoping (Prefect, new axis)
Prefect's strongest argument for macro-orchestration is: *"the ability to change an agent's capabilities depending on the path it took to get there."* Fugue already has **per-node** capability scoping and per-identity downscoped tokens — the best-in-class cell. But it does **not** make scope depend on the edge taken. This is a new, distinctive dimension that composes perfectly with the existing broker:

- A node reached via the "high-confidence" branch gets the write capability; the same node reached via "low-confidence" gets read-only — decided by the routing predicate, not the author.
- The downscoped-token broker already mints per-identity tokens; extend it to mint **per-path** tokens (the branch taken is known once routing decides, ADR 0029).

This is the natural successor to the bazooka problem, and it is squarely inside Fugue's strongest competency (capability brokering).

### A2 — Path-dependent **one-shot / bounded-use** capabilities (Prefect)
Prefect's refund node is *"locked to the one customer it's supposed to affect, usable exactly once."* That is HITL plus a bounded-use capability. Fugue's broker could mint capabilities with a **usage budget** (usable exactly `N` times, or bound to a single resource) — a `CapabilityHandle` with a consumption limit that is fail-closed on exhaustion. Aligns with F2 (quorum) and the HITL gate: a consequential action is authorized once, then the token is spent.

**Certification seam (needed before A1/A2 ship).** Both proposals key authorization on routing outcomes that, in an LLM-bearing DAG, derive from model output. Stay deny-by-default: mint capabilities only from *certified* routing decisions (validated branch data, never raw model field values); make one-shot spend a compare-and-spend port with atomic consumption; fail closed on exhaustion. The F2 (quorum) and F3 (budget) machinery already provides the gate — reuse it rather than adding a parallel trust path.

### A3 — Durable-by-default + child spawning + dynamic fan-out are now table stakes (Hatchet)
Hatchet advertises *"Durable Tasks, Child Spawning, Sleeps, Event Waits, Task Eviction, DAGs as Durable Workflows,"* and *"everything in Hatchet is durable by default — every task, DAG, event or agent invocation is stored in a durable event log."* LangGraph, Temporal, Inngest, Trigger.dev all ship local/file-backed durable persistence.

**Implication:** Fugue's "static shapes, no dynamic fan-out, Redis-only durable" is no longer a defensible design split — it is a competitive gap. This **accelerates** F1 (map node), F6 (file `JobLike`/checkpointer), and F4 (prompt caching, since fan-out at table-stakes width without caching is the 10× cost). F1 and F6 move from "nice roadmap" to "parity."

### A4 — Worker slot control is the budget/concurrency primitive (Hatchet)
Hatchet models cost-concurrency as **worker slot control** ("workers only accept the amount of work they can handle"), plus per-queue rate limits and idempotency keys. For Fugue's F3 this is the concrete mechanism: a `budget` capability that is really a **concurrency/slot + token + rate ceiling** on fan-out — which is exactly the quota-denominated ceiling Loom's L3 budget concluded it needed. Budget = slots, not just dollars.

### A5 — Checkpointer vs. Store: two persistence tiers (LangGraph)
LangGraph splits persistence into:
- **Checkpointer** — short-term, thread/run-scoped, for continuity, HITL, **time travel**, fault tolerance.
- **Store** — durable cross-run key-value for shared knowledge / long-term memory.

Fugue has the checkpointer (in-memory + Redis) but no first-class **Store**. This is the concrete shape of the long-flagged **memory capability (4.6)**: an injectable `Store` adapter, distinct from the run checkpointer. It also settles a design question for **F8 nested subgraph**: *"a subgraph manages its own checkpoint namespace; use shared state via Store for data that must cross graph boundaries."* So transcendent state between parent and mapped child must route through the Store, not through nesting — write that into the F8 design.

### A6 — Local file-based checkpointer is the industry baseline (LangGraph)
LangGraph ships `SqliteSaver`/`"Local file-based storage for development"`, and Hatchet/Temporal/Inngest/Trigger.dev all persist durably without an external broker. **Direct validation of F6**: Fugue should offer a JSON + SQLite file checkpointer (`@fuguejs/framework/file`), the exact adapters Loom had to hand-roll as `ProgramJournal`. It is the biggest unblock per design risk.

### A7 — Prompt caching: automatic + explicit breakpoints, 4 slots, prepend-writes (Anthropic)
F4 implementation target, current as of 2025-06+:
- **Automatic caching** applies the breakpoint to the last cacheable block and moves it forward; best for multi-turn — but it must not displace an explicit system-prompt breakpoint (4 slots total; 400 error beyond).
- **Explicit breakpoint** on the static system prompt = the canonical Loom use (shared Rules / Skills / context-packet prefix).
- **Prepend-write rule:** content beyond the breakpoint is invalidated on edit, so static-prefix-first ordering is required for fan-out caching.
- TTLs: 5-min standard, 1-hr at 2× input price.

### A8 — Token usage ≈ 80% of performance variance; budget is a behavior signal, not just cost (Anthropic)
Anthropic found token usage alone explains ~80% of performance variance (BrowseComp); multi-agent "burns through tokens fast"; early agents "make errors like spawning 50 subagents for simple queries." Two reads for us:
- **F3 budget is a quality control, not just spend protection.** A runaway tool/token burst is the same failure Corpus/Claude observed — maxWidth + budget + slot control stop "spawn 50 agents for a simple query."
- This is the strongest empirical push for F4-before-F1: fan-out width without caching is exactly the "burns through tokens fast" regime.

---

## B — Loom / harness findings

### B1 — Direct subagent outputs and **subagent→subagent references** (Anthropic)
Anthropic: *"The direct from subagents to the lead… can bypass the main coordinator for certain types of results,"* and *"subagents write results to external systems, then pass lightweight references back."* This **validates Loom's already-correct design** (hashes/references, ids/counts, not bytes — findings identity, evidence ledger, context packets). It also suggests an enhancement: allow the verification panel to compare findings **directly against a shared finding artifact** (which it already does via the manifest) rather than funneling every verdict through the parent — Loom's `review-packet` + immutable finding set already realizes this; make it a documented contract, not an implementation detail.

### B2 — "Teach the orchestrator how to delegate" = the decompose spec (Anthropic)
Anthropic: each subagent needs *"an objective, an output format, guidance on the tools and sources to use, and clear criteria."* This is exactly Loom's `AgentRequestAuthority` + `ContextPacket` + `model-profiles`. New check: **explicit "sources to use" and "success criteria" per subagent** — Loom's spec bundle already carries tools/skill; add a per-spawn **success criterion** (what a valid completion must contain) so the accept/capture path has an explicit contract in the packet, not just in the template.

### B3 — Deterministic runtime > agent-managed coordination for reliability (Anthropic + Temporal)
Anthropic: *"LLM agents are not yet great at coordinating and delegating to other agents in real time,"* coordination complexity grows fast, and Temporal's whole model is *deterministic replay over an event history, with Activities recorded and reused, not recomputed.* The architectural corollary for us: **keep coordination in the deterministic runtime** (Fugue's machines/DAGs) and treat agents as leaf nodes — never let the orchestration shape be decided by agent-to-agent messaging. This is the strongest external buy for Fugue's "deterministic runtime + agent nodes" split (F0) over an agent-managed graph.

### B4 — Evals: iterative eval harness with obs + test cases (Anthropic)
Anthropic: effective agent evals are an *"iteration loop with observability and test cases"*; multi-agent evals need bespoke harnesses. Loom's `calibration/` dir + evidence ledger is the seed. The missing piece the web confirms is the **optimizer axis (rubric #12)**: a compile-time structure search against a metric (DSPy/GEPA-style) over the calibration data Loom already collects. This remains the largest, most speculative payoff; gather eval-guided iteration first.

### B5 — MCP as a brokered capability, with new security surfaces (MCP spec 2025)
MCP features map directly onto Fugue capability kinds:
- **Resources** (context/data) → `documents` / a future `memory` **Store** (A5).
- **Prompts** (templated workflows) → Fugue's `prompts` capability.
- **Tools** (functions for the model) → the proposed `@fuguejs/mcp` capability, brokered + per-identity downscoped.
- **Sampling / Elicitation** (server-initiated LLM calls) → a **new approval surface**: return-channel LLM calls and server-initiated recursive calls must be user-approved and can escalate capabilities. Treat elicitation as a gated inverse-capability, not a footgun.

Two concrete notes: MCP tool descriptions are untrusted ("Tools represent arbitrary code execution") — so descriptions should be **validation-gated**, not injected verbatim; and `Roots`/`Elicitation` are where capability-boundary violations creep in. This is the exact risk Fugue's broker was built to contain.

### B6 — Motherhood-but-real: single write path (Anthropic + Cognition [prior])
Anthropic's "subagents write to external systems" + Cognition's "extra agents contribute intelligence, not actions; writes single-threaded" reinforce what Loom already does (one `StateManager` writer, subagents can't edit state). Keep it; do not relax for fan-out.

---

## C — Prioritized new work that falls out of the web research

Cheap, immediate, low-risk additions on top of the existing F-list:
1. **F6a — JSON + SQLite file checkpointer & `JobLike` (A6, A3).** The single biggest Loom unblock; directly retires `ProgramJournal`.
2. **F3a — budget as slots/rate ceiling, not just dollars (A4, A8).** Composes with Loom L3's quota-denominated ceiling and stops "spawn N agents" bursts.
3. **F4a — prompt caching with explicit system-prompt breakpoint + prepend-write ordering (A7).** Canonical Loom prefix.
4. **F10 — path-dependent capability scoping (A1, A2).** New distinctive axis inside Fugue's strongest competency; include one-shot/bounded-use tokens.
5. **Memory as a Store, distinct from the run checkpointer (A5).** Concrete 4.6 shape; also the subgraph cross-boundary channel for F8.
6. **MCP adapter implementing Resources→documents/Store, Prompts→prompts, Tools→brokered capability, Elicitation→gated approval (B5).**
7. **Loom: per-spawn success criterion in the authority packet (B2); eval-guided calibration loop → optimizer axis (B4).**

Ordering note: A3 argues F1+F6 are now **parity** items, not differentiators — so front-load them alongside F4-caching. Path-dependent capabilities (A1) and the MCP/gate surfaces (B5) are the *distinctive* differentiators only Fugue is positioned for.

---

## Sources

- Prefect, *Loops vs. graphs* (bazooka; control-vs-autonomy; path-dependent capabilities; one-shot locked capability)
- Hatchet docs (durable by default; Durable Tasks, Child Spawning, DAGs as Durable Workflows; worker slot control; bulk retries)
- LangGraph docs, *Persistence* (checkpointer vs. store; SqliteSaver local file storage; subgraph checkpoint namespace + shared store)
- Anthropic, *Multi-agent research system* (token usage 80% of variance; direct subagent outputs; teach orchestrator to delegate; coordination complexity; eval iteration loop)
- Anthropic, *Building effective agents* (**[prior]**, underpins the workflow patterns)
- Anthropic, *Prompt caching* docs (auto vs explicit breakpoints; 4 slots; prepend-write; TTLs)
- Temporal docs (deterministic replay over event history; recorded/reused Activities; Child Workflows)
- MCP Specification (2025): Resources / Prompts / Tools / Sampling / Elicitation / Roots; tool-description trust warning
- Google ADK 2.0 feature list (**[prior]**: rubric source)
