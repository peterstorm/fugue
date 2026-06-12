# Plan Alignment Report — Identity-Scoped Capabilities

**Date:** 2026-06-10
**Spec:** `/Users/hansen142/dev/agentic/fugue/.claude/specs/2026-06-10-identity-scoped-capabilities/spec.md`
**Plan:** `/Users/hansen142/dev/agentic/fugue/.claude/plans/2026-06-10-identity-scoped-capabilities.md`

## Summary

The plan is a faithful, high-fidelity translation of the spec. All 5 design-doc
waves are mapped to loom phases with an explicit "nothing dropped" justification,
the two-repo scope is tagged on every path, the 4 verification spikes are each
modeled as a documented pass/fail outcome gating a named phase, and the manual
Entra ops surface is captured as a runbook with explicit per-step acceptance.

**Requirements checked:** 47 (6 FR-W0, 6 FR-W1, 9 FR-W2, 11 FR-W3, 6 FR-W4,
4 FR-X, 4 FR-SPK, 14 SC, plus the 8 US scenario groups cross-checked).

**Gaps found:** 0.

The high-risk areas called out for special attention are all covered:

- **Zero-regression bar (FR-W2-003 / SC-005):** AD-2 + the pass-through broker;
  Phase 2 includes a byte-identical-behavior test (`passthrough-broker.test.ts`)
  and a "pass-through path unchanged" assertion in `node-context-factory.test.ts`.
- **Fail-closed-with-zero-Entra-egress (FR-W3-003 / SC-006):** AD-5 + AD-7
  (`policy-refusal` before any Entra call); Phase 4 ships a no-egress network
  assertion test in `keycloak-broker.test.ts`.
- **Operation-narrowing / no-raw-credential (FR-W3-004/005 / SC-007):**
  `capability-scope.ts` + a type-level "no raw-client / no-token field reachable"
  test; operation-narrowed handles in both the Keycloak broker and the Graph
  capability.
- **Token-cache bound (FR-W2-007 / SC-008):** `token-cache.ts` keyed on
  `(identity, audience, scope)`, TTL-under-token-lifetime, with a property test
  for ≤1 mint per key per TTL window.
- **Audit on every mint AND refusal (FR-X-004 / SC-009):** `broker-audit.ts`
  carrying `sub`/`azp`/`runId`/`nodeId`/scope, with a 100%-coverage test.
- **Frontend-realm dual-client (FR-W3-011 / SC-012):** Phase 3 `ClientStep`
  builds both a confidential auth-code SSO client and agent SA clients; the
  golden test asserts both client types.
- **Two-path inbound auth + user V2 exchange (FR-W3-006/008/009 / SC-010):**
  AD-6, the `user` `AuthIdentity` variant, `jwt-validation.ts`, two-path
  `auth.ts` middleware, and `Invocation.origin` selecting `client_credentials`
  (agent) vs V2 exchange (user).
- **Spikes as gating preconditions (FR-SPK-001..004 / SC-014):** four dated
  spike docs in Phase 3; spike #4 is the documented HARD GATE for the Phase 4
  user-initiated path, spikes #1–#3 gate Phase 5.

No out-of-scope item is flagged as a gap. The plan explicitly re-states the
out-of-scope set (per-team LLM resolution, `act`-claim, DCR, the lead-desk app,
DPoP/mTLS, per-agent Entra apps) in its Security & NFR Notes and does not build
any of them.

## Gaps

None.

## Coverage Table

| Req ID | Status | Where addressed in plan |
|---|---|---|
| FR-W0-001 | Covered | Phase 1 `metered-llm.ts` stamps `(dagId,runId,nodeId)`; Phase 1 "Satisfies: FR-W0-*" |
| FR-W0-002 | Covered | `metered-llm.ts` "zero network round trips"; structured log line + in-memory `llm-meter` counter |
| FR-W0-003 | Covered | Security & NFR Notes "metering local-only SC-002 <5ms p99"; no round trips |
| FR-W0-004 | Covered | `llm-meter.ts` aggregates `tokensIn/tokensOut` per runId; Component Design MeteredLlmClient |
| FR-W0-005 | Covered | Phase 1 is host-only (plus one framework error variant); wires into existing `createNodeContextForDag` / `dag`/`runId` seam |
| FR-W1-001 | Covered | Phase 1 `dag-registration.ts` adds `llmBudgetTokens?` to fugue.yaml Zod schema + `RegisteredDag` |
| FR-W1-002 | Covered | `metered-llm.ts` pre-check budget → `Err llm-budget-exceeded`; `budgetDecision` cumulative≥budget |
| FR-W1-003 | Covered | AD-7 + Phase 1 add `llm-budget-exceeded` `FrameworkError` variant flowing through Result |
| FR-W1-004 | Covered | Component Design "Overshoot rule (FR-W1-004): check before the call; overshoot by at most one; next refused" |
| FR-W1-005 | Covered | `llm-meter` in-memory counter, no network; SC-004 <1ms cited in NFR Notes |
| FR-W1-006 | Covered | `metered-llm.test.ts` "no-budget passthrough"; budget optional → identical behavior |
| FR-W2-001 | Covered | AD-1/AD-2 + `capability-broker.ts` defines `CapabilityBroker.mintFor(invocation, requires)`; "same layer CapabilityHandle occupies" |
| FR-W2-002 | Covered | `passthrough-broker.ts` returns statically-configured clients (today's `extractClients` output) |
| FR-W2-003 | Covered | AD-2 pass-through default is migration path; `passthrough-broker.test.ts` byte-identical behavior |
| FR-W2-004 | Covered | AD-2 framework port + pass-through "neither referencing Keycloak or Entra"; impl is host-only |
| FR-W2-005 | Covered | AD-1 "boot lifecycle untouched — connect/close/healthCheck and pools stay BOOT-scoped; only authority per invocation" |
| FR-W2-006 | Covered | AD-2 "Keycloak/Entra implementation lives only in the host" (`keycloak-broker.ts` under packages/host) |
| FR-W2-007 | Covered | `token-cache.ts` keyed `(identity,audience,scope)`, TTL under token lifetime; property test ≤1 mint/TTL |
| FR-W2-008 | Covered | `docs/adr/0052-per-invocation-capability-axis.md` amends ADR-0051; `capability-manager.ts` extractClients comment updated per ADR |
| FR-W2-009 | Covered | Phase 1 "Satisfies ... FR-W2-009 (LLM as first invocation-scoped capability)"; LLM rides same `mintFor` seam without OIDC |
| FR-W3-001 | Covered | AD-5 + Phase 3 `ClientScopesStep.java` mirrors downstream perms as optional client scopes; assigning the scope is the grant |
| FR-W3-002 | Covered | `keycloak-broker.ts` requests exactly the `requires` scopes, mints via `client_credentials` as agent client |
| FR-W3-003 | Covered | AD-5/AD-7 fail-closed `policy-refusal` before Entra; `keycloak-broker.test.ts` no-egress network assertion (SC-006) |
| FR-W3-004 | Covered | `capability-scope.ts` operation-narrowed handle; type-level test "no raw-client reachable, no escape hatch" |
| FR-W3-005 | Covered | `capability-scope.test.ts` no-token-field type-level test (SC-007); Security Notes "no raw token/vendor key reachable, type+lint" |
| FR-W3-006 | Covered | AD-6 + `jwt-validation.ts` + two-path `auth.ts` middleware validates `fugue-platform` JWT (iss=realm, aud=fugue-host) alongside `fug_` |
| FR-W3-007 | Covered | `auth.ts` `user` variant carries `sub`; `run-dag.ts` threads user sub into invocation/run + NodeContext |
| FR-W3-008 | Covered | AD-6 + Phase 4 V2 token exchange for user origins (`sub` stays user, `azp` becomes agent) with same narrowing |
| FR-W3-009 | Covered | AD-6 + Data Flow: agent-initiated uses direct `client_credentials`, no exchange |
| FR-W3-010 | Covered | AD-6 "this effort owns the inbound path, no separate frontend migration"; both paths in Phase 4 |
| FR-W3-011 | Covered | Phase 3 `ClientStep.java` confidential SSO client + agent SA clients; `FuguePlatformRealmGoldenTest` covers both (SC-012) |
| FR-W4-001 | Covered | AD-3 one `fugue-agents` Entra app holding union of app permissions, admin-consented once |
| FR-W4-002 | Covered | AD-4 FIC variant A, one FIC per agent-type client; runbook FIC entries matching issuer/subject/audience |
| FR-W4-003 | Covered | Phase 3 `ClientScopesStep.java` `entra-exchange` scope w/ hardcoded-audience mapper (`aud: api://AzureADTokenExchange`); golden test asserts mapper |
| FR-W4-004 | Covered | `entra-wif.ts` presents Keycloak SA token as `client_assertion` → app-only Graph/Dynamics token, no stored secret |
| FR-W4-005 | Covered | Runbook captures `Sites.Selected` + Exchange application access policies bounding the union token |
| FR-W4-006 | Covered | Phase 5 `docs/runbooks/2026-06-10-fugue-agents-entra-provisioning.md` manual ops with explicit per-step acceptance |
| FR-X-001 | Covered | AD-7 distinct `infra-unreachable`, `policy-refusal`, `llm-budget-exceeded` variants in `errors.ts`; SC-013 discriminability test |
| FR-X-002 | Covered | AD-7 collapses Entra FIC/WIF/resource-scoping into one `downstream-denied`, kept distinct from `infra-unreachable` |
| FR-X-003 | Covered | AD-7 "token-cache miss is NOT an error — triggers a mint"; `token-cache.test.ts` miss-is-not-error |
| FR-X-004 | Covered | `broker-audit.ts` correlated record (sub,azp,runId,nodeId,scope) on every mint AND refusal; 100% coverage test (SC-009) |
| FR-SPK-001 | Covered | Phase 3 `docs/spikes/2026-06-10-spike-1-fic-signin-attribution.md`, documented outcome, gates Phase 5 |
| FR-SPK-002 | Covered | Phase 3 `spike-2-subclaim-fic-matching.md`, documented outcome, gates Phase 5 |
| FR-SPK-003 | Covered | Phase 3 `spike-3-resource-scoping-coverage.md`, documented outcome, gates Phase 5 |
| FR-SPK-004 | Covered | Phase 3 `spike-4-identity-chaining-e2e.md`, HARD GATE for Phase 4 user-initiated path (Phase 3 GATE note) |
| SC-001 | Covered | Phase 1 attribution test; FR-W0-001 |
| SC-002 | Covered | NFR Notes <5ms p99, zero round trips |
| SC-003 | Covered | `metered-llm.test.ts` overshoot-by-one + next-refused; `llm-meter` property test |
| SC-004 | Covered | NFR Notes <1ms, zero network |
| SC-005 | Covered | `passthrough-broker.test.ts` + `node-context-factory.test.ts` unchanged-path assertion |
| SC-006 | Covered | `keycloak-broker.test.ts` no-egress network assertion |
| SC-007 | Covered | `capability-scope.test.ts` + `graph-capability.test.ts` type-level no-raw-client/no-token-field |
| SC-008 | Covered | `token-cache.test.ts` property test ≤1 mint per (identity,audience,scope)/TTL |
| SC-009 | Covered | `broker-audit.test.ts` 100% mint+refusal coverage |
| SC-010 | Covered | Data Flow user V2 exchange sub=user/azp=agent; agent path 0 exchanges |
| SC-011 | Covered | `entra-wif.ts` no stored secret/cert; Security Notes "no stored Entra secret/certificate anywhere on WIF path" |
| SC-012 | Covered | `FuguePlatformRealmGoldenTest.java` asserts both client types + scope mirror + entra-exchange mapper |
| SC-013 | Covered | `errors.test.ts` each variant discriminable + formatted; `downstream-denied` distinct from `infra-unreachable` |
| SC-014 | Covered | All 4 spike docs in Phase 3; explicit GATE note that gated phases don't proceed without passing outcome |
| US1 | Covered | Phase 1 metering (FR-W0-*) |
| US2 | Covered | Phase 1 budget (FR-W1-*) |
| US3 | Covered | Phase 2 broker port + pass-through (FR-W2-*) |
| US4 | Covered | Phase 4 Keycloak broker + operation narrowing (FR-W3-002/003/004) |
| US5 | Covered | Phase 4 two-path auth + V2 exchange (FR-W3-006/007/008/009) |
| US6 | Covered | `broker-audit.ts` (FR-X-004 / SC-009) |
| US7 | Covered | Phase 5 Entra WIF + Graph capability (FR-W4-*) |
| US8 | Covered | Phase 3 dual-client realm package (FR-W3-011 / SC-012) |
