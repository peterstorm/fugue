# PR Remediation Plan — ADR-0060 HITL Teams Approvals (cohort pass 3)

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Findings:** 0 hard criticals (code-review + architecture both clean); aggregated criticals/advisories from the 6-agent cohort below.

The branch is high quality. code-reviewer and architecture-tech-lead each reported **0 critical**
defects. The actionable items are one real silent-failure misclassification, two stale doc-comments,
and a cluster of high-value advisories (engine-level invariant, parse-symmetry, missing logs).

## Fixes (applied)

### F1 — Guard `await res.json()` on the bot token response  *(silent-failure CRITICAL)*
- **File:** `packages/host/src/hitl/adapters/bot/connector.ts:63`
- **Issue:** A 200-with-malformed-body token response makes `res.json()` reject; the rejection
  escapes `getToken → sendToConversation → notifier.notify`, where it is misclassified as an
  `onHumanReview` hook crash (→ `retrying-hook`) instead of the intended non-fatal
  `notification-failed`.
- **Fix:** Wrap line 63 in try/catch, returning `err({ kind: "notification-failed", … })`.

### F2/F3 — Stale "TEAMS_WEBHOOK_URL enables HITL" comments  *(comment CRITICAL ×2)*
- **Files:** `packages/host/src/domain/config.ts:136-141`, `packages/host/src/host.ts:82-87`
- **Issue:** Both claim HITL is off unless `TEAMS_WEBHOOK_URL` is set, ignoring the Bot Framework
  enable path (`BOT_APP_ID`/`BOT_APP_PASSWORD`) the same files wire up.
- **Fix:** Reword to "webhook OR Bot Framework transport enables HITL".

### F4 — Enforce parked-at-gate invariant in `recordDecision`  *(architecture advisory, 80%)*
- **File:** `packages/host/src/hitl/service.ts:175`
- **Issue:** The "a decision only resolves the gate the run is currently parked at" invariant is
  enforced only in the two boundary adapters (HTTP + bot), not the engine.
- **Fix:** Re-check `status.kind === "suspended" && status.nodeId === nodeId` in `recordDecision`;
  return a new typed `run-not-suspended` HostError (409). Aligns with the existing 409
  `run-not-suspended` string code already returned by `runs.ts:183`.

### F5 — Parse off-the-wire `nodeId` via `tryNodeId`  *(type-design CRITICAL/symmetry)*
- **File:** `packages/host/src/hitl/adapters/bot/messages-handler.ts:124`
- **Issue:** `runId` is parsed through its smart constructor; the sibling `nodeId` is left a raw
  string, so the staleness guard compares a branded `NodeId` against an unbranded string.
- **Fix:** Parse `nodeId` through `tryNodeId` for brand-correct comparison + boundary symmetry.

### F6 — Use the `EXECUTOR_NODE_ID` sentinel instead of `"__executor__" as NodeId`  *(type-design advisory)*
- **Files:** `packages/host/src/hitl/service.ts:61`, `packages/host/src/hitl/adapters/run-executor.ts:44`
- **Fix:** Export `EXECUTOR_NODE_ID` as a value from the framework public index and import it in both
  host sites, removing the primitive-obsession casts.

### F7 — Log `markPending` failure before the fail-open fallback  *(silent-failure advisory)*
- **File:** `packages/host/src/hitl/human-review-hook.ts:71`
- **Fix:** `logger?.warn` the decision-store error before coercing `isFirstPark = true`.

### F8 — Log decided-but-not-woken on enqueue failure  *(silent-failure advisory)*
- **File:** `packages/host/src/hitl/service.ts:186`
- **Fix:** `logger?.error` when `putDecision` succeeded but `runQueue.enqueue` failed.

### F9 — Bump `updatedAtMs` on `setStatus`  *(code-reviewer advisory)*
- **File:** `packages/host/src/hitl/adapters/run-store.ts`
- **Fix:** Inject `now: () => number` (default `Date.now`) into both store factories; write
  `updatedAtMs: now()` in `setStatus` instead of preserving the stale creation value.

### F10 — Comment fixes  *(comment advisories)*
- `webhook-notifier.ts:96` — names the wrong error kind (`redis-unavailable` → `notification-failed`).
- `run-dag.ts:4` — FR-020 "returns 200" header predates the HITL 202 fork.
- `connector.ts:5` — confusing coined term "INJECTED-free".

### F11 — Document the HITL audit-trail gap in the ADR  *(architecture advisory)*
- **File:** `docs/adr/0060-hitl-suspend-resume-primitive.md`
- **Fix:** Elevate the `JobLike.appendEvent` no-op (no per-transition event journal for HITL runs)
  from a buried code comment to an ADR Consequence.

## Tests (added)

### T1 — `processRun` idempotency guards  *(pr-test-analyzer CRITICAL)*
- terminal-run replay: completing then re-enqueuing must not re-invoke the executor.
- unknown-run stale enqueue: `processRun` for a deleted/expired run is `ok` no-op.

### T2 — `recordDecision` gate guard (covers F4)
- A decision for a non-suspended run errs `run-not-suspended`.

### T3 — `reroute` end-to-end through the resume loop  *(pr-test-analyzer advisory)*

## Deferred (with rationale)

- **`transition.ts:157` node-id guard** — the `suspended + human-suspend` branch already returns
  `stay(p, ctx)`; adding `if (e.nodeId !== p.nodeId) return stay(p, ctx)` is behaviorally identical
  (dead code). The existing comment documents the deliberate unconditional re-park. No change.
- **`verify.ts:79` `meta.json()`** — already self-contained: the bare `await meta.json()` sits in
  the `getJwks` IIFE whose `.catch` resets the promise and rethrows, caught by the caller and
  classified `unavailable`. No behavioral gap.
- **`HumanGatePayload` shared-type extraction** (type-design CRITICAL) — a real "make the invariant
  compiler-enforced" improvement, but it spans framework `types.ts`, four `transition.ts` branches,
  and host `types.ts`. High blast radius for code that is correct today; tracked as a follow-up.
- **`setStatus` CAS atomicity** (architecture advisory) — worker status writes are already
  lock-serialized; the narrow non-lock-held race needs Lua/WATCH. Tracked as a follow-up.
- **Branded `TrustedServiceUrl`, `OnHumanReview` type alias, exec-identity brand, `ReviewActionData`
  ↔ `HumanAction` bridge** — type-design nice-to-haves; deferred.
- **`RunExecutor` adapter test, concurrent single-flight test, live JWKS integration test**
  (pr-test advisories) — additive coverage; the critical `processRun` idempotency gap is covered (T1).

## Validation Commands
```bash
cd /home/peterstorm/dev/agentic/fugue
bun test packages/host packages/framework 2>&1 | tail -30
bunx tsc -p packages/host --noEmit && bunx tsc -p packages/framework --noEmit
```
