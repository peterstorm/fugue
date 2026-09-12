# ADR-0086: Root-owned mapped child execution

## Status
Accepted — implemented and merged in PR #46 on 2026-09-08.

## Date
2026-09-08

## Context

F1 keeps a map as one node in the immutable outer DAG (one wave membership and
one gathered output), while applying a child DAG over a runtime-bounded array.
The original callable map invoked public `runDag(child, item, ctx)`. That looked
like reuse of the single-path runtime (ADR-0021), but crossed the wrong seam:

1. Child root lifecycle events used the same RunId and prematurely finalized the
   root BufferedObserver buffer, losing earlier history under `errorOnly`.
2. Child/configuration hidden in a live closure evaded the DAG snapshot proof;
   unsupported nested maps could execute and alias inner completions.
3. Index-only fan completions survived a valid backward reroute and returned old
   results, even though the parent had durably advanced its execution generation.
4. Options-held minting authority did not reach child dispatch. A broker-only
   child executable directly failed when mapped; blindly spreading options would
   instead grant the child ownership of the root durable job and lifecycle.

The host also has two different ports: readable `Checkpointer` fan completions
and write-only `CheckpointWriter` node outputs. Manual index-only writer tests
had not proved actual child dispatch supplied a collision-free address.

ADRs 0075/0085 already provide one composite codec and backend parity. The fix
must use those contracts, preserve canonical keys, and retain host-selected
origin, resource namespace and Run Spend Authority (ADRs 0053/0054/0083).

## Decision

### One visible definition, one root-owned execution seam

`NodeDef` remains the ordinary callable node contract; its `kind` excludes map.
`MapNodeDef` has `kind: "map"`, `requires: readonly ["checkpointer"]`, an immutable
visible `mapping` descriptor and **no `run`**, including no throwing placeholder.
`DagNodeDef` is the ordinary-or-map dispatch union. DAG/map/inference types live
together in `types/dag.ts`; ordinary types stay in `types/node.ts`. The former
`types/dag-internals.ts` is removed, not compatibility-aliased.

`createMapNode` captures child/schema/reducer/width policy once.
`validateDagShape` snapshots the descriptor and bounded child through the same
parser. Eligibility checks cover early caller observations, captured discriminants
before parsing, and **the exact owned frozen child returned for execution**.
Changing accessors cannot reveal unsupported policy after the refusal check or
introduce recursive map parsing. Opaque functions/schemas are captured references,
not recursively cloned implementations. The parser owns and freezes `evalJudges`
entries/configs, criteria arrays and rubric records as bounded definition data;
later caller mutation cannot replace the captured evaluator definition. It does
not clone functions, schemas or closure state, nor freeze caller-owned values.

The internal `ExecutionScope` is root versus mapped-child. Root preparation binds
`ExecuteMappedChild` to the inventory of prepared children, selected by parent
map NodeId; author callbacks cannot supply another DAG or discover root authority
through NodeContext. One `runPreparedDag` compiled state-machine body serves both
scopes. Deleting this seam would scatter authority, lifecycle, resource and address
policy across map callbacks: its depth earns its interface.

### Root authority and resources, not child root ownership

Before predecessor work, `prepareDagRun` inventories outer nodes and each map's
direct child nodes, including zero-width fans. Broker claims are snapshotted once
per distinct required capability over that inventory and used for validation and
dispatch. Describe capabilities use the same pure `runtimeNodeInventory` helper:
a sorted, deduplicated union of outer and direct-child requirements, without
recursive topology projection or changing map `requires: ["checkpointer"]`.
Each ordinary child node mints its own requirements using real child
NodeId, structural child DagId and root RunId, with the original validated **base**
context, snapshotted origin, broker receiver and host LLM meter. Requirements are
not hoisted into the map's request, and parent-scoped grants never become the
child's base overlay.

Children retain the root clock/RNG/FreshnessIndex, signal, original clients,
cache/prompt closures and spend authority. Their structural DagId does not rebind
host resource namespaces. Each child has a private local job; root durable
JobLike, replay map, retry overrides, human/decision-commit/trace/classification
hooks and background ownership stay root-only. Child-authored retry policy still
runs through the same kernel with the shared RNG.

Only root preparation starts the observer Run lifecycle. Child node/domain events
and spans remain, but children emit no observer root run-start/run-end and cannot
finalize the root buffer. Child judges finalize **in the foreground before fan
completion save**, even when root finalization is backgrounded. This does not
introduce root aggregation of child DagRunMeta judge/guardrail summaries.

### Durable generation and two address spaces

Actual wave dispatch passes the current persisted parent
`freshnessExecutionEpoch`. The fan uses precisely `{ index, attempt: executionEpoch }`
for **both** completion lookup and save against map NodeId:

`dag@<mapNodeId>@<index>@<executionEpoch>`

Same-generation retry/replacement reuses acknowledged completions. A valid backward
reroute durably advances the epoch before replacement work; even identical inputs
or a reroute directly to the fan cannot consume the prior generation's completions.
This reuses the existing durable generation, not a retry counter, random token,
input hash, new counter or checkpoint migration.

Actual child `CheckpointWriter.write(runId, childNodeId, value, scope?)` calls
receive frozen `MappedChildScope { mapNodeId, index, executionEpoch }`. The host
uses the existing codec with namespace=mapNodeId, nodeId=real child NodeId,
index=index and attempt=executionEpoch:

`fugue:<tenant>:<rootDag>:<run>:<mapNodeId>@<childNodeId>@<index>@<executionEpoch>`

Root writes omit scope and remain byte-identical
`fugue:<tenant>:<rootDag>:<run>:<nodeId>`. These STRING output records are not
resume readers. Fan completions live separately in the host's `$nodes` HASH;
`$meta` and `$spend` remain disjoint under the same root prefix. Response-cache
policy and root cache/prompt namespaces do not acquire a mapped index dimension.
The host writer rejects a requested runId differing from its closure-bound run at
entry, before scope/value observation, encoding, serialization, diagnostics or
Redis/checkpoint-spend effects. Matching-run keys and retention are unchanged;
the addressable writer port is not redesigned as an unforgeable capability.

The pure codec moved inward to `shared/composite-node-key.ts`, byte-identical.
Existing named exports (`compositeNodeKey`, `parseCompositeNodeKey`,
`DEFAULT_NODE_NAMESPACE`, `CompositeNodeKeyOpts`, `ParsedCompositeNodeKey`) and
main/file entry points are unchanged. `checkpoint/index.ts` re-exports the shared
implementation; no forwarding source module or second encoder remains.

### Corrupt fan state is not missing work

Immediately after a successful Checkpointer load, a mapped fan rejects **every
nonempty `corruptNodeAddresses`**, before replay/gather, metadata seeding, child
dispatch, completion saves or reduction. This includes zero width, apparently
unrelated node keys, other indices/old epochs and opaque digest filenames. A digest
cannot establish that a dropped acknowledged completion is irrelevant; filtering
would risk repeating effects. The `node-key`/`digest-filename` ADT is preserved in
the diagnostic, not collapsed into an invented node key.

File/Redis adapters still warn and drop undecodable entries, returning remaining
nodes plus corruption addresses. The stricter refusal belongs to the mapped-fan
consumer, not a global adapter recovery-policy change. The fan's typed
`checkpoint-corrupt` names the current run and map. Existing retry classification
wraps it at public `runDag` as `retry-exhausted`, with
`rootErrorKind: checkpoint-corrupt` and the serialized original error in `lastError`
(default zero retries: one attempt). Configured retries may load again; every
corrupt load still refuses work. A failed initial metadata `Result` also stops work
and preserves its original error through the public boundary. Fresh child outputs
must pass the mapping's schema before save/gather, even if the child DAG accepted them.

There is **no automatic destructive cleanup**. Operators inspect and repair the
underlying storage, then rerun, accounting for already-completed external effects;
deleting corrupt acknowledged work is not a safe missing-work shortcut. Healthy
prefixes are reused and genuinely missing indices execute normally.

### Bounded v1 refusal and cancellation

Nested maps, child human review and child read/write freshness extractors are
unsupported and refused by construction and snapshot parsing. Ordinary reads/writes
without extractors remain legal. The human alternative is fan → gather → review
at root level, including a reviewed map node. Indexed witness/gate semantics are
not invented here. Malformed map descriptors/requirements and revoked-array width
inputs stay on the typed failure channel.

Cancellation gates prevent subsequent child dispatch and reduction, including
empty/final-index success. An already-completed child may still have its successful
completion saved. Cancellation cannot undo delegated effects, and effects without
acknowledged fan completion may repeat after interruption.

## Alternatives not chosen

- **Materialize N outer nodes:** breaks static topology and one-output-per-NodeId.
- **Public child `runDag` or blanket option forwarding:** respectively loses root
  authority or transfers root durable/lifecycle ownership.
- **Hoist all child requirements onto the map:** changes invocation authority and
  permits parent-scoped grants to masquerade as child authority.
- **New child root RunId or resource namespace:** breaks the host's run-bound
  checkpointer and shared spend/cache/prompt ownership.
- **Input hashing or per-invocation random generation:** confuses reroute with
  same-valued retry or destroys acknowledged-prefix resume.
- **Index-only writer suffix/new codec:** cannot distinguish sibling maps and
  reroute epochs, and duplicates an existing shared grammar.

## Consequences and evidence limits

Runtime/host tests now cross the public DAG and real host execution seams, rather
than calling a map closure or proving only manual writer calls. Real Redis and
five SIGKILL/replacement cases cover acknowledged-prefix resume, changed/same-valued
reroute, direct-to-fan reroute, and replacement immediately after epoch commit.
This is not proof of deployed HTTP/BullMQ acquisition/renewal, live identity-provider
policy, production tenant ACL enforcement or exactly-once external effects.

Recursive child fingerprinting, indexed broker Invocation audit dimensions and
root child-quality-summary aggregation are **deferred advisories**, not guarantees.
PR-C authored-map/plate rendering, PR-D whole-fan admission projection and concurrent
fan scheduling remain separate work. PR-B validation history lives in the closure
record; merge does not certify deployed infrastructure or exactly-once effects.

## Related

- [F1 plan §13](../plans/2026-09-06-f1-runtime-width-fanout.md#13-pr46-correctness-closure--current-contract-2026-09-08)
- [PR46 closure record](../../.claude/plans/2026-09-08-pr46-correctness-closure.md)
- [ADR-0021](0021-single-path-runtime.md) — one runtime path
- [ADR-0053](0053-per-invocation-capability-axis.md) — per-invocation authority
- [ADR-0054](0054-capability-broker-port-passthrough.md) — broker port
- [ADR-0075](0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md) — composite grammar
- [ADR-0085](0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md) — backend parity
- [ADR-0083](0083-spend-durability-lives-in-a-ledger-port.md) — root spend durability
