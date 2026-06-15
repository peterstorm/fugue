# ADR-0055: One Entra App per Trust Boundary (`fugue-agents`)

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md). This ADR remains the immutable "why".

## Status

Accepted

## Context

The Wave 4 Entra bridge lets a fugue node reach Microsoft Graph and Dynamics
through a narrowly-scoped capability handle, with **no static Entra secret**: the
host presents a Keycloak service-account token as a `client_assertion` to Entra
via workload identity federation (WIF) and receives an app-only downstream token
(US7, FR-W4-001..006, SC-011). To do this Entra needs at least one **app
registration** that (a) trusts the `fugue-platform` realm as an external OIDC
issuer and (b) holds the *application* (app-only) permissions the agents exercise
(`Mail.Send`, `Sites.Selected`, the Dynamics/Dataverse read grant).

The open question is the **granularity** of that registration. Each distinct
agent (mail, sites, dynamics, …) needs a different downstream permission. The
instinct from least-privilege is to give each agent its own Entra app holding
only its single permission, so a leaked app credential exposes only one
integration. That instinct collides with two facts about this system. First,
there is no static app credential to leak — the only credential on the path is
the Keycloak-minted assertion (SC-011), and that assertion is minted *per agent
client* upstream of Entra, governed by Keycloak optional client scopes (AD-5,
FR-W3-001) that fail closed at the Keycloak hop with **zero Entra egress** when a
scope is unassigned. Per-agent least privilege is therefore already enforced
*before* the Entra hop. Second — and decisively — the thing that would actually
compromise these federation paths is a compromise of the **deployed host
process** that holds the WIF exchange logic and can mint assertions for every
agent client it serves. Once that process is owned, the attacker can drive every
FIC the host's realm can satisfy, regardless of how many Entra apps those FICs
are spread across. App count buys no containment at the layer where the
compromise actually happens.

The forces in tension: least-privilege blast-radius minimization (argues for many
apps) versus operational ceremony and an honest model of the trust boundary
(argues for one). The decision must name the real blast-radius unit and place the
app boundary there, then recover per-agent containment by other means.

## Options Considered

1. **One app per agent (`fugue-agent-mail`, `fugue-agent-sites`, … each an Entra
   app holding a single permission)**
   - Pros: superficially tightest least privilege — a single app holds a single
     permission; deleting one app revokes exactly one integration.
   - Cons: every new agent demands a fresh app registration plus a fresh
     tenant-admin consent ceremony, throttling agent rollout on a human approval
     gate. It buys **no containment at the layer where compromise occurs**: a host
     process owns the WIF logic and can mint assertions for *every* agent client,
     so it can drive every per-agent app — the split does not reduce the realized
     blast radius. Multiplies FIC/consent/sign-in-policy surface to audit with no
     security return. Rejected.

2. **One app for ALL fugue deployments (a single tenant-wide `fugue` app every
   host process federates into)**
   - Pros: minimal Entra footprint — one app, one consent, ever.
   - Cons: collapses distinct blast-radius units into one. A different embedding
     host process is a *different* compromise unit; letting an unrelated
     deployment federate into the same app means owning one host yields every
     other deployment's downstream access. Conflates "trust boundary" with
     "vendor account." Rejected — a different embedding process MUST NOT federate
     into `fugue-agents`; it gets its own app.

3. **One app per trust boundary, where the trust boundary is the deployed host
   process (`fugue-agents`, holding the union of permissions)** — *chosen*.
   - Pros: the app boundary sits exactly on the real blast-radius unit. Union
     permissions are admin-consented **once** — no per-agent consent ceremony, no
     mint-time consent prompt. Per-agent least privilege is preserved *before*
     Entra by Keycloak scopes (fail-closed, zero egress); the union is bounded *at*
     Entra by resource-scoping policies. Variant-A FICs keep per-agent-type
     forensic attribution (AD-4) without per-agent apps.
   - Cons: the app-only `.default` token carries the **full union** on every call
     and cannot be downscoped per request — Entra-side containment rests entirely
     on resource-scoping policies, which must exist and be verified or the
     one-app bound is illusory (mitigated below).

## Decision

**One Entra app registration, `fugue-agents`, holds the union of application
permissions any agent needs and is admin-consented once; the trust boundary is
the deployed host process, not the agent.**

- **One app, union permissions, consented once.** `fugue-agents` holds the union
  of *application* (app-only) permissions across all agents the host serves —
  today `Mail.Send`, `Sites.Selected`, and the Dynamics/Dataverse read grant —
  granted via a single tenant-admin consent (FR-W4-001). No per-agent app
  registration exists; `fugue-agent-mail` / `fugue-agent-sites` exist **only** as
  Keycloak clients, never as Entra app registrations.

- **The trust boundary is the host process.** The blast-radius unit is the
  deployed process that holds the WIF exchange and can mint assertions for the
  agent clients it serves. The app boundary is drawn there. A **different**
  embedding host process is a different blast-radius unit and gets its **own**
  app — it must NOT federate into `fugue-agents`.

- **Per-agent least privilege is enforced *before* the Entra hop.** Each agent's
  authority is its assigned Keycloak optional client scope (`msgraph:mail.send`,
  `msgraph:sites.read`, `dynamics:read`; AD-5, FR-W3-001). The broker
  (`packages/host/src/adapters/keycloak-broker.ts`) requests exactly the scopes a
  node's `requires` names; an unassigned scope fails the token request at the
  Keycloak hop and the broker never reaches Entra (fail-closed, zero Entra
  egress). The union at Entra is never the *grant* surface — Keycloak is.

- **The union is bounded *at* Entra by resource-scoping policies.** Because the
  app-only `.default` token carries the union and cannot be downscoped per
  request, containment on the Entra side comes from resource scoping, not
  permission count: `Sites.Selected` (per-site grant — never `Sites.Read.All`),
  Exchange application access policies (per-mailbox `RestrictAccess`), and the
  Dataverse application-user security role. Both **coverage** and **denial** of
  these are mandatory acceptance gates.

- **WIF presents the assertion to *this* app.** `packages/host/src/adapters/entra-wif.ts`
  performs the exchange: it posts the Keycloak SA token as `client_assertion`
  (`client_assertion_type` = the jwt-bearer URN) in a `client_credentials` request
  to `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token`, with
  `client_id` = the `fugue-agents` app id and `scope` = the downstream resource's
  `.default`. The assertion's own `aud` is pinned to
  `api://AzureADTokenExchange` (`AZURE_AD_TOKEN_EXCHANGE_AUDIENCE`) by the
  `entra-exchange` Keycloak scope, so it is usable only at Entra's token-exchange
  endpoint and cannot be replayed against internal services. There is **no stored
  secret or certificate** on `fugue-agents` (SC-011) — WIF is the only credential.

- **Provisioning of this single app is human-executed and gated.** The Azure-portal
  steps — register `fugue-agents`, add the union, admin-consent once, add the
  variant-A FICs, apply `Sites.Selected` and Exchange access policies, confirm
  zero secrets/certs — live in
  `docs/team-security-and-capabilities.md (Appendix A)` (FR-W4-006), each
  step with an explicit, checkable acceptance and gated by the Wave 4 spikes.

### Escalation rule

If a future sensitivity split is warranted, split `fugue-agents` by **sensitivity
tier**, never per agent: e.g. `fugue-agents-read` (read-only union) and
`fugue-agents-act` (mutating union), so a compromise of a read-only host segment
cannot reach act-capable permissions. The boundary stays on a trust/blast-radius
unit, not on agent identity.

## Consequences

**Positive:**

- The app boundary sits exactly on the real blast-radius unit (the host process),
  so the model is honest: no false sense of containment from app multiplication.
- Admin consent happens **once** for the union — agents roll out without a fresh
  app-registration and consent ceremony each time; no mint-time consent prompt is
  ever possible on the app-only path (FR-W4-001).
- Per-agent least privilege is genuinely enforced where it is cheapest and
  fail-closed — at the Keycloak hop, before any Entra egress (AD-5).
- Variant-A FICs (AD-4) preserve per-agent-*type* forensic attribution in Entra
  sign-in logs without needing per-agent apps.
- Zero static Entra secrets/certificates on the path (SC-011); the WIF assertion
  is single-purpose (audience-pinned) and short-lived.

**Negative:**

- The app-only `.default` token carries the **full union** on every call and
  cannot be downscoped per request. Entra-side containment depends entirely on
  resource-scoping policies (`Sites.Selected`, Exchange access policies, Dataverse
  role) being present and correct — a missing or misconfigured policy silently
  widens the realized blast radius. Mitigated by making both the *coverage* and
  the *denial* of each policy mandatory, spike-verified acceptance gates in the
  provisioning runbook (spike #3).
- Adding a permission to the union is an admin-consent event touching the one
  shared app; an over-broad addition raises every agent's ceiling at Entra (the
  Keycloak scope mirror still gates each agent, but the Entra ceiling moves). Risk
  accepted; the escalation-by-tier rule is the pressure-release valve.
- Operators must hold the discipline that a different embedding deployment gets
  its **own** app and must NOT federate into `fugue-agents` — a convenience
  shortcut here would silently merge two blast-radius units. Documented as a hard
  rule in the runbook's cross-side constants.
