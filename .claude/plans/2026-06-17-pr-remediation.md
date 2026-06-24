# PR Remediation Plan

**Date:** 2026-06-17
**Branch:** feat/keycloak-entra-wiring
**Scope:** keycloak-entra-wiring PR — 58 files, 6755 insertions, 23 source files
**Findings:** 1 critical, 22 advisory (deduped; several overlapping / design-level)

Review agents: code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent (all 6, parallel).

## Critical Fixes

### Fix 1: Unconditional fail-closed origin throw breaks the zero-regression no-realm baseline
- **Source:** architecture-agent (CRITICAL)
- **File:** `packages/host/src/adapters/node-context-factory.ts:314-323`
- **Issue:** `createNodeContextForDag` resolves `invocationOriginForIdentity(AGENT_CLIENT_MAP, …)` and throws whenever a DAG isn't mapped — *regardless of whether a broker is wired*. `AGENT_CLIENT_MAP` defaults to `{}` and the broker is `undefined` when `REALM_JWT_ISSUER` is unset, so a stock no-realm deployment throws on **every** run (admin/team/user). The throw lands in `run-dag.ts:270` setup-catch → `markFailure` (trips circuit breaker) + rethrow → 500. Empirically reproduced: `invocationOriginForIdentity({}, {kind:"admin"}, dag)` returns `undefined`. Directly contradicts SC-001/SC-005 "byte-identical to today, zero regression".
- **Fix:** The `origin` is only *consumed* when minting is wired (`minting: broker !== undefined ? {broker, origin} : undefined` at both call sites). Thread a `mintingActive` flag into the factory and gate the fail-closed throw on it: throw (preserving FR-040) only when minting will actually occur; otherwise return `origin: undefined` (unused). `NodeContextForDag.origin` becomes `InvocationOrigin | undefined`; the two minting sites already guard `broker !== undefined` and now also `origin !== undefined` (type-honest + fail-closed). Regression tests added.
- **Files touched:** `domain/run-context.ts`, `adapters/node-context-factory.ts`, `http/handlers/run-dag.ts`, `host.ts`, `hitl/adapters/run-executor.ts`, `adapters/__tests__/node-context-factory.test.ts`

## Advisory Fixes

### Fix 2: Unguarded prototype-key lookup fabricates an AgentClientId brand
- **Source:** type-design-analyzer, silent-failure-hunter (A1 sibling)
- **File:** `packages/host/src/domain/auth.ts:126`
- **Fix:** Guard `map[dagId]` with `Object.prototype.hasOwnProperty.call(...)`, matching the hardened sibling `approverTeamIdentity` (`hitl/identity.ts:59`).

### Fix 3: assignedScopes closure uses bare bracket access
- **Source:** silent-failure-hunter (A1)
- **File:** `packages/host/src/host.ts:299`
- **Fix:** Own-property guard on `AGENT_CLIENT_SCOPES[agentClientId]`, matching siblings.

### Fix 4: Checkpoint write swallows Redis failures with no escalation
- **Source:** silent-failure-hunter (A2)
- **File:** `packages/host/src/adapters/node-context-factory.ts:184`
- **Fix:** Apply the same consecutive-failure → `error` escalation pattern the cache adapter uses.

### Fix 5: Shared HttpPost transport port owned by Entra-specific module (coupling)
- **Source:** architecture-agent
- **File:** `adapters/entra-wif.ts:118,128` imported by `fetch-http-post.ts:35` and `keycloak-token-endpoint-http.ts:47`
- **Fix:** Move `HttpPost`/`HttpPostResponse` to the neutral generic transport module `fetch-http-post.ts` (which already owns `createFetchHttpPost`); update imports so Keycloak no longer depends on Entra for a type.

### Fix 6: Comment accuracy (4 sites)
- **Source:** comment-analyzer
- `node-context-factory.ts:285` + `adapters/metered-llm.ts:23` — stale `capability-broker.ts` → `keycloak-broker.ts`.
- `node-context-factory.ts:240` — cache isolation tagged `FR-030`; host spec FR-031 = Redis key namespacing → change to `FR-031`.
- `host.ts:121-150` — orphaned `selectCapabilityBroker` JSDoc moved to immediately precede the function.
- `config.ts:235` — port type `KeycloakClientCredential` → parsed `KeycloakClientCredentialConfig`.

## New Tests
- `node-context-factory.test.ts` — no-realm baseline: unmapped DAG with `mintingActive=false` does NOT throw and yields `origin: undefined`; `mintingActive=true` + unmapped still fails closed (throws) WITHOUT binding a subject token (NFR-014 ordering).
- `middleware/auth.test.ts` — direct `isJwtShape` cases (2-segment, empty segment, non-base64url char).

## Deferred (require team / security decision or are out of remediation scope)
- **Subject-token FR-030 bypass on cache hit** (code-reviewer) — genuine SC-008 (≤1 mint/triple/TTL) vs FR-030 (per-hop current proof) tension; needs a security decision. Recommend `security-expert`.
- **`AuthIdentity.user.subjectToken?` collapses live vs reconstructed** (type-design) — type redesign with behavioral risk; design decision.
- **`ExchangeV2Request.userSub`/`subjectToken` unenforced coupling** (type-design) — type redesign; design decision.
- **Secret/token plain-string self-redaction** (silent-failure A5, type-design) — best addressed as a lint/CI grep guard (NFR-014), separate scope.
- **`dynamics:read` builder throw → branded NonEmptyHost** (type-design) — current throw is unreachable defense-in-depth; defensible as-is.
- **JWKS jose message-string fragility** (silent-failure A4) — already mitigated (pinned jose + regression tests asserting exact strings).
- **conversationUpdate ref-save discarded** (silent-failure A3) — analyzer rates acceptable (logged at error; Bot Framework does not retry).
- **Keycloak token-endpoint 404 → retriable** (architecture) — debatable semantics; current behavior is safe (persistent 404 trips breaker → 503).
- **realm-jwt-verifier lazy-JWKS retry test** (pr-test) — nice-to-have; existing suite already covers steady-state unavailable.

## Validation Commands
```bash
cd packages/host && bun run typecheck
cd packages/host && bun test
```
