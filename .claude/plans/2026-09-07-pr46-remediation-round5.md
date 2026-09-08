# PR #46 — round-5 remediation plan

**Branch:** `feat/f1-map-node` (PR #46, *F1 PR-B: the map node — runtime-width fan-out*)
**Review HEAD:** `fe39eb4`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-08T16-00-00Z-standalone-review-r27-pr46`

## Why this round exists

Round 4 closed three criticals. Its report ended by *predicting* the map-width defect class would
stop recurring rather than checking. This round replaces that prediction with evidence: a fresh
seven-reviewer panel against the post-round-4 HEAD.

## Panel outcome

| | count |
|---|---|
| criticals found | **0** |
| refuted | 0 |
| surviving | **0** |
| advisories | 5 |

`panel: null` in `result.json` — the refutation panel did not fire, because the critical set was
empty. **The convergence claim holds.** Four rounds of criticals, then none.

Two independent confirmations came with it, from reviewers who had no way to coordinate:
- the `type-design-analyzer` — the role that found the round-4 critical on `map-width.ts:209` —
  returned **0/0** on the same file this round;
- the `comment-analyzer` independently re-verified every historical claim in those comments
  (the four bypass variants, the `FRAMEWORK_ERROR_KIND_TABLE` count, the round-23/24/25/26
  cross-references) against the implementation and found no drift.

## Advisory dispositions

### A1 — `code-reviewer-1` (`redis-bundle.ts:131`) + `pr-test-analyzer-1` (`:124`) — **ACCEPTED**

> `pubsub.subscribe`'s `unsubscribe()` never removes the `message` listener it registered, so
> listeners accumulate without bound and a resubscribe to the same channel double-fires the stale
> handler.

Two reviewers found this independently. It is a **real behavioral defect**, filed advisory only
because the call path is dormant — `subscribeTenantEvents` (`redis-registry-adapter.ts:747`) is the
sole consumer and `main-supervisor.ts:117-121` deliberately does not call it yet ("forward-infra for
a future multi-supervisor topology"). Dormant is not fixed: it wakes up the moment that topology
lands.

Honest provenance: the code is **pre-existing**, moved verbatim from `main-supervisor.ts` by round
4's extraction. Round 4 gave it a test seam — and the very first panel to see it through that seam
found the bug. That is the extraction paying for itself, but it also means the defect now lives in a
file this remediation authored, so it is this round's to fix.

**Fix.** Name the listener so the handle can detach exactly it:

```ts
const onMessage = (receivedChannel: string, message: string): void => {
  if (receivedChannel === channel) handler(message);
};
subClient.on("message", onMessage);
await subClient.subscribe(channel);
return {
  unsubscribe: async () => {
    subClient.off("message", onMessage);   // listener FIRST
    await subClient.unsubscribe(channel);
  },
};
```

Listener removal precedes the wire command deliberately: after that line no delivery can reach the
handler even if `UNSUBSCRIBE` rejects, so releasing is total over the thing the caller asked to be
rid of.

### A2 — `pr-test-analyzer-2` (`redis-bundle.test.ts:308`) — **ACCEPTED**

> "unsubscribe releases the channel" asserts only that the outgoing `UNSUBSCRIBE` was sent, not that
> the handler stops firing — it would stay green if the JS-side removal were a no-op.

Correct, and it is my test from round 4. It asserted the wire protocol and called it the contract.
Replaced with three pins that assert the contract itself: delivery stops after `unsubscribe`,
listener count does not grow across five subscribe/unsubscribe cycles, and a resubscribe does not
double-fire the released handler. `FakeClient` gained a real identity-based `off` — a fake that
accepted `off` and did nothing would have let the leak pass.

### A3 — `code-simplifier-1` (`redis-bundle.ts:99`) — **ACCEPTED; round 4 got this call wrong**

> The lazy-connect guard is hand-copied five times instead of sharing one helper.

Round 4's distill pass saw this and **skipped it**, reasoning that the sibling
`createRedisConnectivity` keeps the guard inline and project idiom wins. The reviewer's counter is
better and I am taking it: `redis-bundle.ts` already imports `attachRedisErrorListener`,
`createIoredisRedisPort`, and `defaultIoredisFactory` from that same sibling *specifically*, per its
own header, "so the package's two client-construction sites cannot drift apart". The connect guard
was the one piece of that shared contract left un-extracted — and both test files already describe
it as one named invariant. The idiom argument pointed the other way from where I read it.

**Fix.** `ensureConnected` exported from `redis-connectivity.ts` beside `attachRedisErrorListener`,
carrying the "conditional because `connect()` on a connected client rejects and flaps the host to
`degraded:redis-disconnected`" rationale once. All five sites call it; one definition remains.

### A4 — `architecture-tech-lead-1` (`node-context-factory.ts:439`) — **DEFERRED**

> `selectAndHydrateSpendLedger` entangles the fail-closed spend-ledger-unreadable decision with the
> Redis I/O that produces it, mixing business logic and I/O in one function.

The FC/IS reading is fair. Deferred on two concrete grounds:

1. **It is not this PR's code.** `git diff main...HEAD -- packages/host/src/adapters/node-context-factory.ts`
   contains no `selectAndHydrateSpendLedger` hunk — the function predates the branch and this PR
   never touched it. Fixing it here would put an unrelated refactor inside a map-node PR.
2. **It is a deepening, not a distill.** Separating decide-from-act moves a seam and changes a
   signature callers see. Per the distill skill's own scope rule that is `deepen` territory, and it
   belongs in its own change with its own review.

The current behavior is correct and fail-closed; this is a structural improvement, not a defect.

## Validation

```bash
bun run typecheck   # bun run --filter '*' typecheck
bun run test        # bun run --filter '*' test
```

| gate | result |
|---|---|
| `bun run typecheck` | exit 0, every workspace clean |
| `bun run test` | **exit 0**, 0 failures — `@fuguejs/framework` 3679 / 193 files, `@fuguejs/host` **2690** / 126 files (up 2 from round 4's 2688) |
| `redis-bundle.test.ts` + `redis-connectivity.test.ts` | 64 pass, 10 skip, 0 fail |

**Non-vacuous:** removing the single `subClient.off("message", onMessage)` line fails all three new
pins (delivery-stops, no-accumulation, no-double-fire). Restored and re-verified green.

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-09-07-pr46-remediation-round5.md` — this plan
