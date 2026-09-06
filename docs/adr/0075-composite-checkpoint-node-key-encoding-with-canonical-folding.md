# ADR-0075: Composite checkpoint node-key encoding with canonical folding

## Status
Accepted

## Date
2026-08-14

## Context
The original `Checkpointer` address space used only `nodeId`, which is sufficient while a node has one checkpointed instance per run. Indexed fan-out, nested DAG namespaces, and repeated attempts need multiple durable outputs for the same node without one save overwriting another. The port therefore needed an additive address space that could identify `(namespace, nodeId, index, attempt)` while preserving the existing `Record<string, NodeState>` load shape.

Compatibility constrained the change. Existing consumers index `RunState.nodes` by the bare node ID, and the in-memory and Redis implementations and layouts were not to be migrated in this feature. The [F6 specification's FR-021, FR-022, and FR-023](../../.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md) require a backend-agnostic port extension with canonical fallback, collision-free composite persistence in the file backend, and unchanged behavior and storage for the existing backends.

The stored address also had to be deterministic, reversible, and unambiguous. Valid framework identifiers match `^[A-Za-z0-9_:-]{1,128}$`, so delimiters such as `:` cannot distinguish a composite key from a valid canonical node ID. The encoding must normalize omitted defaults without allowing a composite address to collide with the canonical bare-node form.

## Options Considered

1. **An `@`-delimited string key with canonical folding**
   - Pros: Preserves bare `nodeId` keys for existing calls; remains compatible with `Record<string, NodeState>`; uses a separator outside the valid identifier alphabet; is deterministic, reversible, and collision-free across normalized addresses.
   - Cons: Establishes a positional string grammar; namespace-only options intentionally fold away (superseded by the 2026-08-14 Amendment below — they are now rejected); composite persistence is initially supported only by the file backend.

2. **A `:`-delimited key such as `namespace:nodeId:index:attempt`**
   - Pros: Human-readable and visually consistent with identifiers already used by the framework.
   - Cons: `:` is valid inside every identifier component, so canonical and composite keys could collide and parsing would be ambiguous without an additional escaping protocol.

3. **Structured address objects inside `RunState`**
   - Pros: Makes each address component explicit and avoids delimiter parsing.
   - Cons: Breaks `Record<string, NodeState>`, property lookup through `nodes[nodeId]`, serialized layouts, and existing consumers; requires a migration rather than an additive port extension.

4. **Apply composite storage semantics to the in-memory and Redis backends immediately**
   - Pros: Gives every backend identical behavior for the new options from day one.
   - Cons: Changes established storage keys and observable load behavior, expands migration and regression risk, and directly violates FR-023's requirement that those backends and their layouts remain unchanged.

## Decision
**Adopt the `@`-delimited string codec with canonical folding, and implement composite persistence only in the file checkpointer.**

The port in [`checkpoint/checkpointer.ts`](../../packages/framework/src/checkpoint/checkpointer.ts) accepts `saveNode(runId, state, opts?)`, where `state.nodeId` is the sole canonical node identity and `SaveNodeOpts` aliases `CompositeNodeKeyOpts { namespace?: string; index?: number; attempt?: number }`. The optional third argument extends that identity with composite addressing without duplicating node identity at the interface.

The pure codec in [`checkpoint/composite-node-key.ts`](../../packages/framework/src/checkpoint/composite-node-key.ts) defines these invariants:

- If both `index` and `attempt` are absent, `compositeNodeKey` returns exactly `nodeId`. A supplied namespace alone does not change the address. This is the canonical form required by FR-021. (Amended 2026-08-14: a namespace alone is now **rejected** as ambiguous caller error rather than folded — see the Amendment below.)
- If either `index` or `attempt` is present, the result is `` `${namespace}@${nodeId}@${index}@${attempt}` ``, with namespace defaulting to `dag` and each missing numeric component defaulting to `0`. An explicitly supplied zero selects composite form.
- Namespace and node ID components use the framework ID grammar. Index and attempt are non-negative safe integers. The file persistence boundary validates all supplied fields before encoding.
- `@` cannot occur in a valid canonical node ID or component. Canonical keys therefore have zero separators and composite keys exactly three, making the forms disjoint. Distinct normalized composite tuples produce distinct strings; omitted values and their explicit defaults intentionally denote the same normalized address.
- `parseCompositeNodeKey` accepts a valid zero-separator canonical key or an exactly-three-separator composite key, re-validates every component, requires canonical unsigned decimal numeric text, and returns `null` for every other shape.

The codec and its types are exported from [`checkpoint/index.ts`](../../packages/framework/src/checkpoint/index.ts). `RunState.nodes` is keyed by the stored node key, while each `NodeState.nodeId` continues to identify the actual DAG node. `RunState.corruptNodeAddresses` uses a discriminated union: recoverable addresses are `{ kind: "node-key", nodeKey }`, while unreadable file envelopes are `{ kind: "digest-filename", fileName }`. Consumers can use `parseCompositeNodeKey` only on the recoverable node-key arm.

The shipped file implementation in [`file/checkpointer.ts`](../../packages/framework/src/file/checkpointer.ts) applies the codec in `saveNode`, persists each logical address independently, and returns every valid entry under its stored key on `load`, satisfying FR-022. Its digest-addressed node file contains the original `nodeKey`, and reads verify and parse that key before exposing it. The in-memory implementation deliberately ignores `SaveNodeOpts`, and the Redis implementation retains its canonical `nodeId` behavior and layout, satisfying FR-023. (Superseded 2026-09-06 by [ADR-0085](0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md): both now honor the address. Canonical folding is unchanged, so no stored key moved.) The evidence is split by surface: [`composite-node-key.test.ts`](../../packages/framework/src/__tests__/composite-node-key.test.ts) pins canonical folding, composite defaulting, strict parse/encode round-trips, form disjointness, and injectivity; it also verifies that in-memory saves with full composite options or malformed runtime option values remain keyed by bare `nodeId` without logger output. [`file-checkpointer.test.ts`](../../packages/framework/src/__tests__/file-checkpointer.test.ts) pins file persistence for canonical, index-only, attempt-only, combined index/attempt, namespace-plus-index, and distinct-node permutations, plus the digest filename for a full namespace/index/attempt address.

## Consequences

**Positive:**
- Canonical node keys and in-memory and Redis storage remain unchanged; no checkpoint migration is required.
- The file backend can persist indexed, namespaced, and attempted instances of the same node without overwriting the canonical entry or another normalized composite address.
- The separator rule and strict parser make malformed or impossible stored addresses detectable rather than silently interpreting them.
- The pure exported codec gives producers, persistence implementations, and consumers one definition of the composite address grammar.

**Negative:**
- Composite options are part of the shared port but have backend-specific persistence semantics in this release: the file backend honors them, while in-memory and Redis intentionally collapse saves to `nodeId`.
  **Closed 2026-09-06 by [ADR-0085](0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md):** every backend now honors the address, and the contract cases moved into the shared parity suite. Canonical folding is unchanged, so stored keys did not move.
- A namespace alone cannot create a distinct entry; callers must provide `index` or `attempt` to select composite form.
- The positional key grammar and reserved `@` separator become compatibility constraints. Adding components or changing normalization requires a versioned design change.
- Loaded node maps may contain both bare and composite string keys, so consumers that enumerate nodes must inspect stored keys rather than assume every key equals `NodeState.nodeId`.

## Amendment (2026-08-14)

**Namespace-only `SaveNodeOpts` are rejected, not folded.** The Decision bullet above ("a supplied namespace alone does not change the address") described the original encoder behavior. During the 2026-08-14 standalone-review remediation (`.claude/plans/2026-08-14-pr-remediation-215348.md`, advisory `type-design-analyzer-1/5`, accepted), the silent fold was changed to a contract violation: `compositeNodeKey` throws when a runtime caller supplies `namespace` without `index` or `attempt`, because a namespace-only address would be silently discarded while a later composite save with `index: 0` would land on a different durable entry. The file backend maps a forged runtime shape to typed `checkpoint-write-failed`.

The 2026-08-20 remediation also encoded this invariant in `CompositeNodeKeyOpts`: the canonical arm is empty, while each composite arm requires `index` or `attempt`. Namespace-only is therefore a compile-time error for typed callers and remains runtime-rejected for JavaScript/brand-bypassed input. The pins are `composite-node-key.test.ts` (compile-time `@ts-expect-error` plus runtime refusal) and `file-checkpointer-codec.test.ts` (hostile boundary parse). The canonical-fold behavior for omitted `index`/`attempt` (bare `nodeId`, byte-identical for existing consumers) is unchanged.

## Amendment (2026-08-20 — single node identity)

`Checkpointer.saveNode` now takes `(runId, state, opts?)`; the separate addressed `nodeId` parameter was removed. `NodeState.nodeId` is the one identity used by canonical keys, composite-key construction, and serialized node envelopes. The previous `(nodeId, state.nodeId)` pair admitted mismatches that the file adapter rejected but the in-memory and Redis adapters persisted. Removing the duplicate shrinks the port state space so backend disagreement is unrepresentable for typed callers; the file boundary still re-parses forged JavaScript inputs before path construction. This is a pre-release interface deepening, so no compatibility overload is retained.

## Related

- [ADR 0076](0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md) — defines the digest-addressed file-checkpointer layout that persists and verifies composite node keys.
