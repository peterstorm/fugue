# Runbook — `fugue-agents` Entra app provisioning (Workload Identity Federation bridge)

> **Date:** 2026-06-10 · **Phase:** 5 (wave 4) · **Owner:** platform/security operator ·
> **Spec anchors:** US7, US8, FR-W4-001..006, SC-011, SC-012 ·
> **Plan:** [identity-scoped-capabilities](../../.claude/plans/2026-06-10-identity-scoped-capabilities.md)
> (AD-3 one-app-per-trust-boundary, AD-4 FIC variant A, AD-5 scope-mirror) ·
> **Design ADRs cited inline.**

This is the **human-executed** half of the Entra bridge. The config-as-code side
(the `fugue-platform` Keycloak realm package — the `entra-exchange` audience
scope, the agent service-account clients, the optional-scope policy mirror) and
the host broker (`entra-wif` / `keycloak-broker`) already exist and are
golden-/unit-tested. What does **not** exist until an operator runs the steps
below is the Azure-portal provisioning of the `fugue-agents` app registration,
its federated identity credentials, and the resource-scoping policies that bound
its union-permission token.

Per **FR-W4-006**, every step here is a runbook/operational requirement with an
**explicit, checkable acceptance** the operator verifies *before moving on*. Do
not skip a step's acceptance: several steps are security-load-bearing (the FIC
case-match, the no-secret invariant, the resource-scoping denial). Treat a failed
acceptance as a hard stop, not a warning.

---

## 0. Gating preconditions — the four spikes

This runbook is **gated by the wave-4 verification spikes**. Each spike below
gates one or more steps; its outcome must be a recorded **PASS** (with observed
token/log evidence) before the gated step is executed against a real tenant.

| Spike | File | Gates | Required outcome |
|---|---|---|---|
| #1 — FIC sign-in attribution | [`spike-1`](../spikes/2026-06-10-spike-1-fic-signin-attribution.md) | Step 3 (variant A choice), Step 6 (attribution check) | PASS — sign-in log names the matched FIC (`federatedCredentialId`) |
| #2 — sub-claim × FIC matching | [`spike-2`](../spikes/2026-06-10-spike-2-subclaim-fic-matching.md) | Step 3 (FIC subject/issuer/aud exact match + case-sensitivity negative control) | PASS — minted `sub` matches FIC verbatim; case-flip fails with `AADSTS700213` |
| #3 — resource-scoping coverage | [`spike-3`](../spikes/2026-06-10-spike-3-resource-scoping-coverage.md) | Step 4 (`Sites.Selected` + Exchange app access policy coverage AND denial) | PASS — in-scope site/mailbox granted, out-of-scope denied |
| #4 — identity-chaining e2e | [`spike-4`](../spikes/2026-06-10-spike-4-identity-chaining-e2e.md) | the user-initiated chain feeding the WIF assertion (H1–H4) | PASS / PARTIAL (Keycloak segment) — chain composes, `aud: api://AzureADTokenExchange` pinned |

> **Status note (2026-06-10):** all four spikes are currently recorded as
> `PENDING-LIVE-VERIFICATION` — no Entra tenant + no live `fugue-platform`
> Keycloak realm was reachable from the authoring environment. **This runbook
> must not be executed against a production tenant until spikes #1–#3 are run to
> PASS** (spike #4 gates the wave-3 *user-initiated* path, not the app
> provisioning itself, but its `aud` pinning is what makes Step 5's no-secret
> story safe). Where a step's acceptance depends on a spike result, the step
> says so explicitly. Run the spikes first; they are ready-to-run as written.

### Cross-side constants (the two sides must agree byte-for-byte)

| Constant | Value | Source of truth |
|---|---|---|
| Entra app | `fugue-agents` (one app — the deployed host process is the trust boundary) | this runbook (AD-3 / FR-W4-001) |
| Federation audience | `api://AzureADTokenExchange` | minted by the `entra-exchange` Keycloak scope (FR-W4-003); written into every FIC's `audience` |
| Issuer | `https://<kc-host>/realms/fugue-platform` (the `fugue-platform` realm issuer URL — exact scheme/host/port, no trailing slash) | the `fugue-platform` realm; written into every FIC's `issuer` |
| Agent-type clients | `fugue-agent-mail`, `fugue-agent-sites` | `fugue-platform` realm `ClientStep` (one FIC each, variant A) |
| FIC `subject` | the agent client's service-account `sub`, exactly as minted (predictable `service-account-<client_id>` per spike #2, or read-then-pinned if spike #2 records PARTIAL) | Keycloak-minted assertion `sub` (spike #2 step 2 captures it verbatim) |

> **Why the audience can't be replayed internally:** the `entra-exchange` scope
> mints `aud: api://AzureADTokenExchange` and *only* that audience (the golden
> test pins exactly one audience mapper, access-token-only — see Deliverable 2
> confirmation in the closing note). An internal `fugue-host` resource server
> rejects that token on audience mismatch. The WIF assertion is therefore
> single-purpose: usable only at Entra's token-exchange endpoint.

---

## Step 1 — Register the `fugue-agents` app with the union of application permissions

**Why:** **FR-W4-001 / AD-3.** One app registration per trust boundary (the
deployed host process), **not** per agent. A host compromise yields every
federation path regardless of app count, so per-agent apps add admin-consent
ceremony without buying containment. Per-agent least privilege is enforced
*before* Entra (Keycloak optional scopes, AD-5 / FR-W3-001); the union is bounded
*at* Entra by Step 4's resource-scoping policies.

**What:**

1. Entra admin center → **App registrations** → **New registration**. Name:
   `fugue-agents`. Supported account types: **single tenant** (accounts in this
   organizational directory only). No redirect URI (this app never does
   interactive auth). Register.
2. Record the **Application (client) ID** and **Directory (tenant) ID** — these
   feed the host's `entra-wif` config (`client_id`, tenant token endpoint).
3. **API permissions** → add the **union** of *application* (app-only, not
   delegated) permissions the current agents need, derived from the assigned
   Keycloak optional scopes in the `fugue-platform` `ClientStep`:

   | Keycloak optional scope (agent grant) | Entra **application** permission | API | Used by |
   |---|---|---|---|
   | `msgraph:mail.send` | **`Mail.Send`** | Microsoft Graph | `fugue-agent-mail` |
   | `msgraph:sites.read` | **`Sites.Selected`** | Microsoft Graph | `fugue-agent-sites` |
   | `dynamics:read` | **Dynamics 365 app permission** — `Dynamics CRM` → `user_impersonation` is delegated; for app-only use the **`https://<org>.crm.dynamics.com/.default`** app role / **`Dataverse` application user** grant (the app-only Dynamics access, see Step 1 note below) | Dynamics 365 / Dataverse | the dynamics-read agent |

   > **Dynamics note:** Dynamics 365 / Dataverse does not expose a classic Graph
   > `*.All` application permission; app-only access is granted by registering
   > `fugue-agents` as a **Dataverse application user** with a security role
   > scoped to read. Add the Dynamics API to the app's permissions and create the
   > application user in the target environment. This is the `dynamics:read`
   > union member; it is bounded at the Dataverse side by the assigned security
   > role (the Dynamics analogue of Step 4's resource scoping).

4. Use **`Sites.Selected`** for SharePoint, **never** `Sites.Read.All` /
   `Sites.ReadWrite.All` — `Sites.Selected` grants *no* site access by itself and
   is the precondition for Step 4's per-site grant (spike #3 Part A).

**Acceptance (check before Step 2):**
- [ ] Exactly **one** app registration named `fugue-agents` exists; **no
  per-agent app** (`fugue-agent-mail`/`fugue-agent-sites` exist only as *Keycloak*
  clients, not Entra app registrations).
- [ ] The app's application-permission list is **exactly the union**:
  `Mail.Send`, `Sites.Selected`, and the Dynamics/Dataverse read grant — no
  broader sibling (`Sites.Read.All`, `Mail.ReadWrite`, tenant-wide Dynamics) and
  no extra permission beyond what an assigned Keycloak scope maps to.
- [ ] All three are **Application** permissions (app-only), **not Delegated**
  (app-only is the accepted residual per spec Out-of-Scope; delegated is not used
  on this path).

---

## Step 2 — Grant admin consent once for the union

**Why:** **FR-W4-001.** The union is consented **once**, by an admin, so no
per-request / per-agent consent prompt ever occurs at mint time. App-only
permissions require tenant-admin consent to take effect at all.

**What:**
1. App registration → **API permissions** → **Grant admin consent for
   `<tenant>`**.
2. Confirm each permission row shows **Status: Granted for `<tenant>`** with a
   green check.
3. For the Dynamics/Dataverse app-user grant, confirm the application user's
   security role is assigned in the target environment (consent for Graph
   permissions does not cover the Dataverse role assignment — verify both).

**Acceptance (check before Step 3):**
- [ ] Every union permission (`Mail.Send`, `Sites.Selected`, Dynamics read) shows
  **Granted for `<tenant>`**; zero permissions in a "Not granted" state.
- [ ] Admin consent is recorded **once** at the app level; there is no
  per-agent-client consent grant and no runtime consent prompt is possible on the
  app-only path.

---

## Step 3 — Add Federated Identity Credentials (Variant A — one FIC per agent-type Keycloak client)

**Why:** **FR-W4-002 / AD-4.** Variant A trusts the `fugue-platform` realm as an
external OIDC issuer and adds **one FIC per agent-type Keycloak client**
(`fugue-agent-mail`, `fugue-agent-sites`), well under Entra's **20-FIC/app cap**.
Per **spike #1**, variant A buys per-agent-type forensic attribution at Entra's
sign-in-log level for free (the matched FIC is named in the log — see Step 6).
Per **spike #2**, the predictable `service-account-<client_id>` `sub` lets FIC
subjects be written as config-as-code, ahead of client creation, with no
read-then-pin — *provided spike #2 recorded PASS*; if it recorded PARTIAL,
read-then-pin the `sub` after the Keycloak client is created.

**What — for each agent-type client (`fugue-agent-mail`, then `fugue-agent-sites`):**

1. App registration → **Certificates & secrets** → **Federated credentials** →
   **Add credential** → **Other issuer** (flexible FIC).
2. Set the three match fields, copy-pasted verbatim from the Keycloak side (do
   **not** retype — Entra matches **exactly and case-sensitively**):
   - **Issuer** = `https://<kc-host>/realms/fugue-platform` (exact scheme, host,
     port; **no trailing slash** — see the broker-port note in the framework
     docs). Identical for both FICs.
   - **Subject identifier** = that client's service-account `sub`, captured
     verbatim from a real minted assertion (spike #2 step 2 prints it). For
     `fugue-agent-mail` this is `service-account-fugue-agent-mail` if the
     predictable-`sub` mapper is in use (spike #2 PASS); otherwise the UUID
     read after `ClientStep` creation (spike #2 PARTIAL fallback).
   - **Audience** = `api://AzureADTokenExchange` (exact — minted by the
     `entra-exchange` Keycloak scope, FR-W4-003).
   - **Name** = `fugue-agent-mail-fic` / `fugue-agent-sites-fic` (so the sign-in
     log and `GET /applications/{id}/federatedIdentityCredentials` are legible).
3. Record each FIC's **name** and **credential object id** for the Step 6
   attribution cross-reference.

**Acceptance (check before Step 4):**
- [ ] **Exactly two** FICs exist on `fugue-agents` (one per agent-type client),
  under the 20-FIC cap; no FIC for any other issuer/app.
- [ ] **Positive match:** minting an `entra-exchange`-scoped assertion as
  `fugue-agent-mail` and exchanging it at
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`
  (`grant_type=client_credentials`, `client_assertion_type=...:jwt-bearer`,
  `scope=https://graph.microsoft.com/.default`) returns **HTTP 200** with an
  app-only Graph token. Repeat for `fugue-agent-sites`. **(Gated on spike #2
  PASS.)**
- [ ] Each FIC's `issuer` / `subject` / `audience` matches the Keycloak-minted
  assertion's `iss` / `sub` / `aud` **byte-for-byte** (cross-reference spike #2's
  captured strings — `aud` is the string `api://AzureADTokenExchange`, not an
  array).
- [ ] **Negative (case-sensitivity) check — mandatory:** temporarily flip one
  character's case in a FIC `subject` (e.g.
  `service-account-fugue-agent-Mail`), re-exchange, and confirm it now **fails**
  with **`AADSTS700213`** ("No matching federated identity record found"). Revert
  the FIC. This proves the match is genuinely case-sensitive and the positive
  pass above was not coincidental (spike #2 step 5).

---

## Step 4 — Resource-scoping policies bounding where the union token can act

**Why:** **FR-W4-005 / AD-3.** The app-only `.default` token carries the full
union on every call and **cannot be downscoped per request**. The *only*
Entra-side containment is two resource-scoping mechanisms; without them the
one-app blast-radius bound the whole AD-3 decision depends on is illusory.
**Spike #3** is the linchpin: it proves both mechanisms **cover** the surfaces the
agents need **and deny** everything else — both directions are mandatory.

### 4a — `Sites.Selected` per-site grant (the sites-agent)

**What:**
1. With a Graph admin token, grant the in-scope SharePoint site(s) to the
   `fugue-agents` app identity:
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{IN_SCOPE_SITE_ID}/permissions
   { "roles": ["read"],
     "grantedToIdentities": [
       { "application": { "id": "<fugue-agents app id>", "displayName": "fugue-agents" } } ] }
   ```
   Use `read` (the sites-agent's `msgraph:sites.read` capability); escalate to
   `write`/`fullControl` only if a specific agent operation requires it (spike #3
   records which role each exercised surface needs).
2. Do this **only** for the specific site(s) the sites-agent operates on — not
   tenant-wide.

**Acceptance:**
- [ ] **Positive:** the app-only token can list/read the granted site's document
  library (`GET /sites/{IN_SCOPE_SITE_ID}/drive/root/children` → 200). *(spike #3
  Part A step 2.)*
- [ ] **Negative:** the same token against an **out-of-scope** site returns
  **403 `accessDenied`** — proving `Sites.Selected` is not silently behaving like
  `Sites.Read.All`. *(spike #3 Part A step 3 — mandatory containment check.)*

### 4b — Exchange application access policy (the mail-agent)

**What:**
1. In Exchange Online PowerShell, scope `fugue-agents`' `Mail.Send` to a
   mail-enabled security group containing **only** the lead-desk shared mailbox:
   ```powershell
   New-ApplicationAccessPolicy -AppId <fugue-agents app id> `
     -PolicyScopeGroupId leaddesk-scope@<tenant> `
     -AccessRight RestrictAccess `
     -Description "fugue-agents: lead-desk mailbox only"
   ```
2. `Test-ApplicationAccessPolicy -Identity leaddesk@<tenant> -AppId <fugue-agents app id>`
   → expect `Granted`; run the same `Test-` against a control mailbox → expect
   `Denied`. Allow up to ~30 min propagation before trusting a negative result
   (spike #3 step 7).

**Acceptance:**
- [ ] **Positive:** the app-only token can `POST /users/leaddesk@<tenant>/sendMail`
  → **202 Accepted**, and the message lands. *(spike #3 Part B step 5.)*
- [ ] **Negative:** the same token, `sendMail` from a **control mailbox**, returns
  **403 `ErrorAccessDenied` / `ApplicationAccessPolicy`**. *(spike #3 Part B step
  6 — mandatory containment check.)*
- [ ] (Dynamics) the Dataverse application user's security role permits the
  read surface the dynamics agent needs and denies write/other-table access.

> A green positive path alone does **not** satisfy this step — the entire value
> of these policies is what they *deny*. Both the coverage and the containment
> acceptance must pass (spike #3 PASS requires both).

---

## Step 5 — Confirm zero stored secret or certificate (WIF is the only credential)

**Why:** **FR-W4-004 / SC-011.** The federation path presents the Keycloak
service-account token as `client_assertion`; there must be **zero** client secret
or certificate on `fugue-agents`. A stored secret would be a long-lived
exfiltratable credential and would defeat the WIF design — SC-011 requires **0
static Entra secrets/certificates anywhere on the Entra-backed capability path.**

**What:**
1. App registration → **Certificates & secrets**:
   - **Client secrets** tab — confirm the list is **empty**.
   - **Certificates** tab — confirm the list is **empty**.
   - **Federated credentials** tab — confirm it holds **only** the two FICs from
     Step 3.
2. Confirm the host's `entra-wif` config references **no** Entra secret/cert (it
   carries only the app/tenant IDs and the Keycloak-minted assertion as
   `client_assertion`).

**Acceptance:**
- [ ] `fugue-agents` has **0 client secrets** and **0 certificates**.
- [ ] The **only** credential on the app is **Workload Identity Federation** (the
  two FICs). Any secret/cert present is a hard stop — delete it and re-verify.

---

## Step 6 — Sign-in attribution check (which FIC matched)

**Why:** **US6-adjacent / spike #1.** Variant A's per-agent-type forensic value
(AD-4) rests on Entra's sign-in log surfacing *which* federated credential
matched. This step confirms that promise on the real tenant and closes the spike
#1 gate with observed evidence.

**What:**
1. Run a real federated exchange as `fugue-agent-mail` (Step 3 positive path),
   note the wall-clock time (UTC). Allow up to ~15 min for service-principal
   sign-ins to appear.
2. Read the service-principal sign-in logs for the app:
   ```sh
   curl -s -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
     "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '<fugue-agents app id>' and signInEventTypes/any(t: t eq 'servicePrincipal')&\$top=20" \
     | jq '.value[] | {createdDateTime, appId, servicePrincipalId, federatedCredentialId, tokenIssuerName, tokenIssuerType, status}'
   ```
   Primary attribution field: **`federatedCredentialId`** (the GUID of the matched
   FIC). Also check the portal view (Sign-in logs → Service Principal Sign-ins →
   entry → Federated Credential / Authentication Details) and the `beta` Graph if
   v1.0 omits the field.

**Acceptance:**
- [ ] A sign-in entry for the test run shows `federatedCredentialId` (or an
  equivalent named field) that **resolves back to `fugue-agent-mail-fic`** — the
  recorded credential object id from Step 3.
- [ ] A second run as `fugue-agent-sites` produces a **distinguishable** entry
  resolving to `fugue-agent-sites-fic` (the two agent types are separable in the
  log — the variant-A forensic payoff). *(Gated on spike #1 PASS; if spike #1
  recorded PARTIAL — distinguishable only by inbound `sub`/issuer, no
  `federatedCredentialId` — record the actual discriminating field here and note
  that host-side `traceparent` attribution carries the remaining weight.)*

---

## Post-provisioning verification (whole-runbook acceptance)

Before declaring `fugue-agents` provisioned, confirm all of:

- [ ] **Step 1–2:** one app, union permissions exactly (`Mail.Send`,
  `Sites.Selected`, Dynamics read), admin-consented once. No per-agent app.
- [ ] **Step 3:** exactly two FICs (variant A), each matching issuer/subject/
  audience byte-for-byte; positive exchange returns app-only tokens; the
  case-mismatch negative check fails with `AADSTS700213`.
- [ ] **Step 4:** in-scope site/mailbox act successfully; out-of-scope site
  (403 `accessDenied`) and control mailbox (403 `ErrorAccessDenied`) are denied.
- [ ] **Step 5:** zero secrets, zero certificates — WIF is the only credential.
- [ ] **Step 6:** sign-in log attributes the run to the correct FIC.
- [ ] All four spikes (#1–#4) recorded PASS (or documented PARTIAL with the
  fallback noted) before the gated steps were trusted.

---

## Appendix — Keycloak side the operator must match against

The two sides must agree; these are the facts the runbook cross-references (they
live in the `fugue-platform` realm package in
`/Users/hansen142/dev/java/keycloakConfigAsCode`, golden-tested):

- The realm mints the federation assertion's audience via the **`entra-exchange`**
  optional client scope, a hardcoded-audience protocol mapper stamping
  `aud: api://AzureADTokenExchange` **on the access token only**, exactly one
  mapper (FR-W4-003). This is what every FIC's `audience` field must equal.
- The agent-type clients are **`fugue-agent-mail`** and **`fugue-agent-sites`**,
  confidential service-account (client-credentials only, ROPC/standard-flow
  disabled), each carrying the optional scope(s) that map to its Entra permission
  (`msgraph:mail.send` → `Mail.Send`; `msgraph:sites.read` → `Sites.Selected`).
  Assigning the scope in the Keycloak `ClientStep` **is** the policy grant
  (AD-5); the broker fails closed at the Keycloak hop with zero Entra egress if a
  scope is unassigned.
- The realm issuer URL is `https://<kc-host>/realms/fugue-platform` — the exact
  string each FIC's `issuer` must equal.

> **Golden-test confirmation (Deliverable 2, static inspection only — no Maven
> run):** the `fugue-platform` golden test
> (`FuguePlatformRealmGoldenTest.java`) **already** asserts both sides this
> runbook depends on: (a) **both client types present** via
> `bothClientTypesPresent()` (frontend SSO + agent service-account, with the
> agent client-id roster pinned by set-equality) — **SC-012**; and (b) the
> **`entra-exchange` scope mints exactly `aud: api://AzureADTokenExchange`,
> access-token-only, single mapper** via
> `entraExchangeScopeMintsExactWifAudienceAccessTokenOnly()` (exact custom
> audience asserted, `idTokenClaim` false, `protocolMappers.size() == 1`, and
> `included.client.audience` asserted absent) plus
> `entraExchangeIsOptionalNeverDefault()` — **FR-W4-003**. No gap; nothing to add.
