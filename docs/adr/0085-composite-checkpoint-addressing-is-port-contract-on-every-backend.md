# ADR-0085: Composite checkpoint addressing is port contract on every backend

## Status
Accepted

## Date
2026-09-06

## Context

ADR-0075 defined the composite node-key codec — `(namespace, nodeId, index, attempt)` encoded as
`` `${namespace}@${nodeId}@${index}@${attempt}` `` with canonical folding — and named its motivation
outright: *"Indexed fan-out, nested DAG namespaces, and repeated attempts need multiple durable
outputs for the same node without one save overwriting another."*

It shipped with F6, whose FR-023 required the in-memory and Redis backends and their layouts to
remain unchanged. So the codec was implemented in the file backend only, and ADR-0075 recorded the
split as a known negative:

> Composite options are part of the shared port but have backend-specific persistence semantics in
> this release: the file backend honors them, while in-memory and Redis intentionally collapse saves
> to `nodeId`.

That was the right call for F6, which needed to change no existing layout. It is the wrong state to
begin F1 (runtime-width fan-out) from, and the reason is not stylistic. The port at
`checkpoint/checkpointer.ts:505` declares `saveNode(runId, state, opts?: SaveNodeOpts)`, so a
composite-aware caller compiles against every backend — but `redis-checkpointer.ts` did not even
*declare* the third parameter, and `InMemoryCheckpointer` accepted and discarded it. A mapped node
checkpointing per index would therefore have had every index of the fan overwrite the same entry on
two of three backends, and a partial fan would silently restart from whichever index wrote last on
resume.

The failure would not have been caught by the framework suite, because composite expectations lived
in `file-checkpointer.test.ts` — the one backend that implemented them. This is the same shape of
gap ADR-0084 had just closed for the Bun runtime: a green suite that is evidence about a
configuration other than the one that runs.

## Decision

**Composite addressing is port contract. Every `Checkpointer` backend honors `SaveNodeOpts`, and the
contract cases live in the shared parity suite.**

Three parts:

1. **`redis-checkpointer.ts` and `InMemoryCheckpointer` encode the address** through the same
   `compositeNodeKey` codec the file backend uses. On Redis the composite string becomes the HASH
   FIELD within the existing `chkpt:<runId>` hash; the layout is otherwise untouched. The stored
   `NodeState.nodeId` remains the canonical DAG identity in every backend — the key is the address,
   `nodeId` is who the node is.

2. **A malformed address is `checkpoint-write-failed` everywhere, not `cache-error`.** The file and
   in-memory backends already classified it that way. Redis's natural implementation would have
   folded the encoder's throw into its driver `try`, reporting `cache-error(saveNode)` — making one
   failure wear a different error kind depending on which backend a deployment happened to
   configure, which a caller cannot branch on. The encoder therefore runs *outside* the driver
   `try`, which also guarantees the fail-closed property: a rejected address issues **no write at
   all** rather than falling back to the canonical key. A silent canonical fallback is precisely how
   a fan index would clobber the node's own checkpoint.

3. **Composite expectations move into `_checkpointer-suite.ts`.** They were excluded from the shared
   suite because FR-023 made them a fake carve-out; now that all backends honor the address, the
   suite is where the contract belongs, so a fourth backend cannot ship indexed fan-out that
   silently overwrites itself. The file backend's richer cases (digest filenames, the full
   permutation table) and filesystem atomicity stay in `file-checkpointer.test.ts` — adapter
   properties, not port contract.

**Canonical folding is what makes this non-breaking.** A `saveNode` call with no opts encodes to
exactly `nodeId` on every backend, so existing keys are byte-identical and no migration is required.
FR-023's *outcome* for stored data is preserved; only its restriction on new addresses is lifted.

## Consequences

**Positive:**
- The address a composite-aware caller can express is the address every backend stores. F1's fan-out
  can checkpoint per index without asking which backend is configured.
- One error kind for one failure across backends.
- The parity suite, not one adapter's test file, is the definition of composite behavior.
- ADR-0075's recorded negative is closed rather than left stale.

**Negative:**
- The Redis nodes hash may now contain both `n1` and `dag@n1@0@0` for one node. They are distinct
  normalized addresses by ADR-0075's injectivity argument, and `parseCompositeNodeKey` classifies
  either — but readers walking `RunState.nodes` must use it rather than assume bare node ids. This
  was already true for the file backend.
- `InMemoryCheckpointer` still does not run the shared parity suite (only the file and Redis
  backends call `checkpointerSuite`). Its composite behavior is pinned directly in
  `composite-node-key.test.ts`. Bringing it under the suite is worthwhile and is not done here.

## Related

- ADR-0075 — the composite codec and its file-backend-only rollout, which this completes
- ADR-0084 — the same class of gap (a suite proving something about a non-shipped configuration)
- `docs/plans/2026-09-06-f1-runtime-width-fanout.md` §2, PR-A
