# Plan Alignment Report

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Plan:** .claude/plans/2026-11-24-agent-identity-redesign.md
**Date:** 2026-11-25

## Summary

No gaps found.

Loop-back 10 regression check, all five fixes consistent across the plan:
- AD-9, File Structure, HITL Authority Continuity and Component Design agree that the record stores a bare `RunAuthority` under its own `runId`, and that `parseBoundAuthority(raw.authority, raw.runId)` builds the `BoundAuthority` on read. The run store only decodes JSON, and the CT-3 and Phase 2 and 4 tasks carry the callers.
- `EntraObjectId` is used for `TeamsApprover.aadObjectId` and `ApproverRef.teams-user`. The bot handler parses it in Phase 2, and the Phase 5 run store parses persisted approvals.
- A delegating `RunAccess` holds a `NonEmptyReadonlyMap` of delegated entries. `parseRunAccess` refuses an empty delegated map, and `routeRequirement` and `accessOf` agree.
- `RequirementRef` is an alias of `RawCapabilityRequirement`, and `capability-unknown` refusals still use it.
- The 21 `...Fn` aliases (CT-1: 8, CT-2: 5, CT-3: 8) each match one Export-bindings entry. None is dangling, and `parseBoundAuthority` is correctly unbound.

## Gaps

None.

## Supporting Documents Checked

- `clarifications/log.md` — 14 discoveries and decisions checked (priorities, authority mode, boot gating, custody policy, approver, retention, broker tokens, Teams scope, latency, retries, Agent ID deferral, and the loop-back 1 to 10 resolutions). No contradiction with the plan.
- `architecture-interview.md` — 14 rows checked. Each is stated in the plan body, and there is no contradiction.
- `plan-history.md` — 6 self-audits and the change log skimmed. The loop-back 10 audit was checked in detail. It is history only, and no Requirement is covered solely there.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| AS-001, AS-002, AS-003, AS-005, FR-001, FR-013 | Realm mint with both grants, zero-egress refusal, grant-missing, federation fault | Covered (AD-4, AD-8, CT-2) |
| AS-004, FR-014, NFR-012 | Per-identity, per-mode and per-user cache isolation, single-flight | Covered (CT-2, token-cache ADT, property test) |
| AS-006, FR-004, FR-020 | User-origin `app` attribution with no user token retained | Covered (CT-4) |
| AS-007, AS-008, FR-016, SC-006 | Resume and long runs without a user token | Covered (CT-3) |
| AS-009, FR-005, SC-013 | Authority mode required, boot refusal for a data catalog | Covered (AD-2, boot-capability-catalog test) |
| AS-010, FR-006, SC-003 | Agent-origin delegated DAG refused at run start | Covered (CT-1, two-pass admission) |
| AS-011, AS-012, FR-011, SC-008, FR-012 | Two Entra identity models behind one port, no secrets | Covered (AD-3, CT-2) |
| AS-013, AS-033, FR-019, NFR-020 | Boot refusal, leg gating, no default model | Covered (Identity Topology, boot-identity-refusal test) |
| AS-014, AS-030, FR-041 | Runbook: RBAC for Applications, spike, fallback, rollback, rotation | Covered (Phase 6) |
| AS-015 to AS-019, FR-030 to FR-035 | Realm work: oid claim, no token exchange, exact scopes, broker tokens, idempotency, predictable subject | Covered (Cross-Repo Realm Work section) |
| AS-020, AS-021, AS-022, AS-023, FR-007, FR-008, FR-009, FR-036, SC-004 | Delegated token contract, verification, binding, refusals | Covered (AD-5, AD-7, CT-1) |
| AS-024, AS-025, FR-010 | Mixed handles, no `app` fallback | Covered (CT-2) |
| AS-026, AS-034, AS-027, FR-017, FR-023, SC-012 | Encrypted custody, cap, fail-closed re-authorization, teardown | Covered (AD-6, LC-1, INV-4, CT-3) |
| AS-028, FR-025 | Approver recorded, no authority lent | Covered (AD-9, CT-3) |
| AS-029, FR-040 | New ADRs 0093 to 0095, supersession pointers | Covered (Phase 1) |
| AS-031, AS-032, FR-042, FR-043, SC-009 | Doc truth, status matrix, sequence diagram, doc lint | Covered (AD-10, Phase 6) |
| AS-035, AS-036, NFR-001, NFR-002, NFR-003, SC-011 | Latency budgets with injected transports | Covered (CT-2 and CT-1 budget acceptance files) |
| AS-037, AS-038, AS-039, FR-022, SC-007, INV-3 | Credential-material sentinel scans per contract | Covered (credential-sentinel.ts, CT-1 to CT-4) |
| FR-002, FR-003, SC-001, SC-002 | No human-subject assertion, no RFC 8693 exchange | Covered (INV-1 lint, CT-2 request-body capture) |
| FR-015, NFR-021 | Typed failure kinds, no internal retry | Covered (AD-8, fault vocabulary, CT-2) |
| FR-018, SC-010 | Admin and team paths unchanged | Covered (CT-1 FR-018 row, Verification) |
| FR-021 | Audit fields | Covered (broker-audit, CT-2) |
| FR-024, FR-044 | Retention and data-handling notes | Covered (data-handling.md) |
| NFR-010, NFR-011 | Fail closed, blast radius of one deployment | Covered (Security notes, `capability-not-admitted`, AD-3) |
| OOS-001 to OOS-009 | Out of scope | Not gaps |
| MODEL, OWN, JUDGE, SEAM, FEAS checks | LC-1 bound to a machine file; INV-1 lint rule; INV-2, INV-4 and INV-5 owned with matrices; types files are declaration files; budgets and sentinel scans judged in their building phase; seams declared per contract | No findings |

Total checked: 63 spec items (6 US-level groups, 39 AS, 39 FR and NFR and SC groupings folded into the rows above), plus the MODEL, OWN, JUDGE, SEAM and FEAS policy checks.
