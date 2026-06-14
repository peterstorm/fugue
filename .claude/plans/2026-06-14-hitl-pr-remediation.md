# PR Remediation Plan — HITL Teams Approvals (ADR-0060)

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
**Findings:** 3 critical, 11 advisory (after dedup)

This is the second remediation pass on this branch (first was commit `7b29c9f`). The
codebase quality is high; the criticals are concentrated at the **inbound bot boundary**,
where off-the-wire data is trusted more than it should be.

## Critical Fixes

### Fix 1: Stale card records a decision against the wrong gate (silent cross-gate approval)
- **Source:** silent-failure-hunter (CRITICAL); architecture-tech-lead flagged the same site but read it as benign.
- **File:** `packages/host/src/hitl/adapters/bot/messages-handler.ts:142`
- **Issue:** The Approve/Reject card embeds the `(runId, nodeId)` it was issued for
  (`card.ts:66,73`). On click the handler validates `data.nodeId` is present (line 125)
  but records the decision against `record.status.nodeId` — the run's *current* gate —
  never comparing the two. For sequential gates A→B: run parks at A (card-A posted),
  reviewer approves A, run resumes and re-parks at B (card-B posted). The stale card-A is
  still interactive. A click on card-A's Approve now records a decision against gate **B** —
  silently approving a gate the reviewer never looked at. Durable and irreversible.
- **Fix:** After the `suspended` check, compare the card's `data.nodeId` against
  `record.status.nodeId`. If they differ, the card is stale → refresh it with a
  "this review has moved on" outcome instead of recording. (The HTTP path is unaffected —
  it derives the gate solely from `status.nodeId` and accepts no client node id.)

### Fix 2: Off-the-wire ids cast to branded types, bypassing the smart constructors
- **Source:** type-design-analyzer (CRITICAL)
- **Files:** `messages-handler.ts:134` (`data.runId as RunId`), `runs.ts:97,150`
  (`runId as RunRecord["runId"]`), `runs.ts:134` (`b.targetNodeId as NodeId`)
- **Issue:** Attacker-influenceable strings (card `data`, URL params, request body) are
  `as`-cast to branded ids without going through `tryRunId`/`tryNodeId`
  (`framework/src/types/ids.ts:144,150`), which exist precisely for this. The brand becomes
  decorative; parse-don't-validate is violated at the boundary where it matters most.
- **Fix:** Parse each inbound id via `tryRunId`/`tryNodeId`; reject (bot: "Malformed review
  action."; HTTP GET/approve: 404 run-not-found; reroute body: 400 invalid-decision) on
  failure. Remove the now-redundant `as NodeId` on `record.status.nodeId` (already a `NodeId`).

### Fix 3: `RunQueuePort` doc claims a safety guarantee the adapter does not provide
- **Source:** comment-analyzer (CRITICAL)
- **File:** `packages/host/src/hitl/ports.ts:42-48`
- **Issue:** The doc states `enqueue` "is idempotent on `runId` within a short window so a
  double-approval doesn't run the same parked run twice concurrently." The adapter
  (`run-queue.ts:74-87`) passes no `jobId` and is explicitly non-idempotent; the
  no-double-concurrent-run guarantee comes from the single-flight Redis lock in
  `startWorker`, not enqueue. A maintainer trusting the comment could remove the lock and
  reintroduce the double-run hazard.
- **Fix:** Reword: enqueue is intentionally non-idempotent (fresh job each time so a resume
  re-enqueue is never dropped); concurrency safety is the single-flight lock in the worker.

## Advisory Fixes

### Fix 4: `BOT_APP_PASSWORD` required only by comment; `BOT_TOKEN_URL` allows http
- **Source:** type-design-analyzer
- **File:** `packages/host/src/domain/config.ts:163-167`
- **Fix:** Add a `superRefine` clause requiring `BOT_APP_PASSWORD` when `BOT_APP_ID` is set
  (mirroring the LLM/documents cross-checks), and tighten `BOT_TOKEN_URL` to https-only
  (it carries the client secret on token requests). Fail at boot, not at first token mint.

### Fix 5: Dead guard branch in the suspended→human-suspend transition
- **Source:** architecture-tech-lead
- **File:** `packages/framework/src/dag-runtime/transition.ts:159-160`
- **Fix:** Both arms return `stay(p, ctx)`; collapse to a single return (idempotent re-park
  is unconditional here).

### Fix 6: Webhook card / docs overstate `/runs/<id>` as an "approval page"
- **Source:** comment-analyzer
- **Files:** `packages/host/src/hitl/adapters/webhook-notifier.ts:7,33`,
  `packages/host/docs/hitl-teams.md`
- **Fix:** That route returns auth-protected JSON status, not an approval UI; approval is the
  authenticated `POST /runs/:id/approve`. Reword to "status endpoint (deep-link)" and make
  the approval mechanism explicit for the smoke-test transport.

### Fix 7: Document the deliberate omission of `output` from `RunStatus.suspended`
- **Source:** type-design-analyzer
- **File:** `packages/host/src/hitl/types.ts:36`
- **Fix:** `DagPhase.suspended`/`RunExecOutcome.suspended` carry `output`, `RunStatus` does
  not — a status poll intentionally does not re-expose the output-under-review. Add a comment
  pinning that intent so the divergence reads as deliberate, not drift.

### Fix 8: Tests for the two critical bot-boundary fixes
- **Source:** pr-test-analyzer (gap), this remediation
- **File:** `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts`
- **Fix:** (a) a click on a card whose `nodeId` no longer matches the run's current gate does
  NOT record a decision and refreshes the card; (b) a card with a malformed `runId` is
  rejected without touching `recordDecision`.

## Deferred (documented, not fixed this pass)

- **`human-responded` shared discriminant** (`types.ts:154`, type-design advisory): the two
  members differ only by `rerouteActiveSet`, recovered at runtime via `"… in e"`. Splitting
  into a distinct event `type` ripples through the framework state machine for a hazard with a
  single trusted emitter (guarded by `satisfies`). Larger refactor; out of scope for a fix pass.
- **`toAction(decision: string)`** (type-design advisory): NOT a defect. The decision arrives
  off an untrusted wire; accepting `string` and matching to `null` for unknowns IS
  parse-don't-validate. Tightening to `ReviewActionData["decision"]` would wrongly assume the
  wire is trusted. Left as-is by design.
- **`setStatus` freezes `updatedAtMs`** (`run-store.ts:141`, code-reviewer advisory): the field
  is never read in production; advancing it needs a clock injected into the adapter or the
  field removed. Disproportionate to the value. Left for a dedicated cleanup.
- **`recordDecision` has no own suspended-guard** (pr-test-analyzer advisory): safe today via
  `processRun`'s terminal guard and both callers' guards; adding a third is defense-in-depth,
  not a fix. Service-layer branch tests likewise deferred.
- **In-Teams per-user→team authorization gap** (ADR-0060-accepted v1 limitation): documented in
  the handler header, ADR Consequences, and `hitl-teams.md`. Tracked follow-up, not a defect.
- **`recordDecision` enqueue-failure has no server-side re-drive** (silent-failure-hunter
  advisory): surfaced to the caller (retry is idempotent). Acceptable v1; durability follow-up.

## Validation Commands
```bash
cd packages/framework && bun run typecheck
cd packages/host && bun run typecheck
bun test packages/framework/src/__tests__/hitl-suspend-resume.test.ts
bun test packages/host/src/hitl
bun test packages/host/src/__tests__/handlers
```
