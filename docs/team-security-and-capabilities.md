# Fugue Team Security & Capabilities — Single Source of Truth

**Status:** living reference (canonical). Last consolidated 2026-06-15.
**Scope:** how teams/tenants are isolated, how hosts and DAGs are secured inbound,
and how DAG nodes reach downstream systems (LLM, Microsoft Graph, Dynamics) with
scoped, per-invocation authority via Keycloak + Entra.

> **This doc consolidates and supersedes** the following, which have been folded
> in and removed:
> - `docs/plans/2026-06-14-keycloak-entra-hitl-completion.md` (the completion plan)
> - `docs/plans/2026-06-10-identity-scoped-capabilities.md` (capability-broker design + wave plan)
> - `docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md` (Entra provisioning → Appendix A)
>
> The **ADRs remain** as the immutable decision history and are the "why" behind
> this doc: ADR-0051/0053 (capability registry + per-invocation axis), **0054**
> (broker port + pass-through), **0055** (one Entra app per trust boundary),
> **0056** (FIC variant A), **0057** (Keycloak scopes mirror permissions),
> **0058** (two/three-path inbound host auth + subject-token amendment), 0059
> (capability failure taxonomy), 0060 (HITL suspend/resume), **0061** (per-team
> DAG image scoping; amends 0041 to depth-agnostic discovery — see §2). The
> non-security parts of `docs/plans/2026-06-09-lead-desk-bff-dashboard.md`
> (BFF/dashboard) stay in that plan.

---

## Contents

1. [The mental model (read this first)](#1-the-mental-model-read-this-first)
2. [DAG repo & deployment topology](#2-dag-repo--deployment-topology)
3. [What works today (live)](#3-what-works-today-live)
4. [The target model — the correct way to secure hosts and DAGs per team](#4-the-target-model--the-correct-way-to-secure-hosts-and-dags-per-team)
5. [Gap analysis — current state vs target](#5-gap-analysis--current-state-vs-target)
6. [Architectural decisions (AD-1 … AD-7)](#6-architectural-decisions-ad-1--ad-7)
7. [Implementation plan — phases, files, data flow, testing](#7-implementation-plan--phases-files-data-flow-testing)
8. [Open decisions (confirm before building)](#8-open-decisions-confirm-before-building)
9. [Appendix A — `fugue-agents` Entra provisioning runbook](#appendix-a--fugue-agents-entra-provisioning-runbook)
10. [Appendix B — verification spikes](#appendix-b--verification-spikes)
11. [Appendix C — cross-side constants & references](#appendix-c--cross-side-constants--references)

---

## 1. The mental model (read this first)

**Per-team isolation is a *deployment* boundary, not a *code* boundary. Keycloak
and Entra do not replace that — they sit on top of it to secure two separate
axes: who may *trigger* a host (inbound) and what a DAG node may *reach outward*
(capabilities).** Conflating those two axes is the usual source of confusion.

Three layers, and where security lives in each:

| Layer | What it is | Security responsibility |
|---|---|---|
| `@fuguejs/framework` (fugue) | The DAG engine. **Provider-agnostic. Zero auth, zero Keycloak/Entra.** | None — by design (ADR-0032 framework independence). It only defines the `CapabilityBroker` *port* and a pass-through default. |
| `@fugue/host` (the deployment) | The HTTP server that registers + runs DAGs. **This is the trust boundary.** | All of it: inbound auth, authorization, capability minting, token exchange. |
| `fugue-dags` (e.g. `oister-flexii/fugue-dags`) | The DAG definitions a team authors + deploys onto a host. | Ownership tag: the `team` field in `fugue.yaml`. |

**One deployed host process = one team.** (PR #13, 2026-06-09, `ce45dff`.) Each
team's host brings its own env, provider keys, token store. Per-team LLM/provider
config is therefore *correct by construction* — the host-global singleton is the
team's config.

> **Anti-goal:** do not build per-team client resolution into the host. It would
> re-create the multi-tenancy the deployment model deliberately rejects. What
> *remains* open is the **per-agent dimension within one team's host** (metering,
> budgets, scoped downstream tokens) — that is what the capability broker
> (§4, §7) addresses.

> **Terminology — "agent" ≠ LLM node.** Throughout this doc and the Keycloak/Entra
> config, **"agent" means an autonomous *service identity*, not an LLM/agentic
> node.** The naming (`fugue-agent-*` clients, `agentClientId`, "agent path") is
> historical and routinely misread. Two orthogonal axes are involved:
>
> - **Node kind** (`framework/.../node.ts` — `"fetch" | "transform" | "llm" |
>   "guardrail" | "eval-judge"`): what a node *does*. A `fetch`/`transform` node
>   is plain deterministic code — no LLM, no reasoning.
> - **Invocation origin** (`framework/.../capability-broker.ts`): *who* triggered
>   the run. `{ kind: "agent" }` = **autonomous / no human in the loop** (cron or
>   system-initiated, authenticated via `client_credentials` → app-only token).
>   `{ kind: "user" }` = user-initiated (token exchange preserving `sub`).
>
> These axes are independent. **A deterministic, programmatic data-gathering DAG
> that never touches an LLM is an `"agent"`-origin run** — that is the *normal*,
> intended case, not an edge case. "Agent path" = "app-only service-account path",
> nothing more. See [§4.4 — Programmatic nodes reading Graph/Dynamics](#programmatic-nodes-reading-graphdynamics)
> for the two ways to wire SharePoint/Dynamics reads from a plain node.

The published `@fuguejs` packages never reference Keycloak or Entra. The
`fugue-platform` realm, the `fugue-agents` Entra app, the scope mirror, and the
FIC entries are **deployment artifacts of our host instance**, not framework
features (see [Framework-only embedders](#framework-only-embedders)).

---

## 2. DAG repo & deployment topology

This is the deployment-side counterpart to "host = team" (§1): where DAG code
lives, what gets built, and what lands inside a running host.

### 2.1 Two things, only one of which can be shared

| Thing | What it is | Shared across teams? |
|---|---|---|
| **The source repo** | where DAGs are authored (`fugue-dags`) | **Yes** — a shared monorepo is fine |
| **What lands inside a running host** — the baked image *or* the cloned tree | sits *inside* the trust boundary | **No** — must be exactly one team |

Why the second is a hard "no": **host = team = trust boundary** (§1). One host
has *one* set of LLM/provider keys, *one* `DOCUMENTS_FS_ROOT` data volume, and
*one* set of Entra agent clients. The moment a host serves two teams, those teams
share keys, data, and downstream identity — the isolation collapses. So you
cannot run two teams on one host, and therefore **the image (or clone) feeding a
team's host must contain only that team's DAGs + data.**

> **Critical nuance — API isolation ≠ confidentiality at rest.** The host loads
> **every** DAG in the root it is given (`module-loader.ts` scans `dags/**/dag.ts`,
> any depth) and isolates at the **API** layer via `canAccessDag` on the
> `fugue.yaml` `team` field (§3.2). That governs *who can trigger* a DAG — it does
> **not** protect code/prompts/embedded data *at rest*. Bake all teams into one
> image and team B's code + workbooks physically sit inside team A's image even
> though A's token can't run them. Inside a trust boundary, that is a leak.

### 2.2 The two supported deployment mechanisms

1. **Git-sync** (the host's own `packages/host/Dockerfile`, ADR-0041/0034). The
   host clones `DAGS_REPO_URL` at boot and polls every `DAGS_POLL_INTERVAL_MS`.
   The generic default; "push = deploy".
2. **Baked image + `DAGS_LOCAL_PATH`** (what `fugue-dags` uses today). The local
   git adapter's clone/pull/install become no-ops (`adapters/git-sync.ts`); the
   DAGs — with `node_modules` installed at **image-build** time (no runtime
   npm/registry egress) — are baked into an image, and a Kubernetes initContainer
   copies `/dags` into a volume the host mounts at `DAGS_LOCAL_PATH`. Sensitive
   workbook data rides a separate data image (`fugue-dags/Dockerfile.data`),
   staged the same way into `DOCUMENTS_FS_ROOT`.

Both mechanisms obey the §2.1 rule: in git-sync mode a host clones the **whole**
repo (there is no sparse-checkout/subdir knob — config is only `DAGS_REPO_URL`,
`DAGS_REPO_BRANCH`, `DAGS_LOCAL_PATH`), so a multi-team repo would put every
team's code on every host's disk. Scoping must therefore happen at the build/clone
step, not be relied upon from `canAccessDag`. The baked-image path now does this
(per-team `ARG TEAM`, §2.4); git-sync scoping remains unbuilt.

> **Layout & team derivation (ADR-0041 amended, ADR-0061).** Discovery is
> depth-agnostic: `dags/{team}/.../{dag}/dag.ts`. The **team is the first folder
> under `dags/`** (`extractTeam`); deeper folders are free-form intra-team
> grouping, e.g. `dags/business-sales/leads/lead-scoring/`. The `fugue.yaml`
> `team` field is the source of truth and overrides the path; keep it equal to the
> top-level folder so the per-team image scope (`COPY dags/${TEAM}/`) matches.

### 2.3 Current state of `fugue-dags`

One repo, **currently one team** (`business-sales`), ADR-0041 layout with
intra-team grouping under `leads/`:

```
fugue-dags/
├── Dockerfile          # per-team baked image: ARG TEAM + COPY dags/${TEAM}/ (NOT COPY . .)
├── Dockerfile.data     # bakes the real .xlsx workbooks (CVR/AM data) — team-confidential
├── lib/  packages/contract/                          # shared code + private contract (workspace member)
└── dags/business-sales/leads/{lead-scoring,lead-opener}/   # fugue.yaml → team: business-sales
```

The `Dockerfile.data` image is implicitly team-scoped (it carries only the
business-sales/leads workbooks) — keep it that way.

### 2.4 Recommendation (decided — ADR-0061)

- **Repo: shared monorepo** (preferred). Keep `fugue-dags` with
  `dags/{team}/…`; it keeps the shared `lib/` + contract-package ergonomics.
  Per-team repos are also valid if you'd rather make the boundary structural.
- **Image + host: one per team.** `image = team = host = trust boundary`. Build
  one image per team, scoped to that team's subtree + that team's data.

**Implemented (2026-06-15):** the `fugue-dags` `Dockerfile` is now per-team —
`ARG TEAM=business-sales` + explicit `COPY dags/${TEAM}/` (plus shared
`lib/`/`packages/`), replacing the leaky `COPY . .`. Build with
`--build-arg TEAM=<team>` and tag the image per team.

Remaining options if needed later:
- **git-sync scoping** — add a `DAGS_SUBDIR`/sparse-checkout option to the host's
  git-sync path (not built); until then, git-sync clones the whole repo, so prefer
  the baked-image path or a repo per team for git-sync deployments.
- **repo per team** — the simplest way to make the guarantee structural rather
  than dependent on a correct `COPY`.

Never ship a single all-teams image to multiple hosts, and never run more than one
team on one host.

---

## 3. What works today (live)

### 3.1 Inbound host auth — two live paths (+ one merged-but-unwired)

Source of truth: `packages/host/src/domain/auth.ts`. The resolved request
identity (`AuthIdentity`) has **three variants**; two are live today:

| Identity | How it resolves | Status |
|---|---|---|
| `admin` | `ADMIN_TOKEN` env var, constant-time compare, no Redis, full access. Used to provision teams. | ✅ live |
| `team` | Opaque `fug_<base64url>` bearer token → SHA-256 hash → Redis lookup → `{ team, label }`. | ✅ live |
| `user` | A human via a `fugue-platform` realm OIDC JWT → `{ sub, azp, canRunDag }`. | ✅ live when `REALM_JWT_ISSUER` is set — the JWKS verifier (`createRealmJwtVerifier`, jose `createRemoteJWKSet`) and the `authorizeUserRun` policy are wired as one group (`host.ts:496`); unset ⇒ JWT path disabled-by-omission, JWT-shaped tokens 401 (fail-closed). |

**Token model (live):**
- Team tokens are minted with `crypto.getRandomValues()` (32 bytes), formatted
  as `fug_<base64url>` by `formatToken` (which *enforces* 32 bytes — the
  `TeamToken` brand means "carries full entropy").
- Stored hashed (SHA-256, no salt — tokens are high-entropy) in Redis, every key
  tenant-prefixed (`token-store.ts`): `fugue:<tenant>:tokens:<hash>` (hot-path
  lookup) and `fugue:<tenant>:teams:<team>` (reverse index for revocation), plus a
  `fugue:<tenant>:teams-index` SET for enumeration (the per-tenant ACL denies
  `SCAN`, so a SET is the only sound listing path — see
  `docs/migrations/tenant-key-namespacing.md`).
- `isTeamTokenShape` narrows an inbound string to `TeamTokenShaped` (prefix +
  ≥43 chars). Shape is *all* it asserts — a forged `fug_aaaa…` resolves to
  nothing because resolution is hash-based. This is parse-don't-validate: the
  `TeamTokenShaped` brand routes; only `formatToken` mints the stronger
  `TeamToken` brand.

### 3.2 Authorization — pure, and already correct

`canAccessDag(identity, dagTeam)` (`auth.ts`, pure, `ts-pattern` match):
- `admin` → any DAG.
- `team` → only DAGs where `dag.team === identity.team`.
- `user` → delegates to the `canRunDag(dagTeam)` policy carried *on the identity*
  (captured at the auth middleware from the **required** `RealmJwtDeps.authorizeUserRun`).

DAG ownership is `RegisteredDag.team`, resolved from the `team` field in
`fugue.yaml` (or path-derived). The check runs in the run-dag handler **after**
registry lookup but **before** concurrency acquire, so denied requests don't
consume concurrency tokens.

> **So today, securing a team is:** deploy a host for them → mint them a `fug_`
> token → tag their DAGs with their team. That is a complete, working isolation
> story. Keycloak/Entra are **not** in the live request path yet.

### 3.3 Capabilities today — boot-time singletons + pass-through broker

- Capabilities (LLM clients, FS, document sources) are **boot-time singletons**:
  `SharedInfra` holds them, `connectAll` runs once at boot, `extractClients`
  builds one static `name → client` map injected by reference into every
  `NodeContext`. There is **no per-invocation authority dimension** yet.
- The `CapabilityBroker` **port** exists in `@fuguejs/framework` (ADR-0054) with
  a **pass-through default** that returns the statically-configured clients —
  i.e. exactly today's behaviour. The default broker *is* the zero-regression
  migration path.

### 3.4 Merged but fail-closed-unwired (the Keycloak/Entra plumbing)

PRs #16 (identity-scoped-capabilities) and #17 (HITL Teams approvals) landed all
the **pure core, ports, audit, caching, and fail-closed wiring**. Everything
currently fails closed (no silent successes); the remaining work is *additive
wiring*, not a rewrite — every seam already exists as an injected port with a
recorded-call fake. See the [gap table](#5-gap-analysis--current-state-vs-target).

---

## 4. The target model — the correct way to secure hosts and DAGs per team

There are **two run origins**, and they secure differently. This split is forced
by a hard Keycloak constraint (§4.5) and is the single most important distinction
in the design.

### 4.1 The `fugue-platform` Keycloak realm

- A **new, dedicated realm** — **not** `toolbox`, **not** bare `fugue`. (The only
  pre-existing realms are `toolbox` and `2ndbrands`/`secondbrands`, one
  self-contained config-as-code package per realm in
  `~/dev/java/keycloakConfigAsCode`.) `fugue-platform` is the third.
- A Keycloak realm is an **isolated identity & trust domain** — its own issuer,
  signing keys, users, clients, roles, IdP, mappers, flows. Tokens from realm A
  are invalid in realm B. Realms are named for the **user population / product
  boundary**, never the underlying engine — hence `fugue-platform` (the trust
  domain of deployed fugue actors + apps), not `fugue` (the engine).
- Humans come from the **3.dk / mother-company Entra tenant via brokering** (an
  `azuread` IdP). No realm "owns" the humans; each realm stands up its own broker
  and maps only the Azure groups it cares about.
- Issuer URL: `https://<kc-host>/realms/fugue-platform` (exact scheme/host/port,
  **no trailing slash** — this string must match the Entra FIC byte-for-byte).
- Governed as **config-as-code** (Java steps in `keycloakConfigAsCode`,
  PR-reviewed, golden-export-tested). Realm build steps:
  `RealmStep` → create realm; `AzureIdpStep` → broker Entra + map Azure groups →
  realm roles (role name == team name, the namespace reserved for teams — ADR-0062);
  `ClientStep` → declare clients (BFF + per-agent service accounts);
  `ClientScopesStep` → optional scopes mirroring downstream permissions;
  `RolesStep` + `ValidationStep` → seal the realm.

### 4.2 The two run origins

**Origin A — agent-initiated (cron / autonomous).** No human subject. The host
authenticates **as the agent's Keycloak client** via `client_credentials`, gets a
service-account token, presents it as a `client_assertion` to **Entra via
Workload Identity Federation (WIF)**, and receives an app-only Graph/Dynamics
token. **Secretless** (no static Entra secret — the SA token *is* the credential).
Agent runs never use token exchange (exchanging your own `client_credentials`
token buys nothing).

**Origin B — user-initiated (BFF / human).** A human authenticates to the
`fugue-platform` realm → realm JWT → host **verifies signature (JWKS) + claims
(iss/aud/exp)** → host threads the *raw verified token* host-side as a branded
`SubjectToken` → the broker does **RFC 8693 Standard Token Exchange V2** per hop
to downscope while keeping `sub` = the user (and `azp` = the agent).

### 4.3 Securing the *host* per team (inbound) — ADR-0058

The inbound middleware is a **fail-safe, three-path decision tree** (a third path
added to today's two-path bearer middleware, *not* a rewrite):

1. **Admin token** — constant-time compare (provisioning). Unchanged.
2. **Realm JWT path (new)** — entered only if `verifyRealmJwt` is configured
   **and** the token is **not** `fug_`-shaped (`!isTeamTokenShape` is an enforced
   precondition, not an accidental shape property):
   - Signature verified via JWKS (injected `VerifyRealmJwt` port →
     `markSignatureVerified`).
   - Claims validated (`iss`/`aud`/`exp` against `expectedIss`/`expectedAud`, plus
     the `teams` claim defensively hand-parsed — array of non-empty strings, no Zod,
     fail-closed on malformed — ADR-0063) in `validateRealmJwtClaims` → branded
     `AuthenticatedUser`.
   - `authorizeUserRun(user, dagTeam)` → captured as `canRunDag` on the identity.
   - Result: `{ kind: "user", sub, azp, canRunDag }`.
3. **Opaque `fug_` team path** — unchanged.

The brilliant invariant: a `user` identity **cannot exist** without a wired
`realmJwt` group, and that group **cannot be constructed** without deciding the
`authorizeUserRun` policy (a *required* member of `RealmJwtDeps`). So "verifier
wired but authorization undecided" is **unrepresentable in the types** — wiring
the JWKS verifier *forces* the authz decision at the same construction site, in
types rather than mirrored SECURITY comments. The JWKS verifier itself is live
(`createRealmJwtVerifier`); the JWT path is **disabled-by-omission** until
`REALM_JWT_ISSUER` is configured (fail-closed; JWT-shaped tokens 401 until then).

`fug_` tokens remain for bootstrap, local dev, and callers outside the realm;
deprecate only if they end up unused.

### 4.4 Securing the *DAG* per team (outbound capabilities) — the broker

This is the per-invocation authority axis (ADR-0053/0054, amending ADR-0051).
Connection **pools stay boot-scoped; authority becomes invocation-scoped**
(`connect`/`close`/`healthCheck` untouched).

The flow (`mintFor(invocation, requires) → ScopedCapabilityHandle`):

```
LLM/Graph node          fugue host (imperative shell)          Keycloak (fugue-platform)        Entra
────────────            ─────────────────────────────          ─────────────────────────       ─────
requires:               capability broker (mintFor):
["msgraph:mail.send"] ─▶ 1. client_credentials AS the     ───▶ grants ONLY if the optional
                            agent's Keycloak client,            scope is assigned to that
                            scope=msgraph:mail.send             client — policy lives HERE
                         2. present that token as          ────────────────────────────────▶ FIC match
                            client_assertion (WIF)                                            (issuer+sub+aud)
                         3. receive app-only Graph token   ◀────────────────────────────────  ONE app:
                         4. wrap in a typed handle                                            "fugue-agents"
                            exposing ONLY sendMail();
                            hand the handle to the node
```

The node **never sees a token** — it receives a capability handle whose
*operation surface* is narrowed in code (`sendMail`, not a raw Graph client).
Parse-don't-validate at the capability boundary; the functional core never holds
a credential (SC-007).

**Keycloak is the policy enforcement point.** Each downstream permission is an
**optional client scope** named `<provider>:<operation>` (e.g. `msgraph:mail.send`,
`msgraph:sites.read`, `dynamics:read`). **Assigning a scope to an agent's client
in `ClientStep` *is* the policy grant** — config-as-code, PR-reviewed,
golden-export-tested (ADR-0057). If the agent's client lacks the scope, the
`client_credentials` mint fails **at the Keycloak hop with zero egress to Entra**
(SC-006, fail-closed). Defense in depth: both the broker's `assignedScopes` gate
and Keycloak's own scope validation refuse an unassigned scope.

**Token cache** keyed on `(identity, audience, scope)` with TTL safely under
token lifetime (SC-008) — per-invocation *authority* must not mean per-invocation
*network calls*.

For **user-initiated runs**, step 1 becomes Standard Token Exchange V2 of the
user's token (`sub` stays user, `azp` becomes agent), same scope/audience
narrowing.

<a id="programmatic-nodes-reading-graphdynamics"></a>
#### Programmatic nodes reading Graph/Dynamics (the non-agentic, no-LLM case)

A very common need: **a plain deterministic node gathers data from SharePoint
(`msgraph:sites.read`) or Dynamics (`dynamics:read`) programmatically — no LLM,
no agentic reasoning.** This is fully supported and is the *primary* shape, not an
edge case. Recall the terminology note in §1: a `fetch`/`transform` node with an
`{ kind: "agent" }` origin is exactly "autonomous run authenticating as a service
account" — the word "agent" carries no LLM connotation.

Capabilities are decoupled from node kind entirely. Any node declares what it
needs in `requires`, and the runtime hands it a typed, **operation-narrowed**
handle on its `NodeContext` — identical ergonomics to using `db` or `http`:

```ts
const fetchSites = createFetchNode({
  requires: ["msgraph:sites.read"],            // or "dynamics:read"
  run: async (ctx) => {
    const res = await ctx["msgraph:sites.read"].read(/* … */);  // app-only, zero LLM
    // … deterministic transform of the rows …
  },
});
```

The handle exposes only `read` — no token, no raw Graph/Dataverse client, no
agent loop (SC-007). There are **two ways to wire the underlying identity**,
pick by whether you need per-run scoping:

| | **Option A — static, boot-scoped** | **Option B — per-invocation broker** |
|---|---|---|
| When | One fixed app identity reads the same Graph/Dynamics for every run | Per-DAG/per-team scoping, user-initiated reads (`sub` preserved), per-invocation audit |
| Wiring | Register a normal boot-scoped `CapabilityHandle` (like the `db`/`http` adapters); **no broker** — `runDag` without a `minting` option skips minting (zero-regression default, §3.3) | The Keycloak-backed broker; origin `{ kind: "agent", agentClientId }` → `client_credentials` → WIF → app-only token (the §4.4 flow) |
| Per-run identity | None — one app identity | Scoped per invocation, audited on `(runId, dagId, nodeId)` |

For most "we just pull data programmatically on a schedule" pipelines, **Option A
is the simplest correct choice** — you don't need the broker/minting machinery at
all.

**Provisioning is the same either way** (it's an Entra-side requirement, not a
code one): SharePoint needs `Sites.Selected` on `fugue-agents` with the target
site(s) explicitly added (never `Sites.Read.All`); Dynamics needs `fugue-agents`
registered as a **Dataverse application user** with a read security role plus
`DYNAMICS_ORG_HOST` set (else the `dynamics:read` audience resolves to `undefined`
and the capability **fails closed with zero egress** — `audienceForScope` in
`adapters/keycloak-broker.ts` resolves the Dynamics audience only when the host
is set). For Option B you additionally assign the
`msgraph:sites.read` / `dynamics:read` optional scope to that DAG's Keycloak
service-account client (§4.4).

### 4.5 The hard constraint (why two origins, not one chain)

Verified 2026-06-10 against Keycloak nightly 26.6.3 docs, re-confirm before
building waves 3–4:

- **Keycloak Standard Token Exchange V2 (GA 26.2) is internal→internal
  DOWNSCOPING ONLY.** It re-audiences/narrows a Keycloak token for another client
  *in the same realm* ("supports only use-case (1)"). It does **not** stamp the
  RFC 8693 `act` claim, has no `actor_token`/delegation/impersonation, requires
  `subject_token` to be an access token, and **rejects DPoP/mTLS subject tokens**
  with `invalid_request` (though it *can* emit a DPoP-bound token as output).
- Therefore "one agent token carries both its own + the user's identity
  downstream" is **not possible** in Keycloak today. Entra On-Behalf-Of also
  cannot run through the Keycloak broker (OBO needs Entra-issued tokens).
- Consequence: identity is preserved by `sub`+`azp` on the V2-exchanged token
  (`sub` = user, `azp` = requesting agent) plus `traceparent` chain logging — not
  by an `act` delegation chain. Adopt `act` when Keycloak ships it.
- **JWT Authorization Grant (RFC 7523)** was promoted preview→SUPPORTED in
  Keycloak 26.6.0 — a distinct, complementary feature; not required for the paths
  above but available if a future flow needs it.

### 4.6 One Entra app, union permissions (ADR-0055)

**ONE** Entra app registration, **`fugue-agents`**, holds the **union** of all
application permissions any agent needs (e.g. `Mail.Send`, `Sites.Selected`,
Dynamics read), admin-consented **once**. **No per-agent apps.**

Why one app is sound: **the trust boundary is the deployed host process, not the
agent.** Every DAG runs inside the same host, so one or twenty Entra apps, a host
compromise yields every federation path regardless. Per-agent apps buy ~no
containment while costing an app-registration + admin-consent ceremony per agent.
Per-agent **least privilege is enforced *before* Entra** (Keycloak scopes, §4.4),
fail-closed at the Keycloak hop with zero Entra egress.

The honest trade-off: **app-only tokens cannot be downscoped per request**
(`client_credentials` against Entra is `scope=.default` — the token carries all
granted app roles every time). So the union is bounded **at Entra** by
resource-scoping policies:
- **`Sites.Selected`** (never `Sites.Read.All`) — only explicitly granted
  SharePoint sites.
- **Exchange application access policies** — `Mail.Send` restricted to specific
  mailboxes (e.g. the lead-desk shared mailbox).
- **Dataverse application user** + scoped security role — row/table-level read.

**Escalation path** (the *only* sanctioned reason to add an Entra app): split by
**sensitivity tier** — `fugue-agents-read` / `fugue-agents-act` — never per agent.
2–3 apps total, an order of magnitude below per-agent registrations.

### 4.7 Federated Identity Credentials — Variant A (ADR-0056)

**One FIC per agent-type Keycloak client** (`fugue-agent-mail`,
`fugue-agent-sites`), well under Entra's **20-FIC/app cap**. Each FIC matches,
**exactly and case-sensitively**:
- `issuer` = `https://<kc-host>/realms/fugue-platform`
- `subject` = that client's service-account `sub` (predictable as
  `service-account-<client_id>` if the sub-claim mapper is in use — gated by spike
  #2; otherwise read-then-pin the UUID after `ClientStep`)
- `audience` = `api://AzureADTokenExchange`

This preserves **per-agent-type attribution at Entra's sign-in log** (the matched
FIC is named — gated by spike #1) at zero runtime cost (FIC granularity is
provisioning-side only). The `entra-exchange` Keycloak scope mints
`aud: api://AzureADTokenExchange` on the access token only — a useful side effect:
that audience is rejected by every internal `fugue-host` resource server, so the
WIF assertion **cannot be replayed inside the platform**.

> **Variant B** (one funnel client, one FIC) was rejected as the default: it
> collapses Entra-side attribution (all Graph activity traces to one identity).
> Choose only if even 20 FICs is too much Entra surface.

### 4.8 No static Entra secret (SC-011)

The Keycloak SA token is the `client_assertion`; the WIF body builder
structurally omits `client_secret`/cert. `fugue-agents` must carry **0 client
secrets and 0 certificates** — the only credential is WIF (the FICs). The
Keycloak-side secret (AD-1) is a *Keycloak* client secret for the
`client_credentials` mint, **never sent to Entra**.

### 4.9 The LLM capability — same axis, no OIDC

The LLM client (Anthropic/OpenAI key) rides the same `mintFor` seam but is a
vendor API key — no Keycloak/Entra. The first, cheapest instances of the
per-invocation axis (no IdP needed):
- **Wave 0 — usage metering.** Decorator at `createNodeContextForDag` stamps
  `dagId`/`runId`/`nodeId` onto every LLM call and aggregates (`LlmResponse`
  already returns `tokensIn`/`tokensOut`; the factory already receives `dag` +
  `runId`). Per-agent cost attribution, host-only, ~an afternoon.
- **Wave 1 — budget enforcement.** `llmBudgetTokens` in `fugue.yaml`, enforced by
  the same decorator; one framework touch (a new `FrameworkError` variant
  `llm-budget-exceeded`). The first true invocation-scoped capability and the
  low-risk dry run for the OIDC-backed waves.

### Framework-only embedders

An app embedding `@fuguejs/framework` directly (no host) brings its own
imperative shell and identity substrate:

| Embedder | Identity substrate | Uses `fugue-agents`? |
|---|---|---|
| Our fugue host | `fugue-platform` realm + `fugue-agents` app | Yes — it's this deployment's app |
| Internal org app, framework-only | Own broker impl; *may* register as a `fugue-platform` client for SSO | **No** — own Entra app/FIC, own union |
| External/third-party app | Entirely their own (any IdP or none); pass-through broker by default | No — never sees our infra |

What it inherits free (via framework types): `requires` declarations,
operation-narrowed handles, no raw credentials. What it must **not** do: federate
into `fugue-agents` (different process → different trust boundary → its own app).

---

## 5. Gap analysis — current state vs target

> **STATUS UPDATE (2026-06-17).** The wiring below **has landed.** On branch
> `feat/keycloak-entra-wiring` (commits `86f82db` T1–T8, `2ee0009` ADRs/runbook,
> `f2a0ed5` review remediation) **every row marked STUB / MISSING / PLACEHOLDER /
> LIVE-UNWIRED / v1 GAP below is now IMPLEMENTED, merged, and unit/golden-tested.**
> The table is retained as the pre-wiring baseline (file → seam map). What remains
> is **Phase 5 only** — operator provisioning + live verification against a real
> tenant (see the two runbooks). No host code remains to write.

Baseline below verified 2026-06-14 against `main` HEAD (at that point the branch
was 0 commits ahead). Read the State/Gap columns as the *starting* condition the
Phase 0–4 wiring closed.

| Component | File | State | Gap |
|---|---|---|---|
| Capability broker (pure) | `adapters/keycloak-broker.ts` | WIRED | — |
| Auth domain + JWT validation (pure) | `domain/auth.ts`, `domain/jwt-validation.ts` | WIRED | — |
| Token cache, audit, scope-narrow (pure) | `domain/token-cache.ts`, `adapters/broker-audit.ts`, `domain/capability-scope.ts` | WIRED | — |
| Auth middleware (accepts `RealmJwtDeps`) | `http/middleware/auth.ts` | WIRED | `realmJwt` left `undefined` at boot (`host.ts:130`) |
| Keycloak token endpoint | `adapters/keycloak-token-endpoint-http.ts` (`createKeycloakTokenEndpoint`) + `unwired-token-endpoint.ts` | **WIRED (on config)** | live `createKeycloakTokenEndpoint` when `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` is set, else `createUnwiredTokenEndpoint` (`host.ts:309`) |
| Entra WIF exchange | `adapters/entra-wif.ts` (`createEntraWifExchange`) | **WIRED (on config)** | live when `ENTRA_TENANT_ID`+`ENTRA_CLIENT_ID` are set, else `createUnwiredEntraWifExchange` (`host.ts:324`) |
| Graph HTTP transport | `adapters/fetch-graph-http.ts` (`createFetchGraphHttp`) | **WIRED (on config)** | live when Entra config present, else `createUnwiredGraphHttp` (`host.ts:328`) |
| Realm JWT JWKS verifier (`VerifyRealmJwt`) | `adapters/realm-jwt-verifier.ts` (`createRealmJwtVerifier`, jose) | **WIRED (on config)** | live when `REALM_JWT_ISSUER` is set (`host.ts:499`) |
| `authorizeUserRun` policy | `RealmJwtDeps.authorizeUserRun` | **WIRED (on config)** | stateless `user.teams.includes(dagTeam)`, built with the verifier group (`host.ts:505`) |
| Subject-token threading (user exchange) | n/a | **MISSING** | `ExchangeV2Request` carries only `userSub` (ADR-0058 amendment gap) |
| dagId→Keycloak client mapping | `domain/auth.ts` `agentClientIdForDag` | **PLACEHOLDER** | identity function (ADR-0056) |
| Dynamics/Dataverse | `keycloak-broker.ts:154`, `graph-capability.ts:236` | **PLACEHOLDER** | hardcoded host |
| Entra config (`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`) | `domain/config.ts` | **MISSING** | not in schema |
| HITL durable suspend/resume + stores | `hitl/**` | WIRED (Redis/BullMQ) | — |
| HITL Bot connector / inbound verify / endpoint | `hitl/adapters/bot/**`, `http/router.ts` | WIRED | needs Azure Bot provisioned |
| HITL Teams card builder | `hitl/adapters/bot/card.ts` (102 lines) | WIRED | AdaptiveCard v1.4, approve/reject `Action.Execute` (`fugue.review`) + required reason |
| **HITL Teams-button per-team authz** | `hitl/adapters/bot/messages-handler.ts` | **IMPLEMENTED** (was v1 GAP) | clicker authorized via `HITL_APPROVER_TEAMS` at parity with HTTP path; non-member click refused (SC-006) |
| `.env.example` HITL/Entra vars | `.env.example` | **MISSING** | only Server/Redis/MLflow/LLM/Eval vars present |

**Asymmetry (RESOLVED 2026-06-17).** At the 2026-06-14 baseline HITL was
code-complete bar the Teams-button authz gap, and Keycloak/Entra could not yet
mint a downstream token. **Both are now wired:** the Teams-button authz gap is
closed (`messages-handler.ts` authorizes the clicker via `HITL_APPROVER_TEAMS` at
parity with the HTTP path), the live Keycloak token endpoint
(`keycloak-token-endpoint-http.ts`), Entra WIF, Graph transport
(`fetch-graph-http.ts`), and the realm JWT verifier (`realm-jwt-verifier.ts`) are
all present and config-gated in `selectCapabilityBroker`. The only remaining
dependency is **provisioning + live verification** (Phase 5), not code.

---

## 6. Architectural decisions (AD-1 … AD-7)

### AD-1 — How the host authenticates as each agent's Keycloak client
**Choice:** an `AgentClientCredentials` port — `(AgentClientId) →
KeycloakClientCredential | undefined` — resolved from `KEYCLOAK_AGENT_CLIENT_CREDENTIALS`
(JSON `{ clientId: clientSecret }`), injected into the live token-endpoint
adapter. A miss is **fail-closed** (`policy-refusal`-shaped, no egress).
**Why:** each agent client is a confidential service-account client; to mint AS
`fugue-agent-mail` the host must present that client's secret. One host owns only
a small fixed set of agent clients (one-host-per-team), so a config/secret map
suffices. Keeping it a **port** lets a Vault/Key Vault adapter replace the env map
later with no broker change.
**Rejected:** one shared host service account (collapses the per-agent trust
boundary; `azp` audit would lie); secret carried in the request (leaks credential
across the port surface).

### AD-2 — One shared fetch transport for OAuth form POSTs
**Choice:** a single `createFetchHttpPost(): HttpPost` reused by **both** the
Entra WIF exchange and the Keycloak token endpoint (both POST
`application/x-www-form-urlencoded`, consume `{ status, json }`). Graph gets its
own `createFetchGraphHttp(): GraphHttp` (bearer + GET/POST + absolute URL).
**Why:** one transport, one place for timeout/retry/TLS posture. **Rejected:**
hardcoded `fetch` inside adapters (breaks the "every egress is an injected port"
invariant that keeps security tests network-free).

### AD-3 — Staged go-live via config presence, not a flag
**Choice:** `selectCapabilityBroker` swaps each unwired stub for its live adapter
**only when that adapter's config is present** (live Keycloak endpoint when
`KEYCLOAK_AGENT_CLIENT_CREDENTIALS` set; live WIF when `ENTRA_TENANT_ID` +
`ENTRA_CLIENT_ID` set; live Graph alongside live WIF). Absent config → keep the
fail-closed stub + one-time boot warn.
**Why:** lets the agent path, user path, and Entra leg light up **independently**
as each is provisioned and spike-verified; each partial state stays provably
fail-closed. **Rejected:** a single `CAPABILITY_MINTING_ENABLED` flag (forces all
three egresses live at once — the four-spike gate forbids it).

### AD-4 — Realm JWT verifier mirrors the Bot token verifier
**Choice:** `createRealmJwtVerifier({ issuer })` builds `VerifyRealmJwt` via
`jose.createRemoteJWKSet` against `<issuer>/.well-known/openid-configuration` →
`jwks_uri`, then `markSignatureVerified(claims)`. **Signature only** — iss/aud/exp
stay in `validateRealmJwtClaims`. Structurally identical to
`hitl/adapters/bot/verify.ts`. **Rejected:** hand-rolled JWKS + RS256 verify
(re-implements `jose`, including key rotation).

### AD-5 — `authorizeUserRun` from a realm-role/group claim (recommended)
**Choice (recommended):** extend `RealmJwtClaims` with optional
`teams: readonly string[]` (a Keycloak realm-role/group mapper), and
`authorizeUserRun(user, dagTeam) => user.teams.includes(dagTeam)`. Stateless — the
mapping is data on the verified token. `authorizeUserRun` is a **required** member
of `RealmJwtDeps`, so the compiler forces the decision; it can't be silently
`() => true`. **Rejected:** Redis-backed user→teams grant store (sync/ops burden +
I/O hop in the auth hot path — defer unless membership must be host-local);
`() => true` (latent any-user-runs-any-DAG grant).

### AD-6 — Subject-token threading is a host-side side-channel, never the framework origin
**Choice:** carry the **raw verified user JWT** host-side: capture it on the
`user` `AuthIdentity` as a branded `SubjectToken`, store per-run
(`runId → SubjectToken`) when the shell builds context, add
`resolveSubjectToken: (runId) => SubjectToken | undefined` to `KeycloakBrokerDeps`.
The live `exchangeV2` reads it; `ExchangeV2Request` gains a required
`subjectToken`. The framework `InvocationOrigin` stays string-only.
**Why:** ADR-0058 amendment (2026-06-12): a real V2 exchange must present the
user's actual verified JWT as `subject_token` proof; the framework port must not
depend on a host Keycloak concern, so the token can't ride the origin.
**Rejected:** proof-less "mint a token claiming this sub" (forbidden by the port
contract); putting the token on `InvocationOrigin` (leaks a host credential across
the framework seam).

### AD-7 — Close the HITL Teams-button per-team authz gap by reusing the HTTP path's check
**Status (2026-06-17): IMPLEMENTED** (commit `86f82db`, Phase 4). `messages-handler.ts`
resolves the clicker's `from.aadObjectId` via `HITL_APPROVER_TEAMS` to an approver
identity (fail-closed on unknown id) and gates on the SAME `canAccessDag`
predicate the HTTP path uses; per-team conversation routing keys on
`HITL_TEAM_CHANNELS`. The single-team-per-channel fallback below is **no longer
required**.
**Choice:** in `messages-handler.ts`, before recording a button decision, resolve
the approver's AAD identity (`from.aadObjectId` on the verified inbound activity)
to fugue team membership and authorize against the run's DAG team — the same check
`runs.ts` applies on the HTTP approve path. Pair with per-team conversation
routing (store conversation references keyed by team). **Rejected:** ship
single-channel only and document the limit (acceptable **only** if deployment is
single-team-per-channel — surfaced as an Open Decision).

---

## 7. Implementation plan — phases, files, data flow, testing

Everything fails closed today, so this is **additive wiring**. Phases are ordered
by dependency; items within a phase are parallelizable.

### Data flow (target)

**Agent-initiated (team/admin token) — Phase 1:**
```
team token → auth mw (team identity) → invocationOriginForIdentity → origin{agent, agentClientId}
  → runDag(minting) → broker.mintFor → policy gate (assignedScopes) → [assigned]
  → KeycloakTokenEndpoint.mintClientCredentials(creds.secret) → SA token
  → EntraWifExchange.exchange(SA token as client_assertion) → app-only Graph token
  → buildGraphHandle → node calls sendMail via GraphHttp.request
```

**User-initiated (OIDC JWT) — Phase 2+3:**
```
realm JWT → auth mw: createRealmJwtVerifier (signature) → validateRealmJwtClaims (iss/aud/exp)
  → authorizeUserRun(user, dagTeam) → user identity{sub, azp, subjectToken, canRunDag}
  → origin{user, sub, agentClientId=dagId} ; subjectToken stored runId→token (host side)
  → broker.mintFor → policy gate → KeycloakTokenEndpoint.exchangeV2(subjectToken) → user-preserving SA token
  → EntraWifExchange → app-only token → handle
```

### Phase 0 — Foundations (no dependencies)
- Add Entra/Keycloak env to `domain/config.ts` schema + `superRefine` pairing
  (tenant+client together; creds JSON valid).
- `createFetchHttpPost` (`HttpPost`) + tests — `adapters/fetch-http-post.ts`.
- `createFetchGraphHttp` (`GraphHttp`, bearer GET/POST) + tests — `adapters/fetch-graph-http.ts`.
- `createRealmJwtVerifier` (`VerifyRealmJwt`, JWKS via `jose`) + tests — `adapters/realm-jwt-verifier.ts`.
- `AgentClientCredentials` port + env-map adapter + tests — `adapters/agent-client-credentials.ts`.
- `.env.example`: add all HITL/Bot/Entra/Keycloak vars with comments.

### Phase 1 — Keycloak/Entra **agent path** end-to-end (depends on Phase 0)
- `createKeycloakTokenEndpoint` live impl + pure helpers + tests —
  `adapters/keycloak-token-endpoint-http.ts`. Pure helpers (mirror
  `entra-wif.ts`'s `buildWifFormBody`/`mapWifResponse` split exactly):
  `buildClientCredentialsBody(req, cred)`, `buildExchangeV2Body(req, cred)`,
  `mapKeycloakTokenResponse(audience, res)`.
- `selectCapabilityBroker`: swap the three unwired stubs for live adapters under
  AD-3 config gating (`host.ts`).
- **Outcome:** an agent-initiated run with `requires:["msgraph:mail.send"]` mints
  a real token end-to-end against a provisioned tenant. Until provisioning lands,
  integration tests use recorded-call fakes.

### Phase 1′ — HITL go-live (independent; can run in parallel)
- Provision Azure Bot + Entra app (out-of-band; set `BOT_APP_ID`/`BOT_APP_PASSWORD`,
  messaging endpoint → `POST /teams/messages`, install bot in a Teams channel).
- Smoke-test suspend → card → approve → resume. **Code is ready** — ops only.
- **Operator runbook:** [`docs/runbooks/azure-bot-hitl-provisioning.md`](runbooks/azure-bot-hitl-provisioning.md)
  — the full operator-executed procedure (Bot/Entra provisioning, host config, the
  suspend→card→approve→resume smoke test). **Live provisioning + smoke test are
  DEFERRED to the operator (Peter Hansen); tracked on GitHub issue #24 and required
  before production HITL go-live.** This is the Bot's **own** Entra app — distinct
  from the `fugue-agents` capability-broker app in Appendix A.

### Phase 2 — User inbound path (depends on Phase 0 verifier)
- Extend `RealmJwtClaims`/`AuthenticatedUser` with `teams` (AD-5); update
  `domain/jwt-validation.ts` (parse-don't-validate).
- Wire `routerDeps.realmJwt`: `verify` = `createRealmJwtVerifier`,
  `expectedIss`/`expectedAud` from config, `authorizeUserRun` = team-membership.
- **Outcome:** user JWTs accepted; DAG execution + static capabilities authorized
  per team. (Downstream user→Graph exchange still fails closed until Phase 3.)

### Phase 3 — User **downstream** exchange (depends on Phase 1 + Phase 2)
- Capture `SubjectToken` on the `user` identity (auth mw already holds the raw
  token); thread `runId→SubjectToken` host-side; add `resolveSubjectToken` to
  `KeycloakBrokerDeps`; `saDispatch` user branch passes it;
  `ExchangeV2Request.subjectToken` required.
- Implement `exchangeV2` as a real RFC 8693 token exchange (ADR-0058 amendment —
  proof-bearing; never a proof-less impersonation grant).
- **Files:** `auth.ts`, `run-context.ts`, `keycloak-broker.ts`,
  `keycloak-token-endpoint-http.ts`, `host.ts`.

### Phase 4 — Hardening (depends on Phase 1–3)
- **ADR-0056:** replace `agentClientIdForDag` identity function with a
  config-mapped dagId→real-client-id registry; re-key `AGENT_CLIENT_SCOPES` +
  `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` on real client ids.
- **HITL AD-7:** approver AAD→team authz on the Teams-button path + per-team
  conversation routing (`messages-handler.ts`, `conversation-store.ts`,
  `hitl/identity.ts`).
- **Dynamics (optional):** per-org Dataverse host from `DYNAMICS_ORG_HOST`,
  threaded through `audienceForScope` + `buildDynamicsReadHandle`.

### Phase 5 — Live verification (depends on a real tenant)
- Run spikes #1–#3 to PASS; execute the provisioning runbook (Appendix A); verify
  0 secrets / 0 certs on `fugue-agents`.
- e2e: agent run mints+sends mail; user run exchanges+reads a scoped site;
  out-of-scope denied.

### Testing strategy

| Component | Unit (pure) | Integration (I/O) | Property |
|---|---|---|---|
| `fetch-http-post` | — | transport reject → throws; status/json passthrough (fetch faked) | — |
| Keycloak endpoint helpers | `buildClientCredentialsBody`/`buildExchangeV2Body` exact body, **no extra params**; `mapKeycloakTokenResponse` status→Result | live adapter over recorded-call fake: no-egress on creds-miss; 4xx→denied | — |
| `fetch-graph-http` | — | bearer presented as `Authorization: Bearer`; status/json passthrough | — |
| `realm-jwt-verifier` | classify infra vs invalid | valid → `SignatureVerifiedClaims`; bad sig → `invalid`; JWKS down → `unavailable` | — |
| `AgentClientCredentials` | hit → cred; miss → undefined (fail-closed) | — | — |
| broker subject-token (P3) | user branch sets `subjectToken`; agent branch never does | exchangeV2 fail-closes when `resolveSubjectToken` returns undefined | — |
| `authorizeUserRun` | member → true; non-member → false | — | any user ∉ team ⇒ `canAccessDag` false |
| HITL approver authz (P4) | AAD→team map; non-member click → refused | button path refuses cross-team approval (parity with HTTP path) | — |
| `selectCapabilityBroker` | live vs stub chosen by config presence (AD-3); warns once | — | — |

**Invariants that must stay green** (existing SC tests): SC-006 no-egress-on-refusal,
SC-007 no raw token reachable from a handle, SC-008 `(identity,audience,scope)`
dedup, SC-010 per-origin exchange count, SC-011 no static Entra secret, SC-012
golden-export-tested realm policy.

### Verification checklist
1. `bun run typecheck` green across `packages/host`.
2. `bun test packages/host` — all suites incl. the six SC-invariant tests pass.
3. `.claude/linter` passes (no bare throw, no catch-ignore, no `as any`, no raw-string-ids).
4. Boot with: (a) no realm config → static path byte-identical; (b)
   `REALM_JWT_ISSUER` only → broker warns "verifier not wired"; (c) full
   Entra+Keycloak config → live broker, no warn.
5. Phase 1/5 manual: agent run sends mail via a minted scoped handle; out-of-scope
   `requires` refused with zero egress (check audit log).
6. Phase 1′ manual: suspend a HITL DAG, approve the Teams card in-channel, confirm resume.
7. Phase 3 manual: user run reads a `Sites.Selected` site it's entitled to; a
   non-entitled site returns `downstream-denied`.

---

## 8. Open decisions — RESOLVED 2026-06-16 (before building)

All five were resolved before the Phase 0–4 wiring landed; recorded here for
provenance:

1. **`authorizeUserRun` source (AD-5):** RESOLVED → stateless `teams` claim on the
   verified realm JWT (`(u, dagTeam) => u.teams.includes(dagTeam)`). No Redis
   grant store. (ADR-0062/0063.)
2. **HITL Teams-button authz (AD-7):** RESOLVED → build approver-AAD→team authz +
   per-team routing in Phase 4 (`HITL_APPROVER_TEAMS` / `HITL_TEAM_CHANNELS`). The
   single-team-per-channel fallback was NOT taken.
3. **Dynamics/Dataverse:** RESOLVED → Graph-only (`msgraph:mail.send` /
   `msgraph:sites.read`) for v1; the Dynamics leg is wired but stays config-gated
   (`DYNAMICS_ORG_HOST`) and unassigned until needed.
4. **Agent-client secrets (AD-1):** RESOLVED → env-map JSON
   (`KEYCLOAK_AGENT_CLIENT_CREDENTIALS`) for v1, behind the `AgentClientCredentials`
   port so a Vault/Key Vault adapter can replace it with no broker change.
5. **Sequencing:** RESOLVED → all phases (0–4) landed together on
   `feat/keycloak-entra-wiring`; HITL go-live and the Entra bridge are now both
   gated only on operator provisioning (Phase 5).

---

## Appendix A — `fugue-agents` Entra provisioning runbook

The **human-executed** half of the Entra bridge (Phase 5 / wave 4). The
config-as-code side (the `fugue-platform` realm package — `entra-exchange` scope,
agent service-account clients, optional-scope mirror) and the host broker
(`entra-wif`/`keycloak-broker`) already exist and are golden-/unit-tested. What
does **not** exist until an operator runs these steps is the Azure-portal
provisioning of `fugue-agents`, its FICs, and its resource-scoping policies.

Per FR-W4-006, every step has an **explicit, checkable acceptance** verified
*before moving on*. Several are security-load-bearing (the FIC case-match, the
no-secret invariant, the resource-scoping denial). A failed acceptance is a hard
stop.

### A.0 Gating preconditions — the four spikes

This runbook is **gated by the wave-4 spikes** (Appendix B). Each spike's outcome
must be a recorded **PASS** (with observed token/log evidence) before the gated
step runs against a real tenant.

| Spike | Gates | Required outcome |
|---|---|---|
| #1 FIC sign-in attribution | Step 3 (variant A), Step 6 (attribution) | PASS — sign-in log names the matched FIC (`federatedCredentialId`) |
| #2 sub-claim × FIC matching | Step 3 (subject/issuer/aud exact match + case-sensitivity) | PASS — minted `sub` matches FIC verbatim; case-flip fails `AADSTS70021` |
| #3 resource-scoping coverage | Step 4 (`Sites.Selected` + Exchange policy coverage AND denial) | PASS — in-scope granted, out-of-scope denied |
| #4 identity-chaining e2e | the user-initiated chain feeding the WIF assertion | PASS/PARTIAL — chain composes, `aud: api://AzureADTokenExchange` pinned |

> **Status (2026-06-10):** all four spikes are `PENDING-LIVE-VERIFICATION` (no
> Entra tenant + no live `fugue-platform` realm reachable at authoring time). **Do
> not execute against a production tenant until spikes #1–#3 PASS.**

### A.1 Register `fugue-agents` with the union of application permissions (FR-W4-001 / AD-3)
1. Entra admin center → App registrations → New registration. Name `fugue-agents`.
   **Single tenant**, no redirect URI (never does interactive auth). Register.
2. Record **Application (client) ID** + **Directory (tenant) ID** → feed the
   host's `entra-wif` config.
3. API permissions → add the **union of *application* (app-only) permissions**,
   derived from the assigned Keycloak optional scopes:

   | Keycloak optional scope | Entra application permission | API | Used by |
   |---|---|---|---|
   | `msgraph:mail.send` | `Mail.Send` | Graph | `fugue-agent-mail` |
   | `msgraph:sites.read` | `Sites.Selected` (never `Sites.Read.All`) | Graph | `fugue-agent-sites` |
   | `dynamics:read` | Dataverse application user + read security role | Dynamics 365 | unassigned (host path unwired) |

   > Dynamics has no classic Graph `*.All` app permission; app-only access = register
   > `fugue-agents` as a **Dataverse application user** with a read-scoped security role.

**Acceptance:** exactly one app `fugue-agents` (no per-agent app — `fugue-agent-*`
exist only as *Keycloak* clients); permission list is **exactly the union** (no
broader sibling, no extra); all are **Application** (app-only), not Delegated.

### A.2 Grant admin consent once (FR-W4-001)
App → API permissions → Grant admin consent → confirm each row **Granted for
`<tenant>`**. For Dynamics, confirm the application user's security role is
assigned in the target environment (Graph consent doesn't cover the Dataverse
role).
**Acceptance:** every union permission Granted; consent recorded **once** at app
level; no per-agent consent, no runtime consent prompt possible on the app-only path.

### A.3 Add Federated Identity Credentials — Variant A (FR-W4-002 / AD-4)
For each agent-type client (`fugue-agent-mail`, then `fugue-agent-sites`):
1. App → Certificates & secrets → Federated credentials → Add → **Other issuer**.
2. Set the three match fields, **copy-pasted verbatim** (Entra matches exactly,
   case-sensitively):
   - **Issuer** = `https://<kc-host>/realms/fugue-platform` (no trailing slash).
   - **Subject** = the client's service-account `sub` (e.g.
     `service-account-fugue-agent-mail` if the predictable-`sub` mapper is in use
     per spike #2 PASS; else the UUID read after `ClientStep`).
   - **Audience** = `api://AzureADTokenExchange`.
   - **Name** = `fugue-agent-mail-fic` / `fugue-agent-sites-fic`.
3. Record each FIC's name + credential object id (for Step 6).

**Acceptance:** exactly **two** FICs (under the 20-cap), no FIC for any other
issuer; **positive** — minting an `entra-exchange`-scoped assertion and exchanging
it at `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`
(`grant_type=client_credentials`, `client_assertion_type=...:jwt-bearer`,
`scope=https://graph.microsoft.com/.default`) returns 200 with an app-only token
(both agents); issuer/subject/audience match byte-for-byte (`aud` is the string,
not an array); **negative (mandatory)** — flip one char's case in a FIC subject,
re-exchange, confirm `AADSTS70021`, then revert.

### A.4 Resource-scoping policies (FR-W4-005 / AD-3)
The app-only `.default` token carries the full union every call and **cannot be
downscoped per request** — these two mechanisms are the *only* Entra-side
containment. Spike #3 must prove both **coverage** and **denial**.

**4a — `Sites.Selected` per-site grant (sites-agent):** with a Graph admin token,
`POST /sites/{IN_SCOPE_SITE_ID}/permissions` `{ "roles":["read"],
"grantedToIdentities":[{"application":{"id":"<fugue-agents app id>","displayName":"fugue-agents"}}] }`
— only the specific site(s), not tenant-wide. **Acceptance:** positive —
`GET /sites/{IN_SCOPE}/drive/root/children` → 200; negative — out-of-scope site →
403 `accessDenied`.

**4b — Exchange application access policy (mail-agent):** in Exchange Online
PowerShell, `New-ApplicationAccessPolicy -AppId <id> -PolicyScopeGroupId
leaddesk-scope@<tenant> -AccessRight RestrictAccess`; verify with
`Test-ApplicationAccessPolicy` (Granted for lead-desk, Denied for a control
mailbox; allow ~30 min propagation). **Acceptance:** positive —
`POST /users/leaddesk@<tenant>/sendMail` → 202 and message lands; negative —
control mailbox → 403 `ErrorAccessDenied`/`ApplicationAccessPolicy`. (Dynamics:
the Dataverse role permits only the needed read surface.)

> A green positive path alone does **not** satisfy this step — the value is what
> these policies *deny*. Both coverage and containment must pass.

### A.5 Confirm zero stored secret/certificate (FR-W4-004 / SC-011)
App → Certificates & secrets: **Client secrets** empty, **Certificates** empty,
**Federated credentials** = only the two FICs. The host's `entra-wif` config
references no Entra secret/cert (only app/tenant IDs + the Keycloak assertion as
`client_assertion`). **Acceptance:** 0 secrets, 0 certs; WIF is the only
credential. Any secret/cert present is a hard stop.

### A.6 Sign-in attribution check (spike #1)
Run a real federated exchange as `fugue-agent-mail`, note UTC time (allow ~15 min),
then read service-principal sign-in logs:
```sh
curl -s -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
  "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '<fugue-agents app id>' and signInEventTypes/any(t: t eq 'servicePrincipal')&\$top=20" \
  | jq '.value[] | {createdDateTime, appId, servicePrincipalId, federatedCredentialId, tokenIssuerName, status}'
```
**Acceptance:** an entry shows `federatedCredentialId` resolving to
`fugue-agent-mail-fic`; a second run as `fugue-agent-sites` is distinguishable
(resolves to `fugue-agent-sites-fic`). If spike #1 is PARTIAL (no
`federatedCredentialId`), record the actual discriminating field and note that
host-side `traceparent` attribution carries the remaining weight.

### A.7 Whole-runbook acceptance
- [ ] Steps 1–2: one app, union exactly, admin-consented once, no per-agent app.
- [ ] Step 3: two FICs, byte-for-byte match, positive exchange 200, case-mismatch → `AADSTS70021`.
- [ ] Step 4: in-scope act succeeds; out-of-scope site (403) + control mailbox (403) denied.
- [ ] Step 5: zero secrets, zero certificates.
- [ ] Step 6: sign-in log attributes to the correct FIC.
- [ ] All four spikes PASS (or PARTIAL with fallback noted) before gated steps trusted.

### A.8 Keycloak side the operator must match against
Lives in the `fugue-platform` realm package
(`~/dev/java/keycloakConfigAsCode`, golden-tested):
- The realm mints the federation assertion's audience via the **`entra-exchange`**
  optional client scope — a hardcoded-audience protocol mapper stamping
  `aud: api://AzureADTokenExchange` on the **access token only**, exactly one
  mapper (FR-W4-003). Every FIC's `audience` must equal this.
- Agent-type clients **`fugue-agent-mail`** / **`fugue-agent-sites`** are
  confidential service-account (client-credentials only; ROPC/standard-flow
  disabled), each carrying the optional scope mapping to its Entra permission.
  Assigning the scope in `ClientStep` **is** the policy grant (AD-5); the broker
  fails closed at the Keycloak hop with zero Entra egress if unassigned.
- Realm issuer URL `https://<kc-host>/realms/fugue-platform` — the exact string
  each FIC's `issuer` must equal.
- **Golden-test confirmation:** `FuguePlatformRealmGoldenTest.java` already
  asserts both client types present (`bothClientTypesPresent()`, SC-012) and the
  `entra-exchange` scope mints exactly `aud: api://AzureADTokenExchange`,
  access-token-only, single mapper (FR-W4-003), optional-never-default.

---

## Appendix B — verification spikes

Located in `docs/spikes/`. Run waves 3–4 only after these PASS:

1. **FIC sign-in attribution** (`2026-06-10-spike-1-fic-signin-attribution.md`) —
   confirm Entra sign-in logs surface *which* FIC matched (decides variant A's
   forensic value over B).
2. **Sub-claim mapper × FIC matching** (`spike-2-subclaim-fic-matching.md`) —
   Keycloak's sub mapper producing `service-account-<client_id>` must survive
   Entra's case-sensitive issuer/subject/audience match (negative control: a
   case-flip fails `AADSTS70021`).
3. **Resource-scoping coverage** (`spike-3-resource-scoping-coverage.md`) —
   `Sites.Selected` + Exchange application access policies must **cover** the
   needed Graph surfaces **and deny** everything else.
4. **Identity-chaining end-to-end on 26.6** (`spike-4-identity-chaining-e2e.md`) —
   the constituent features are individually supported; the composed
   user-initiated flow needs a spike before prod, with `aud:
   api://AzureADTokenExchange` pinned.

---

## Appendix C — cross-side constants & references

### Cross-side constants (the Keycloak and Entra sides must agree byte-for-byte)

| Constant | Value | Source of truth |
|---|---|---|
| Entra app | `fugue-agents` (one app; the deployed host process is the trust boundary) | AD-3 / FR-W4-001 |
| Federation audience | `api://AzureADTokenExchange` | minted by the `entra-exchange` Keycloak scope; every FIC's `audience` |
| Issuer | `https://<kc-host>/realms/fugue-platform` (no trailing slash) | the `fugue-platform` realm; every FIC's `issuer` |
| Agent-type clients | `fugue-agent-mail`, `fugue-agent-sites` | `fugue-platform` `ClientStep` (one FIC each, variant A) |
| FIC `subject` | the agent client's service-account `sub` (`service-account-<client_id>` per spike #2, or read-then-pinned) | Keycloak-minted assertion `sub` |

### Config / environment variables

Existing (in schema): `REALM_JWT_ISSUER`, `REALM_JWT_AUDIENCE`, `ADMIN_TOKEN`,
`BOT_APP_ID`, `BOT_APP_PASSWORD`, LLM provider keys.

To add (Phase 0/4): `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `KEYCLOAK_TOKEN_URL?`
(derived from `REALM_JWT_ISSUER` or explicit), `KEYCLOAK_AGENT_CLIENT_CREDENTIALS`
(JSON `{ clientId: clientSecret }` — sensitive, never log), and Phase 4
`AGENT_CLIENT_MAP`, `DYNAMICS_ORG_HOST?`.

### ADRs (the "why" — kept as immutable decision history)

- **0051** extensible capability registry · **0052** document source capability ·
  **0053** per-invocation capability axis
- **0054** capability broker port + pass-through default
- **0055** one Entra app per trust boundary
- **0056** FIC variant A per agent-type client
- **0057** Keycloak optional scopes mirror permissions
- **0058** two/three-path inbound host auth (+ 2026-06-12 subject-token amendment)
- **0059** capability failure taxonomy · **0060** HITL suspend/resume primitive
- **0061** per-team DAG image scoping (amends **0041** separate DAGs repo → depth-agnostic discovery)
- **0062** team modeling via realm roles (role name == team name; emit all realm roles as the access-token-only `teams` claim)
- **0063** `teams` claim defensive parse in the pure host validator (hand-rolled, no Zod; fail-closed on malformed)

### External references

- [Keycloak token exchange](https://www.keycloak.org/securing-apps/token-exchange) ·
  [identity & authorization chaining](https://www.keycloak.org/securing-apps/oauth-identity-authorization-chaining-across-domains)
- [Entra workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) ·
  [client credentials with a federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential)
- [Sites.Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) ·
  [Exchange application access policies](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
- Code seams: `packages/host/src/domain/auth.ts`,
  `packages/host/src/ports.ts` (`SharedInfra`),
  `packages/host/src/domain/capability-manager.ts` (`extractClients`),
  `packages/host/src/adapters/node-context-factory.ts` (`createNodeContextForDag`),
  `packages/framework/src/types/llm.ts` (`LlmResponse.tokensIn/tokensOut`)
- BFF/dashboard (non-security): `docs/plans/2026-06-09-lead-desk-bff-dashboard.md`
- HITL Teams go-live (Phase 1′) operator runbook: [`docs/runbooks/azure-bot-hitl-provisioning.md`](runbooks/azure-bot-hitl-provisioning.md)
</content>
</invoke>
