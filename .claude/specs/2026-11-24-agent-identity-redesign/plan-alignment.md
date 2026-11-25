# Plan Alignment Report

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Plan:** .claude/plans/2026-11-24-agent-identity-redesign.md
**Date:** 2026-11-25

## Summary

Re-check after loop-back 15b (commit 904c4894). All six gaps from the lb-15 pass are closed in substance. Every spec requirement is still covered. The spec's ID set (AS-001 to AS-043, FR-001 to FR-044, NFR-001 to NFR-021, SC-001 to SC-013) is unchanged and matches the plan's references. The loop-back 15b self-audit reports equal sets.

The re-read of the touched sections found three low gaps. All are feasibility or placement details of the lb-15b fixes, not missing requirements:
- G-1: the run-store `now` dep and the service clock are named loosely and do not match the code.
- G-2: the commit-time TTL edge.
- G-3: the park-time closed-window path has no test-file entry or fold mention of its own.

No MODEL, OWN, JUDGE or SEAM contradictions were found in the touched sections.

## Gaps

- **G-1 (FEAS/SEAM, low): the `now` dep is named, but its home, type and the service clock do not match the code or the Phase 5 Task.**
  - The plan says the run store has "`deps.now: () => EpochMs` from `composeHitlRunService`". `createRedisRunStore` has no deps record. Its signature is `(redis, tenant, config: RedisRunStoreConfig, leases, logger?)`. `RedisRunStoreConfig.now` is an existing optional `() => number` that defaults to `Date.now`. `composeHitlRunService` currently passes only `{ ttlSec }`.
  - The plan does not say whether the new dep is that existing field, a required branded one, or a new field. The about 45 `cfg` fixtures in `redis-stores.test.ts` and the `mapped-resume-worker.ts` constructor depend on the answer. The File Structure entry and the plan-history note name the dep. The Phase 5 re-authorization Task bullet does not, though `run-composition.ts` and the fixtures are in its Files.
  - Same seam on the service side. `reauthorizationOpen(w, nowMs: EpochMs)` is read by `processRun` (expiry settle and park-time settle), reconciliation and `runViewOf`. `HitlRunServiceDeps` already has `clock: () => number` (`Date.now`). The plan never says these callers convert it with `epochMsOf(deps.clock())`.
  - Fix:
    - State that the commit's `nowMs` is `RedisRunStoreConfig.now`, kept optional or made required, with its EpochMs conversion (`epochMsOf`) at the store or at `composeHitlRunService`.
    - State that the service reads the window rule through `epochMsOf(deps.clock())`.
    - Name the dep in the Phase 5 Task bullet.

- **G-2 (FEAS, low): the commit-time TTL below one second is unspecified.**
  - `reestablishDelegation` guards at its clock read `t` (LC-1: TTL ≥ 1, expiry ≤ t + cap). `CommitReauthorization` takes a later `nowMs` from the run store's clock and computes the custody TTL with `custodyTtlSecOf(expiry, nowMs)`.
  - A custody expiry within about one second of `t` can reach a TTL of 0 at commit. The plan lists the "custody TTL ≤ record TTL" and "held of another run" guards (both `Err`, nothing written). It does not say a TTL under 1 s is refused the same way. The outcome is fail-closed either way, so the gap is only the unstated row.
  - Fix: add "custody TTL < 1 → Err, nothing written" to the `CommitReauthorization` comment and a case to the `delegated-custody-store-redis.test.ts` commit rows.

- **G-3 (SEAM/OWN, low): the park-time closed-window path has no test-file entry, and the fold and failure wording are loose.**
  - The path itself is specified. LC-2 allows `running → failed` (existing row, prose says so). The HITL Continuity text says a parked outcome with a closed window settles `failed` from `running`, audited `expired`, with no notice. INV-4's matrix names "a park past it at once", released through `endRun`. The Data Flow agrees.
  - The remaining omissions:
    - No test-file entry names the path. `reauthorize-run.test.ts` covers only the sweep case. The `service.ts` File Structure entry covers only "settling a closed one failed" for an awaiting record. `run-executor.test.ts` covers parking only. Only the INV-4 matrix row holds it. The test entries are "the canonical list of per-file test obligations", so add a `reauthorize-run.test.ts` case: a closed-window park → `failed`, no notice, one `endRun`, one `expired` audit.
    - The `ProcessRunOutcome` fold prose lists "completed, failed, suspended, corrupt, evicted". It does not name the executor's `awaiting-reauthorization` outcome. It should say that outcome folds `continuing` when `reauthorizationOpen` and `ended{failed}` when closed.
    - The failed error is written `authority-unavailable{capability, agent, reauthorization-required{reason}}` in the HITL Continuity text, AD-13 and the Data Flow. AD-8 and CT-2 define the kind as `{scope, agentClientId, cause}`. Align the field names.

## Previous Gaps (plan-alignment-15) Re-checked

| Gap | Result | Evidence |
|---|---|---|
| G-1 stale `stage` references | Closed | The custody-store test entry now reads "put's and the commit's custody TTL ≤ HITL_RUN_TTL_SEC". The establishment test entry reads "the LC-1 reestablish guard before the Reestablished is built, zero store writes". A word-level grep for `stage` and `StagedCustodyWrite` in the plan and `plan-reference.md` finds none. The only hits are the unrelated "staged" in the approvals checkpoint and "staging" in `setAllIfValues`. |
| G-2 `commitReauthorization` name | Closed | A case-sensitive grep finds zero hits. Every mention reads the injected `CommitReauthorization` or `createReauthorizationCommit`: AD-13 (plan and reference), LC-1, INV-4, INV-7, the lifecycle comment, HITL Continuity, the test entries and the `plan-reference.md` Data Flow. |
| G-3 `reauthorizationOpen` and `delegatedBoundOf` homes | Closed | `reauthorizationOpen` is in the `delegated-custody.ts` entry, the Phase 2 custody bullet and `delegated-custody.property.test.ts` (open iff ≥ 1 s remains, agrees with `planReauthorization`'s window-closed). `delegatedBoundOf` is in the `run-authority.ts` entry, the Phase 2 planner bullet and `run-authority.property.test.ts` (Ok iff user-delegated, else `record-not-delegated`). Both are in Component Design with their readers listed. No export binding, which is consistent with `boundAuthorityOf` and `custodyTtlSecOf`. |
| G-4 commit clock | Partly closed | The source is now named: the run store's `now` from `composeHitlRunService`, read once per `markReauthorized` call and passed as `nowMs`. The `CommitReauthorization` signature carries `nowMs`, and `markReauthorized`'s signature is unchanged. The dep is named in File Structure and the Component Design comment. `composeHitlRunService` and `redis-stores.test.ts` are in the Phase 5 Files, and the Phase 5 Task and Files are the same Task as the commit. The residual naming, type and Task-bullet issue is G-1 above. |
| G-5 park-time closed window | Closed (residual in G-3) | Chosen: a closed-window park settles `failed` from `running`, with no notice. So `RunNotification.reauthorization-required` always carries the open variant, matching its `Extract<ReauthorizationView, {window:"open"}>` type. The LC-2 `running → failed` row exists, with the prose stating the case. The caller (`processRun`) is in the Phase 5 re-authorization Task with reconciliation. INV-4 lists the path ("a park past it at once", through `endRun`). The `awaiting-reauthorization → failed` row and the lease fence are consistent with the unleased commit: a settle that wins makes the commit's guard fail, giving 409. |
| G-6 INV-4 expiry row placement | Closed | INV-4's Statement says "the re-authorization race and expiry-settle rows in the Phase 5 re-authorization Task". The Phase 5 Task says "the INV-4 re-authorization race and expiry-settle rows". |

## Supporting Documents Checked

- plan 2026-11-24-agent-identity-redesign.md, read in pages. Lines 1 to 1418 were covered except Component Design lines 509 to 678 (Entra Agent Authority tail and the Run Authority Planner), 843 to 868 (Capability Authority), and 984 to 989. I grepped the Planner for `delegatedBoundOf` and `planReauthorization`, which sit at lines 614 to 666. These sections are outside lb-15b's change set except for those two symbols.
- plan-reference.md:
  - read in full: lines 1 to 56 (Data Flow), 153 to 165 (HITL composition) and 248 to 304 (AD-3, AD-5, AD-2, AD-12 and AD-13 full text);
  - not read: the remaining sections, which lb-15b did not touch.
- plan-history.md: "Loop-back 15b" and its self-audit (lines 1045 to 1066).
- spec.md: ID inventory only (grep of requirement IDs). Requirement text was not re-read; coverage for untouched requirements is carried from the lb-15 full pass.
- Code, to check the `now` dep and the clock: `packages/host/src/hitl/adapters/run-store.ts` (`createRedisRunStore`), `packages/host/src/host.ts` (`composeHitlRunService`), and a grep of `createRedisRunStore` call sites.
- Not read: architecture-interview.md, implementation-notes.md, cross-repo-realm.md, the INV-1 rule file (unchanged since lb-15), `.claude/hooks/`, `.claude/state/`.

## Coverage

| ID | Description | Status |
|---|---|---|
| AS-001, AS-003, AS-005, FR-001, FR-002, FR-003, FR-012, SC-001 | Entra-exchange grant plus capability grant, assertion inspection, typed federation faults, no secret or certificate | Covered (carried from lb-15 full pass) |
| AS-002, FR-013 | Refusal before egress on an unassigned scope | Covered (carried from lb-15 full pass) |
| AS-004, FR-014, NFR-012 | Cache isolation and single-flight | Covered (carried from lb-15 full pass) |
| AS-035, AS-036, NFR-001 to NFR-003, SC-011 | Latency budgets | Covered (carried from lb-15 full pass) |
| AS-006, AS-007, AS-008, FR-004, FR-016, FR-020, SC-002, SC-006 | User-origin `app` runs attribute without user tokens | Covered (carried from lb-15 full pass) |
| AS-009, FR-005, SC-013 | Authority mode mandatory | Covered (carried from lb-15 full pass; `brokeredNamespacesOf` unchanged) |
| AS-010, FR-006, SC-003 | Agent-origin run needing `delegated` refused | Covered (carried from lb-15 full pass) |
| AS-039, AS-037, AS-038, FR-022, SC-007 | No credential material | Covered (carried from lb-15 full pass; CT-3 sentinel scope still includes the notification as rendered) |
| AS-011, AS-012, FR-011, SC-008 | Two Entra identity models behind one port | Covered (carried from lb-15 full pass; AD-3 reference text re-read) |
| AS-013, AS-033, FR-019, NFR-020 | Boot refusal and dark legs | Covered (carried from lb-15 full pass) |
| AS-014, AS-030, FR-041 | Runbook | Covered (Phase 6, re-read) |
| AS-015 to AS-019, FR-030 to FR-035, SC-005 | Realm package work | Covered (carried from lb-15 full pass) |
| AS-020, AS-021, AS-022, AS-023, AS-040, FR-007, FR-008, FR-009, FR-036, SC-004 | Delegated-token contract, verification, binding | Covered (AD-5 full text in `plan-reference.md` consistent with the plan summary) |
| AS-024, AS-025, FR-010, FR-015 | Delegated and app handles separate, no `app` fallback | Covered (carried from lb-15 full pass) |
| AS-026, AS-027, AS-028, FR-017, FR-023, FR-025, SC-012 | Run-bound custody, write-once, release | Covered (LC-1, INV-4, CT-3 re-read; INV-4 expiry rows placed) |
| AS-034, AS-041, FR-027 | Park awaiting re-authorization, sync 401, initiator re-authorization, terminal path for parked runs | Covered (AD-13, LC-2, INV-4, INV-7, CT-3 re-read); see G-1, G-2 and G-3 |
| AS-042, FR-026 | Resume-slice drift check | Covered (carried from lb-15 full pass) |
| AS-043, FR-028 | Atomic decision with approver, audited attempts | Covered (carried from lb-15 full pass) |
| AS-029, AS-031, AS-032, FR-040, FR-042, FR-043, FR-044, SC-009 | ADRs, doc truth, sequence diagram, data-handling notes, doc-lint | Covered (carried from lb-15 full pass) |
| FR-018, OOS-007, SC-010 | Admin and team token paths unchanged | Covered (carried from lb-15 full pass) |
| FR-021 | Mint, reuse and refusal audit fields | Covered (carried from lb-15 full pass) |
| FR-024 | Retention unchanged | Covered (carried from lb-15 full pass) |
| NFR-010, NFR-011, NFR-021 | Fail closed, blast radius, no internal retries | Covered (carried from lb-15 full pass) |
| OOS-001 to OOS-009 | Out of scope items | Respected |
| MODEL, OWN, JUDGE, SEAM and FEAS checks on lb-15b changes | New types and functions have homes and Tasks; signature changes land with callers | Pass with three low gaps (G-1 to G-3) |
