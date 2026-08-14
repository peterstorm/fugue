# ADR-0079: File FreshnessIndex — digest-addressed latest-write files with lazy TTL parity

## Status
Accepted

## Date
2026-08-14

## Context
The filesystem backend must implement the existing `FreshnessIndex` port durably so that a write recorded by one process remains available to a fresh process (FR-030). `findConflict(conditionedOn, sinceMs)` needs bounded Redis parity at the port boundary: select the latest write for the resource, use Redis's ordering for equal scores, treat `succeededAtMs === sinceMs` as eligible, suppress a conflict when the selected value equals the conditioned value, refresh the 24-hour lifetime on every successful write, and return a clean `ok(null)` for an absent record (FR-032). The backend must provide those behaviors without Redis, new package dependencies, or a separate event-history subsystem.

Concurrent and out-of-order `recordWrite` calls make a naive last-arrival file unsafe. Under AD-5's singleton contract, a delayed write with a lower `succeededAtMs` must not replace the live higher-scored singleton, while equal timestamps must select the member Redis would return from its reverse score query regardless of arrival order. This is deliberately not exact Redis mutation or physical ZSET parity. Redis member identity excludes the score, so `ZADD` can lower the score of an identical serialized member; because Redis also retains the other members, that update can expose a different latest member. Reproducing that behavior generally requires member history, which AD-5 rejects. The file backend instead binds itself to a monotonic live singleton, deterministic latest-write selection across retained candidates, conflict boundaries, and TTL refresh. The singleton comparison and replacement must form one serialized transaction, and readers must observe either the prior complete record or the new complete record, never partial JSON (FR-031). Redis refreshes a 24-hour key TTL on every successful write, including writes that do not become the latest member, so the file representation needs the corresponding observable expiry-window refresh without a background service.

Freshness resources are arbitrary non-empty strings with no identifier-length bound, so raw resource names cannot safely become portable path components or be narrowed to the checkpointer's identifier charset. Persisted files are untrusted after restart: malformed shapes, crossed digest/content resources, and attempts to substitute a member history must be detected strictly while retaining the Redis adapter's corrupt-member behavior on lookup. History, retention, and physical garbage collection must not leak into this index's responsibility.

## Options Considered

1. **One digest-addressed latest-write singleton with serialized compare/replace and lazy TTL**
   - Pros: Stores the bounded latest-write state required by AD-5; bounds filenames independently of resource length; survives restart; prevents delayed writes from regressing the singleton; reproduces Redis's equal-score winner, conflict boundaries, and TTL refresh target; permits strict whole-record validation and atomic rename.
   - Cons: Requires a per-resource filesystem lock and a read/compare/write transaction; discards write history by design; lazy expiry leaves expired files on disk; digest filenames are not human-readable.

2. **A full per-resource Redis ZSET member set/history persisted in JSON**
   - Pros: Mirrors Redis's physical data structure; retains every unexpired member; can reproduce `ZADD` lowering the score of an identical member and then reselect from the remaining history; could answer historical queries if the port later gained them.
   - Cons: Reintroduces a superseded full-ZSET design that the current AD-5 singleton model neither exposes nor needs; requires set-update, deduplication, pruning, and corruption rules for many members; rewrites growing aggregate state or needs additional files; expands contention and recovery complexity to cover a deliberately excluded mutation case. Rejected: the file backend must not persist a `members` collection or member history.

3. **Per-resource append-only write files or an append set**
   - Pros: Preserves an audit trail and makes each committed write immutable; avoids replacing a resource record.
   - Cons: Requires scans and deterministic tie resolution on every lookup, unbounded retention or a compactor, and additional atomic sequencing/deduplication machinery; duplicates the event log's history responsibility. Rejected: append logs and append sets are not part of the freshness index.

4. **Raw resource filenames with filesystem-identifier validation**
   - Pros: Human-readable paths and no digest computation.
   - Cons: Rejects long or punctuation-rich resources accepted by the port and Redis; risks `NAME_MAX` failures and path interpretation. Rejected because backend substitution must not narrow valid resource names.

5. **Eager expiry deletion through a sweeper or write-time global scan**
   - Pros: Reclaims physical space and makes on-disk presence match logical visibility.
   - Cons: Adds lifecycle, scheduling, race, and ownership concerns; a global scan increases write cost; the specification assigns no background GC to this backend. Rejected in favor of lazy visibility checks and consumer-owned directory retention.

## Decision
**Persist one SHA-256-addressed, score-monotonic latest-write singleton per resource, targeting bounded Redis parity for selection, equal-score ordering, conflict boundaries, and TTL refresh—not physical ZSET history.**

`createFileFreshnessIndex` is implemented in `packages/framework/src/file/freshness-index.ts` and exported by `packages/framework/src/file.ts`. For resource `r`, its sole committed record is:

```text
<directory>/<sha256hex(r)>.json
```

with the exact JSON shape:

```text
{
  writtenAtMs,
  runId,
  nodeId,
  newWitness: { kind, resource, value },
  succeededAtMs
}
```

The raw resource never participates in path construction. `keyDigest` from `packages/framework/src/file/layout.ts` produces the fixed 64-lowercase-hex filename address, while the embedded `newWitness.resource` proves that the file content owns that address.

`recordWrite` snapshots and validates the incoming event, including its event type, bounded `runId` and `nodeId`, allowed witness kind, non-empty resource and value, and finite `succeededAtMs`. It then acquires `<directory>/<digest>.lock` through `withFileLock`. The lock's permanent race fence remains as `<directory>/<digest>.lock.fence/`; it is protocol metadata, not a freshness record, and contains no raw resource text. While holding that cross-process lock, `recordWrite` reads and strictly decodes the existing singleton, compares it with the incoming write, selects the winner, and commits the complete replacement through `atomicWriteFile` (same-directory temporary file plus rename). The lock makes read/compare/replace one serialized operation; atomic rename is the process-crash commit point, so a reader sees the complete previous singleton or complete replacement (FR-031).

For a live existing singleton, the greater `succeededAtMs` wins. This score-monotonic rule is binding AD-5 behavior: a lower timestamp arriving later cannot overwrite a higher singleton, including when the incoming write serializes to the same Redis member. Equal scores are resolved using the byte-identical Redis member serialization `JSON.stringify([runId, nodeId, witnessKind, witnessValue])`; the lexicographically greater unsigned UTF-8 byte sequence wins, matching the reverse binary member ordering used by Redis for equal-score ZSET members. Put precisely, the file backend retains the maximum `(succeededAtMs, memberBytes)` tuple observed during the live singleton window. Selection between distinct equal-score candidates is therefore independent of arrival order. If the stored singleton has already expired, the incoming write starts a new window and may replace it regardless of score because no live file state remains.

The identical-member/lower-score case is an explicit parity boundary. Redis `ZADD` updates the current score attached to that member even when the new score is lower; `ZREVRANGEBYSCORE` then selects from the current scores of that member and every other retained member. The rescore can move the identical member below `sinceMs` or expose another retained member as latest. The file backend preserves the previously higher tuple instead: it has neither the member history needed to reveal another Redis candidate nor a contract to emulate physical ZSET mutations. AD-5 rejects adding that history. “Redis parity” in this ADR therefore means the observable target for latest-write selection under the singleton model, equal-score ordering, inclusive `sinceMs` and same-value conflict rules, and expiry-window refresh; it does not mean exact command-by-command or stored-state equivalence.

Every successful `recordWrite` writes a fresh finite `writtenAtMs`, even when the incoming write loses and the prior logical winner is retained. This gives the resource the same observable 24-hour refresh behavior targeted from Redis's atomic `ZADD` plus `EXPIRE`. `findConflict` treats the singleton as live through 24 hours and absent when `now() - writtenAtMs > 86_400_000`. Expiry is lazy: the file is neither deleted nor swept.

`findConflict` reads only the conditioned resource's singleton. `ENOENT` returns `ok(null)` without creating the directory. For a valid, live singleton it returns the selected `WriteEntry` iff `succeededAtMs >= sinceMs` and `newWitness.value !== conditionedOn.value`; otherwise it returns `ok(null)`. In particular, an older differing value cannot create a conflict when the selected latest write has restored the conditioned value. This is the latest-write behavior required by FR-032, not a scan over retained members.

The persisted codec is closed and strict: the outer object must contain exactly `writtenAtMs`, `runId`, `nodeId`, `newWitness`, and `succeededAtMs`; the witness must contain exactly `kind`, `resource`, and `value`; timestamps must be finite; identifiers, kind, and non-empty strings must be valid; and content resource must match the requested digest address. `members`, `history`, append-set shapes, unknown fields, malformed JSON, and digest/content disagreement are corruption, not alternate formats. On lookup, corruption is logged with path and digest context and treated as absent, matching `RedisFreshnessIndex.decodeMember`'s drop-with-warning behavior. On `recordWrite`, a corrupt existing singleton produces a typed `cache-error` and its bytes are left untouched rather than being silently replaced. Genuine I/O, validation, clock, or warning-transport failures also use the port's typed `cache-error` operations.

These invariants and FR-030/FR-031/FR-032 are exercised in `packages/framework/src/__tests__/file-freshness-index.test.ts`: restart durability, one-file layout, concurrent and out-of-order selection, Redis-compatible equal-score properties, atomic replacement, conflict boundaries, TTL refresh/expiry, and strict rejection of member/history shapes.

## Consequences

**Positive:**
- A recorded latest write survives process restart while requiring only one bounded file per resource (FR-030).
- Serialized comparison prevents older or racing writes from regressing the singleton; equal-score selection is deterministic and Redis-compatible.
- Same-directory temporary write plus rename gives prior-complete/new-complete reader observations for process crashes (FR-031).
- Within AD-5's documented singleton boundary, latest-write selection, inclusive `sinceMs`, same-value suppression, missing-record behavior, and 24-hour refresh semantics align with the Redis adapter (FR-032).
- Digest addressing accepts every non-empty resource admitted by the port without path escape or `NAME_MAX` exposure.
- Strict decoding prevents a full member set, append history, extra fields, or crossed content from becoming an accidental second on-disk format.

**Negative:**
- The index intentionally cannot answer historical-write queries; audit history must come from the event log.
- Redis can lower an identical member's score and reselect from retained ZSET history; the file backend deliberately keeps the higher live singleton, so physical and command-by-command Redis parity are not provided.
- Every write acquires a filesystem lock and performs a read/compare/atomic-write transaction, adding contention and I/O compared with an in-memory latest-value assignment.
- Expired singleton files remain physically present until the consumer removes the directory or a later write replaces them; there is no built-in disk reclamation.
- Corruption is asymmetric by operation: lookup warns and treats the record as absent for Redis parity, whereas write fails closed to preserve forensic bytes; callers must monitor warnings to detect degraded conflict coverage.
- SHA-256 filenames obscure resources during manual inspection and carry a negligible theoretical collision risk.
- Atomic rename provides process-crash atomicity but, without `fsync`, does not claim durability across sudden host power loss.

## Related

- [ADR-0076 — On-disk layout: ProgramJournal parity with the digest-filename adaptation](./0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md)
- [ADR-0080 — Failure surface: `Result` everywhere the port allows; typed throwing inside the `JobLike` shell](./0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md)
