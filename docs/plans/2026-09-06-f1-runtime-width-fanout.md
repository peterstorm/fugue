# Plan: F1 — Runtime-width fan-out

**Created:** 2026-09-06
**Status:** **PR-A shipped 2026-09-06** (ADR-0085). PR-B's initial implementation was
recorded on 2026-09-07; that record was not proof of PR46 correctness closure or merge.
**2026-09-08 correctness closure implemented; parent final validation/publication pending.**
The supported runtime contract is §13 and [ADR-0086](../adr/0086-root-owned-mapped-child-execution.md).
PR-C and PR-D remain outside this closure. §§1–11 preserve the original problem/design
record; supersession notes distinguish proposals from current behavior. §12 records the
initial PR-B decisions and explicitly marks those replaced by closure.
**Branch:** `feat/f1-map-node` (original planning branch: `feat/f1-runtime-width-fanout`)
**Baseline:** `main` @ `3845ad9` (0.5.1 — F6, F4 and F3 all merged; Bun pinned to 1.4.2 by ADR-0084)
**Roadmap position:** F1 in `docs/spikes/2026-08-02-graph-engineering-findings.md` §F1. The recommended
order is `F4 + F3 → F1 → F2`. Both preconditions have now shipped, and the spike's gate — *"Do not
start F1 before F3 and F4"* — is satisfied: F3 gives a per-run spend ceiling, so data-dependent width
is no longer unbounded spend, and F4 gives prompt caching, so a shared prefix fanned N ways no longer
costs ~10× what it should.

> **Citation convention.** Code references in this document name a **file and a
> symbol**, never a line number. Line numbers here rotted three times across the
> PR-45 review rounds — most recently when an edit *above* `saveNode` in
> `redis-checkpointer.ts` silently moved it, with nothing failing. A symbol
> survives any edit that does not rename it, and a rename is greppable in a way
> a stale integer never is. Please keep it that way.

---

## 1. Problem

**Historical motivation (before PR-B).** Runtime-width mapping is now implemented as
one node, not an additional outer DAG shape; see §13.

`DagDefInput.nodes` (`types/dag.ts`) is a static record keyed at author time, and `DAG_SHAPES`
(`types/dag.ts`) is the closed tuple `["linear", "fan-out", "diamond", "router", "sources"]`.
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
rewritten. **Rows marked CLOSED were fixed by PR-A** (ADR-0085). The Host row records the
original PR-B gap, now closed by the full mapped child scope in §13, not an index alone.

**The outer topology is compile-time and immutable.**

- `DagTopology.waves` is `readonly (readonly NodeId[])[]`, documented on `DagTopology` in `dag-runtime/types.ts`
  as *"Topology facts computed once at compile time. Immutable after construction."*
- `DagMachineContextPersisted.outputs` is `ReadonlyMap<NodeId, unknown>` (`dag-runtime/types.ts`)
  — **exactly one output per node id**.
- `activeNodeIds` is `ReadonlySet<NodeId>` (`dag-runtime/types.ts`).
- Every helper in `dag-runtime/wave-resolution.ts` (`waveNodes`, `activeWaveNodes`,
  `waveIndexByNodeId`, `collectHumanReviewQueue`, `advanceToNextWave`) is keyed by `NodeId` alone.

So there is no index dimension anywhere in the running machine's address space.

**Indexed checkpoint addressing already exists — and F1 is why it was built.**

ADR-0075 shipped a composite node-key codec with F6. Its Context paragraph names the motivation
outright: *"Indexed fan-out, nested DAG namespaces, and repeated attempts need multiple durable
outputs for the same node without one save overwriting another."*

- `shared/composite-node-key.ts` (relocated unchanged during PR46 closure) encodes `(namespace, nodeId, index, attempt)` as
  `` `${namespace}@${nodeId}@${index}@${attempt}` ``, with `@` outside the identifier grammar so
  canonical (0 separators) and composite (exactly 3) forms are provably disjoint.
- The port already accepts it: `Checkpointer.saveNode` (`checkpoint/checkpointer.ts`) is
  `saveNode(runId, state, opts?: SaveNodeOpts)` where `SaveNodeOpts = CompositeNodeKeyOpts`.

**But the address does not exist on the path production actually writes.** This is the finding that
shapes the work breakdown:

| Backend | Honors composite opts? | Evidence |
|---|---|---|
| File | Yes | `file/checkpointer.ts`'s `saveNode` takes and applies `opts` |
| In-memory | ~~No — deliberately~~ **CLOSED by PR-A** | ADR-0075 / F6 FR-023; now honors `opts` (ADR-0085) |
| Redis | ~~**No — no `opts` parameter at all**~~ **CLOSED by PR-A** | was `saveNode(runId, state)`; now `saveNode(runId, state, opts?)` encoding via `encodeStoredNodeKey` |
| **Host (production)** | Historically no — different code path | **CLOSED by PR46 closure**, §13; original evidence below |

The host does not go through the framework checkpointer port for run checkpoints. It has its own
writer, `createNamespacedCheckpointWriter` (`host/src/adapters/node-context-factory.ts`), which
builds keys with `buildCheckpointKey` (`host/src/domain/cache-keys.ts`):

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
   routing predicates are already `{ field, equals }` (`cli/authored.ts`). Runtime width must
   stay in that register — a closed schema, not an eval.
5. **No checkpoint migration.** ADR-0075 achieved its address extension additively; F1 must extend
   Redis and the host key the same way, with canonical keys unchanged.

---

## 4. Design

**Original proposals, with supersessions noted.** D1's one-node topology, D2's
bounded width and D7's child-HITL refusal survive. §13 governs the execution seam,
complete write scope, and durable generation semantics. D5/D6 and D4's projection
remain future PR-C/PR-D work, not live implementation instructions for PR46.

### D1 — The map node is ONE node in the outer graph

A `map` node is a single `NodeId` in `waves`, `activeNodeIds` and `outputs`. Its output is the
**gathered** value produced by a typed reducer. Per-index execution of the child sub-DAG happens
*inside* the node, against a sub-executor.

This is the decision everything else follows from, so the rejected alternative is worth stating.

**Rejected: materialize N nodes into the wave at runtime.** It reads natural — the fan really is N
things — but it breaks, in order: `DagTopology.waves`' compile-time immutability
(`dag-runtime/types.ts`), the one-output-per-`NodeId` shape of `ctx.outputs`, `activeNodeIds`
set semantics, the static `DagDefInput.nodes` record, and `defineDag`'s ability to validate
reachability and else-totality at module load — because the node set would no longer be known then.
It converts the framework's central invariant into a runtime concern to buy notation.

The original proposal inferred that `wave-execution.ts` / `wave-resolution.ts` would
be untouched. **Superseded by closure:** topology and wave scheduling remain static,
but actual wave dispatch must carry the root execution scope and current persisted
parent epoch. A callable map closure cannot provide that ownership.

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

- `redis-checkpointer.ts`'s `saveNode` gains the `opts?: SaveNodeOpts` parameter its own port already
  declares on `Checkpointer.saveNode`, and encodes via `compositeNodeKey` — the same codec the file
  backend uses. Canonical calls (no opts) must produce byte-identical keys to today, so existing
  runs are unaffected and no migration is required.

The original host proposal — **superseded by §13's full map/index/epoch scope**:

- `buildCheckpointKey` (`host/src/domain/cache-keys.ts`) gains an optional index dimension,
  preserving `fugue:<tenant>:<dagId>:<runId>:<nodeId>` exactly when absent.
- `createNamespacedCheckpointWriter` (`host/src/adapters/node-context-factory.ts`) threads it.

The separator must be chosen the way ADR-0075 and the spend key already choose theirs: outside the
`NodeId` grammar, so an indexed address cannot collide with a node literally named to look like one.
The spend key's use of `$` for exactly this reason is the local precedent.

**Resume semantics (qualified by §13).** Within the same durable execution epoch, a
partial fan resumes by loading acknowledged per-index completions and re-running
only missing indices. A valid reroute advances the epoch and cannot reuse old completions. This is the whole point of the index dimension, and it is the
behaviour to pin with tests, because it is precisely what silently degrades to "restart the whole
fan" if the address is dropped anywhere along the path.

### D4 — Budget: project the fan, don't discover it

F3's Run Spend Authority meters settled LLM calls. The original assumption that this
composed automatically was **superseded by PR46 closure**: child dispatch must retain
the original host meter and minting authority, including broker-delivered LLM aliases. What `maxWidth` adds is that admission can project `width × per-child estimate`
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
register as that file's existing `when: { field, equals }`. `DAG_SHAPES` (`types/dag.ts`) gains a member;
the doc comment there already states that both `DagProvenance` and the CLI's `SHAPES` derive from
that tuple, so a new shape is added in exactly one place and the projections cannot drift.

### D7 — HITL is rejected inside a mapped sub-DAG, at module load

**Decided 2026-09-06.** A node carrying `humanReview` (`types/node.ts`) inside a mapped
sub-DAG is rejected at module load, with an error naming the gather-then-review
alternative. Current enforcement is shared `snapshotMappedChild`, called by
`createMapNode` and `validateDagShape` (see §13); the original assignment to the
executor validator was superseded.

The structural reason is that it cannot currently be expressed. `HumanGatePayload`
(`dag-runtime/types.ts`) carries a single `nodeId: NodeId` and `pendingReviews: readonly
NodeId[]`; neither has an index dimension, so *"index 12 of the mapped review node is awaiting a
human"* has no representation. That payload is deliberately shared across all three gate phases —
`awaiting-human`, `suspended`, `retrying-hook` — each an intersection with it — with the stated intent that a
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
(`host/src/adapters/node-context-factory.ts`) is a **different port** from the framework's
`Checkpointer`. It never had composite support and is not part of ADR-0075's story, so widening its
signature in PR-A would add an index parameter with no caller until PR-B — "ports introduced for
future swappability with no second adapter or test fake", which `architecture.md` names as an
anti-pattern. It lands with the map node that gives it meaning.

PR-A is therefore self-contained: `Checkpointer.saveNode` already declares `opts?`, and
two of three backends silently ignore it. Closing that is meaningful on its own terms.

---

## 8. Documentation

**Original documentation proposal.** ADR-0085 now owns backend parity; ADR-0086
owns root mapped-child execution. The number reservation and broader feature/
requirements work below are historical proposals, not outstanding PR46 instructions.

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

1. **Resolved by PR46 closure:** roots and mapped children use one `runPreparedDag`
   kernel body behind an explicit root-owned execution seam. Blindly calling public
   `runDag(child, item, ctx)` loses authority and duplicates root lifecycle; spreading
   root options would corrupt durable-job ownership. Freshness/observability do not
   come free: resource sharing and root-only lifecycle are explicit, and child
   freshness extractors remain refused.
2. ~~**Is HITL legal inside a mapped sub-DAG at all in F1?**~~ **Resolved 2026-09-06 — no.** See D7
   and FR-F1-011.
3. **Does admission project the fan (D4), or is metering-only sufficient for v1?** Open. Does not
   block PR-A or PR-B.


---

## 12. What PR-B decided that this plan did not specify

Initial PR-B implementation record (2026-09-07), retained for provenance. The
write-only/readable port distinction and sequential fan survive; index-only writer
addressing and hidden constructor execution were superseded by §13.

### The `checkpointer` capability is where per-index state lives

FR-F1-007 says resume must re-run only the indices with no durable entry, "on
Redis and the host writer". Implementing it surfaced a fact §2 did not record:
**the host's `CheckpointWriter` keys are write-only.** Nothing in production
reads them back — outer-run resume comes from the kernel's `jobLike`, and those
keys are a durable per-node output record consumed elsewhere. So there was no
reader on that path for a fan to consult.

The fan's per-index state therefore lives in the framework's `Checkpointer`
port, reached through a new `checkpointer` capability. That is the port
ADR-0075's composite address was designed for — its Context paragraph names
indexed fan-out explicitly — and PR-A had just made every backend honor it.

The capability is registered through ADR-0051's module-augmentation point from
`checkpoint/capability.ts`, not added to `BaseNodeContext` as an eighth
built-in. The reason is structural: `types/errors.ts` imports `Capability` from
`types/node.ts`, and `checkpoint/checkpointer.ts` imports `types/errors.ts`, so
a built-in field would close an import cycle. `module-graph-acyclic.test.ts`
catches this; it caught it once during PR-B already, for `MapIndex`, which is
why that brand sits in its own leaf module.

**Consequence for hosts:** a DAG containing a map node now needs a
`Checkpointer` wired into the node context (`capabilities: { checkpointer }`).
A run without one fails at the capability gate before any node runs, which is
the intended fail-closed behavior — a map node without durable per-index state
would silently re-run every completed index after a crash.

### Historical index-only host writer — superseded

Initial PR-B added a `$<index>` key form and manual writer tests. Actual child
runtime calls did not carry that index, so those tests did **not** establish
collision-free production writes. Closure replaces this with frozen
`MappedChildScope` on actual child writes: map identity, real child node identity,
index and parent epoch all participate via the existing composite codec (§13).
The writer remains write-only; fan resume correctly reads the separate
`checkpointer` capability, not these output records. No writer read port is required
or promised for FR-F1-007.

### The fan is sequential

Not stated either way in §4. PR-B runs indices one at a time, and two properties
depend on it: a run that hits its F3 ceiling mid-fan stops at a **known** index
rather than at whichever of N in-flight children lost the race, and the
reducer's input is in index order on a resumed run as well as a fresh one.

Bounded concurrency is additive later — it changes neither the address space nor
the reducer's contract — but it is a real gap for a wide fan of slow children
and should be its own PR with its own budget-interaction tests.

### Historical constructor-only child refusal — superseded

Initial PR-B hid the child in a callable map closure and refused human review
only in `createMapNode`. Closure makes the immutable `mapping` descriptor visible
on `MapNodeDef`, not every ordinary `NodeDef`. Both construction and the mandatory
DAG parser invoke bounded child snapshot/refusal. Eligibility also covers the exact
owned frozen child that executes, so changing getters cannot introduce unsupported
freshness or human review after preflight, or enter recursive nested-map parsing.

---

## 13. PR46 correctness closure — current contract (2026-09-08)

[ADR-0086](../adr/0086-root-owned-mapped-child-execution.md) records the decision;
[the closure record](../../.claude/plans/2026-09-08-pr46-correctness-closure.md)
records defect groups, acceptance evidence and validation status.

- **One visible immutable map, one outer output.** Ordinary `NodeDef` remains
  callable and excludes map from its `kind`; `DagNodeDef` is the ordinary-or-map
  union. `MapNodeDef` has a frozen descriptor and no `run`. The child, reducer,
  schemas and width policy are captured once; functions/schemas remain opaque
  references, not recursively cloned implementations. Evaluator entries/configs,
  criteria arrays and rubric records are owned frozen snapshots; caller values,
  functions and closure state are not recursively cloned/frozen.
- **Root-owned dispatch and authority.** `prepareDagRun` inventories outer nodes
  plus each direct mapped child before any predecessor work, including zero width.
  One broker-claim snapshot covers that inventory. Each child mints its own
  requirements with its structural DagId, real NodeId and root RunId, using the
  original base context, snapshotted origin, broker receiver and host LLM meter.
  Child requirements are not hoisted into the map's checkpointer-only request;
  parent-scoped grants are not inherited. Describe capabilities use the same
  bounded runtime inventory's sorted, deduplicated union, without expanding outer
  topology or changing map `requires: ["checkpointer"]`.
- **Shared resources, separate ownership.** One `runPreparedDag` kernel body serves
  both scopes. Child jobs are private/local; root durable JobLike, replay map,
  retry overrides, human/commit/trace/classification hooks and background ownership
  stay root-only. Clock/RNG/FreshnessIndex and original signal, clients, cache/prompt
  closures and spend authority are retained. Structural child DagId never rebinds
  host root resource namespaces. Children emit node/domain events and spans, not
  observer run-start/run-end; child judges finish foreground before fan save.
- **Retry is not reroute.** Actual wave dispatch passes persisted parent
  `freshnessExecutionEpoch`. Completion lookup and save both use
  `{ index, attempt: executionEpoch }` for map NodeId, producing
  `dag@<mapNodeId>@<index>@<executionEpoch>`. Same-generation retry/replacement
  reuses acknowledged completions; a valid backward reroute advances the epoch
  before work, even for identical inputs or a reroute directly to the fan.
- **Corruption is not missing work.** Every nonempty loaded
  `corruptNodeAddresses` refuses fan work before replay/gather, metadata seeding,
  children, saves or reduction, including zero width, unrelated/old-epoch keys and
  opaque digest filenames. File/Redis adapters still warn/drop; the stricter fan
  returns attributable `checkpoint-corrupt`, preserving both address ADT arms.
  Public `runDag` wraps it as `retry-exhausted` with
  `rootErrorKind: checkpoint-corrupt` and the serialized original error in
  `lastError` (default zero retries: one attempt). No automatic destructive cleanup:
  operators inspect/repair storage, then rerun; corrupt acknowledged work is not
  a healthy miss. Healthy prefixes are reused and genuinely missing work runs.
  Failed initial metadata stops work with its original error; fresh child outputs
  must pass the mapping schema before save/gather, not only the child DAG schema.
- **Two record spaces.** Fan completions live in the readable Checkpointer
  (`$nodes` hash in the host). Actual child output writes carry frozen
  `MappedChildScope { mapNodeId, index, executionEpoch }` as the writer's fourth
  argument. Host STRING keys are
  `fugue:<tenant>:<rootDag>:<run>:<mapNodeId>@<childNodeId>@<index>@<executionEpoch>`:
  namespace=mapNodeId, nodeId=real child node, index=index, attempt=epoch. Root
  writes remain `fugue:<tenant>:<rootDag>:<run>:<nodeId>` byte-for-byte. No new
  codec or checkpoint migration; `shared/composite-node-key.ts` is the unchanged
  relocated codec, with identical named main/checkpoint exports. Wrong-run host
  writer calls reject before scope/value observation, encoding, serialization,
  diagnostics or checkpoint/spend effects; matching-run keys/retention are unchanged.
- **Bounded refusal and cancellation.** Nested maps, child human review and child
  read/write freshness extractors are refused against the actual execution
  snapshot. Ordinary reads/writes without extractors are legal. Malformed map
  descriptors/requirement containers and revoked-array width inputs fail typed.
  Cancellation blocks subsequent indices and reduction, including empty/final-index
  success. A concurrently completed child can still be saved; external effects
  without acknowledged completion may repeat after interruption.

**Not part of this guarantee:** recursive child fingerprints, indexed broker audit
metadata, or root aggregation of child judge/guardrail summaries. These are deferred
advisories, not silently implemented closure criteria. PR-C authoring/plate rendering,
PR-D fan budget projection, nested/HITL/indexed freshness semantics and concurrent fan
scheduling remain separate work.

**Evidence status:** the earlier full workspace baseline passed **7,141 tests,
3 skipped, 0 failed** before snapshot/codec corrections (**3,721 framework tests**
and **5 independent probes** subsequently passed). The later **7,149 + 7** parent
validation is also historical, before adjudication. The adjudicated **2 criticals
and 4 accepted advisories are implemented; 5 advisories deferred, 0 findings refuted**.
Worker RED/GREEN history now includes corruption **7 pass/9 fail → 76 focused pass**,
snapshot/describe **8 pass/15 fail → 103 pass**, and writer **92 pass/7 fail → 150
final focused pass**. Both framework workers report **3,752 pass, 0 fail, 0 skip**
with source/bin typechecks green; these overlapping runs are not additive or final
whole-candidate certification. Full counts, mutation controls, prerequisites and
scope caveats live in the closure record. Parent final validation, registered
installation and publication remain pending.
