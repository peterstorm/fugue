# PR Remediation Plan — Pass 6

**Date:** 2026-06-12
**Branch:** feat/identity-scoped-capabilities
**Findings:** 0 critical, 9 advisory (6 review agents)

Six parallel review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead) found **zero critical**
issues. All findings are advisory. User chose **Fix all actionable**: the safe subset
PLUS the higher-churn refactors. Two advisories are no-action (deferred-by-design /
outside the `main...HEAD` diff).

## Fixes

### Fix 1 (test): TENANT_ID_RE length-boundary cases — `entra-wif.test.ts`
- **Source:** pr-test-analyzer
- **Issue:** `TENANT_ID_RE = /^[A-Za-z0-9.-]{1,128}$/` tested for charset rejection and a
  valid GUID, but not the `{1,128}` length bounds.
- **Fix:** add 1-char (valid), 128-char (valid), 129-char (reject) cases to the existing
  `wifTokenEndpoint` accept/reject `it.each` blocks.

### Fix 2 (doc): SA-cache vs app-only-cache shared-key rationale — `keycloak-broker.ts`
- **Source:** architecture-tech-lead
- **Issue:** `saCache` and `appOnlyCache` share the `(identity, audience, scope)` key.
  Correct today, but the SA token's *true* audience is the Entra exchange audience, not
  the downstream resource — the coincidence (each scope maps 1:1 to a downstream
  audience) is under-documented.
- **Fix:** comment-only clarification at the cache-cell declaration.

### Fix 3 (robustness): pin the C6 soundness side-channel import — `keycloak-broker.ts`
- **Source:** architecture-tech-lead
- **Issue:** the `handleRecord` cast is sound only because the type-only
  `CapabilityRegistryWired` import keeps the `_Equal` assertions in the broker's compile
  graph. A "remove unused import" cleanup could silently drop the guarantee.
- **Fix:** reference the type in an exported type-level position so it cannot be dropped
  without a compile reference breaking.

### Fix 4 (types): make `AgentClientId` load-bearing at the policy gate
- **Source:** type-design-analyzer
- **Issue:** the brand has a single producer but every consuming position is plain
  `string`, so it is convention, not a compiler check.
- **Constraint:** `InvocationOrigin.agentClientId` is a FRAMEWORK type and the framework
  must not depend on the host's Keycloak-client brand — so the framework seam stays
  plain `string` (correct). The brand can only be load-bearing HOST-side.
- **Fix (the authors' own stated follow-up):** add a documented framework-seam
  brand-restore in `auth.ts` (brand-boundary idiom, like `markSignatureVerified`); make
  `AssignedScopes` demand `AgentClientId`; re-brand once at the broker's policy-gate call.
  Update the `auth.ts` comment to reflect the brand is now enforced at the gate.

### Fix 5 (types): `invocationFor` smart constructor — `capability-broker.ts` + `run-node.ts`
- **Source:** type-design-analyzer / architecture-tech-lead
- **Issue:** `Invocation.origin` and `MintingAuthority.origin` are independent fields that
  can disagree; consistency relies on the single run-node build site.
- **Fix:** add `invocationFor(authority, { runId, dagId, nodeId })` deriving
  `origin` from the authority; use it in `run-node.ts` so the per-node `Invocation`
  provably carries the authority's origin.

### Fix 6 (concurrency): structural never-reject for single-flight — `keycloak-broker.ts`
- **Source:** architecture-tech-lead
- **Issue:** the in-flight map's correctness relies on `doAcquireAppToken` never
  rejecting (an invariant held by an inner try/catch but relied on by a separate
  function). A future `await` outside the inner fence would reject every waiter.
- **Fix:** wrap the acquisition with an outer `.catch` in `acquireAppToken` so the shared
  promise can never reject regardless of the inner fence — the map invariant becomes
  structural, not maintenance-dependent. Keep the inner fence for precise hop attribution.

## No action (documented / out of scope)
- `keycloak-token-endpoint.ts` live SA-mint HTTP adapter — deferred-by-design; the unwired
  fail-closed default is tested. (pr-test-analyzer)
- `capability-manager.ts:309` `extractClients` cast — one of exactly two sanctioned
  correlation casts (ADR-0053) with a runtime duplicate guard. (type-design / architecture)
- `index.ts:1874` `runDagStateful` "(deprecated)" mislabel — pre-existing, outside the
  `main...HEAD` diff. (comment-analyzer)

## Validation
```bash
bun run -C packages/framework typecheck && bun run -C packages/host typecheck
bun test
```
