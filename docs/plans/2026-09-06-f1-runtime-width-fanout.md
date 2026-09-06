# Plan: F1 — Runtime-width fan-out

**Created:** 2026-09-06
**Status:** **PR-A shipped 2026-09-06** (composite checkpoint addressing on every backend — see
ADR-0085). D7 decided. PR-B (the `map` node itself) is what remains; PR-C and PR-D follow it.
§2 below is preserved as the evidence record of the state PR-A was written against, annotated
rather than rewritten — see the note at its head.
**Branch:** `feat/f1-runtime-width-fanout`
**Baseline:** `main` @ `3845ad9` (0.5.1 — F6, F4 and F3 all merged; Bun pinned to 1.4.2 by ADR-0084)
**Roadmap position:** F1 in `docs/spikes/2026-08-02-graph-engineering-findings.md` §F1. The recommended
order is `F4 + F3 → F1 → F2`. Both preconditions have now shipped, and the spike's gate — *"Do not
start F1 before F3 and F4"* — is satisfied: F3 gives a per-run spend ceiling, so data-dependent width
is no longer unbounded spend, and F4 gives prompt caching, so a shared prefix fanned N ways no longer
costs ~10× what it should.

---

## 1. Problem

`DagDefInput.nodes` (`types/dag.ts:154`) is a static record keyed at author time, and `DAG_SHAPES`
(`types/dag.ts:184`) is the closed tuple `["linear", "fan-out", "diamond", "router", "sources"]`.
Every width in a Fugue DAG is therefore a number the author typed.

The motivating workload is one where a scoping node decides the width: 5 → 25 → 75, where 25 is
whatever the scoper returned. Today you hard-code the widths or you do not build it. The existing
`fan-out` shape is author-time width — N named sibling nodes — which is a different thing wearing
the same word.

This is a boundary consumers already work around rather than an abstract gap: dynamic fan-out is one
of the absent framework boundaries `loom` routes around when it drives orchestration through
`@fuguejs/framework`.

---

## 2. Verified current state

Read on `3845ad9`. This section is what the code actually did **before PR-A**, not what the spike
assumed — it is the evidence record of why PR-A was needed, so it is annotated below rather than
rewritten. **Rows marked CLOSED were fixed by PR-A** (ADR-0085); the Host row is still open and
is PR-B's work.

**The outer topology is compile-time and immutable.**

- `DagTopology.waves` is `readonly (readonly NodeId[])[]`, documented at `dag-runtime/types.ts:249`
  as *"Topology facts computed once at compile time. Immutable after construction."*
- `DagMachineContextPersisted.outputs` is `ReadonlyMap<NodeId, unknown>` (`dag-runtime/types.ts:314`)
  — **exactly one output per node id**.
- `activeNodeIds` is `ReadonlySet<NodeId>` (`dag-runtime/types.ts:292`).
- Every helper in `dag-runtime/wave-resolution.ts` (`waveNodes`, `activeWaveNodes`,
  `waveIndexByNodeId`, `collectHumanReviewQueue`, `advanceToNextWave`) is keyed by `NodeId` alone.

So there is no index dimension anywhere in the running machine's address space.

**Indexed checkpoint addressing already exists — and F1 is why it was built.**

ADR-0075 shipped a composite node-key codec with F6. Its Context paragraph names the motivation
outright: *"Indexed fan-out, nested DAG namespaces, and repeated attempts need multiple durable
outputs for the same node without one save overwriting another."*

- `checkpoint/composite-node-key.ts` encodes `(namespace, nodeId, index, attempt)` as
  `` `${namespace}@${nodeId}@${index}@${attempt}` ``, with `@` outside the identifier grammar so
  canonical (0 separators) and composite (exactly 3) forms are provably disjoint.
- The port already accepts it: `Checkpointer.saveNode` (`checkpoint/checkpointer.ts`) is
  `saveNode(runId, state, opts?: SaveNodeOpts)` where `SaveNodeOpts = CompositeNodeKeyOpts`.

**But the address does not exist on the path production actually writes.** This is the finding that
shapes the work breakdown:

| Backend | Honors composite opts? | Evidence |
|---|---|---|
| File | Yes | `file/checkpointer.ts:392` takes and applies `opts` |
| In-memory | ~~No — deliberately~~ **CLOSED by PR-A** | ADR-0075 / F6 FR-023; now honors `opts` (ADR-0085) |
| Redis | ~~**No — no `opts` parameter at all**~~ **CLOSED by PR-A** | was `saveNode(runId, state)`; now `saveNode(runId, state, opts?)` encoding via `encodeStoredNodeKey` |
| **Host (production)** | **No — different code path entirely** | see below |

The host does not go through the framework checkpointer port for run checkpoints. It has its own
writer, `createNamespacedCheckpointWriter` (`host/src/adapters/node-context-factory.ts:254`), which
builds keys with `buildCheckpointKey` (`host/src/domain/cache-keys.ts:73`):

```
fugue:<tenant>:<dagId>:<runId>:<nodeId>
```

Bare `nodeId`. **No index dimension.** If a mapped node checkpointed per index through this path
today, every index of the fan would overwrite the same Redis key, and crash-resume of a partial fan
would silently restart from whichever index happened to write last.

**Consequence for the plan.** The spike lists checkpoints as one of four design consequences. In
fact the *codec* is done and the *port* is done; what is missing is carrying that address through
Redis and through the host's own writer. That is the load-bearing work in F1, and it is invisible
from the framework tests because the file backend — the one with composite support — is not what
production runs.

---

## 3. Constraints the design must respect

1. **`defineDag`'s boot-time validation must survive.** Illegal states unrepresentable at module
   load is the framework's core property (features.md §1). A design that defers structural validity
   to runtime trades away the thing Fugue is for.
2. **Width must be bounded before it is spent.** F3 gives a per-run ceiling, but a ceiling is a
   backstop, not a design. A declared maximum width makes worst-case fan cost statically knowable.
3. **Acyclic.** A map node applies a child sub-DAG; it does not introduce a back edge.
4. **The authored surface is a field reference, not an expression language.** `AuthoredDag`'s
   routing predicates are already `{ field, equals }` (`cli/authored.ts:323`). Runtime width must
   stay in that register — a closed schema, not an eval.
5. **No checkpoint migration.** ADR-0075 achieved its address extension additively; F1 must extend
   Redis and the host key the same way, with canonical keys unchanged.

---

## 4. Design

### D1 — The map node is ONE node in the outer graph

A `map` node is a single `NodeId` in `waves`, `activeNodeIds` and `outputs`. Its output is the
**gathered** value produced by a typed reducer. Per-index execution of the child sub-DAG happens
*inside* the node, against a sub-executor.

This is the decision everything else follows from, so the rejected alternative is worth stating.

**Rejected: materialize N nodes into the wave at runtime.** It reads natural — the fan really is N
things — but it breaks, in order: `DagTopology.waves`' compile-time immutability
(`dag-runtime/types.ts:249`), the one-output-per-`NodeId` shape of `ctx.outputs`, `activeNodeIds`
set semantics, the static `DagDefInput.nodes` record, and `defineDag`'s ability to validate
reachability and else-totality at module load — because the node set would no longer be known then.
It converts the framework's central invariant into a runtime concern to buy notation.

Keeping the map node singular means **wave scheduling needs no change at all.** The spike lists
`wave-execution.ts` / `wave-resolution.ts` as a design consequence; under D1 they are untouched.
That is a real reduction in scope versus the spike's estimate, and it is a consequence of the
sub-DAG framing the spike itself proposed.

### D2 — `MapWidth`: parsed, bounded, fail-closed

```
widthFrom: <field reference into the upstream output>
maxWidth:  <declared positive integer, author-time>
```

Width is read from the upstream output at runtime and immediately parsed into a value type, not
validated into a boolean. The arms that must exist:

- not an array / not a countable field → typed error, fail closed
- `width > maxWidth` → typed error naming both numbers, fail closed. **Never silently truncate** —
  a truncated fan produces a plausible, wrong, cheaper answer, which is the worst available failure.
- `width === 0` → an explicit, legal outcome (the reducer receives an empty array), not an error.
  Zero-width is the common real case for "nothing matched" and must not be a crash.

`maxWidth` is what makes the F3 interaction sound: worst-case spend for the node is bounded before
the run starts, so admission can reason about it rather than discovering it.

### D3 — Carry the composite address to Redis and to the host key

The framework work — **all of it shipped in PR-A (ADR-0085); kept here as the design record**:

- `redis-checkpointer.ts:250` gains the `opts?: SaveNodeOpts` parameter its own port already
  declares on `Checkpointer.saveNode`, and encodes via `compositeNodeKey` — the same codec the file
  backend uses. Canonical calls (no opts) must produce byte-identical keys to today, so existing
  runs are unaffected and no migration is required.

The host work — **still open, and PR-B's**; no current equivalent:

- `buildCheckpointKey` (`host/src/domain/cache-keys.ts:73`) gains an optional index dimension,
  preserving `fugue:<tenant>:<dagId>:<runId>:<nodeId>` exactly when absent.
- `createNamespacedCheckpointWriter` (`host/src/adapters/node-context-factory.ts:254`) threads it.

The separator must be chosen the way ADR-0075 and the spend key already choose theirs: outside the
`NodeId` grammar, so an indexed address cannot collide with a node literally named to look like one.
The spend key's use of `$` for exactly this reason is the local precedent.

**Resume semantics.** A partial fan resumes by loading the per-index entries that exist and
re-running only the missing indices. This is the whole point of the index dimension, and it is the
behaviour to pin with tests, because it is precisely what silently degrades to "restart the whole
fan" if the address is dropped anywhere along the path.

### D4 — Budget: project the fan, don't discover it

F3's Run Spend Authority already meters every settled LLM call, so a fan is metered correctly
without changes. What `maxWidth` adds is that admission can project `width × per-child estimate`
*before* starting the fan, rather than admitting child 1 and refusing child 40 halfway through — a
half-executed fan that has spent money and produced nothing usable. Whether projection is in F1 or
deferred is a scoping decision (see §9); the metering itself is already correct either way.

### D5 — Render a plate, not N boxes

`describedToMermaid` (`cli/visualize.ts`) is shared by `fugue visualize` and compose previews, so
this is one change, not two. A mapped node renders as a single node with a multiplicity annotation
(`×n`, `≤ maxWidth`), not an unrolled fan — the width is not known at render time, and drawing a
guessed N would be a lie in a diagram people read to understand topology.

### D6 — `AuthoredDag` gains a closed `map` shape

A `widthFrom` **field reference** added to the closed schema in `cli/authored.ts`, in the same
register as `when: { field, equals }` at `:323`. `DAG_SHAPES` (`types/dag.ts:184`) gains a member;
the doc comment there already states that both `DagProvenance` and the CLI's `SHAPES` derive from
that tuple, so a new shape is added in exactly one place and the projections cannot drift.

### D7 — HITL is rejected inside a mapped sub-DAG, at module load

**Decided 2026-09-06.** A node carrying `humanReview` (`types/node.ts:467`) inside a mapped
sub-DAG is rejected by `executor/validate-dag.ts` at module load, with an error naming the
gather-then-review alternative.

The structural reason is that it cannot currently be expressed. `HumanGatePayload`
(`dag-runtime/types.ts:56`) carries a single `nodeId: NodeId` and `pendingReviews: readonly
NodeId[]`; neither has an index dimension, so *"index 12 of the mapped review node is awaiting a
human"* has no representation. That payload is deliberately shared across all three gate phases —
`awaiting-human`, `suspended`, `retrying-hook` (`:71`, `:72`, `:93`) — with the stated intent that a
field added there propagates to every gate phase and every transition projection. Widening it is not
a local change.

Two further consequences argue against doing it in v1:

- **Partial-fan park semantics are undefined.** If index 12 parks, either 13..24 keep running (the
  fan is now partly settled and partly parked, and resume must reconstruct which) or the whole fan
  halts (a parallel construct serialized on its slowest human). Both are defensible; neither is
  obvious; the choice changes the resume reconstruction.
- **It silently voids ADR-0074.** `maxQueuedRuns` bounds *runs*, not gates. One run with a 75-wide
  parked fan is one run against the limit but 75 outstanding human decisions — precisely the failure
  ADR-0074 was written to fix ("a first-class admission limit that advertised a guarantee the system
  did not provide").

The decision rests on an asymmetry rather than on HITL-in-a-fan being unreasonable. Forbidding it is
removable in one additive change once fan semantics have been exercised for real. Shipping a
half-specified per-index gate is not: **parked runs are durable and long-lived**, so a wrong address
shape means migrating runs a human is mid-decision on, days later. Checkpoint addresses can be
migrated quietly; pending human decisions cannot.

The documented alternative is fan → gather → one `humanReview` node over the gathered array: one
prompt, one decision, N items — which for most approval workflows is better than N separate
approvals anyway.

This also narrows §11 Q1: the child sub-DAG can reuse the existing executor minus the one branch
whose semantics were undefined.

---

## 5. Requirements

| ID | Requirement |
|---|---|
| FR-F1-001 | A `map` node applies a child sub-DAG over a runtime-resolved array and produces one gathered output through a typed reducer. |
| FR-F1-002 | `maxWidth` is declared at author time; `defineDag` rejects a missing or non-positive value at module load. |
| FR-F1-003 | A resolved width exceeding `maxWidth` fails closed, naming both the resolved width and the declared maximum. Truncation is never a legal outcome. |
| FR-F1-004 | A width of `0` succeeds, invoking the reducer with an empty array. |
| FR-F1-005 | `widthFrom` resolving to a non-array / non-countable field fails closed with a typed error. |
| FR-F1-006 | Each child index is checkpointed under a distinct durable address; no index overwrites another. |
| FR-F1-007 | Resume re-runs only the indices with no durable entry, on **Redis and the host writer**, not only on the file backend. |
| FR-F1-008 | Canonical (non-mapped) checkpoint keys are byte-identical to `3845ad9` on every backend. No migration. |
| FR-F1-009 | A mapped node renders as one plate with a multiplicity annotation in `describedToMermaid`. |
| FR-F1-010 | `AuthoredDag` accepts a `map` shape with a `widthFrom` field reference through its closed schema; no expression evaluation. |
| FR-F1-011 | A node carrying `humanReview` inside a mapped sub-DAG is rejected at module load, with an error naming the gather-then-review alternative (D7). |

---

## 6. Test strategy

- **Property tests (fast-check)** for the composite address under an index dimension: injectivity
  across `(nodeId, index)`, disjointness from canonical form, and round-trip. `@fuguejs/framework`
  already uses `fast-check ^4.7.0`, and `composite-node-key.test.ts` is the pattern to extend.
- **The Redis + host resume test is the one that matters most**, because it is the gap §2 found.
  It must run against real Redis (CI already exports `REDIS_URL` and the suites are gated on it),
  kill a fan mid-flight, resume, and assert that completed indices are not re-executed. A test that
  proves this only on the file backend proves nothing about production.
- **Width boundary table**: `0`, `1`, `maxWidth`, `maxWidth + 1`, non-array, missing field.
- **Budget interaction**: a fan that exhausts the run ceiling mid-fan refuses fail-closed and does
  not leave a half-gathered output.
- **Renderer**: a mapped DAG produces one plate node, and the existing injective-token property for
  Mermaid ids still holds.

---

## 7. Work breakdown

| PR | Scope | Why this seam |
|---|---|---|
| **PR-A** | Bring `redis-checkpointer.ts` and `InMemoryCheckpointer` up to the composite address `Checkpointer.saveNode` already declares, and move composite expectations into the shared `_checkpointer-suite.ts`. No `map` node yet. | Independently valuable and independently testable: it closes the F6-era gap where ADR-0075's address exists in the port but is honored by only one of three backends. Landing it first means the F1 runtime work has a durable address to write to instead of inventing one. |
| **PR-B** | `MapWidth` parsing, the `map` node kind, sub-DAG execution, the typed reducer, `defineDag` validation (incl. FR-F1-011), **and the index dimension on the host's `CheckpointWriter` / `buildCheckpointKey`**. | The functional core. The host writer moves here deliberately — see the note below. |
| **PR-C** | `AuthoredDag` closed `map` shape + `widthFrom`; `DAG_SHAPES` member; plate rendering in `describedToMermaid`. | The authoring and visualization surface; no runtime risk. |
| **PR-D** | Budget projection over `maxWidth` at admission, if §9 keeps it in scope. | Isolated to the F3 admission path. |

**Why the host writer sits in PR-B, not PR-A** (refined 2026-09-06 after reading the code). The
host's `CheckpointWriter.write(runId, nodeId, value)`
(`host/src/adapters/node-context-factory.ts:254`) is a **different port** from the framework's
`Checkpointer`. It never had composite support and is not part of ADR-0075's story, so widening its
signature in PR-A would add an index parameter with no caller until PR-B — "ports introduced for
future swappability with no second adapter or test fake", which `architecture.md` names as an
anti-pattern. It lands with the map node that gives it meaning.

PR-A is therefore self-contained: `Checkpointer.saveNode` already declares `opts?`, and
two of three backends silently ignore it. Closing that is meaningful on its own terms.

---

## 8. Documentation

- **ADR** — the D1 decision (map node stays one node in the outer graph; runtime materialization
  rejected) is exactly the kind of choice this repo writes ADRs for. Number assigned at merge
  (0085 is next free as of this draft).
- **A second ADR or an amendment to 0075** for extending the composite address to Redis and the
  host key — 0075's Consequences section explicitly records the file-only limitation as a known
  negative, so closing it should amend that record rather than leave it stale.
- `docs/features.md` — a new numbered feature section, following §21/§22's "What It Does / What It
  Catches / Why It Matters" structure.
- `docs/requirements.md` traceability entries for FR-F1-001..010.

---

## 9. Explicitly out of scope

- **Nested maps** (a map inside a mapped sub-DAG). The composite codec has a `namespace` component
  that anticipates it, but the width-of-widths semantics are a separate design.
- **Cache pre-warming** (`max_tokens: 0`). The F4 plan §304 parks it here; it is a genuine
  optimization for fan-out over a shared prefix, but it is an economics change, not a topology one,
  and should not ride along with the structural work.
- **F2 (quorum node).** Downstream in the roadmap; F1 is its precondition.
- **Dynamic width on the `evalJudges` path.** Judges have their own execution path; fanning them is
  F2's concern.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **The index dimension is dropped somewhere along the production path and nobody notices**, because framework tests pass on the file backend. This already happened once — that is what §2 found. | FR-F1-007 makes the Redis + host resume test mandatory, not optional. Treat a green file-backend test as insufficient evidence by construction. |
| A partial fan leaves spend burned with no usable output. | Fail closed on width violation before any child runs (FR-F1-003); consider D4 projection. |
| `maxWidth` gets set defensively high and stops bounding anything. | It is author-time and reviewable; the lint pass can flag implausible values. Worth a follow-up, not a blocker. |
| Sub-DAG execution grows its own divergent copy of retry / freshness / HITL semantics. | The child sub-DAG should reuse the existing executor rather than reimplement it. If that proves impossible, that discovery is itself a reason to re-open D1. |
| Zero-width treated as an error by a later refactor. | FR-F1-004 pins it with a test; it is the common "nothing matched" case. |

---

## 11. Open questions

1. **Does the child sub-DAG reuse `runDagStateful`, or a narrower sub-executor?** Narrowed by D7,
   not yet closed. With HITL rejected at module load, reuse no longer drags in the branch whose
   semantics were undefined, so reuse is now the presumptive answer — retry, freshness and
   observability come free. To confirm against the executor's actual entry conditions before PR-B.
2. ~~**Is HITL legal inside a mapped sub-DAG at all in F1?**~~ **Resolved 2026-09-06 — no.** See D7
   and FR-F1-011.
3. **Does admission project the fan (D4), or is metering-only sufficient for v1?** Open. Does not
   block PR-A or PR-B.
