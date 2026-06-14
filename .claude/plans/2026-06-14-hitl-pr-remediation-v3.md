# PR Remediation Plan — HITL Teams Approvals (ADR-0060)

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Findings:** 3 critical themes, 2 cheap advisories (after dedup across a 6-agent cohort)

Six review agents ran against `git diff main...HEAD` (60 files, 5395 insertions).
Four agents reported clean (code-reviewer: 0 crit; silent-failure-hunter: 0 crit;
comment-analyzer: 0 crit; architecture: 0 crit but one important advisory). The
genuine remaining issues, verified against the real code:

## Critical Fixes

### Fix 1: Lost-wakeup race — `recordDecision` drops approvals in the `running` window
- **Source:** architecture-tech-lead (conf 80), corroborated by code-reviewer's
  "decision-consumed-before-checkpoint" advisory.
- **File:** `packages/host/src/hitl/service.ts:192` (guard), window spans
  `service.ts:121 → 168` around the awaited notify at `human-review-hook.ts:84`.
- **Issue:** `processRun` writes status `running` (121), then `executor.run`
  invokes the hook, which sends the review notification (`human-review-hook.ts:84`)
  **before** `executor.run` returns and `setStatus(suspended)` lands (168). A
  human/automated approval arriving in that window is rejected by the
  `status.kind !== "suspended"` guard (`run-not-suspended`, HTTP 409) — the
  decision is dropped and, if never retried, the run is stranded forever.
- **Fix:** Gate `recordDecision` on the decision store's **pending marker**, not
  the lagging run-store status. `markPending` is written BEFORE notify (line 71)
  and cleared when the gate resolves, so it is present for the entire window a
  human could respond. Add `isPending(runId, nodeId)` to `DecisionStorePort`
  (in-memory: `pending.has`; Redis: `GET` non-null), and rewrite the guard to
  accept iff a pending marker exists for the exact gate. Preserves the existing
  rejections (queued run / wrong gate both have no marker). Add a service test
  that reproduces the window by calling `recordDecision` from inside the notifier.

### Fix 2: Parse-don't-validate broken at the Redis deserialization boundary
- **Source:** type-design-analyzer (critical).
- **Files:** `run-store.ts:99`, `decision-store.ts:100`, `bot/conversation-store.ts:38`.
- **Issue:** Each `JSON.parse(...)` is `as`-cast straight into a domain ADT with no
  shape validation. JSON-syntax corruption is caught; a structurally-wrong-but-
  parseable value (unknown `kind`, missing required field) flows in and drives
  exhaustive `match`es that assume well-formed ADTs. The HTTP/bot read paths
  already parse-don't-validate via `tryRunId`/`tryNodeId`; the Redis read path is
  held to a lower standard.
- **Fix:** zod (already a host dep) schemas for `RunMeta`, `HumanAction`,
  `ConversationReference`; replace the three `as` casts with `safeParse` →
  `internal-invariant-violated` on shape failure (reusing the existing error
  channel already wired for the JSON-syntax case). Add reject-path tests.

### Fix 3: Framework test gaps for the durable `suspended` phase
- **Source:** pr-test-analyzer (2 critical).
- **Files:** `dag-transition-property.test.ts:92-169`, `dag-transition.test.ts`.
- **Issue:** The "never throws on replay" property never generates the new
  `suspended` phase or `human-suspend` event — the exact serialized-replay path
  the property exists to guard. And there is zero direct unit coverage of the
  `suspended`-phase transition branches (`transition.ts:154-180`).
- **Fix:** (a) Add `suspended` to `arbDagPhase` and `human-suspend` to
  `arbDagEvent`. (b) Add `describe("dagTransition — suspended (ADR-0060)")`
  mirroring the `retrying-hook` block: human-responded approve/reject,
  wrong-nodeId staleness no-op, idempotent re-park, hook-crash → retrying-hook.
  Plus a `retrying-hook + human-suspend` re-park test.

## Advisory Fixes

### Fix 4: Clarify the deliberate TTL-less conversation-reference write
- **Source:** silent-failure-hunter.
- **File:** `bot/conversation-store.ts:29`.
- **Fix:** One-line comment noting the single default reference is intentionally
  durable (no TTL), unlike the run/decision/pending keys.

### Fix 5: Doc serviceUrl allowlist exactness
- **Source:** comment-analyzer.
- **File:** `packages/host/docs/hitl-teams.md:102`.
- **Fix:** Note the `.smba.trafficmanager.net` subdomain suffix the allowlist
  also accepts (`trusted-host.ts:21-25`).

## Deliberately NOT changed (advisory, low-value/high-churn)
- Branded `TrustedServiceUrl`, `ReadonlyMap` test veneer, `pendingReviews`
  ordering-in-type, `run-not-suspended` `status: string` — noted by type-design
  as sub-threshold; the outbound re-check already exists. Skipped to avoid churn.
- Unreachable `else if (BOT_APP_ID)` warn branch (host.ts:305) — code-reviewer
  said "not worth a code change on its own."
- Bot click-time per-team authorization — documented v1 scope decision, tracked
  as a separate follow-up (not an error-handling defect).

## Validation Commands
```bash
bun run typecheck
bun test packages/framework packages/host
```
