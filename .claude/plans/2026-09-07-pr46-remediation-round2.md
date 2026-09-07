# PR-46 remediation — round 2 (F1 PR-B, the map node)

**Branch:** `feat/f1-map-node`
**Reviewed HEAD:** `cfd29e8`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-09-08T04-00-00Z-standalone-review-r24`
**Result authority:** that run's `result.json`
**Panel:** 3 criticals through the registered Refutation Panel — 3 lenses
(`reproduction`, `intent`, `security`), threshold 2. 0 refuted.

Support paths (remediation-owned, outside the frozen review scope):

- `.claude/plans/2026-09-07-pr46-remediation-round2.md` (this plan)
- `packages/host/src/adapters/redis-checkpointer.ts` (C3's adapter)
- `packages/host/src/adapters/__tests__/redis-checkpointer.test.ts` (C3's tests)
- `packages/host/src/ports.ts` (C3 — the `hSet` primitive the adapter needs)
- `packages/host/src/adapters/redis-connectivity.ts` (C3 — its ioredis implementation)

## Counts

| | count |
|---|---|
| Reviewers | 7 (no retries) |
| Critical found | 3 (C1/C2 are the same claim from two lenses) |
| Refuted | 0 |
| **Surviving critical (mandatory)** | **3** |
| Advisory | 6 |
| Advisory accepted | 4 |
| Advisory deferred | 2 |
| Advisory dismissed | 0 |

Round 1 fixed the `maxWidth` bypass and wrapped two of the three untrusted
reads in `resolveMappedItems`. This round found the third — the same defect
class, one line above the one that was fixed — and the host-side gap that makes
the node unrunnable outside the framework's own tests.

---

## Surviving criticals — mandatory

### C1 / C2 — `silent-failure-hunter-1`, `type-design-analyzer-1`: the `length` read still throws past the `Result`

**File:** `packages/framework/src/types/map-width.ts`, `resolveMappedItems`

Two reviewers, two lenses, one line. `const width = field.length;` sits between
the two `try`/`catch` blocks round 1 added — the field read above it and the
bounded element copy below it — and is itself unguarded.

`Array.isArray` performs `IsArray`, which unwraps a Proxy to its target without
invoking any trap (ECMA-262). So a `Proxy` wrapping a real array, with a `get`
trap that throws on `"length"`, passes the array guard on the line above and
then throws on this one. The throw escapes `resolveMappedItems`, whose contract
is `Result<MappedItems, FrameworkError>`, and escapes `map.ts`'s `run`, whose
contract is the same.

All three lenses upheld it. The `security` lens noted `run-node.ts` catches the
escape one layer up and re-tags it as a generic non-retriable `node-crash` —
that bounds the blast radius but does not close the contract violation, and it
converts a precise `map-width-invalid` refusal into an opaque crash.

The module's own header is unambiguous about the invariant this breaks:

> every access below is written to survive a hostile value — a `null` prototype,
> a throwing getter, a non-object — with a typed refusal rather than a raw throw

This is the "fixed the instance, not the class" shape round 1 named in its own
C2 write-up, recurring on the one access site that round did not reach.

**Fix:** read `length` inside a `try`/`catch` that returns the same
`readThrew(...)` typed refusal the sibling reads already use, so every untrusted
access in the function converts. Comment the *why* at the site — that
`Array.isArray` does not invoke traps, so passing the guard proves nothing about
the next property read.

### C3 — `architecture-tech-lead-1`: no host wires the `checkpointer` capability

**File:** `packages/host/src/adapters/node-context-factory.ts`

`createMapNode` declares `MAP_REQUIRES = ["checkpointer"]` unconditionally.
`validateCapabilities` enforces that against the wired `ctx` before any node
runs. No production host code registers a `checkpointer` `CapabilityHandle`:
`buildRuntimeCapabilities` registers `http`, `clock`, `documents`, `authedHttp`,
`oracle`, and `createNodeContextForDag` builds only the sibling
`checkpointWriter` — a **write-only** port nothing reads back.

So every DAG containing a map node fails at the capability gate on any host.
The feature ships unreachable from the only runtime that runs DAGs in
production.

The `intent` lens refuted this, citing plan §12 ("fails at the capability gate
before any node runs, which is the intended fail-closed behavior") and round 1's
deferral of the adjacent write-side advisory. That reading is fair about
*safety* — the gate is fail-closed, so nothing runs half-wired — and it is the
reason this is a completeness defect rather than an exploit. It does not make
the node runnable. `reproduction` upheld, `security` returned `uncertain`
(correctly: an availability gap is outside its lens), so the finding survives
the threshold, and the plan text it cites describes the state of the world one
PR ago rather than authorizing it permanently.

**Why the obvious wiring is wrong.** The framework ships `RedisCheckpointer`,
and `ioredis.Redis` satisfies its driver port structurally. Wiring that into the
host would be actively unsafe:

- its keys are `chkpt:<runId>` / `chkpt:<runId>:meta` — **global**, with no
  tenant segment. The host's load-bearing invariant (`cache-keys.ts`, AD-4 /
  US2 / SC-001) is that *every* key it emits is `fugue:<tenant>:…`.
- the per-tenant Redis credential is scoped to exactly one key pattern,
  `~fugue:<tenant>:*` (`supervisor/secrets/redis-acl.ts`). A `chkpt:*` write
  from a worker is denied by the ACL at runtime.
- it needs `EVAL`/`EVALSHA`/`SCRIPT`, none of which `RedisPort` exposes, so
  reaching it means handing the node-context factory a raw vendor client and
  discarding the port seam the architecture rule requires at this boundary.

**Fix:** a host-owned `Checkpointer` adapter over the existing `RedisPort`,
namespaced by the key builders the host already owns.

1. `packages/host/src/domain/cache-keys.ts` (pure, in scope) gains two builders
   beneath the existing checkpoint prefix, using the `$` separator that is
   already load-bearing there because it is outside `NodeId`'s grammar:
   - `buildCheckpointMetaKey` → `fugue:<t>:<d>:<r>:$meta`
   - `buildCheckpointNodesKey` → `fugue:<t>:<d>:<r>:$nodes`

   Both are provably disjoint from every canonical and indexed node key and from
   the sibling `$spend` aggregate, for the same reason the module already
   states.

2. `packages/host/src/ports.ts` gains `hSet?` — optional, exactly like the
   `hGetAll?` it pairs with, so the two in-memory `RedisPort` values in the
   supervisor stay valid without change. `redis-connectivity.ts` implements it
   on the ioredis port.

3. `packages/host/src/adapters/redis-checkpointer.ts` (new) implements the
   framework's `Checkpointer` over `RedisPort`:
   - `setMeta` writes the meta string key, stamping `frameworkVersion` so
     ADR-0017's version gate has something to check.
   - `saveNode` routes the address through the framework's
     `encodeStoredNodeKey`, so a malformed composite address fails
     `checkpoint-write-failed` **without issuing a write** (the port's explicit
     requirement) rather than silently folding to the canonical key. The entry
     lands in the run's `$nodes` hash under the stored composite key.
   - `load` reads meta, returns `ok(null)` when absent, then delegates the gate
     order (framework version → DAG fingerprint → TTL expiry) to the framework's
     own `evaluateCheckpointLoadGates` rather than re-encoding it — the
     divergence that function exists to prevent. Undecodable hash fields are
     dropped into `corruptNodeAddresses` instead of failing the whole load.
   - Every seam is total: a throwing driver, a non-string field, malformed JSON
     and a non-canonical timestamp each become a typed `FrameworkError`, never a
     raw rejection.

4. `packages/framework/src/checkpoint/index.ts` (in scope) re-exports
   `evaluateCheckpointLoadGates`, `encodeStoredNodeKey`,
   `parseCanonicalIsoDate`, `TTL_SECONDS` and the `CheckpointerLoadOpts` /
   `SaveNodeOpts` types the adapter consumes. The framework's root `index.ts`
   already does `export * from "./checkpoint/index.js"`, so the public surface
   follows with no out-of-scope edit.

5. `createNodeContextForDag` constructs the adapter with the same
   `tenant`/`dagId`/`runId`/`checkpointTtlSec` it already hands
   `createNamespacedCheckpointWriter`, and appends
   `{ name: "checkpointer", client: checkpointer }` to the per-run capability
   array. It is per-run, not boot-scoped, for the same reason the writer is: the
   namespace is not known until the run is.

**Tests:** the adapter against a fake `RedisPort` — round-trip save/load,
composite (indexed) addressing surviving into `RunState.nodes`, absent meta
yielding `ok(null)`, a version mismatch and an expired checkpoint each refused
by kind, a corrupt hash field landing in `corruptNodeAddresses` rather than
failing the load, and a throwing driver becoming a typed error. Plus a
`node-context-factory.test.ts` pin that the assembled context actually carries a
`checkpointer` capability — the regression that would have caught this round's
C3 at the time it was introduced.

---

## Advisory dispositions

| ID | Agent | Disposition | Reason |
|---|---|---|---|
| `pr-test-analyzer-1` | pr-test-analyzer | **accepted** | `sideEffects.kind === "writes"` is round 1's own C3 fix and nothing asserts it; a silent revert to `"reads"` passes every test in the suite. Three lines to pin the profile a state-mutating node must present. |
| `pr-test-analyzer-2` | pr-test-analyzer | **accepted** | The title at `errors.test.ts:576` still says "the 27 error kinds" over a 29-row table. The body no longer depends on the number (round 1 replaced the assertion with a taxonomy diff), but the stale literal in the title is the exact drift class that fix removed. One line. |
| `comment-analyzer-1` | comment-analyzer | **accepted** | The two `@satisfies FR-013` checkpoint-key lines in `node-context-factory.ts` document the pre-F1 format while the sibling `cache-keys.ts` doc documents both forms. This PR added the suffix; the doc that names the format should say so. |
| `code-simplifier-1` | code-simplifier | **accepted** | Two author-time rejection tests re-type `fanNode`'s whole fixture body to vary one field. `fanNode` already takes an override bag; widening it with `widthFrom` collapses both call sites and is the pattern the file establishes. |
| `silent-failure-hunter-2` | silent-failure-hunter | **deferred** | The claim is sound — `createNamespacedCache.set` can never populate the `Err` branch its `Result` type advertises — but the site documents this deliberately and the return type is imposed by the framework's `ContextCacheAdapter` port. A complete fix narrows that port and every adapter and caller behind it, none of which is in the reviewed scope, and PR-B touches none of it (its whole diff in this file is the 14-line `index` threading). Not a defect this PR introduced or can honestly close. |
| `architecture-tech-lead-2` | architecture-tech-lead | **deferred** | `selectAndHydrateSpendLedger`'s entanglement of the fail-closed budget decision with its I/O is real and worth extracting, but it is F3 budget code with its own review history, untouched by this PR, and reachable only through a refactor of a different feature's module. It is in the reviewed *scope* by file, not by change. |

No advisory is dismissed.

---

## Refuted-finding audit

None. The panel refuted zero of three. `architecture-tech-lead-1` drew one
`refuted` verdict from the `intent` lens (recorded in `result.json` under
`panel.outcomes[2].reasoning`) and one `uncertain` from `security`; with
`upheld_by: ["reproduction"]` against a threshold of 2 it survives, and it is
fixed above rather than argued with.

---

## Fix list

1. **C1/C2** — `map-width.ts`: guard the `length` read, returning the same typed
   refusal as its two sibling reads.
2. **C1/C2 tests** — `map-width.test.ts`: a Proxy whose `get` trap throws on
   `"length"` yields a typed refusal, not a raw throw.
3. **C3** — `cache-keys.ts` builders, `ports.ts` `hSet?`,
   `redis-connectivity.ts` implementation, the new
   `adapters/redis-checkpointer.ts`, the `checkpoint/index.ts` re-exports, and
   the capability wiring in `createNodeContextForDag`.
4. **C3 tests** — `adapters/__tests__/redis-checkpointer.test.ts`, plus the
   capability-presence pin in `node-context-factory.test.ts` and the key-builder
   rows in `cache-keys.test.ts`.
5. **Advisories** — the four accepted items above.

## Validation commands

```bash
for p in framework host examples adapter-fs adapter-pg adapter-oracle \
         adapter-ms-graph document-source http-auth xlsx; do
  (cd packages/$p && bunx tsc --noEmit && bun test)
done
```

Run per workspace, the way CI does — a root-level `-p` invocation resolves a
different file set and is what let 14 type errors reach CI on this branch.
