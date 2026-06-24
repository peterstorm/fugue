# PR Remediation Plan

**Date:** 2026-06-16
**Branch:** feat/keycloak-entra-wiring
**Findings:** 1 critical, 13 advisory across 7 review agents — 5 fixes applied, false-positive corrected, rest deferred with rationale

## Review verdict

Exceptionally high-quality security-critical code: 0 critical bugs in the source logic, illegal states unrepresentable via branded types, fail-closed throughout, full test suite green (1197 pass / 1 skip / 0 fail; tsc clean). The one CRITICAL finding was operator-facing doc rot; the most consequential real defect was an advisory-labelled token-retention leak reachable by any authenticated user.

## Applied

### Fix 1 (CRITICAL): `.env.example` wave-deferral comment rot
- **Source:** comment-analyzer
- **File:** `packages/host/.env.example` (banner + Entra + Keycloak blocks)
- **Issue:** Comments claimed the Entra/Keycloak agent-client legs' live transports were "wired in a later wave" with "fail-closed stubs wired regardless of config presence". They are now wired LIVE under config-presence gating (AD-3) in `host.ts selectCapabilityBroker`. Misled operators about Entra egress.
- **Fix:** Rewrote to present-tense AD-3 gating (set a leg's config -> live transport; unset -> fail-closed stub).

### Fix 2: Subject-token registry retention leak (NFR-014)
- **Source:** security-agent (advisory, elevated — reachable by any authed user)
- **File:** `packages/host/src/adapters/node-context-factory.ts`
- **Issue:** `bindSubjectToken` ran BEFORE the unmapped-DAG fail-closed throw. A user request for a registered-but-unmapped DAG bound a valid JWT under a runId that was never released (run-dag setup-error catch does not release; only `withSubjectTokenRelease` around `executeDag` does, which never runs). Unbounded retention of valid JWTs.
- **Fix:** Moved the bind to AFTER the origin fail-closed check, so an unmapped DAG throws before any token is bound.

### Fix 3 (false positive — corrected): KEY_DELIMITER
- **Source:** code-reviewer (advisory) — FALSE POSITIVE
- **File:** `packages/host/src/domain/token-cache.ts:36`
- **Finding claimed:** `KEY_DELIMITER = ""` (empty string) breaks compositeKey/cacheKey injectivity.
- **Reality:** The line already held the RAW U+001F control byte (`0x1f`) inside the quotes, which renders invisibly as `""` in terminals/grep — fooling the reviewer. The injectivity property was always satisfied at runtime.
- **Action:** Converted the raw control byte to the readable JS escape `""` (byte-for-byte semantically identical). Source-hygiene improvement that prevents the exact misread that produced this false positive. No behavioral change.

### Fix 4: SubjectToken doc overstated leak protection
- **Source:** comment-analyzer + type-design-analyzer (converged)
- **File:** `packages/host/src/domain/auth.ts`
- **Issue:** Doc said the type "exposes NO toString/toJSON that would surface the value" — but a branded string surfaces verbatim via `String()`/`JSON.stringify`/interpolation.
- **Fix:** Tightened the doc to state the branded string carries no self-protection; only the never-log constraint + single-producer brand protect it.

### Fix 5: Duplicated parseJsonObject extracted
- **Source:** architecture-tech-lead
- **Files:** `packages/host/src/adapters/{fetch-http-post,fetch-graph-http}.ts` + new `adapters/parse-json-object.ts`
- **Issue:** Byte-identical tolerant JSON-object parser in both transports.
- **Fix:** Extracted to a shared pure module; both transports import it.

## Deferred (with rationale)

- **IdP `error_description` echoed into client-facing `downstream-denied` reason** (security-agent adv-2): echoing the message is the established framework error-channel contract — every `formatFrameworkError` kind echoes its message; the reason is non-secret IdP text and the full reason is recorded server-side in the broker audit. Making only `downstream-denied` generic would be inconsistent; a proper fix is a framework-wide error-contract decision outside this remediation.
- **jose version pin (`^6.1.0`)** (silent-failure-hunter, pr-test-analyzer, architecture — converged): the JWKS-fault message-match fallback could be reworded by a jose bump, flipping 503->401, but the direction is FAIL-SAFE and the behavior is regression-tested (`realm-jwt-verifier.test.ts:261-281`), which fails CI on a reword. Pinning exact would forgo jose's own security patches. Keep the caret; the regression test is the gate.
- **ENTRA/BOT pairs not carried as a nested type** (type-design-analyzer): biconditional is enforced and tested at the parse gate; lifting into a nested sub-object ripples through every config consumer — a design improvement, not a defect.
- **RealmJwtClaims.teams typed required but validator defaults absent->[]** (type-design-analyzer): the validator always produces `teams`, so the type is accurate for every constructed value; the over-claim is cosmetic.
- **token-cache prompt-store / cache-set swallow; port colocation** (silent-failure-hunter, architecture): pre-existing, unchanged on branch, documented sound designs.

## Validation
```bash
cd packages/host && bun run typecheck   # tsc --noEmit, clean
cd packages/host && bun test            # exit 0, 0 failures
```
