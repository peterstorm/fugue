# Plan: Identity-Scoped Capabilities

**Spec:** `/Users/hansen142/dev/agentic/fugue/.claude/specs/2026-06-10-identity-scoped-capabilities/spec.md`
**Design doc (locked approach):** `/Users/hansen142/dev/agentic/fugue/docs/plans/2026-06-10-identity-scoped-capabilities.md`
**Created:** 2026-06-10

> Approach was **pre-locked** by the design doc above. No approach gate was run
> (per environment constraint); the architecture below translates that committed
> design into loom phases. Two repositories are in scope, tagged on every path:
> **[fugue]** = `/Users/hansen142/dev/agentic/fugue`, **[kc]** =
> `/Users/hansen142/dev/java/keycloakConfigAsCode`.

## Summary

Transforms a fugue node's `requires`-declared capability from a boot-time
god-credential singleton into **narrowly-scoped, per-invocation authority**. The
framework gains a `CapabilityBroker` port (`mintFor(invocation)`) plus a
zero-regression pass-through default; the host owns the Keycloak/Entra
implementation as the single Policy Enforcement Point that refuses *before* any
Entra hop. Keycloak (`fugue-platform` realm) is the refusal point via optional
client scopes; one Entra app (`fugue-agents`) is a dumb token vendor reached by
workload identity federation. LLM usage metering and per-run budgets ride the
same `mintFor` seam and ship first as standalone, identity-free hosting features.

---

## Wave Mapping: design doc 5 waves → loom phases

The design doc names waves 0–4. Loom limits (≤5 waves, ≤12 tasks). Mapping:

| Loom Phase | Design wave(s) | Why combined / split |
|---|---|---|
| **Phase 1** | Wave 0 + Wave 1 | Both are small, host-only (plus one framework error variant). Metering decorator (W0) and budget enforcement (W1) share the same `createNodeContextForDag` LLM-decorator seam. **Combined.** |
| **Phase 2** | Wave 2 | `CapabilityBroker` port + pass-through default + invocation model + ADR amending ADR-0051. Structural foundation for all later waves. Stands alone. |
| **Phase 3** | Wave 3 (config-as-code half) + spikes | `fugue-platform` realm package in **[kc]** (scope mirror, frontend SSO client, agent clients, `entra-exchange` scope), plus the 4 verification spikes. Parallelizable, no dependency on the host broker impl. |
| **Phase 4** | Wave 3 (host half) | Keycloak-backed broker impl: `client_credentials` minting, token cache, operation-narrowed handles, two-path inbound auth (`fug_` + realm JWT), V2 token-exchange for user-initiated runs, capability failure taxonomy, audit. |
| **Phase 5** | Wave 4 | Entra bridge: `fugue-agents` app + FICs + resource-scoping policies (manual Azure runbook + supporting [kc] config), WIF `client_assertion` exchange in the broker, Graph/Dynamics capabilities. Gated by Phase 3 spikes. |

Nothing from the design doc's 5 waves is dropped. Wave 3 is split across Phase 3
(config-as-code + spikes, no host dependency) and Phase 4 (host broker impl,
depends on the Phase 2 port and the Phase 3 realm) so the two repos progress in
parallel where possible.

---

## Architectural Decisions

### AD-1: Per-invocation capability axis (`mintFor`) — amends ADR-0051

**Choice:** Add a per-invocation factory axis to the capability system. Boot
lifecycle is untouched — `SharedInfra.capabilities`, `connectAll`/`closeAll`/
`checkHealth`, and connection pools stay BOOT-scoped. A new `CapabilityBroker.mintFor(invocation)`
resolves *authority* per node invocation. The single trust-boundary cast in
`extractClients` (`capability-manager.ts`) gains/moves to a per-request
correlation point — the exact thing its own doc-comment currently forbids "for
today's design." A token cache keyed on `(identity, audience, scope)` with TTL
safely under token lifetime lives in the host shell next to the minting.
**Why:** Authority must vary per node/run/identity while pools must not churn per
call. Separating the two axes preserves the proven boot lifecycle while adding
the new one. **Rejected:** per-invocation pool creation (network cost, FR-W2-005
violation); silently editing the `extractClients` comment (FR-W2-008 / SC-005
require an ADR, not a patch). **This is the headline ADR amending ADR-0051.**

### AD-2: `CapabilityBroker` port + pass-through default in `@fuguejs/framework`; Keycloak/Entra impl in the host

**Choice:** The `CapabilityBroker` port lives in `@fuguejs/framework`, the same
layer `CapabilityHandle` occupies. The framework ships a trivial **pass-through
broker** that hands back the statically-configured clients (today's behavior
exactly) — the default broker *is* the migration path. The Keycloak/Entra
implementation lives only in the host. **Why:** Framework-only embedders bring
their own identity substrate; the flagship security feature must not be
host-exclusive. The pass-through default guarantees zero regression (FR-W2-002/003,
SC-005). **Rejected:** growing `mintFor` machinery host-side only (leaves
framework consumers without the feature, forces a painful extraction later).
**Rule of Three:** extract to an optional `@fuguejs/keycloak-broker` adapter
package *only* if a second Keycloak-using embedder appears — not now.

### AD-3: One Entra app per trust boundary (`fugue-agents`)

**Choice:** One Entra app registration holding the **union** of application
permissions any agent needs, admin-consented once. The trust boundary is the
deployed host process, not the agent. **Why:** A host compromise yields every
federation path regardless of app count; per-agent apps add registration +
admin-consent ceremony without containment. Per-agent least privilege is enforced
*before* the Entra hop (Keycloak scopes + broker); the union is bounded *at* Entra
by resource-scoping policies. **Rejected:** one app per agent (ceremony, no
containment at the layer compromise happens); one app for all fugue deployments (a
different embedding process is a different blast-radius unit and gets its own app —
it must NOT federate into `fugue-agents`). **Escalation:** split by sensitivity
*tier* (`fugue-agents-read`/`fugue-agents-act`), never per agent.

### AD-4: FIC variant A — one federated identity credential per agent-type Keycloak client

**Choice:** Each agent-type Keycloak client's service-account token is itself the
federated assertion; one FIC per agent-type client (up to Entra's 20-FIC/app cap).
**Why:** Preserves per-agent attribution at Entra's sign-in-log level (which
credential matched) and reinforces per-agent-*type* identity — 20 FICs fits agent
types, is untenable for dynamic instances. **Rejected:** Variant B (one funnel
`entra-bridge` client, one FIC) — minimal Entra config but collapses all Graph
attribution to one identity; choose only if even 20 FICs is too much surface.
Default is A. Gated by spikes #1 and #2.

### AD-5: Keycloak optional client scopes mirror downstream permissions

**Choice:** Mirror each downstream permission as a Keycloak **optional client
scope** (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`, …).
Assigning a scope to an agent's client in the `fugue-platform` `ClientStep` *is*
the policy grant — config-as-code, PR-reviewed, golden-export-tested, the same
governance gate as the agent code. The broker requests exactly the scopes the
node's `requires` names; an unassigned scope fails the token request at the
Keycloak hop and the broker never reaches Entra (fail-closed). **Why:** Single
policy surface with the same review gate as code. **Rejected:** realm roles / UMA
as the *primary* mechanism (coarser; they compose with, not replace, the scope
mirror).

### AD-6: Two-path inbound host auth (opaque `fug_` + `fugue-platform` JWT)

**Choice:** Extend the host's inbound auth middleware to validate `fugue-platform`
OIDC JWTs (`iss` = realm, `aud: fugue-host`) as a first-class mode *alongside* the
existing opaque `fug_` bearer / admin-token path. The resolved `AuthIdentity`
union gains a `user` variant carrying `sub`. The user `sub` threads through the
run and `NodeContext` so the broker can perform a per-hop V2 token exchange
(`sub` stays user, `azp` becomes agent). Agent-initiated (cron/autonomous) runs
use direct `client_credentials` with no exchange. **Why:** Enables user-identity
preservation downstream without a separate frontend migration (FR-W3-010).
**Rejected:** depending on an external frontend migration to deliver the inbound
path (this effort owns it); `act`-claim in-token delegation (Keycloak roadmap,
out of scope — `sub`+`azp`+traces is the v1 substitute).

### AD-7: Capability failure taxonomy — distinct typed `FrameworkError` variants, fail-closed-before-Entra

**Choice:** Add discriminable `FrameworkError` variants, each ts-pattern-matchable
and added to `formatFrameworkError`'s `.exhaustive()`:
- `llm-budget-exceeded` (Phase 1) — per-run LLM budget reached.
- `infra-unreachable` (Phase 4) — Keycloak / token mint transient failure.
- `policy-refusal` (Phase 4) — scope not assigned; authorization; **fail-closed
  before any Entra call**.
- `downstream-denied` (Phase 5) — Entra FIC mismatch / WIF rejection /
  resource-scoping denial collapsed into one authorization category, distinct
  from `infra-unreachable` (FR-X-002 permits this collapse for v1).

A token-cache miss is **not** an error (FR-X-003) — it triggers a mint. **Why:**
Callers must distinguish a transient retry-worthy failure from an authorization
refusal from a budget stop. **Rejected:** a single generic `capability-error`
(loses the retry/authorization distinction SC-013 requires).

---

## File Structure

All files to create or modify, grouped by component. `[fugue]` paths are under
`/Users/hansen142/dev/agentic/fugue`; `[kc]` paths under
`/Users/hansen142/dev/java/keycloakConfigAsCode`.

### Phase 1 — LLM Metering + Budget (host + one framework error variant) [fugue]

```
packages/framework/src/types/errors.ts          — ADD `llm-budget-exceeded` variant + formatFrameworkError case
packages/framework/src/__tests__/errors.test.ts  — assert variant discriminable + formatted
packages/host/src/adapters/metered-llm.ts        — NEW: decorator wrapping LlmClient; stamps (dagId,runId,nodeId), aggregates tokensIn/Out, enforces llmBudgetTokens
packages/host/src/adapters/__tests__/metered-llm.test.ts — NEW: attribution + budget + overshoot + no-budget passthrough
packages/host/src/domain/llm-meter.ts            — NEW (pure): in-memory per-runId counter ADT, budget decision fn (allow/refuse), accumulate
packages/host/src/domain/__tests__/llm-meter.test.ts — NEW: pure counter/budget property tests
packages/host/src/adapters/node-context-factory.ts — MODIFY: wrap shared.llm in metered-llm at context construction (uses existing dag/runId)
packages/host/src/domain/dag-registration.ts      — MODIFY: add `llmBudgetTokens?: number` to fugue.yaml Zod schema + RegisteredDag config
```

### Phase 2 — CapabilityBroker port + pass-through default + ADR [fugue]

```
packages/framework/src/types/capability-broker.ts — NEW: CapabilityBroker port, Invocation type, ScopedCapabilityHandle type
packages/framework/src/types/index.ts             — MODIFY: export the new broker types
packages/framework/src/shared/passthrough-broker.ts — NEW: pass-through broker returning static clients (today's behavior)
packages/framework/src/shared/index.ts             — MODIFY: export passthrough broker factory
packages/framework/src/__tests__/passthrough-broker.test.ts — NEW: byte-identical behavior vs direct client injection
packages/host/src/adapters/node-context-factory.ts — MODIFY: resolve capabilities through a broker (pass-through by default)
packages/host/src/host.ts                          — MODIFY: createContext threads an invocation + selected broker
packages/host/src/__tests__/node-context-factory.test.ts — MODIFY: assert pass-through path unchanged
packages/framework/src/types/capability-handle.ts  — MODIFY (doc only): note authority vs lifecycle axis split
docs/adr/0052-per-invocation-capability-axis.md     — NEW ADR (amends 0051): mintFor, token cache, extractClients boundary, broker layering
packages/host/src/domain/capability-manager.ts      — MODIFY: update `extractClients` trust-boundary doc-comment per the ADR (the change ADR-0052 authorizes)
```

### Phase 3 — `fugue-platform` realm config-as-code + verification spikes

```
[kc] java-configuration/src/main/java/dk/secondbrand/keycloak/configuration/fugueplatform/FuguePlatformConstants.java        — NEW: realm name, scope names, client ids
[kc] .../fugueplatform/FuguePlatformRealmConfig.java          — NEW: config record (realm, environment, clients)
[kc] .../fugueplatform/FuguePlatformEnvironment.java          — NEW: env sealed type (Local/Opr/Onr) — issuer URLs, redirect URIs
[kc] .../fugueplatform/FuguePlatformRealmConfiguration.java   — NEW: orchestrator wiring the steps
[kc] .../fugueplatform/steps/RealmStep.java                   — NEW: create fugue-platform realm
[kc] .../fugueplatform/steps/ClientScopesStep.java            — NEW: optional client scopes (msgraph:*, dynamics:*) + `entra-exchange` scope w/ hardcoded-audience mapper
[kc] .../fugueplatform/steps/ClientStep.java                  — NEW: confidential auth-code frontend SSO client + agent-type service-account clients; assign optional scopes
[kc] .../fugueplatform/steps/ValidationStep.java              — NEW: assert both client types + scopes present
[kc] java-configuration/src/test/resources/golden-realm-export-fugue-platform.json — NEW: golden export
[kc] java-configuration/src/test/java/dk/secondbrand/keycloak/configuration/fugueplatform/FuguePlatformRealmGoldenTest.java — NEW: golden test covering both client types + scope mirror (SC-012)
[fugue] docs/spikes/2026-06-10-spike-1-fic-signin-attribution.md   — NEW: spike #1 outcome (gates Phase 5)
[fugue] docs/spikes/2026-06-10-spike-2-subclaim-fic-matching.md    — NEW: spike #2 outcome (gates Phase 5)
[fugue] docs/spikes/2026-06-10-spike-3-resource-scoping-coverage.md — NEW: spike #3 outcome (gates Phase 5)
[fugue] docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md     — NEW: spike #4 outcome (HARD GATE for Phase 4 user-initiated path)
```

Note: `ClientPlanBuilder` has no scope-assignment or protocol-mapper method
today (verified). Optional-scope creation + the `entra-exchange` hardcoded-audience
mapper follow the existing `ClientScopesStep` pattern (raw `ClientScopeRepresentation`
+ `ProtocolMapperRepresentation`). Assigning optional scopes to clients is a small
`ClientStep`/executor extension; specify it as part of the [kc] tasks.

### Phase 4 — Keycloak-backed broker + two-path inbound auth + V2 exchange [fugue]

```
packages/framework/src/types/errors.ts            — MODIFY: add `infra-unreachable`, `policy-refusal`, `downstream-denied` variants + format cases
packages/framework/src/__tests__/errors.test.ts    — MODIFY: discriminability tests (SC-013)
packages/host/src/adapters/keycloak-broker.ts       — NEW: CapabilityBroker impl — client_credentials mint, scope request, typed operation-narrowed handles, audit emit
packages/host/src/adapters/__tests__/keycloak-broker.test.ts — NEW: fail-closed (no-egress assertion), narrowing, cache TTL, audit
packages/host/src/domain/token-cache.ts             — NEW (pure-ish): cache keyed (identity,audience,scope), TTL logic; miss-is-not-error
packages/host/src/domain/__tests__/token-cache.test.ts — NEW
packages/host/src/domain/capability-scope.ts        — NEW (pure): parse `requires` name → scope, validate, map to operation-narrowed handle shape
packages/host/src/domain/__tests__/capability-scope.test.ts — NEW: parse-don't-validate + no-raw-client/no-token-field type-level test (SC-007)
packages/host/src/domain/auth.ts                    — MODIFY: add `user` AuthIdentity variant (sub, azp); JWT claim types
packages/host/src/domain/jwt-validation.ts          — NEW (pure): validate fugue-platform JWT claims (iss/aud/exp), extract sub — verification injected
packages/host/src/domain/__tests__/jwt-validation.test.ts — NEW
packages/host/src/http/middleware/auth.ts           — MODIFY: two-path resolution (fug_ opaque OR fugue-platform JWT)
packages/host/src/__tests__/middleware/auth.test.ts — MODIFY: JWT path tests
packages/host/src/host.ts                            — MODIFY: build Invocation from AuthIdentity (user→exchange vs agent→client_credentials); select keycloak-broker
packages/host/src/http/handlers/run-dag.ts           — MODIFY: thread user sub into the invocation/run
packages/host/src/adapters/broker-audit.ts           — NEW: correlated mint+refusal audit record (sub,azp,runId,nodeId,scope) over existing tracer/log spine
packages/host/src/adapters/__tests__/broker-audit.test.ts — NEW: 100% mint+refusal coverage (SC-009)
[kc] .../fugueplatform/steps/ClientStep.java         — MODIFY: ensure agent clients carry the scopes used by the host integration test
```

### Phase 5 — Entra bridge (manual ops + host WIF + capabilities) [fugue] + [kc] + Entra

```
[fugue] docs/runbooks/2026-06-10-fugue-agents-entra-provisioning.md — NEW: manual Azure-portal runbook (app registration, admin consent, FIC entries, Sites.Selected, Exchange app access policies) with explicit acceptance per step (FR-W4-006)
[fugue] packages/host/src/adapters/entra-wif.ts        — NEW: present Keycloak SA token as client_assertion → Entra client_credentials → app-only Graph/Dynamics token (no stored secret)
[fugue] packages/host/src/adapters/__tests__/entra-wif.test.ts — NEW: assertion audience pinned; downstream-denied mapping
[fugue] packages/host/src/adapters/graph-capability.ts  — NEW: operation-narrowed Graph handle (sendMail, sites.read) over the WIF token
[fugue] packages/host/src/adapters/__tests__/graph-capability.test.ts — NEW: only-named-op reachable; no raw client
[fugue] packages/host/src/adapters/keycloak-broker.ts   — MODIFY: route Entra-backed scopes through entra-wif after the Keycloak mint
[kc] .../fugueplatform/steps/ClientScopesStep.java       — MODIFY: confirm `entra-exchange` scope mints `aud: api://AzureADTokenExchange`; wire to agent clients needing Entra
[kc] java-configuration/src/test/.../FuguePlatformRealmGoldenTest.java — MODIFY: assert entra-exchange audience mapper present
```

---

## Component Design

### MeteredLlmClient (Phase 1)

**Responsibility:** Decorate the host's `LlmClient` so every call is attributed
and budget-checked, with zero network round trips.
**Files:** `[fugue] packages/host/src/adapters/metered-llm.ts`, `[fugue] packages/host/src/domain/llm-meter.ts`
**Interface:**
```
// domain/llm-meter.ts — pure
type LlmMeter            // immutable per-runId counter snapshot
accumulate(meter, runId, { tokensIn, tokensOut }): LlmMeter
budgetDecision(meter, runId, budget?: number): { allow: true } | { allow: false }  // cumulative >= budget → refuse
// adapters/metered-llm.ts — shell
createMeteredLlm(inner: LlmClient, deps: { dagId, runId, meterRef, budget?, log }): LlmClient
//   sendStructured / sendWithTools: pre-check budget → Err llm-budget-exceeded; post-call accumulate + emit structured log line
```
**Depends on:** the new `llm-budget-exceeded` error variant. **Overshoot rule
(FR-W1-004):** check is *before* the call against cumulative-so-far; an in-flight
call may overshoot by at most one; the next is refused.

### CapabilityBroker port + pass-through (Phase 2)

**Responsibility:** Define the per-invocation authority seam in the framework and
ship the zero-regression default.
**Files:** `[fugue] packages/framework/src/types/capability-broker.ts`, `[fugue] packages/framework/src/shared/passthrough-broker.ts`
**Interface:**
```
interface Invocation {
  readonly origin:
    | { kind: "agent"; agentClientId: string }                 // client_credentials
    | { kind: "user"; sub: string; agentClientId: string };    // V2 token exchange
  readonly runId: RunId; readonly dagId: DagId; readonly nodeId: NodeId;
}
interface CapabilityBroker {
  mintFor(inv: Invocation, requires: readonly Capability[]):
    Promise<Result<Partial<{ [K in Capability]: CapabilityRegistry[K] }>, FrameworkError>>;
}
// pass-through: ignores origin, returns the statically-configured clients (today's extractClients output)
createPassthroughBroker(clients): CapabilityBroker
```
**Depends on:** none new (Phase 2 foundation). Pools stay boot-scoped; the broker
resolves authority only.

### Keycloak broker + token cache + scoped handles (Phase 4)

**Responsibility:** Host PEP. Mint scoped tokens via Keycloak `client_credentials`
(agent) or V2 exchange (user), cache by `(identity,audience,scope)`, wrap in
operation-narrowed handles, fail closed before Entra, emit audit on every
mint/refusal.
**Files:** `[fugue] packages/host/src/adapters/keycloak-broker.ts`, `[fugue] packages/host/src/domain/token-cache.ts`, `[fugue] packages/host/src/domain/capability-scope.ts`, `[fugue] packages/host/src/adapters/broker-audit.ts`
**Interface:**
```
// pure
parseScope(name: Capability): Result<DownstreamScope, FrameworkError>  // parse-don't-validate
cacheKey(identity, audience, scope): string
isFresh(entry, now, ttl): boolean      // miss is NOT an error
// shell
createKeycloakBroker(deps: { kc, cache, audit, now, ... }): CapabilityBroker
//   policy-refusal on unassigned scope BEFORE any Entra call (SC-006: 0 Entra egress)
//   handle exposes ONLY named operation; no raw client / token field reachable (SC-007)
```
**Depends on:** AD-2 port (Phase 2), `fugue-platform` realm (Phase 3),
`infra-unreachable`/`policy-refusal` variants (AD-7).

### Two-path inbound auth + JWT validation (Phase 4)

**Responsibility:** Accept `fugue-platform` OIDC JWTs alongside opaque `fug_`
tokens; extract user `sub`; build the `Invocation.origin`.
**Files:** `[fugue] packages/host/src/domain/jwt-validation.ts` (pure claim
validation, verification injected), `[fugue] packages/host/src/domain/auth.ts`
(adds `user` `AuthIdentity` variant), `[fugue] packages/host/src/http/middleware/auth.ts`.
**Interface:**
```
type AuthIdentity =
  | { kind: "admin" }
  | { kind: "team"; team; label }
  | { kind: "user"; sub: string; azp: string };   // NEW
validateRealmJwtClaims(claims, { expectedIss, expectedAud, now }): Result<{ sub; azp }, AuthError>
```
**Depends on:** existing middleware shape; `host.ts` maps `AuthIdentity` → `Invocation.origin`.

### EntraWif + Graph capability (Phase 5)

**Responsibility:** Exchange a Keycloak SA token for an app-only Graph/Dynamics
token via WIF (no stored secret), expose narrowed operations.
**Files:** `[fugue] packages/host/src/adapters/entra-wif.ts`, `[fugue] packages/host/src/adapters/graph-capability.ts`.
**Depends on:** Phase 4 broker; Phase 3 spikes #1–#3 PASSED; `fugue-agents` app
provisioned per the runbook; `downstream-denied` variant.

### fugue-platform realm package (Phase 3) [kc]

**Responsibility:** Config-as-code realm exposing BOTH a confidential auth-code
frontend SSO client AND agent service-account client(s); optional client scopes
mirroring downstream permissions; the `entra-exchange` audience scope.
**Files:** the `[kc] .../fugueplatform/**` package + golden test.
**Convention:** mirrors the existing `toolbox` realm package shape
(`{Realm}Constants`, `{Realm}RealmConfig`, `{Realm}Environment`,
`{Realm}RealmConfiguration`, `steps/{Realm,ClientScopes,Client,Validation}Step`,
`{Realm}RealmGoldenTest`).
**Depends on:** none (parallel with Phases 1–2).

---

## Data Flow

```
Agent-initiated:
node.requires ─▶ host.createContext builds Invocation{origin:agent} ─▶ broker.mintFor
  ─▶ Keycloak client_credentials (scope=requires) ─[refuse if scope unassigned: policy-refusal, 0 Entra]─
  ─▶ [Entra-backed] WIF client_assertion ─▶ app-only Graph token ─▶ operation-narrowed handle ─▶ node

User-initiated:
realm JWT ─▶ auth middleware validates (iss/aud) ─▶ AuthIdentity{user,sub} ─▶ Invocation{origin:user}
  ─▶ broker.mintFor does V2 token exchange (sub=user, azp=agent) ─▶ same narrowing ─▶ node

Every mint AND refusal ─▶ broker-audit record {sub,azp,runId,nodeId,scope}
```

Key transformation: `Invocation.origin` (agent vs user) selects
`client_credentials` vs V2 exchange; `requires` name → scope (parse-don't-validate)
→ token request → operation-narrowed handle (raw client never reachable).

---

## Implementation Phases

### Phase 1: LLM Metering + Budget (no dependencies)

- Add `llm-budget-exceeded` to `FrameworkError` + `formatFrameworkError`.
- Build the pure `llm-meter` ADT (counter + budget decision + overshoot rule).
- Build the `metered-llm` decorator; wire it into `createNodeContextForDag`.
- Add `llmBudgetTokens` to the fugue.yaml Zod schema + `RegisteredDag` config.
- **Sensitive:** no. **Agents:** ts-test for the meter/decorator.
- **Files:** see Phase 1 file list. **Satisfies:** FR-W0-*, FR-W1-*, SC-001..004, FR-W2-009 (LLM as first invocation-scoped capability).

### Phase 2: CapabilityBroker port + pass-through default + ADR-0052 (depends on Phase 1 pattern)

- Define the `CapabilityBroker` port, `Invocation`, scoped-handle types in the framework.
- Ship `createPassthroughBroker` reproducing today's behavior exactly.
- Route `createNodeContextForDag` capability resolution through a broker (pass-through default).
- Thread an `Invocation` through `host.ts` `createContext`.
- Write ADR-0052 amending ADR-0051; update the `extractClients` doc-comment.
- **Sensitive:** boundary-shaping (no live auth yet) — flag for security-agent review of the port shape. **Agents:** general + ts-test; ADR seed → ADR-writing task.
- **Files:** see Phase 2 list. **Satisfies:** FR-W2-001..008, SC-005, SC-008.

### Phase 3: fugue-platform realm + verification spikes (depends on Phase 2 only for scope-name vocabulary; runs parallel to Phase 4 setup)

- Build the `[kc]` `fugue-platform` realm package: realm, client scopes (downstream
  permission mirror + `entra-exchange` audience scope), confidential frontend SSO
  client + agent service-account clients, validation step.
- Golden-export test covering BOTH client types and the scope mirror.
- Execute the 4 verification spikes; document each pass/fail outcome (gating).
- **Sensitive:** YES (auth config + spikes are auth-critical). **Agents:**
  java-test (golden test); security-agent for the realm config + spikes.
- **Files:** see Phase 3 list. **Satisfies:** FR-W3-001, FR-W3-011, FR-W4-003,
  FR-SPK-001..004, SC-012, SC-014.
- **GATE:** spike #4 (identity-chaining e2e) is a HARD GATE for the Phase 4
  user-initiated path; spikes #1–#3 gate Phase 5.

### Phase 4: Keycloak-backed broker + two-path inbound auth + V2 exchange (depends on Phase 2 + Phase 3)

- Add `infra-unreachable`, `policy-refusal`, `downstream-denied` error variants.
- Build `token-cache` (pure freshness; miss-is-not-error) and `capability-scope`
  (parse `requires` → scope; operation-narrowed handle; no raw-client/token field).
- Build `keycloak-broker`: `client_credentials` minting, fail-closed-before-Entra,
  audit on every mint/refusal.
- Add the `user` `AuthIdentity` variant + `jwt-validation`; make the auth middleware
  two-path (`fug_` opaque OR realm JWT); thread `sub` through run + Invocation.
- Add V2 token exchange for user-initiated origins; `client_credentials` for agent.
- **Sensitive:** YES — highest-risk surface (inbound JWT validation, token mint,
  exchange). **Agents:** security-agent (mandatory) + ts-test.
- **Files:** see Phase 4 list. **Satisfies:** FR-W3-002..010, FR-X-001/003/004,
  SC-006, SC-007, SC-008, SC-009, SC-010, SC-013.

### Phase 5: Entra bridge (depends on Phase 4 + Phase 3 spikes #1–#3 PASSED)

- Author the manual Azure-portal provisioning **runbook** (`fugue-agents` app,
  admin consent, FIC entries, `Sites.Selected`, Exchange app access policies) with
  explicit per-step acceptance — modeled as an ops task, not code.
- Build `entra-wif` (Keycloak SA token → `client_assertion` → app-only token, no
  stored secret) and the operation-narrowed `graph-capability`.
- Route Entra-backed scopes through WIF in `keycloak-broker`.
- `[kc]`: confirm/assert `entra-exchange` mints `aud: api://AzureADTokenExchange`.
- **Sensitive:** YES — WIF is auth-critical. **Agents:** security-agent + ts-test;
  runbook → doc/ops task with acceptance.
- **Files:** see Phase 5 list. **Satisfies:** FR-W4-001..006, SC-011, SC-009 (Entra-path audit), SC-012 (audience mapper).

---

## Testing Strategy

| Component | Unit Tests (pure) | Integration Tests (I/O) | Property Tests |
|---|---|---|---|
| `llm-meter` | accumulate, budget decision, overshoot-by-one | — | cumulative monotonic; refuse iff cumulative≥budget |
| `metered-llm` | attribution stamp; no-budget passthrough; pre-call refuse | — | — |
| `passthrough-broker` | byte-identical clients vs direct injection (SC-005) | — | — |
| `CapabilityBroker` port | fake/pass-through impl drives 90%+ without mocks | — | — |
| `token-cache` | freshness, TTL boundary, miss-is-not-error (FR-X-003) | — | ≤1 mint per (identity,audience,scope)/TTL (SC-008) |
| `capability-scope` | parse `requires`→scope; **type-level: no raw-client/no-token field reachable (SC-007)** | — | — |
| `keycloak-broker` | policy-refusal mapping | fail-closed **no-egress network assertion (SC-006)**; mint happy path | — |
| `jwt-validation` | iss/aud/exp/sub extraction; reject malformed | — | — |
| two-path auth middleware | `fug_` path unchanged; JWT path | reject wrong-aud JWT | — |
| `broker-audit` | record carries sub/azp/runId/nodeId/scope | 100% mint+refusal coverage (SC-009) | — |
| `entra-wif` | assertion audience-pinned; downstream-denied | WIF exchange (gated on live Entra) | — |
| `graph-capability` | only-named-op reachable; no raw client | — | — |
| `errors` | each new variant discriminable + formatted (SC-013) | — | — |
| `[kc] fugue-platform realm` | `buildPlan` pure assembly | **golden-export covers both client types + scope mirror (SC-012)** | — |

**New tests required:** every NEW file above ships its `__tests__` sibling. The
broker port is testable via the pass-through/fake (no mocks). Fail-closed is a
network/no-egress assertion. No-raw-credential / operation-narrowing are
type-level + lint-verifiable (SC-007).

---

## Security & NFR Notes

- **Security (sensitive boundaries — flag for security-agent):** Phase 3 realm
  config + spikes, Phase 4 inbound JWT validation + token mint + V2 exchange, and
  Phase 5 WIF are all auth/JWT/OAuth/token-exchange/secrets territory. Inbound JWT
  validation, token exchange, and WIF are the highest-risk surfaces. Fail-closed
  invariant: an unassigned scope refuses at Keycloak with **zero Entra egress**
  (asserted by test). No raw token / vendor key reachable from functional-core
  code (type + lint enforced). No stored Entra secret/certificate anywhere on the
  WIF path.
- **Primary NFR — extensibility:** the `CapabilityBroker` port is the
  optimization axis (multiple identity substrates / embedders). Security-correctness
  is a hard, non-tradeable constraint, not an axis. Secondary: simplicity.
- **Performance:** metering/budget are local-only (SC-002 <5ms p99 / SC-004 <1ms,
  zero round trips). Token cache keeps ≤1 Keycloak request per
  `(identity,audience,scope)` per TTL (SC-008). Pools stay boot-scoped — no
  per-invocation pool churn.
- **Observability:** every mint AND refusal emits a correlated audit/trace record
  (`sub`,`azp`,`runId`,`nodeId`,scope) over the existing OpenTelemetry/`traceparent`
  spine.
- **Backwards compatibility:** the pass-through default broker IS the migration
  path — existing DAGs/embedders compile and run byte-identically, zero migration
  steps, no feature flag. Keycloak/Entra capabilities are opt-in via `requires`
  declarations + scope assignments.
- **Out of scope (do NOT build):** per-team LLM client resolution (one-host-per-team
  PR #13 makes the host-global LLM singleton correct by construction); `act`-claim
  in-token delegation; dynamic client registration; the lead-desk app itself;
  DPoP/mTLS (documented future consideration only).

---

## Verification

1. **Build:** `bun run -C packages/framework build && bun run -C packages/host build` clean. `[kc]` `mvn -q compile`.
2. **Tests:** `bun test` in `packages/framework` and `packages/host` green; `[kc]` golden test passes with both client types asserted.
3. **Fail-closed:** no-egress network assertion proves 0 Entra calls on unassigned scope.
4. **Type-level:** SC-007 test confirms no raw-client/token field reachable from a handle.
5. **Manual (Phase 5):** runbook steps executed in Azure portal with each acceptance checked; spike outcomes documented before their gated phases proceed.
