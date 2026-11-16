# ADR-0091: Node checkpoints are proved exact by one allocation-free walk

## Status
Accepted.

## Date
2026-11-16

## Context

The host persists every node output of every run through
`createNamespacedCheckpointWriter`, synchronous runs included. Before writing,
it proved the output would restore exactly, in three steps:

1. `assertLosslessEvent`: the FR-009 pre-scan, which refuses any value `toJson`
   cannot represent;
2. `toJson(value)`;
3. `isDeepStrictEqual(fromJson(bytes), value)`: the bytes parsed back into a
   second copy of the output and compared with it. This catches what the
   pre-scan defers: non-finite numbers, `-0`, array holes and null-prototype
   objects.

A route's last node returns the whole response, so each of the three steps
cost memory in proportion to the response. Measured in fugue-dags
(`/score-leads`, real data, peak RSS a request adds after warm-up; two node
writes, then the HTTP response):

| | 886-lead response | 1,599-lead response |
|---|---|---|
| No checkpoint writer | 0.3–2.6 MB | 3.8–6.3 MB |
| Writer before this ADR | 44–45 MB | 79–85 MB |
| Writer after this ADR | 11–13 MB | 21–27 MB |

The pre-scan alone accounted for most of the cost: about 25 MB of the
1,599-lead request's write. It built a path string for every value it
visited, before it knew of any error, and per object it allocated two
property descriptors per key, a key `Set`, two key arrays and a `ts-pattern`
`match` chain per scalar. The parse-back added a full copy of the output.

## Decision

**The pre-scan allocates nothing per value it accepts.** The path is two stacks
of the keys and indices already in hand, rendered only when a refusal names it.
Cycle detection keeps each ancestor's stack height, not its rendered path.
Accessors are found with the Annex B `__lookupGetter__`/`__lookupSetter__`
lookups; a descriptor is read only for the one case those cannot distinguish,
an accessor with neither get nor set. Scalars are classified through a
`typeof` table. Verdicts and messages are unchanged:
`file-lossless-prescan-parity.test.ts` checks them byte-for-byte against the
previous walk, kept as a frozen test-only oracle.

**Exactness is proved by the same walk, not by parsing the bytes back.**
`assertExactRoundTrip` (`@fuguejs/framework/file`) is the pre-scan plus the
four values JSON restores as something else: a non-finite number, `-0`, an
array hole and a null-prototype object. A property test holds it equivalent to
`assertLosslessEvent` plus `isDeepStrictEqual(fromJson(toJson(v)), v)` over
arbitrary and hostile values.

**The host's encoding is one exported pure function.** `encodeNodeCheckpoint`
(`@fuguejs/host`) is `assertExactRoundTrip` then `toJson`. The writer calls it,
and a DAG repository can run its DAGs under exactly the encoding its host
applies, in tests and benchmarks.

## Consequences

- Every node output of every run costs about a quarter of the memory it did to
  checkpoint, for the same refusals. The file codecs' pre-scan
  (`serializeFileEventRecord`, `serializeFileCheckpoint`) gets the same
  saving. Their own round-trip backstop is unchanged: it carries a different,
  documented policy (`-0` accepted).
- One value class the writer refused is now accepted, correctly: a Map with two
  or more structurally equal object keys. Bun's `isDeepStrictEqual` reports
  such a Map unequal to an identical copy (Node reports them equal), so the
  parse-back comparison refused an output that JSON restores entry for entry.
- The writer no longer compares its bytes with the output. A defect in
  `toJson` that changed bytes for a value the walk accepts would now reach
  Redis. `serialize-streaming-parity.test.ts` and the exact-round-trip
  property test hold that equivalence as tests rather than as a runtime check
  on every write.
- `encodeNodeCheckpoint` is public surface: changing what it refuses is a
  host contract change.
- Helpers the frozen oracle shares with `event-record.ts` (`kindName`,
  `renderPathSegment`, `ownValue`, `unrepresentableKind`) are module exports.
  They are not re-exported from the `file` barrel.
- Checkpointing stays proportional to output size. A route that must stay
  within a fixed per-request budget has to bound its output; this ADR only
  removes the overhead on top of it.
