# PR Remediation Plan — HITL Teams Approvals (ADR-0060), pass 5

**Date:** 2026-06-14
**Branch:** feat/hitl-teams-approvals
**Findings:** 1 "critical" (a false doc claim), several advisories — after dedup across a fresh 6-agent cohort

Six review agents ran against `git diff main...HEAD` (63 files, 5966 insertions) with
explicit architectural-intent priming (never-throw, fail-closed, ADTs, Result/Either,
idempotent suspend/resume must NOT be flagged). Four agents reported 0 critical. The
durable suspend/resume engine, parse-don't-validate at the Redis boundaries, the
lost-wakeup `recordDecision` pending-marker fix, and SSRF/webhook hardening were all
re-confirmed correct. Remaining genuine items, verified against the real code:

## Fixes applied

### Fix A (critical — false documentation): event-journal "wired by production adapter" claim
- **Source:** comment-analyzer.
- **File:** `packages/host/src/hitl/run-store-job.ts:58-61` + docstring `:28-30`.
- **Issue:** The `appendEvent` no-op comment asserts the Redis-Streams event journal
  "is wired by the production adapter". No such adapter exists, and ADR-0060
  Consequences (lines 149-155) states the opposite — it is a no-op / tracked follow-up.
  Directly misleads a maintainer about a feature that does not exist.
- **Fix:** Align the comment + docstring with the ADR: HITL runs carry only the latest
  `{state,context}` checkpoint, no per-transition journal; a Streams-backed journal is a
  tracked follow-up, not required for suspend/resume correctness.

### Fix B (advisory — stale docstring): `buildDagExecutor` branch list
- **Source:** comment-analyzer.
- **File:** `packages/framework/src/dag-runtime/executor.ts:183-198`.
- **Issue:** The numbered branch list documents only 4 of the executor's 6 phase branches
  (omits `suspended` and `retrying-hook`) and understates the human-gate returns
  (`human-responded` | `human-suspend` | `node-failed`).
- **Fix:** Rewrite the list to match the actual `.with(...)` arms (pending, retrying,
  running, awaiting-human, suspended, retrying-hook) and the real return events.

### Fix C (advisory — parse-don't-validate gap): checkpoint deserialization
- **Source:** type-design-analyzer.
- **Files:** `packages/host/src/hitl/run-store-job.ts:37`, caller `service.ts:129`;
  new single-source-of-truth guard in `packages/framework/src/dag-runtime/types.ts`.
- **Issue:** The checkpoint envelope was `fromJson(...) as Envelope` with no shape check —
  the one Redis-JSON domain-state read path NOT hardened like run-meta / decision /
  conversation-ref (which all `safeParse`). A torn/evicted/edited checkpoint feeds a
  bad `state.kind` straight into `dagTransition`'s `.exhaustive()` match → raw
  `NonExhaustiveError` instead of a clean `internal-invariant-violated`.
- **Fix:** Add `DAG_PHASE_KINDS` (a `Record<DagPhase["kind"], true>`-derived set that the
  compiler keeps in lockstep with the union — adding/removing a phase without updating
  the set is a compile error) + `isDagPhaseKind` guard to the framework, exported from
  `index.ts`. `makeRunStoreJobLike` now returns `Result<JobLike, HostError>`: it uses
  `tryFromJson` and validates the envelope shape (`state` an object with a known phase
  kind, `context` an object), mapping a miss to `internal-invariant-violated`.
  `processRun` settles the run `failed` (terminal, no retry — a corrupt checkpoint will
  not heal) and returns `ok`. New reject-path test added.

### Fix D (advisory — test gaps): untested deliberate fail-open branches
- **Source:** pr-test-analyzer.
- **File:** `packages/host/src/hitl/__tests__/human-review-hook.test.ts`.
- **Issue:** Two load-bearing defensive branches had no test pinning them: (a)
  notify-failure-after-first-park (run parked, notification failed → logs, still
  `pending`, no re-notify); (b) `markPending` store-error fail-open (errors → assume
  first park, notify anyway). A future refactor flipping either could pass all existing
  tests.
- **Fix:** Two additive unit tests pinning both branches.

## Documented as known limitations (real fix is a redesign, out of scope for a remediation pass)
Recorded in ADR-0060 Consequences so they are conscious decisions on the ledger, not
oversights:

### E. Transient `running`-window 409 at the approve pre-checks
- **Source:** code-reviewer (conf 82) + silent-failure-hunter, both advisory.
- The HTTP (`runs.ts:182`) and bot (`messages-handler.ts:149`) handlers pre-check the
  lagging `status === "suspended"` to derive the gate node id and render distinct UX
  before delegating to the authoritative `recordDecision` (which gates on the pending
  marker). In the sub-second window after `notify` but before `processRun` folds
  `suspended` back, a decision is rejected (HTTP 409 / "already running").
- **Why not fixed now:** Recoverable by retry (no decision is recorded; not a strand).
  The clean fix is a redesign: the HTTP body carries no node id, so the handler's only
  source of the gate is the status field — accepting in the window needs either a body
  `nodeId` (breaking the documented API contract) or a new "list pending markers for
  run" store/port operation (Redis scan). Disproportionate to a sub-second recoverable
  window; belongs in a dedicated design cycle.

### F. Decision consume not atomic with the post-gate checkpoint — **FIXED (follow-up)**
- **Source:** architecture-tech-lead (conf 80), advisory.
- The hook `clear`ed the decision before the kernel durably checkpointed the advanced
  state. A worker crash in that window dropped a stored approval; on resume the run
  re-parked/re-notified and a human re-decided.
- **Fix (implemented after the initial pass-5 commit):** effectively-once consumption
  ordered AFTER the durable checkpoint. Added `KernelRunOpts.onCommitted` (fires after
  `updateData` resolves), surfaced through the DAG layer as `onDecisionConsumed(nodeId)`
  (filtered to `human-responded`). The host `onHumanReview` hook is now READ-ONLY; the
  new `makeOnDecisionConsumed` clears the decision via the post-commit callback, threaded
  service → run-executor → `runResumableDagJob` → kernel. A crash between read and the
  durable checkpoint now re-reads the decision on resume instead of losing it. Proven by
  a framework crash-before-commit test; reroute re-gate safety preserved (clear runs in
  the same iteration as the post-gate checkpoint, before any re-gate). Residual (crash in
  the `updateData`→`onCommitted` gap + a later reroute re-gate) documented in ADR-0060.

## Deliberately NOT changed
- In-Teams per-user/per-team click authorization (architecture conf 78) — already an
  explicitly documented v1 scope decision (`messages-handler.ts:18-28`, `hitl-teams.md`,
  ADR Consequences); `actor` is captured for audit. On the security ledger, not a defect.
- Branded `TrustedServiceUrl`, `run-not-suspended` `status: string`, `ReadonlyMap` test
  veneer — sub-threshold type hygiene deferred in prior passes; high churn, low value.

## Validation Commands
```bash
bun run typecheck
bun test packages/framework packages/host
```
