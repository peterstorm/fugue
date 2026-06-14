# PR Remediation Plan — HITL Teams Approvals (ADR-0060), pass 6

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Review cohort:** 6 agents (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent)
**Findings:** 0 critical, 18 advisory (deduped) — **zero critical for the 6th consecutive pass**

## Review outcome

All six agents returned `CRITICAL_COUNT: 0`. The feature's deliberate defensive
patterns (never-throw, fail-closed, ADTs, Result/Either, idempotency,
effectively-once ordering) were verified as correct intent, not defects. The
prior lost-wakeup race and the `as`-cast deserialization gap from earlier passes
are confirmed fixed.

User-selected scope: **high-value batch (advisory rows 1–5)**. Rows 6–10 were
deferred as intentional/documented (per-team click auth, `appendEvent` no-op,
TTL asymmetry) or non-trivial design limitations (HTTP 409 lagging window needs
`nodeId` unreadable during `running`; type near-duplications).

## Fixes applied

### Fix 1 — Stale JSDoc / mislabel (comment-analyzer)
- **executor.ts:79** — `callHumanReviewHook` doc now lists `awaiting-human`,
  `suspended`, `retrying-hook` (was missing `suspended`).
- **executor.ts:295** — `handleHumanGate` banner now lists all three phases.
- **retry-policy.ts:172** — `handleHookCrash` caller list now includes `suspended`
  (it dispatches from the suspended branches in transition.ts:165–178).
- **index.ts:42** — `runDagStateful` relabeled from "(deprecated)" to the
  maintained "back-compat flat `Result<O>` entry (ADR-0060 §4)".

### Fix 2 — Misleading bot card in lagging-`running` window (silent-failure-hunter)
- **messages-handler.ts:149** — a card click while status is still transient
  (`queued`/`running`, gate opening) no longer renders a "resolved" card that
  replaces the buttons. It returns a non-destructive "still being prepared, retry
  shortly" message; only terminal `completed`/`failed` render the resolved card.

### Fix 3 — Negative token-cache expiry (code-reviewer)
- **bot/connector.ts:77** — early-refresh skew capped at `min(60, expires_in/2)`
  so a token with `expires_in < 60` no longer yields an `expiresAtMs` in the past
  (which forced a per-call refetch). Short tokens stay cached for a bounded window.

### Fix 4 — Branded-id validation at the Redis boundary (type-design-analyzer)
- **run-store.ts:50** — `runId`/`dagId`/`status.nodeId` now refined through the
  framework `tryRunId`/`tryDagId`/`tryNodeId` smart constructors (via a `brandedId`
  helper) instead of bare `z.string()`.
- **decision-store.ts:33** — `reroute.targetNodeId` refined through `tryNodeId`.
  Closes the gap between "parses as string" and "is a valid branded id" so a
  hand-edited store value outside `ID_PATTERN` is rejected rather than flowing in.

### Fix 5 — Untested error channels (pr-test-analyzer)
Added to `service.test.ts`:
- corrupt checkpoint → `processRun` settles `failed` + returns ok (no retry loop).
- host-infra failure where the settle-`failed` write itself fails → returns err (retry).
- `completed` outcome where the settle write fails → returns err (retry).
- `recordDecision` where `putDecision` succeeds but `enqueue` fails →
  returns err AND the decision is durably stored (the "decided-but-not-woken" half-state).
- Added `oneNodeDag` fixture (single ungated node).

## Validation

- `bun run typecheck` — ✅ all 9 packages exit 0.
- `@fuguejs/framework test` — ✅ 1660 pass / 0 fail (1694 across 148 files).
- `@fuguejs/host test` — ✅ 1029 pass / 1 skip / 0 fail.

## Deferred (not fixed — intentional or non-trivial)
- Per-team click-time authorization on the in-Teams approve path — documented v1
  limitation with operational mitigation; tracked follow-up.
- HTTP approve 409 in the lagging-`running` window — design limitation (handler
  needs `nodeId`, unreadable while `running`); the bot sibling (Fix 2) was the
  actionable half.
- `recordDecision` crash-between-`putDecision`-and-`enqueue` reconciler sweep —
  follow-up (a background re-enqueue of `suspended` runs carrying a stored decision).
- TTL-refresh asymmetry, `appendEvent` no-op, `pendingReviews` ordering-as-comment,
  `RunExecOutcome`/`RunStatus` parallel arms, untyped `internal-invariant-violated`
  context — marginal / intentional.
