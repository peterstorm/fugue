# PR-46 remediation — round 3 (F1 PR-B, the map node)

**Branch:** `feat/f1-map-node`
**Reviewed HEAD:** `92b4b41`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-09-08T08-00-00Z-standalone-review-r25`
**Result authority:** that run's `result.json`
**Panel:** 4 criticals through the registered Refutation Panel — 3 lenses
(`reproduction`, `intent`, `blast-radius`), threshold 2. **2 refuted.**

Support paths (remediation-owned, outside the frozen review scope):

- `.claude/plans/2026-09-07-pr46-remediation-round3.md` (this plan)
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts` (C1 + C2 tests)
- `packages/host/src/__tests__/domain/framework-error-http.test.ts` (A2's test)
- `packages/host/src/main-supervisor.ts` (C1's sibling instance — see C1)

## Counts

| | count |
|---|---|
| Reviewers | 7 (no retries) |
| Critical found | 4 |
| **Refuted** | **2** |
| **Surviving critical (mandatory)** | **2** |
| Advisory | 5 (one duplicate emission) |
| Advisory accepted | 4 |
| Advisory deferred | 0 |
| Advisory dismissed | 0 |

This round is the first where the panel actually **refuted** findings, and it
refuted them correctly — see the audit below. Both surviving criticals are in
`redis-connectivity.ts`, the file round 2 pulled into scope by adding `hSet` to
it. One of them is a pre-existing process-killer that had never been in a
reviewed scope before.

---

## Surviving criticals — mandatory

### C1 — `silent-failure-hunter-1`: an ioredis connection fault crashes the host

**File:** `packages/host/src/adapters/redis-connectivity.ts`

`createRedisConnectivity` builds an ioredis client and never attaches an
`error` listener. `Redis` is an `EventEmitter`, and Node's contract for an
`error` event with **no** listener is to throw it — so a connection reset, a
failed reconnect, or an ACL disconnect does not degrade the host, it kills the
process. Grepping all of `packages/host/src` finds no `.on("error", …)`
anywhere.

Upheld by all three lenses, unanimously. Two of them went further than the
claim:

- The `intent` lens checked whether the process-wide `uncaughtException`
  handler in `lifecycle/signals.ts` was meant to cover this, and found it is
  registered inside `createHost` via `registerSignalHandlers` — which runs
  *after* `executeStartup`, and `executeStartup` is what first dials Redis. The
  window where the client actually connects is not covered by the global net at
  all.
- The `blast-radius` lens found the same defect in `main-supervisor.ts`, which
  builds **two** more raw ioredis clients the same way and has no
  `uncaughtException` handler whatsoever — so there the fault is an unguarded
  crash of the process supervising every tenant worker on the host.

**Fix.** Attach an `error` listener at every client construction site.

`createRedisConnectivity` gains an optional `logger` parameter and routes the
event through `logWithoutThrowing`, which already falls back to stderr when the
logger is absent or itself throws. Optional, so the two entrypoints
(`main.ts`, `worker-main.ts`) need no change and stay out of this diff; absent
a logger the event is still reported, never swallowed. Wiring their structured
loggers through is a one-line follow-up in files this scope does not own.

`main-supervisor.ts` is registered as a **support path** and gets the same
listener on both of its clients. It is the identical one-line defect with a
strictly wider blast radius, and the last three rounds on this PR have each
caught a "fixed the instance, not the class" miss — closing one client while
leaving two known-crashing siblings would be exactly that.

The listener logs and returns. It does **not** try to reconnect or change
health state: ioredis owns reconnection, and the host already reports
`degraded:redis-disconnected` from its own `ping` probe. The bug is the crash,
not the absence of a recovery policy.

### C2 — `pr-test-analyzer-1`: the real `hSet` is untested

**File:** `packages/host/src/adapters/redis-connectivity.ts`

Round 2 added `hSet` to the ioredis port with two branches — a bare `HSET`, and
a `MULTI` `HSET`+`EXPIRE` when a TTL is supplied — and the production comment
right above it explains that the transaction is load-bearing (a crash between a
bare `HSET` and a separate `EXPIRE` leaves the key immortal). Nothing tests
either branch. The only `hSet` call in any test drives a hand-written fake
`RedisPort` one layer up, which cannot observe which Redis commands were
actually issued.

The `intent` lens noted the test file's own header enumerates the invariants it
deliberately locks — including `setNx`'s analogous atomic acquire — and that
`hSet`'s atomicity is conspicuously absent from a list it belongs on.
`blast-radius` returned `uncertain`, correctly: "is there a test" is not an
impact question.

**Fix.** `redis-connectivity.test.ts` (support path) gains, against the existing
injected `FakeRedis`:

- no TTL → exactly one bare `hset`, and **no** `multi`;
- with TTL → one `MULTI` carrying `hset` **and** `expire` on the same key, with
  the TTL forwarded — the pairing that must never split;
- a queued-command error inside that transaction → a typed `Err`, never a
  success (`requireTransactionResults` is what enforces it);
- a throwing driver → a typed `Err`, not a raw rejection.

`FakeRedis` needs a bare `hset` method; it currently implements only
`multi.hset`, which is *why* the gap was invisible.

---

## Advisory dispositions

| ID | Agent | Disposition | Reason |
|---|---|---|---|
| `code-reviewer-1` | code-reviewer | **accepted (scope stated)** | Every layer of the checkpointer is tested against hand-written fakes, so nothing proves the real Redis commands round-trip. Accepted for the half in reach: a `REDIS_URL`-gated test driving the REAL `createIoredisRedisPort` through `createNamespacedCheckpointer` — save an indexed entry, load it back, assert the tenant-prefixed keys actually in the server. The other half the finding asks for — crash-and-resume through a running host and a real DAG — needs a booted host, worker and registry, and is a fixture this PR does not have; named here as the follow-up rather than quietly dropped. |
| `pr-test-analyzer-2` | pr-test-analyzer | **accepted** | `map-width-invalid` / `map-width-exceeded` were added to `EXECUTION_FAILURE_KINDS` with a comment arguing carefully for that placement, and nothing pins the HTTP status or breaker classification the argument concludes with. A table row each. |
| `pr-test-analyzer-3` | pr-test-analyzer | **accepted** | A gap in MY round-2 tests: the fixture routes `get`, `hGetAll` and `hSet` through its mutable `behaviour` seam but not `set`, so a failing or rejecting `setMeta` write is the one driver path with no failure test. Exactly the arm that caught a real defect for its siblings last round. |
| `comment-analyzer-2` / `-4` | comment-analyzer | **accepted** | `map-width.ts`'s header labels its three arms `FR-F1-003/004/005` in ascending order above bullets whose real mapping is 005, 003, 004. A reader pairing positionally mis-attributes all three. Tag each arm with its own FR. |

No advisory is deferred or dismissed.

---

## Refuted-finding audit — both refutations were right

The panel refuted two criticals, and re-checking them confirms the panel rather
than the reviewer. Recording the reasoning because it is a live trap for the
next round.

### `comment-analyzer-1` and `comment-analyzer-3` — the "round-23 atl-1" citation

**Claim:** the `round-23 atl-1` citation in `checkpoint/index.ts` and
`redis-checkpointer.ts` (Redis accepting any `Date`-parseable timestamp where
the file codec demanded canonical ISO) matches no real finding, because
round 1 (review `r23`) was about `CheckpointWriter.write`'s unused index and
round 2 (review `r24`) was about the unwired checkpointer capability.

**Refuted by `reproduction` and `intent`, unanimously on the evidence.** The
citation resolves against a *different numbering track*:
`.claude/plans/2026-08-19-pr-remediation-round-23.md`, whose
`architecture-tech-lead-1` entry states the drift almost verbatim. Both lenses
independently corroborated it with sibling citations that resolve on the same
track — `round-23 ca-1` (`file/checkpointer.ts`), `round-23 tda-3`
(`redis-checkpointer.ts`), `round-22 atl-1` — none of which would resolve
against the PR-46 review-run ids.

**The trap:** this branch now has *two* independent "round-N" sequences — the
older `pr-remediation-round-N` plan track, and this PR's `standalone-review-rN`
run ids, whose numbers currently overlap (both have a 23 and a 24). A reviewer
matching on the number alone will keep reaching the wrong one. Nothing is
changed in the code: the comments were correct, and rewriting a correct
citation to satisfy a mistaken search would have made the codebase worse.

---

## Fix list

1. **C1** — `redis-connectivity.ts`: optional `logger`, `error` listener on the
   client, routed through `logWithoutThrowing`; the same listener on both
   clients in `main-supervisor.ts`.
2. **C1 tests** — the listener is attached, a fault is reported and does NOT
   escape, and a hostile logger cannot turn a connection error into a crash.
3. **C2** — `redis-connectivity.test.ts`: both `hSet` branches, the split-TTL
   hazard, the transaction-error arm, the throwing-driver arm; `FakeRedis`
   gains bare `hset`.
4. **Advisories** — the four accepted items above.

## Validation commands

```bash
for p in framework host examples adapter-fs adapter-pg adapter-oracle \
         adapter-ms-graph document-source http-auth xlsx; do
  (cd packages/$p && bunx tsc --noEmit && bun run test)
done
```

Run per workspace, the way CI does — a root-level `-p` invocation resolves a
different file set and is what let 14 type errors reach CI on this branch.
