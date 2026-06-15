# lead-desk — Dashboard / BFF for fugue DAGs — Design

> Status: **proposal / not yet implemented.** Captures the design discussion of
> 2026-06-09 so it can be built later. No code exists yet.
>
> Lives in the `fugue` repo (not `fugue-dags`) deliberately — see
> [Where this lives](#where-this-lives). The reusable parts described here are a
> *fugue-platform* concern; the lead-specific instance is not.

## Summary

We want a deployed dashboard that lets humans (and AI agents) drive the endpoints
a fugue DAG exposes — for the current case, `POST /score-leads` and
`POST /lead-opener` in `fugue-dags`. The DAG host is stateless request/response;
it has no auth beyond a team token, no UI, and no place to store who claimed a
lead or what the outcome of a call was.

The proposal is a **Next.js BFF (working name `lead-desk`)** that sits in front of
the fugue host and owns everything stateful and human-facing: authentication,
authorization, lead claims, and call-outcome tracking. It holds the fugue team
token server-side and proxies to the DAG endpoints. It does **not** live in
`fugue-dags` (which must stay stateless and push-to-deploy) and it does **not**
live in the framework packages.

Crucially, we already operate this exact pattern in production: `connect-webui`
and `toolbox-webui` are Next.js + Keycloak BFF clients against the same Keycloak
that brokers Entra. So `lead-desk` is not a new auth *design* — it is **one more
confidential OIDC client** wired the way we already wire them. What *is* new is
**where** it lives: a dedicated **`fugue-platform`** realm that becomes the home
for every client in the fugue-host ecosystem (see
[Authentication](#authentication--a-dedicated-fugue-platform-realm)), not a
client bolted onto `toolbox`.

## Motivation

- DAG endpoints will become a deployed host at some point; something has to call
  them with the team token, and a browser can never safely hold that token.
- Multiple actors (sales agents on phones, possibly AI agents) will work the same
  lead pool concurrently → need claims/leasing so two actors don't grab the same
  lead.
- We need call outcomes recorded somewhere — the DAG host is deliberately
  stateless and must stay that way.
- The same shape will plausibly recur for a *similar-but-different* use case, so
  we want the reusable plumbing factored out without prematurely building a
  platform.

## Where this lives

Three repos, three lifecycles. This is the load-bearing decision.

| Repo | Role | Lifecycle | State |
|---|---|---|---|
| `fugue` | The engine + host (generic, npm `@fuguejs/*`) | Library releases | none (per-request) |
| `fugue-dags` | Pure functions on data; push to main = deploy | Continuous deploy | none (stateless, deterministic) |
| `lead-desk` (new) | Everything stateful + human-facing: auth, claims, outcomes, UI | App releases | Postgres |

- **Not in `fugue`** (the framework): the framework is domain-agnostic and
  published to npm. A specific tenant's dashboard, Keycloak config, and claims
  schema would destroy its generality. The framework's job ends at "here's an
  authenticated HTTP endpoint that runs a DAG."
- **Not in `fugue-dags`**: that repo's entire value is being stateless and
  push-to-deploy. A stateful, token-holding, interactive app there would couple
  UI deploys to DAG deploys, drag a database into a repo whose point is having no
  database, and — decisively — a browser physically cannot be the thing that
  calls the DAG with the `fug_` team token. The caller must be server-side.
- **Its own sibling repo** is the answer. When the fugue host gets a real URL it
  becomes one server-side env var in `lead-desk` (`FUGUE_HOST_URL` +
  `FUGUE_TEAM_TOKEN`); nothing in `fugue-dags` changes.

> Note on *this* doc's location: the **doc** lives in `fugue/docs/plans` because
> the reusable BFF kit (below) is a platform concern. The **app** `lead-desk` is a
> separate repo.

```
┌────────────┐  Keycloak auth-code (humans)   ┌─────────────┐  fug_ team token   ┌──────────────┐
│  Browser   │ ─────────────────────────────▶ │  lead-desk  │ ─────────────────▶ │ fugue host   │
│ (dashboard)│  Keycloak svc-acct (AI agents) │   (BFF)     │  POST /score-leads │  + fugue-dags│
└────────────┘                                │  Postgres:  │  POST /lead-opener │ (stateless)  │
                                              │  claims +   │                    └──────────────┘
                                              │  outcomes   │
                                              └─────────────┘
```

## Semi-generic: reuse without overbuilding

Most of the BFF doesn't care that it's leads. But the first generalization from a
single example usually abstracts the wrong axis (Rule of Three). So: **make the
certain-reuse plumbing reusable now via an internal module wall; defer the
uncertain-reuse parts (entity model, UI) until a real second use case forces the
seams.** Design for extraction; don't extract yet.

**Provably domain-independent — factor into `core/` from day one:**

- **Typed fugue client** — `(route, ZodSchema) → Result<T>`, holds the team token
  server-side. Nothing lead-specific.
- **Lease/claims primitive** — `claim(entityId, actor, ttl)` over an *opaque
  string key* (a CVR and any other id are both just strings).
- **Auth**: Keycloak OIDC client (humans), service-account token minting (agents),
  role-claim reader, a `can(user, action, resource)` authz seam.

**Looks generic but isn't — keep in `app/`, do NOT abstract yet:**

- What an "entity" is and its lifecycle (lead vs. ticket vs. renewal).
- Outcome taxonomy (call outcomes ≠ the next case's outcomes).
- Identity → accountManager mapping (a lead-specific join).
- The UI (columns, filters, navigation — where speculative generality dies).

```
lead-desk/
  core/          # zero lead-specific imports — the future desk-kit
    fugue-client.ts      # route + schema → Result
    claims.ts            # lease primitive on opaque entity id
    auth/                # Keycloak OIDC client, service-account tokens, RBAC, can()
  app/           # everything that knows the word "lead"
    leads/               # entity model, AM mapping, outcome taxonomy, UI
```

Rule: `app/` may import `core/`, never the reverse. Enforce with a boundary lint
rule. When a real second use case arrives, lift `core/` into a `desk-kit` package
(or monorepo workspace) — by then the second case shows you the real seams, so
it's a refactor, not a rewrite.

## Authentication — a dedicated `fugue-platform` realm

We do **not** wire Entra directly into the app, and we do **not** reuse the
`toolbox` realm. Keycloak brokers Entra as IdP `azuread`; we create a **new realm,
`fugue-platform`**, that brokers the same Entra tenant and becomes the home for
every client in the fugue-host ecosystem.

### Why a new realm (not `toolbox`)

A Keycloak **realm is an isolated identity & trust domain** — its own users,
clients, roles, identity-provider brokers, signing keys, and token issuer
(`…/realms/<name>`). Tokens, roles, and clients do not cross realm boundaries.
The repo confirms only **two** realms exist today, each a self-contained
config-as-code package:

| Realm | Clients | Machinery | Character |
|---|---|---|---|
| `toolbox` | `toolbox-webui` (auth-code) | Azure IdP broker + group→role mappers, **ABAC/UMA**, **custom username mappers** (`flexii_username`, `oister_username`), sales roles | Heavy — the CS-tooling realm |
| `2ndbrands` | `connect-api` (service-accounts only), `connect-webui` (auth-code) | Azure IdP broker + group→role mappers; **no ABAC, no username mappers** | Lighter — the connect platform |

The earlier instinct to reuse `toolbox` rested on "the users already live there."
They don't: the real identity source is the **3.dk / mother-company Entra tenant**,
brokered in. Each realm stands up its *own* `azuread` broker and maps only the
Azure groups it cares about — no realm owns the org's users; they materialize from
Entra into whichever realm brokers them. Once that pull is gone, the question
becomes *"what is the right trust boundary for the family of apps we're building?"*

That boundary is the **fugue-host ecosystem**. `lead-desk` is the first client,
but more are coming: each future fugue host gets a dashboard/BFF (confidential
auth-code client) and its agent callers (service-account clients). These should be
governed, rotated, and isolated *together* — separate from `toolbox`'s CS tooling
and `2ndbrands`' connect platform. The config-as-code repo is already organized as
**one self-contained package per realm** (`toolbox/`, `secondbrands/`), so
"new product line → new realm package" is exactly how it has scaled from one realm
to two. `fugue-platform` is the third.

> **Naming.** Call it `fugue-platform`, **not `fugue`**. The realm secures the
> *apps and actors around* the hosts (BFFs, agents, human users) — **not the
> engine**, which today runs on `fug_` team tokens and does not touch Keycloak.
> Bare `fugue` would conflate the public `@fuguejs` engine with this private
> internal trust domain. One honest qualifier: the forward-looking agent-framework
> section below *does* eventually put the deployed **host** in contact with this
> realm — as a token-minting client and, later, a resource server accepting
> realm-issued JWTs (see [Inbound host auth](#inbound-host-auth--fug_-tokens-break-the-chain)).
> The naming point stands: the realm secures deployed actors and apps, never the
> published `@fuguejs` library.

### What goes in the realm

Mirror the **`secondbrands` package** as the template — it is the lighter one (no
ABAC, no custom username mappers), which is exactly the weight a 2-DAG dashboard
needs. The package gets the standard steps:

1. `RealmStep` — create `fugue-platform`.
2. `AzureIdpStep` — broker the Entra tenant + map the relevant Azure groups →
   realm roles (copy the `secondbrands` shape).
3. `ClientStep` — `lead-desk` (confidential, auth-code flow) **+** the agent
   service-account client(s) (client-credentials), paired the way
   `connect-webui` / `connect-api` are.
4. `RolesStep` + `ValidationStep`.
5. Register the new realm config in `KeycloakConfigurationApplication` alongside
   `toolbox` and `2ndbrands`.

### The one carry-over to decide consciously

`toolbox` has custom username mappers (`flexii_username`, `oister_username`) that
the lead→account-manager filter hoped to ride on (see open-question #2). A fresh
realm does **not** inherit them. Replace that capability deliberately, one of:

- **(a)** add an equivalent claim/username protocol-mapper in `fugue-platform`,
  derived from the Entra display name / UPN, so the AM identity rides in the
  token; or
- **(b)** resolve AM identity in the BFF via a lookup keyed on a stable Entra
  claim (`oid` / UPN).

Bounded, known work — not a surprise — but it must be done because the AM
data-scoping filter depends on it.

### Reference implementations to copy

- BFF auth-code clients: `connect-webui` / `toolbox-webui` (redirect
  `…/auth/callback/keycloak`). Config-as-code:
  `keycloakConfigAsCode/.../secondbrands/steps/ClientStep.java` (lighter, the
  template) and `.../toolbox/steps/ClientStep.java`.
- Service-account (client-credentials) client: `connect-api`
  (`.../secondbrands/steps/ClientStep.java`).
- Entra brokering + Azure-group→role mappers:
  `.../secondbrands/steps/AzureIdpStep.java` (and the `toolbox` equivalent).
- Backend token validation: `toolbox-backend` `config/SecurityConfig.java`, roles
  from `realm_access.roles` via `security/utils/JwtRoleExtractor.java`.

### Implementation for `lead-desk`

1. Stand up the `fugue-platform` realm package in `keycloakConfigAsCode` (steps
   above) and register it; update the golden export / golden test.
2. Auth.js with the Keycloak/OIDC provider pointed at the `fugue-platform`
   issuer, **server-side session**; the team token and OIDC tokens stay in the
   BFF, never the browser. Copy `connect-webui`'s auth wiring.
3. Roles arrive in `realm_access.roles` off the Azure-group mappers — no custom
   user management.

## AI agents — Keycloak service accounts (NOT home-rolled API keys)

**This retracts the earlier suggestion** that the BFF should issue/hash/revoke its
own API keys. We already do machine auth correctly: `connect-api` is
service-accounts-only (client-credentials), and `toolbox-backend`
`security/client/KeycloakClient.java` already mints + caches service-account
tokens. AI agents get a confidential client (or one per agent) using
`client_credentials` — revocation, rotation, scopes, and audit come for free.

(The only case where home-rolled keys would still win is *external/third-party*
agents we don't want as Keycloak clients. For internal agents, service accounts
win outright.)

## Authorization — RBAC + data-filter, NOT per-request UMA ABAC

We do heavy ABAC in `toolbox` (Keycloak Authorization Services / UMA:
`@AbacPolicy(resource, action)` → `security/aspect/AbacAspect.java` →
`security/service/AbacService.java` does a UMA ticket exchange per request,
resources/scopes/policies/permissions defined centrally in
`keycloakConfigAsCode/.../toolbox/steps/AbacStep.java`). Appropriate for toolbox's
many resources and role matrices. **Overkill for `lead-desk`.**

The key insight, validated by our own setup: **even toolbox's ABAC is
resource/scope/action gating, not per-row ownership.** Row-level access in toolbox
lives in a DB table (`report_role_access`), not in Keycloak. So:

- **Fine-grained "agent sees only their own leads"** = per-row ownership across
  thousands of CVRs. You would *never* model that as Keycloak UMA resources —
  toolbox doesn't either. It is a **BFF data-scoping predicate**
  (`WHERE account_manager = $claim`), regardless of Keycloak.
- **Coarse action gates** ("only admin tunes weights", "agents can claim leads")
  = a handful of resource/scope pairs. Real choice here: model 2–4 ABAC resources
  to stay in house style, *or* just check realm roles directly. For a 2-DAG app,
  default to **plain RBAC**; reach for UMA only if house-style consistency with
  toolbox is wanted.

Either way, route everything through a single `can(user, action, resource)` seam
in `core/`, so starting with role checks and grafting UMA in later never touches
call sites.

**Verdict:** full per-request UMA ABAC is overkill; **RBAC off the existing roles
+ a data-scoping filter** is the right weight — which is exactly how toolbox
itself handles its own row-level case.

## State — claims and outcomes (Postgres)

- **Claims (lease-based locking)** to stop concurrent actors grabbing the same
  lead: `lead_claims(entity_id PRIMARY KEY, claimed_by, claimed_at, expires_at,
  status)`. Atomic `INSERT … ON CONFLICT DO NOTHING` (or `DO UPDATE` if the lease
  expired) enforces the lock at the DB layer — no read-then-write race. Leases
  auto-expire (e.g. 45 min) so abandoned leads re-enter the pool. Idempotent per
  actor (re-claiming your own active lease is a no-op). The primitive keys on an
  opaque string, so it lives in `core/`.
- **Outcomes** — call-outcome logging table; taxonomy is lead-specific → `app/`.

## Forward-looking: authorizing LLM nodes & agents (fugue → agent framework)

> Status: **research / direction, not committed scope.** Captures the auth model
> for when fugue grows from "DAGs with LLM nodes" into an agent framework whose
> nodes/agents act semi-autonomously against downstream APIs. The `fugue-platform`
> realm decided above is the substrate this builds on. Sources dated 2026-06-10;
> verify GA/preview status against your target Keycloak version before building.

### Where fugue is today (the seam this changes)

Today the LLM client is a **host-global capability** — `ports.ts` exposes
`llm: LlmClient`, a single singleton constructed from host env (`ANTHROPIC_API_KEY`
etc. in `main.ts`), injected into nodes that declare `requires: ["llm"]`. There is
**no per-node, per-invocation, or per-identity authority** — a node either has the
capability or doesn't, and all nodes share the host's credentials. That per-node
`requires` declaration is exactly the seam where scoped authority would attach: an
LLM/tool node's capability handle becomes a **narrowly-scoped, audience-bound,
short-lived, sender-constrained token minted per invocation**, not a shared
god-credential.

### The one design-altering constraint (verified)

Two things people assume work, **don't**, in our setup:

1. **No single-token `act`-claim delegation in supported Keycloak** (confirmed
   against nightly 26.6.3 docs). "Standard Token Exchange V2" is GA (26.2, 2025-05)
   but supports **only internal→internal** — re-audiencing/narrowing a Keycloak
   token for another client *in the same realm* (*"supports only use-case (1)"*).
   It does **not** stamp the RFC 8693 `act` claim (*"Keycloak has support for the
   impersonation use case, but not yet for the delegation use case"*), does **not**
   accept an `actor_token`, requires `subject_token` to be an `access_token`, and
   **rejects DPoP/mTLS-bound subject tokens** with `invalid_request` (it *can* emit
   a DPoP-bound token as output). Impersonation exists only in **legacy V1**, which
   is *Preview and Deprecated* and slated for removal. So the clean "one token
   carries `sub`=user + `act`=agent downstream" pattern is **not available today.**
   **The supported cross-domain substitute is the *combination* Standard Token
   Exchange V2 + JWT Authorization Grant = "OAuth Identity and Authorization
   Chaining Across Domains"** (see Adopt-when-it-matures) — the docs explicitly
   recommend it over legacy external→internal exchange.
   ([Keycloak token-exchange](https://www.keycloak.org/securing-apps/token-exchange),
   [26.2 GA blog](https://www.keycloak.org/2025/05/standard-token-exchange-kc-26-2))
2. **Entra On-Behalf-Of cannot work through our Keycloak broker.** OBO requires the
   presented token to be **Entra-issued** with an `aud` matching the middle-tier's
   Entra app. Our downstream APIs receive **Keycloak-issued** tokens, so Entra would
   reject them. OBO is Entra-internal; the equivalent for us is Keycloak-side
   chaining, not Entra OBO. Entra stays the upstream IdP for *humans* — but note it
   is **also a downstream for agents** (Graph and Dynamics are Entra-protected),
   and the supported bridge in that direction is **workload identity federation**,
   not OBO — see
   [Entra-protected downstreams](#entra-protected-downstreams--workload-identity-federation-build-now).
   ([MS Learn — OBO](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow))
   The same applies to **Entra Agent ID** (GA ~2026): it's Entra-issued-token-only,
   so it's a non-fit behind our broker unless a specific downstream trusts Entra
   directly. ([MS Learn — Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id))

**Consequence:** the near-term agent-auth story is *not* `act`-claim delegation
(still unsupported as of 26.6.0). It is **per-agent identity + per-hop downscoped
tokens + audience pinning + short lifetimes + sender-constrained tokens**. Cross-
domain user-context delegation now has a *supported* path — the JWT Authorization
Grant (GA in 26.6.0, 2026-04-08) + Identity Chaining — so it moved from "wait for
GA" to "buildable, pending end-to-end verification" (see Adopt-when-it-matures).

### Build-now model (all GA / confirmed-supported in Keycloak)

- **One confidential service-account client per agent (or per agent *type*)**, not
  a shared client. The client's `client_id`/`sub` is the unit of **attribution,
  revocation, rotation, and rate-limiting** — a shared client collapses all agents
  into one identity and destroys forensics. Prefer certificate / federated-credential
  client auth over static secrets (Microsoft explicitly warns against secrets for
  agent identities in production).
- **Minimal default client scopes; opt into optional scopes per invocation.** Each
  LLM/tool-node call requests only the scopes that hop needs. Maps directly onto
  fugue's per-node `requires`.
- **Strict audience (`aud`) restriction per downstream API**, every resource server
  validating `aud` and rejecting mismatches. This is the **primary confused-deputy
  defense** — a token minted for tool A can't be replayed at tool B.
- **Short access-token lifetimes** for agent tokens — bounds blast radius of a token
  leaked from LLM context/logs.
- **Distinguish the two token sources — token exchange is only in the path for one
  of them.** This matters; conflating them makes exchange look load-bearing
  everywhere when it isn't:
  - **Agent-initiated runs** (cron, sync loop, autonomous agents): the subject *is*
    the agent's service account. Its own `client_credentials` token is already the
    broadest authority it has — "exchanging" it buys nothing. Just mint a fresh
    **narrow** token directly per hop: exactly the optional scopes and `audience`
    that hop needs. No token exchange in this path at all.
  - **User-initiated runs** (a human triggers a DAG from `lead-desk`): the subject
    token is the **user's** token. Here Standard Token Exchange V2 (26.2) earns its
    keep — per hop, downscope (`scope`) + re-audience (`audience`) the user's token
    so `sub` stays the user all the way to the tool. (Accept the no-`act`
    limitation above; see the `azp` substitute below.)
- **Cache minted tokens per `(identity, audience, scope)`** with a TTL safely under
  the token lifetime. Without this, every node execution costs a Keycloak round
  trip — per-invocation minting must not mean per-invocation network calls.
- **Fine-grained tool gating where RBAC is too blunt:** model each tool/resource an
  agent may touch as a Keycloak **Authorization Services (UMA 2.0)** resource +
  scopes, with role/attribute/time policies. Start with **RBAC + scopes + audience**
  for the common case; reserve UMA for genuinely per-resource, context-dependent
  gating. ([Authorization Services Guide](https://www.keycloak.org/docs/latest/authorization_services/index.html))
- **If fugue exposes MCP servers:** implement them as **OAuth 2.1 resource servers**
  fronted by `fugue-platform` Keycloak — Protected Resource Metadata (RFC 9728) +
  Resource Indicators (RFC 8707) + PKCE + audience validation. The MCP auth spec
  bakes in the confused-deputy guard ("MUST NOT accept or transit tokens not issued
  for them"). Note the *core* MCP spec is OAuth 2.1, **not** token exchange — cross-
  domain flows are optional extensions.
  ([MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization))

### Entra-protected downstreams — workload identity federation (build now)

The constraint section above kills OBO but left a hole: it never said how an agent
*calls* an Entra-protected API. That hole is the main road, not a corner case —
the host already ships an **ms-graph capability adapter**, and the lead workflows
live on Dynamics data. Keycloak-issued tokens are useless at Graph/Dynamics, and
the naive fallback (a static Entra client secret per adapter) is exactly the
non-revocable long-lived credential the pitfalls table forbids.

The supported, secretless bridge is **Entra workload identity federation**
(verified 2026-06-10 against MS Learn):

- Register an **Entra app registration** whose **federated identity
  credential(s)** trust the `fugue-platform` realm as an external OIDC issuer
  ("other workloads running in compute platforms outside of Azure" is an
  explicitly supported scenario). The FIC matches the incoming token's `issuer`,
  `subject`, and `audience` **case-sensitively** — `subject` is the agent
  client's service-account `sub`. **Unit decided 2026-06-10: ONE app
  (`fugue-agents`) with one FIC per agent-type client — not one app per
  agent.** The concrete design (trust model, FIC variants, resource-scoping
  policies, escalation path) lives in
  [team-security-and-capabilities.md](./team-security-and-capabilities.md),
  which supersedes any per-agent-app reading of this section.
- Flow: agent mints its Keycloak service-account token → presents it as
  `client_assertion` in a `client_credentials` request to Entra → receives an
  Entra access token for Graph/Dynamics. No secret or certificate stored
  anywhere; this is the same "don't use static secrets for agent identities"
  recommendation quoted above, followed to its conclusion.
- **Caveats:** the resulting tokens are **app-only** (application permissions) —
  user-delegated Graph access stays out of reach behind the broker, which is the
  honest residual limit, so grant application permissions deliberately and
  narrowly. Entra caps federated identity credentials at **20 per app
  registration** (another reason identity is per agent *type*, not per dynamic
  agent) and reads at most 100 signing keys from the external issuer's JWKS
  (a non-issue for one realm). Entra-issued tokens cannot themselves be used as
  the federated assertion — irrelevant here since Keycloak is the issuer.
  ([MS Learn — workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation),
  [client-credentials with federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential))

This completes the picture: **Keycloak-side chaining for internal downstreams,
workload identity federation for Entra-protected ones** — both directions covered
by GA features.

### Living without `act` — substitutes that work today

The missing `act` claim costs us a *standardized, in-token, multi-hop* delegation
chain. It does **not** cost us delegation attribution. What works now:

- **`sub` + `azp` is single-hop delegation attribution for free.** Verified
  against the token-exchange docs: a V2-exchanged token carries `azp` =
  *requesting client* (the agent that performed the exchange) while `sub` stays
  the original user. So every downstream resource server already receives "user X
  via agent Y" — it just has to **log both claims**, and authorization policy may
  key on either. The limit is one hop: `azp` is overwritten by the next exchange,
  so there is no nested history the way `act` chains would give.
- **Put the chain in traces, not tokens.** fugue already has a `Tracer` in
  `SharedInfra` with per-node spans. Propagate W3C `traceparent` on every
  downstream hop and record `user → agent → node → tool` in span attributes;
  Keycloak's event log (token-exchange events carry client + user) correlates via
  `azp`/`sub` + timestamps. The full delegation chain becomes an observability
  query — weaker than a cryptographic in-token chain, but auditable end-to-end
  and available today.
- **App-layer signed context assertion (know it exists, defer it).** The
  two-token pattern: the agent's access token authenticates the call; a separate
  short-lived JWT (signed by the host) carries the delegation context. It works,
  but it invents a parallel trust scheme every downstream must learn to verify.
  Reach for it only if an external party contractually demands chain-in-token
  before Keycloak ships `act`.
- **Do NOT write a custom Keycloak SPI/protocol mapper to stamp `act`
  ourselves.** Tempting, technically possible, and exactly what the roadmapped
  feature will do natively — it would be a throwaway extension maintained on the
  most security-critical component we run.

### Adopt-when-it-matures

- **DPoP (RFC 9449) or mTLS-bound tokens (RFC 8705)** — both GA in Keycloak; the
  highest-leverage control for autonomous agents, since a bearer token lifted from
  LLM context/prompt-injection is useless without the proof key/cert. **Caveat:**
  they don't yet compose with Standard Token Exchange (which rejects sender-
  constrained subject tokens) — sequence per hop, don't assume both at once.
- **Identity Chaining = Standard Token Exchange V2 + JWT Authorization Grant — the
  supported cross-domain recipe (Keycloak 26.6.0, 2026-04-08).** The JWT
  Authorization Grant (RFC 7523) was **promoted from preview to supported** in
  26.6.0; the docs explicitly recommend *combining* it with Standard Token Exchange
  V2 to implement "OAuth Identity and Authorization Chaining Across Domains" —
  replacing the deprecated legacy external→internal exchange. This is our route to
  cross-domain "agent acting for user with preserved intent," now out of preview, so
  it moves from "adopt later" to **buildable**. **Caveat:** 26.6.0 labels the
  *grant* supported but does not explicitly label the end-to-end *chaining flow's*
  status — verify against the 26.6 server docs before prod. 26.6.0 also **deprecates
  Token Exchange V1** (`#45156`), the only thing that ever did impersonation.
  ([26.6.0 release](https://www.keycloak.org/2026/04/keycloak-2660-released),
  [token-exchange docs](https://www.keycloak.org/securing-apps/token-exchange),
  [JWT grant intro](https://www.keycloak.org/2026/01/jwt-authorization-grant),
  [dedicated chaining guide](https://www.keycloak.org/securing-apps/oauth-identity-authorization-chaining-across-domains))
- **`act`-claim delegation in Standard Token Exchange** — on Keycloak's roadmap;
  adopt when shipped (cleanest "agent + user identity downstream" primitive).
- **ID-JAG / Okta Cross App Access** — IETF WG draft (`draft-ietf-oauth-identity-
  assertion-authz-grant`, v04, 2026-05) + vendor initiative; track for multi-IdP /
  cross-org agent delegation, **don't build production on a pre-RFC draft.**

### Inbound host auth — `fug_` tokens break the chain

There is a tension this doc previously papered over: `lead-desk` authenticates a
real user with Keycloak, then calls the host with a **static `fug_` team token** —
user identity dies at the host boundary, which is *exactly* where the agent
framework wants it to survive (the user's token is the `subject_token` for
per-hop exchange, and the source of the `sub`+`azp` attribution above). A
god-credential between BFF and host also makes the host the one hop in the chain
with no per-identity attribution, audience pinning, or short lifetime.

The migration path (not build-now for lead-desk; required before agent semantics):

1. The host **additionally accepts `fugue-platform`-issued JWTs**
   (`iss` = realm, `aud: fugue-host`) alongside `fug_` tokens; team resolution
   moves from the Redis token store to a token claim for these callers. The
   existing two-path bearer middleware is the seam — this is a third path, not a
   rewrite.
2. **User-initiated runs** forward the user's token (exchanged by `lead-desk` to
   `aud: fugue-host`); the host then has a real subject token for per-hop
   downscoping inside the DAG. **Agent/cron runs** authenticate with their own
   service-account token. The chain `user → BFF → host → node → tool` is unbroken.
3. `fug_` tokens remain for bootstrap, local dev, and callers outside the realm —
   deprecate only if they end up unused.

This is also what resolves the naming-note qualifier above: the published
`@fuguejs` engine never learns about Keycloak; the *deployed host* becomes a
resource server + token-exchange client of `fugue-platform`.

### Agent provisioning — keeping config-as-code viable

`keycloakConfigAsCode` is static Java steps plus a golden-export test — excellent
governance, zero runtime dynamism. If "agent" ever means *dynamically spawned
identities*, that provisioning model is the bottleneck: you cannot
golden-export-test clients that didn't exist at commit time.

Resolution: **fix the unit of agent identity at per agent *type* / per DAG**
(this resolves open question #3). A new agent is already a code-reviewed PR to
`fugue-dags`; adding its client to the `fugue-platform` `ClientStep` rides the
same governance gate as the code itself. Per-type is also the right forensics
grain: *which code* acted is the client; *which run / which user* is carried by
traces (and by `sub` on user-initiated runs). It also respects the hard Entra
limit above (20 federated credentials per app registration).

Escape hatch if truly dynamic agents become real: Keycloak supports **OIDC
Dynamic Client Registration** gated by initial access tokens / registration
policies — but it trades away the golden-export governance and turns client
sprawl into a runtime phenomenon. Don't reach for it until a concrete use case
forces it; revisit the identity model deliberately at that point rather than
letting DCR creep in.

### Pitfalls → control

| Pitfall | Control |
|---|---|
| Confused deputy (agent's authority redirected at attacker's target) | Strict `aud` pinning + per-hop downscoped exchange + resource servers rejecting non-matching `aud` |
| Over-broad scopes | Minimal defaults, optional-scope opt-in per call, UMA for fine-grained gating |
| Token leakage from LLM context (prompt-injection exfiltration, logs, traces) | Short lifetimes + sender-constrained tokens (DPoP/mTLS); never put long-lived creds in prompts/system context |
| Non-revocable long-lived secrets | Per-agent clients (individually revocable) + certificate/federated-credential auth over static secrets + rotation |
| Lost delegation chain (no `act` claim yet) | Log `sub`+`azp` at every resource server (single-hop attribution) + trace-based chain via `traceparent`; adopt `act` when Keycloak ships it |
| Static Entra secrets at the Graph/Dynamics bridge | Workload identity federation — Keycloak service-account token as `client_assertion`, no stored secret |
| User identity dying at the host boundary (`fug_` god-credential) | Host accepts realm-issued JWTs (`aud: fugue-host`); user-initiated runs forward the user's exchanged token |

### Implication for the framework

When fugue gains agent semantics, the capability-injection layer (`capability-manager.ts`,
the per-node `requires` typing) is where to introduce an **identity-scoped capability**:
the host holds the agent's service-account client credentials, and at node execution
mints/exchanges a per-invocation token scoped + audience-pinned to exactly the tool
that node touches. That keeps the functional core pure (a node still just receives a
capability handle) while the imperative shell owns token minting, exchange, and
sender-constraint — the same functional-core/imperative-shell split the framework
already enforces.

**Honest sizing: this is an ADR-level restructuring, not an attachment point.**
Capabilities today are **boot-time singletons**: `SharedInfra` holds them,
`connectAll` runs once at boot, and `extractClients` builds a single static
`name → client` map shared by reference into every per-request `NodeContext`.
There is *no per-invocation dimension anywhere in the capability lifecycle*.
Identity-scoped capabilities therefore mean:

- Capability handles grow a **per-invocation factory axis** — conceptually
  `handle.mintFor(invocation) → client` — alongside (not replacing) the existing
  boot-time `connect`/`close`/`healthCheck` lifecycle. Connection pools stay
  boot-scoped; *authority* becomes invocation-scoped.
- The single trust boundary in `extractClients` (the one place the
  `name ↔ client` correlation is cast back) moves or gains a second, per-request
  correlation point — the thing its own doc-comment currently forbids. That
  comment is right *for today's design*; changing it is precisely why this is an
  ADR (amending ADR-0051), not a patch.
- The `(identity, audience, scope)` token cache from the build-now section lives
  in the shell next to the minting, so the pure core never sees tokens at all —
  a node receives an already-authorized client handle, same as now.

None of this blocks `lead-desk`; it gates the agent-framework milestone.

### Is this enough? — accepted residual risk

With the sections above, the model sits at **the ceiling of what GA features
allow today**. What remains open is known, bounded, and tracked:

| Residual gap | Why it's acceptable now | Exit |
|---|---|---|
| No standardized multi-hop delegation chain in tokens | `sub`+`azp` covers single-hop attribution; traces carry the full chain | Keycloak `act`-claim roadmap item |
| No user-delegated access to Entra-protected APIs behind the broker | App-only permissions, granted narrowly per agent type, suffice for agent workloads | Only if a use case truly needs *user-consented* Graph access — then that app talks to Entra directly, outside the broker |
| DPoP/mTLS doesn't compose with token exchange in one hop | Sequence per hop (exchange first, sender-constrain the output) | Keycloak lifting the sender-constrained-subject-token restriction |
| Identity-chaining *end-to-end flow* status not explicitly labeled in 26.6 | Both constituent features (V2 exchange, JWT grant) are individually supported | Verify against 26.6 server docs in a spike before prod |

Nothing on this list justifies delaying the build-now set, and nothing in the
build-now set has to be re-done when the gaps close — `act` adoption, for
instance, is additive to resource servers already logging `sub`+`azp`.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo for the app | New sibling repo `lead-desk` | Keep `fugue-dags` stateless/push-deploy; keep framework generic |
| Repo for this doc | `fugue/docs/plans` | The reusable kit is a platform concern |
| App framework | Next.js BFF (server-side) | Browser can't hold the team token; matches `connect-webui` |
| Reuse strategy | Internal `core/` wall now; extract to `desk-kit` at use case #2 | Rule of Three — capture certain reuse, defer uncertain |
| Keycloak realm | New dedicated `fugue-platform` realm | Trust boundary for the whole fugue-host ecosystem (lead-desk + future hosts/agents); users come from Entra regardless, so `toolbox` has no special pull |
| Human authN | Keycloak confidential client, auth-code flow (Auth.js) | Already a paved road; Entra brokered into the new realm |
| Agent authN | Keycloak service accounts (client-credentials) | Already how `connect-api` works; retracts home-rolled API keys |
| Coarse authZ | RBAC from `realm_access.roles` (optionally a few UMA resources) | Right weight for a 2-DAG app |
| Fine authZ (ownership) | BFF data-scoping predicate on the AM claim | Per-row ≠ Keycloak resource; matches toolbox's own pattern |
| authZ indirection | Single `can(user, action, resource)` seam in `core/` | Swap RBAC→UMA later without touching call sites |
| Concurrency | Lease-based claims table, atomic upsert, auto-expiry | DB-layer lock, idempotent retries |
| Token to fugue | Held server-side in BFF; injected via env | Never exposed to browser; long-term, host also accepts realm JWTs so user context survives the hop |
| Agent identity unit | One client per agent *type* / per DAG, static in config-as-code | Rides the same PR governance as the agent code; right forensics grain; respects Entra's 20-FIC cap; DCR only as a deliberate escape hatch |
| Entra-protected downstreams (Graph/Dynamics) | Workload identity federation — **one** `fugue-agents` Entra app, one FIC per agent-type client trusting `fugue-platform` (see [team-security & capabilities](./team-security-and-capabilities.md)) | OBO impossible behind the broker; WIF is the supported secretless bridge; app-only tokens accepted; per-agent policy stays in Keycloak |
| Delegation attribution (until `act` ships) | Log `sub`+`azp` at resource servers + trace-based chain | V2 exchange already stamps `azp`=agent, `sub`=user; full chain lives in observability |
| Per-hop token strategy | User-initiated runs: V2 exchange of the user's token; agent-initiated runs: direct narrow `client_credentials` minting | Exchange only earns its keep when there's a user subject to preserve |

## Open questions (resolve before building)

1. **Which realm? — RESOLVED: a new `fugue-platform` realm.** Not `toolbox`
   (its only pull was "users live there," but users come from the 3.dk Entra
   tenant via brokering regardless). The new realm is the trust boundary for the
   whole fugue-host ecosystem — lead-desk now, future hosts + their agents later.
   See [Authentication](#authentication--a-dedicated-fugue-platform-realm).
   Remaining sub-decision: confirm *which Azure groups* map to which realm roles
   in `fugue-platform`.
2. **How does the AM identity reach the BFF?** A fresh realm does **not** inherit
   `toolbox`'s `flexii_username` / `oister_username` mappers, so the "AM rides in
   on the token for free" shortcut is gone. Decide between (a) a new protocol
   mapper in `fugue-platform` deriving the AM identity from the Entra display
   name / UPN, or (b) a BFF-side lookup keyed on a stable Entra claim (`oid` /
   UPN). Verify against a decoded token from the new realm.
3. **Agent client model — RESOLVED: one client per agent *type* / per DAG,
   registered statically in config-as-code.** Not shared (collapses attribution,
   forensics, and revocation into one identity); not per dynamic agent instance
   (breaks the golden-export governance model and Entra's 20-federated-credential
   cap). See [Agent provisioning](#agent-provisioning--keeping-config-as-code-viable).
4. **Outcome taxonomy** — confirm the set of call outcomes the business wants
   recorded.

## Next steps (when we build)

1. Stand up the `fugue-platform` realm package in `keycloakConfigAsCode`
   (`RealmStep` + `AzureIdpStep` + `ClientStep` + `RolesStep` + `ValidationStep`,
   mirroring `secondbrands`); register it in `KeycloakConfigurationApplication`
   and update the golden export/test.
2. Decide how the AM identity reaches the BFF — new protocol mapper vs BFF lookup
   (open-Q #2) — and verify against a decoded `fugue-platform` token.
3. Read `connect-webui`'s frontend auth wiring as the copy-from reference.
4. Scaffold `lead-desk` with the `core/` ↔ `app/` boundary + boundary lint rule.
5. Add the `lead-desk` confidential client + agent service-account client(s) to
   the `fugue-platform` `ClientStep`.
6. Implement `core/`: fugue client, claims lease, Keycloak OIDC + service-account
   token minting, `can()`.
7. Implement `app/`: lead entity, AM data-filter, outcome logging, UI.

## References

- Existing BFF clients: `keycloakConfigAsCode/.../toolbox/steps/ClientStep.java`,
  `secondbrands/.../steps/ClientStep.java`
- Entra brokering: `keycloakConfigAsCode/.../toolbox/steps/AzureIdpStep.java`
- ABAC config-as-code: `keycloakConfigAsCode/.../toolbox/steps/AbacStep.java`
- ABAC enforcement: `toolbox-backend/.../security/{aspect/AbacAspect,service/AbacService}.java`
- Token validation: `toolbox-backend/.../config/SecurityConfig.java`,
  `.../security/utils/JwtRoleExtractor.java`
- Service-account tokens: `toolbox-backend/.../security/client/KeycloakClient.java`
- DAG endpoints being fronted: `fugue-dags/dags/leads/{lead-scoring,lead-opener}`
