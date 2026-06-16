# Runbook — `fugue-agents` Entra provisioning + Keycloak↔Entra live verification (Phase 5 / T9)

**Status:** authoring complete; **live spikes + provisioning + e2e DEFERRED to operator** (see [STATUS / HANDOFF](#status--handoff)). At authoring time all four verification spikes are `PENDING-LIVE-VERIFICATION` (no Entra tenant + no live `fugue-platform` realm reachable). **Do NOT mark anything PASS by reading this file — T9 is complete only when the [Evidence capture template](#7-evidence-capture-template) is filled with observed PASS/PARTIAL evidence.**
**Owner of the live steps:** operator (Peter Hansen, hello@dotslash.dev).
**Scope:** the operator-executed half of **Phase 5 — Live verification + ADRs** in [`docs/team-security-and-capabilities.md` §7](../team-security-and-capabilities.md) and the spec's **US6** (`.claude/specs/2026-06-16-keycloak-entra-wiring/spec.md`). This is an **OPS task** — Azure/Entra/Exchange/Dataverse provisioning + live verification against the running host. No code change is required.

> **What this runbook is NOT.** It is *not* the Azure Bot + HITL Teams approval
> runbook (the bot's own Entra app / app password) — that is a separate app and a
> separate deliverable: [`docs/runbooks/azure-bot-hitl-provisioning.md`](azure-bot-hitl-provisioning.md).
> The `fugue-agents` app below is the **capability broker** trust boundary (one
> Entra app per deployed host, ADR-0055). Do not conflate the two apps.

---

## 1. Purpose & scope

### What already exists (do not re-build it)

The config-as-code and pure-core halves of the Keycloak↔Entra bridge are **merged and golden-/unit-tested** on `main`:

| Concern | What exists | Provenance |
|---|---|---|
| Host capability broker | `entra-wif` / `keycloak-broker` adapters; fail-closed scope gate consulted **before** any Entra call; live transports select per-leg by config presence (FR-011) | `packages/host/src/adapters/keycloak-broker.ts`, `graph-capability.ts`; spec FR-010..FR-012 |
| Realm package | `fugue-platform` realm: `entra-exchange` optional scope (single hardcoded-audience mapper, `aud: api://AzureADTokenExchange`, access-token-only, FR-W4-003); agent-type clients `fugue-agent-mail` / `fugue-agent-sites` (confidential service-account, client-credentials only) | `~/dev/java/keycloakConfigAsCode`; Appendix A.8 |
| Golden test | `FuguePlatformRealmGoldenTest.java` asserts both client types present (SC-012) and the `entra-exchange` scope mints exactly `aud: api://AzureADTokenExchange` (FR-W4-003) | Appendix A.8 |
| Config + `.env.example` | every Entra/Keycloak/Bot/HITL var documented, validated at boot (FR-001, FR-005) | `packages/host/.env.example` |

### What only a live operator can prove (this runbook)

The Azure-portal provisioning of `fugue-agents`, its Federated Identity Credentials (FICs), its resource-scoping policies, and the byte-for-byte agreement of issuer/subject/audience across the Keycloak and Entra sides. **None of this exists until you run these steps against a real tenant.**

> **GATE (US6 acceptance, SC-007).** This runbook is gated by the four wave-4
> spikes (Appendix B). **Spikes #1–#3 MUST record PASS (or PARTIAL-with-documented-fallback)
> before any gated provisioning step is trusted**; spike #4 gates the user-initiated
> chain. A gated step run before its spike passes is **not trustworthy** — treat a
> premature run as a hard stop. Per the project standard, **no PASS is recorded for
> an unobserved result.**

---

## 2. Prerequisites

### Access & roles required

- **Entra app-admin** — register applications, add/inspect FICs, grant application permissions + admin consent.
- **Graph admin token** (`${GRAPH_ADMIN_TOKEN}`) — `Sites.FullControl.All` (to write `Sites.Selected` grants), `AuditLog.Read.All` (sign-in logs), `Application.Read.All`. Reports Reader / Security Reader suffices for read-only sign-in inspection.
- **Exchange Online PowerShell** — `ExchangeOnlineManagement` module, rights to run `New-ApplicationAccessPolicy` / `Test-ApplicationAccessPolicy`.
- **Dataverse admin** — to register `fugue-agents` as a Dataverse application user with a read-scoped security role (only if the `dynamics:read` path is being provisioned; host path is currently unwired).
- The live **`fugue-platform` Keycloak realm** reachable from Entra over the public internet (Entra fetches the issuer's OIDC metadata + JWKS, so the issuer URL must be internet-resolvable).
- The running **fugue host** (for the §8 e2e), configured per `packages/host/.env.example`.

### Tooling

`az` (Azure CLI), `curl`, `jq`, PowerShell + `ExchangeOnlineManagement`. JWT payload decoder used throughout:

```sh
jwtpay() { cut -d. -f2 <<<"$1" | tr '_-' '/+' | awk '{l=length%4; if(l)$0=$0 substr("===",1,4-l)}1' | base64 -d 2>/dev/null | jq .; }
```

### Placeholders — defined once, used everywhere

| Placeholder | Meaning |
|---|---|
| `<kc-host>` | hostname of the live Keycloak (e.g. `keycloak.example.com`) |
| `<tenant>` | the Entra tenant id / primary domain |
| `<fugue-agents app id>` | the Application (client) id recorded in step A.1 |
| `<IN_SCOPE_SITE_ID>` | a SharePoint site the sites-agent is *allowed* to use |
| `<OUT_OF_SCOPE_SITE_ID>` | a control site the sites-agent must NOT reach |

Env-var conventions (never inline a real secret/token — reference the var, matching `azure-bot-hitl-provisioning.md`): `${GRAPH_ADMIN_TOKEN}`, `${APP_TOKEN}` (app-only Graph token for `fugue-agents`), `${KEYCLOAK_ASSERTION}` (the WIF assertion minted by the realm).

### Constants you MUST pin (Appendix C — agree byte-for-byte across Keycloak and Entra)

Entra matches FIC `issuer`/`subject`/`audience` **exactly and case-sensitively**. Any divergence (case, trailing slash, array-vs-string) → silent reject (`AADSTS70021`). Copy-paste these, never retype:

| Constant | Value | Source of truth |
|---|---|---|
| Entra app | `fugue-agents` — **one** app (the deployed host is the trust boundary, ADR-0055) | AD-3 / FR-W4-001 |
| Federation audience | `api://AzureADTokenExchange` — every FIC's `audience`; minted by the `entra-exchange` Keycloak scope | FR-W4-003 |
| Issuer | `https://<kc-host>/realms/fugue-platform` (**no trailing slash**) — every FIC's `issuer` | the `fugue-platform` realm |
| Agent-type clients | `fugue-agent-mail`, `fugue-agent-sites` (Keycloak clients only — there is **no** per-agent Entra app) | `fugue-platform` `ClientStep` |
| FIC `subject` | the agent client's service-account `sub`: `service-account-<client_id>` if the predictable-`sub` mapper is in use (spike #2 PASS), else the UUID **read after** `ClientStep` | Keycloak-minted assertion `sub` |

Host env vars consumed (cross-check `packages/host/.env.example`, do not invent names): `ENTRA_TENANT_ID` + `ENTRA_CLIENT_ID` (**inseparable pair** — one without the other is rejected at boot, FR-001), `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` (JSON `{ agentClientId: { clientId, clientSecret } }`, SENSITIVE — never log), `AGENT_CLIENT_MAP`, `AGENT_CLIENT_SCOPES` (the fail-closed scope gate), `DYNAMICS_ORG_HOST`, `REALM_JWT_ISSUER`, `REALM_JWT_AUDIENCE`, `ADMIN_TOKEN`. HITL/user-path cross-refs: `BOT_APP_ID`/`BOT_APP_PASSWORD`, `HITL_APPROVER_TEAMS` (see the [Azure Bot runbook](azure-bot-hitl-provisioning.md)).

---

## 3. Spike gate (Appendix B) — run BEFORE provisioning

Each spike's outcome must be a recorded **PASS** (with observed token/log evidence) before the gated step it controls runs against a real tenant. The **negative controls below are LOAD-BEARING** — a green positive path alone does **not** satisfy a spike.

| Spike | Gates | Required outcome |
|---|---|---|
| #1 FIC sign-in attribution | A.3 (variant A forensics), A.6 | PASS — sign-in log names the matched FIC (`federatedCredentialId`) |
| #2 sub-claim × FIC matching | A.3 (exact + case-sensitive match) | PASS — minted `sub` matches FIC verbatim; **case-flip fails `AADSTS70021`** |
| #3 resource-scoping coverage | A.4 (`Sites.Selected` + Exchange policy) | PASS — in-scope granted **and out-of-scope denied** |
| #4 identity-chaining e2e | the user-initiated chain feeding the WIF assertion (§8 user path) | PASS / PARTIAL — chain composes, `aud: api://AzureADTokenExchange` pinned |

### 3.1 Spike #1 — FIC sign-in attribution

**Objective:** confirm Entra sign-in logs surface *which* FIC matched (decides variant A's per-agent-type forensic value). Source: [`spike-1-fic-signin-attribution.md`](../spikes/2026-06-10-spike-1-fic-signin-attribution.md).

**Procedure:** with `fugue-agents` registered (A.1) and both FICs added (A.3), mint an assertion as `fugue-agent-mail`, exchange it at the tenant endpoint (the §3.2/A.3 `curl`), note the UTC time. Repeat as `fugue-agent-sites`, minutes apart. After ~15 min ingestion latency, read service-principal sign-ins (the A.6 query) and inspect each entry's `federatedCredentialId`.

**Acceptance:**
- **PASS** — the two entries are distinguishable by `federatedCredentialId` (or an equivalent named field) resolving back to `fugue-agent-mail-fic` vs `fugue-agent-sites-fic`. Record the exact field name(s).
- **PARTIAL** — distinguishable only by inbound `sub`/issuer (no `federatedCredentialId`). Record the actual discriminating field; note host-side `traceparent` carries the remaining attribution weight.
- **FAIL** — both entries indistinguishable at app/SP level. Variant A's marginal forensic value collapses to host logs + `traceparent`; escalate before trusting A.3's forensic claim.

### 3.2 Spike #2 — sub-claim mapper × FIC matching

**Objective:** confirm the realm's predictable `sub` (`service-account-<client_id>`) survives Entra's case-sensitive FIC `subject` match — so FIC subjects can be written ahead of client creation (config-as-code) rather than read-then-pinned. Source: [`spike-2-subclaim-fic-matching.md`](../spikes/2026-06-10-spike-2-subclaim-fic-matching.md).

**Procedure:**
1. Mint a service-account token with the `entra-exchange` scope and decode it — assert exact bytes, do not eyeball:
   ```sh
   TOKEN=$(curl -s -X POST "https://<kc-host>/realms/fugue-platform/protocol/openid-connect/token" \
     -d grant_type=client_credentials -d client_id=fugue-agent-mail \
     -d client_secret="${AGENT_MAIL_SECRET}" -d scope=entra-exchange | jq -r .access_token)
   jwtpay "$TOKEN" | jq '{iss, sub, aud}'   # capture exact iss / sub / aud (note aud string-vs-array)
   ```
2. Create the FIC on `fugue-agents` using the captured `iss`/`sub` **verbatim** (copy-paste) and `audience = api://AzureADTokenExchange` (A.3).
3. **Positive** — exchange the assertion (the A.3 tenant `curl`): a **200 with an app-only Graph token** proves all three matched.
4. **NEGATIVE CONTROL (MANDATORY).** After the positive exchange, edit ONE character's **CASE** in the FIC `subject` (e.g. `service-account-fugue-agent-mail` → `service-account-Fugue-agent-mail`), re-exchange, and **confirm `AADSTS70021`** ("No matching federated identity record found for presented assertion"). **Then revert the FIC subject** to the exact captured value. *A 200 in step 3 without this failing case-flip is NOT a PASS — it proves nothing about case-sensitivity.*
5. **Reproducibility** — delete and recreate the agent client via `ClientStep`; confirm the new client (new UUID) still mints `sub = service-account-<client_id>` and matches the **unchanged** FIC.

**Acceptance:**
- **PASS** — step 3 returns a Graph token, step 4 fails with `AADSTS70021` then reverts cleanly, step 5 matches without touching the FIC. FIC subjects are config-as-code; record the verbatim `iss`/`sub`/`aud`.
- **PARTIAL** — token issues only with a read-after-creation UUID subject, or casing is non-deterministic. **Fall back to read-then-pin** (read the service-account `sub` after `ClientStep`, then write the FIC) and document why; A.3 must use the pinned UUID.
- **FAIL** — no mapper config yields a predictable case-stable `sub` Entra matches, or `aud`/`iss` cannot be pinned. Blocker for variant-A ahead-of-time wiring; escalate.

### 3.3 Spike #3 — resource-scoping coverage AND denial

**Objective:** prove the two Entra-side bounds on the union-permission token both **cover** the needed Graph surfaces **and deny** everything else. The app-only `.default` token cannot be per-request downscoped — these policies are the *only* containment. Source: [`spike-3-resource-scoping-coverage.md`](../spikes/2026-06-10-spike-3-resource-scoping-coverage.md).

**Part A — `Sites.Selected`:**
1. Grant the in-scope site (A.4a `POST /sites/.../permissions`).
2. **Positive** — `GET https://graph.microsoft.com/v1.0/sites/<IN_SCOPE_SITE_ID>/drive/root/children` with `${APP_TOKEN}` → **200**.
3. **NEGATIVE CONTROL** — same token against `<OUT_OF_SCOPE_SITE_ID>` → **403 `accessDenied`**. This proves `Sites.Selected` is not silently behaving like `Sites.Read.All`.

**Part B — Exchange application access policy:**
4. Create the policy + `Test-ApplicationAccessPolicy` (A.4b) → `Granted` for lead-desk, `Denied` for a control mailbox.
5. **Positive** — `POST /users/leaddesk@<tenant>/sendMail` with `${APP_TOKEN}` → **202** and the message lands.
6. **NEGATIVE CONTROL** — same token, `sendMail` from a **control mailbox** → **403 `ErrorAccessDenied` / `ApplicationAccessPolicy`**.
7. **Dynamics (if provisioned):** confirm the Dataverse security role permits **only** the scoped read — a read of an out-of-scope table/column is denied.

> Allow ~30 min for Exchange policy propagation; if a negative check unexpectedly passes immediately after policy creation, re-run after the window before recording.

**Acceptance:**
- **PASS** — Part A: (2) succeeds **and** (3) is denied 403; Part B: (5) succeeds + delivers **and** (6) is denied 403. **A green positive path ALONE FAILS this step** — the value is what these policies *deny*. Both coverage and containment must pass. Record the site ids, the scope group, and every Graph surface exercised.
- **PARTIAL** — a needed operation is denied (under-coverage) **or** an out-of-scope target is *not* denied (containment hole). Enumerate the specific gap; a containment hole MUST be resolved before A.4 is trusted (possibly the "apps per permission tier" escalation).
- **FAIL** — a mechanism cannot express the needed scoping at all. The Entra-side bound the one-app decision depends on does not hold; escalate.

### 3.4 Spike #4 — identity-chaining end-to-end (user path)

**Objective:** prove the composed user→agent→Entra chain works on Keycloak 26.6 — `sub` stays the user, `azp` becomes the agent, `aud` pins to `api://AzureADTokenExchange`. Source: [`spike-4-identity-chaining-e2e.md`](../spikes/2026-06-10-spike-4-identity-chaining-e2e.md). Gates the §8 user path.

**Procedure (hypotheses H1–H4):**
1. Get a user token (auth-code via the realm web client, or ROPC against a direct-access test client). Expect `sub: <user-uuid>`, `azp: <web-client>`.
2. **H1** — agent client exchanges the **user's** token (Standard Token Exchange V2, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=$USER_TOKEN`, `subject_token_type=...:access_token`, `audience=fugue-host`). Expect `sub` == the user uuid, `azp` == the agent client.
3. **H2 + H3** — carry the exchanged token forward requesting `scope=entra-exchange`; the WIF assertion's `aud == api://AzureADTokenExchange` and only that audience. **Record the assertion's `sub`** — this is the value the Entra FIC subject must match.
4. **H4** — `client_credentials` to `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with `client_assertion=$WIF` → app-only Graph token (`roles` present, no user `scp`).

**Negative controls (must fail — confirms pinning):** the WIF token presented to an internal `fugue-host` resource server → rejected (audience mismatch); an exchange by a client **without** Standard Token Exchange enabled → `access_denied`/`invalid_client` (confirms Keycloak is the PEP).

**Acceptance:**
- **PASS** — H1–H4 all hold with observed token evidence.
- **PARTIAL PASS (Keycloak segment)** — H1–H3 hold but no Entra tenant for H4; record H4 `PENDING`. The user-path gate is not yet fully cleared.
- **FAIL** — any explicit failure; wave-3's user-initiated path is blocked pending redesign.

---

## 4. Provisioning runbook (Appendix A, steps A.1–A.8)

Every step has an **explicit, checkable Acceptance** verified *before moving on*. A failed Acceptance is a **hard stop**. Source: [`team-security-and-capabilities.md` Appendix A](../team-security-and-capabilities.md).

### A.1 — Register `fugue-agents` with the union of application permissions (FR-W4-001 / AD-3)

1. Entra admin center → App registrations → New registration. Name `fugue-agents`. **Single tenant**, **no redirect URI** (it never does interactive auth). Register.
2. Record **Application (client) ID** (`<fugue-agents app id>`) + **Directory (tenant) ID** — these feed the host's `ENTRA_CLIENT_ID` / `ENTRA_TENANT_ID` (inseparable pair).
3. API permissions → add the **union of *application* (app-only) permissions**, derived from the assigned Keycloak optional scopes:

   | Keycloak optional scope | Entra application permission | API | Used by |
   |---|---|---|---|
   | `msgraph:mail.send` | `Mail.Send` | Graph | `fugue-agent-mail` |
   | `msgraph:sites.read` | `Sites.Selected` (**never** `Sites.Read.All`) | Graph | `fugue-agent-sites` |
   | `dynamics:read` | Dataverse application user + read security role | Dynamics 365 | unassigned (host path unwired) |

   > Dynamics has no classic Graph `*.All` app permission; app-only access = register `fugue-agents` as a **Dataverse application user** with a read-scoped security role.

**Acceptance:** exactly **one** app `fugue-agents` (no per-agent app — `fugue-agent-*` exist only as *Keycloak* clients); the permission list is **exactly the union** (no broader sibling, no extra); all are **Application** (app-only), not Delegated.

### A.2 — Grant admin consent once (FR-W4-001)

App → API permissions → **Grant admin consent** → confirm each row **Granted for `<tenant>`**. For Dynamics, confirm the application user's security role is assigned in the target environment (Graph consent does not cover the Dataverse role).

**Acceptance:** every union permission Granted; consent recorded **once** at app level; no per-agent consent; no runtime consent prompt possible on the app-only path.

### A.3 — Add Federated Identity Credentials — Variant A (FR-W4-002 / AD-4)

For each agent-type client (`fugue-agent-mail`, then `fugue-agent-sites`):

1. App → Certificates & secrets → Federated credentials → Add → **Other issuer**.
2. Set the three match fields, **copy-pasted verbatim** (Entra matches exactly, case-sensitively):
   - **Issuer** = `https://<kc-host>/realms/fugue-platform` (no trailing slash).
   - **Subject** = the client's service-account `sub` — `service-account-fugue-agent-mail` / `service-account-fugue-agent-sites` **if spike #2 PASSed** with the predictable-`sub` mapper; **else the UUID read after `ClientStep`** (spike #2 PARTIAL → read-then-pin).
   - **Audience** = `api://AzureADTokenExchange`.
   - **Name** = `fugue-agent-mail-fic` / `fugue-agent-sites-fic`.
3. Record each FIC's **name** + **credential object id** (`GET /applications/{id}/federatedIdentityCredentials`) — needed for A.6.

**Positive** — mint an `entra-exchange`-scoped assertion (§3.2 step 1) and exchange it:
```sh
curl -s -X POST "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=<fugue-agents app id>" \
  -d "scope=https://graph.microsoft.com/.default" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=${KEYCLOAK_ASSERTION}"
```
Expect **HTTP 200** with an app-only token (both agents); `iss`/`sub`/`aud` match byte-for-byte (`aud` is the string, not an array).

**Acceptance:** exactly **two** FICs (under the 20-cap), no FIC for any other issuer; positive exchange → 200 for both agents; **negative (mandatory, per spike #2)** — flip one char's CASE in a FIC subject, re-exchange, confirm `AADSTS70021`, **then revert**.

### A.4 — Resource-scoping policies (FR-W4-005 / AD-3)

The app-only `.default` token carries the full union every call and **cannot be downscoped per request** — these two mechanisms are the *only* Entra-side containment. **Spike #3 must prove both coverage AND denial.**

**4a — `Sites.Selected` per-site grant (sites-agent):** with the Graph admin token,
```sh
curl -s -X POST -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/sites/<IN_SCOPE_SITE_ID>/permissions" \
  -d '{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<fugue-agents app id>","displayName":"fugue-agents"}}]}'
```
(grant only the specific site(s), not tenant-wide. Use `["write"]` only if the sites-agent must write.)
**Acceptance:** positive — `GET https://graph.microsoft.com/v1.0/sites/<IN_SCOPE_SITE_ID>/drive/root/children` → **200**; negative — `<OUT_OF_SCOPE_SITE_ID>` → **403 `accessDenied`**.

**4b — Exchange application access policy (mail-agent):** in Exchange Online PowerShell,
```powershell
New-ApplicationAccessPolicy `
  -AppId <fugue-agents app id> `
  -PolicyScopeGroupId leaddesk-scope@<tenant> `
  -AccessRight RestrictAccess `
  -Description "fugue-agents: lead-desk mailbox only"

Test-ApplicationAccessPolicy -Identity leaddesk@<tenant> -AppId <fugue-agents app id>   # expect Granted
Test-ApplicationAccessPolicy -Identity control-mbx@<tenant> -AppId <fugue-agents app id> # expect Denied
```
(allow ~30 min propagation.)
**Acceptance:** positive — `POST https://graph.microsoft.com/v1.0/users/leaddesk@<tenant>/sendMail` with `${APP_TOKEN}` → **202** and the message lands; negative — control mailbox → **403 `ErrorAccessDenied` / `ApplicationAccessPolicy`**. (Dynamics: the Dataverse role permits only the needed read surface.)

> A green positive path alone does **not** satisfy this step — the value is what these policies *deny*. Both coverage and containment must pass.

### A.5 — Confirm zero stored secret/certificate (FR-W4-004 / NFR-012 / SC-011)

App → Certificates & secrets: **Client secrets** empty, **Certificates** empty, **Federated credentials** = only the two FICs. The host's `entra-wif` config references **no** Entra secret/cert (only `ENTRA_CLIENT_ID`/`ENTRA_TENANT_ID` + the Keycloak assertion as `client_assertion`).

```sh
# Programmatic confirmation — both arrays MUST be empty.
curl -s -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
  "https://graph.microsoft.com/v1.0/applications(appId='<fugue-agents app id>')" \
  | jq '{passwordCredentials, keyCredentials}'   # EXPECT: both []
```

**Acceptance (HARD INVARIANT):** **0 client secrets, 0 certificates** — federation (WIF) is the only credential. **Any secret or certificate present is a HARD STOP** — delete it and re-confirm before proceeding (NFR-012 / SC-011).

### A.6 — Sign-in attribution check (spike #1)

Run a real federated exchange as `fugue-agent-mail` (A.3 positive), note UTC time, allow ~15 min, then read service-principal sign-in logs:
```sh
curl -s -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
  "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '<fugue-agents app id>' and signInEventTypes/any(t: t eq 'servicePrincipal')&\$top=20" \
  | jq '.value[] | {createdDateTime, appId, servicePrincipalId, federatedCredentialId, tokenIssuerName, status}'
```

**Acceptance:** an entry shows `federatedCredentialId` resolving to `fugue-agent-mail-fic`; a second run as `fugue-agent-sites` is distinguishable (resolves to `fugue-agent-sites-fic`). If spike #1 is PARTIAL (no `federatedCredentialId`), record the actual discriminating field and note that host-side `traceparent` attribution carries the remaining weight.

### A.7 — Whole-runbook acceptance checklist

- [ ] Steps A.1–A.2: one app, union exactly, admin-consented once, no per-agent app.
- [ ] Step A.3: two FICs, byte-for-byte match, positive exchange 200, case-mismatch → `AADSTS70021`.
- [ ] Step A.4: in-scope act succeeds; out-of-scope site (403) + control mailbox (403) denied.
- [ ] Step A.5: zero secrets, zero certificates.
- [ ] Step A.6: sign-in log attributes to the correct FIC.
- [ ] All four spikes PASS (or PARTIAL with fallback noted) before gated steps trusted.

### A.8 — Keycloak side the operator must match against (config-as-code, already golden-tested)

Lives in the `fugue-platform` realm package (`~/dev/java/keycloakConfigAsCode`):

- The realm mints the federation assertion's audience via the **`entra-exchange`** optional client scope — a single hardcoded-audience protocol mapper stamping `aud: api://AzureADTokenExchange` on the **access token only** (FR-W4-003). Every FIC's `audience` must equal this.
- Agent-type clients **`fugue-agent-mail`** / **`fugue-agent-sites`** are confidential service-account clients (client-credentials only; ROPC/standard-flow disabled), each carrying the optional scope mapping to its Entra permission. **Assigning the scope in `ClientStep` IS the policy grant (AD-5);** the broker fails closed at the Keycloak hop with zero Entra egress if unassigned.
- Realm issuer URL `https://<kc-host>/realms/fugue-platform` — the exact string each FIC's `issuer` must equal.
- `FuguePlatformRealmGoldenTest.java` already asserts both client types present (SC-012) and the `entra-exchange` scope mints exactly `aud: api://AzureADTokenExchange`, access-token-only, single mapper (FR-W4-003).

---

## 5. End-to-end verification against the live host

Run these against the deployed fugue host once §3 spikes PASS and §4 provisioning is complete. The host config (`packages/host/.env.example`): `REALM_JWT_ISSUER` set selects the live Keycloak broker; `ENTRA_TENANT_ID`+`ENTRA_CLIENT_ID` select the WIF leg; `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` + `AGENT_CLIENT_SCOPES` (the fail-closed gate) + `AGENT_CLIENT_MAP` map DAG identity → agent client.

### 5.1 Agent path — granted succeeds, un-granted refused with ZERO Entra egress

**Granted (positive):** trigger an agent-initiated DAG whose node declares a capability the agent client **is** granted — e.g. `fugue-agent-mail` with `msgraph:mail.send` (`Mail.Send`). Expect the node to send mail successfully (202 from Graph `sendMail`; the message lands in the lead-desk mailbox, subject to the A.4b policy).

**Un-granted (negative — load-bearing):** trigger a node requesting a capability the agent client is **not** granted in `AGENT_CLIENT_SCOPES` (a client absent there has NO scopes — fail closed). Per **FR-012 / NFR-010**, the request MUST be **refused at the Keycloak hop with ZERO downstream (Entra) egress** — the broker consults the fail-closed scope gate *before* any Entra call (`packages/host/src/adapters/keycloak-broker.ts`).

**Confirm zero egress** — after the refused attempt, note the UTC time and re-run the A.6 sign-in-log query for `<fugue-agents app id>`. **There MUST be no service-principal sign-in entry corresponding to the refused attempt** (no Entra token was ever requested). Cross-check the host audit log shows the refusal at the Keycloak hop (SC-004).

**Acceptance:** granted capability → mail sent; un-granted capability → refused at Keycloak, **no Entra sign-in entry for the refused attempt**, host audit log records the fail-closed refusal.

### 5.2 User path — user-initiated run reaches downstream AS the user (Phase 3 / RFC 8693)

Trigger a **user-initiated** run with a verified realm JWT (`REALM_JWT_ISSUER`/`REALM_JWT_AUDIENCE`). The host authorizes the run by checking the DAG-owning team against the user's multi-valued `teams` claim (FR-020/FR-021, stateless), then — per Phase 3 — reaches downstream **as the user** via the RFC 8693 Standard Token Exchange V2: the exchanged token preserves `sub` = the user and `azp` = the agent client (FR-030/FR-031), and the host threads the verified user token **host-side only** (FR-032).

This is the live composition of **spike #4** — confirm the chain produces a WIF assertion with `aud: api://AzureADTokenExchange` pinned (H2) and Entra returns an app-only token (H4). Reference [`spike-4-identity-chaining-e2e.md`](../spikes/2026-06-10-spike-4-identity-chaining-e2e.md) for the per-hop token evidence.

**Acceptance:** a user **in** the DAG's team reaches the downstream capability as the user (exchanged `sub` = user, `azp` = agent); a user **not** in the team is denied before any capability mint (SC-005); the WIF assertion `aud` is pinned to `api://AzureADTokenExchange`.

---

## 6. STATUS / HANDOFF

**Live spikes + provisioning + e2e: DEFERRED — owner: operator (Peter Hansen). NOT yet executed** (no live Entra tenant + no live `fugue-platform` realm reachable at authoring time, 2026-06-16). All four spikes are `PENDING-LIVE-VERIFICATION`.

This runbook is written and verified against the merged, golden-/unit-tested broker + realm package on `main`. No code change is required to execute it — it is Entra/Exchange/Dataverse provisioning + live verification only. **Nothing below has been performed; do not treat any step as done until the operator ticks it and records evidence in §7.**

**T9 is COMPLETE only when the [Evidence capture template](#7-evidence-capture-template) is filled with PASS/PARTIAL evidence — NOT on authoring of this file.**

---

## 7. Evidence capture template

> Operator: fill this in during the live run. T9 / Phase 5 is complete only when every spike is PASS or PARTIAL-with-fallback, the A.7 checklist is fully ticked, the sign-in-log JSON is captured, and the sign-off line is signed (US6 / SC-007).

### 7.1 Per-spike outcome

```
Spike #1 (FIC sign-in attribution):  PASS / PARTIAL / FAIL
  Discriminating field observed: __________ (e.g. federatedCredentialId = <guid> → fugue-agent-mail-fic)
  Evidence (log snippet / portal ref): __________

Spike #2 (sub-claim × FIC matching): PASS / PARTIAL / FAIL
  Captured iss: __________   sub: __________   aud: __________ (string? array?)
  Positive exchange: HTTP ____   Case-flip negative: AADSTS______ (expect 70021)   Reverted: Y / N
  Mechanism in use: predictable-sub mapper / read-then-pin (PARTIAL fallback) — circle one

Spike #3 (resource-scoping coverage + denial): PASS / PARTIAL / FAIL
  Sites — in-scope GET: HTTP ____   out-of-scope GET: HTTP ____ (expect 403 accessDenied)
  Mail  — lead-desk sendMail: HTTP ____ (expect 202)   control mbx: HTTP ____ (expect 403 ApplicationAccessPolicy)
  Dynamics (if provisioned): scoped read granted ___ / out-of-scope denied ___
  Site ids + scope group recorded: __________

Spike #4 (identity-chaining e2e): PASS / PARTIAL PASS (Keycloak segment) / FAIL
  H1 sub==user/azp==agent: ___   H2 aud==api://AzureADTokenExchange: ___   H3 chain composes: ___   H4 app-only Graph token: ___ / PENDING
```

### 7.2 A.7 whole-runbook acceptance checklist

- [ ] Steps A.1–A.2: one app, union exactly, admin-consented once, no per-agent app.
- [ ] Step A.3: two FICs, byte-for-byte match, positive exchange 200, case-mismatch → `AADSTS70021`.
- [ ] Step A.4: in-scope act succeeds; out-of-scope site (403) + control mailbox (403) denied.
- [ ] Step A.5: zero secrets, zero certificates.
- [ ] Step A.6: sign-in log attributes to the correct FIC.
- [ ] All four spikes PASS (or PARTIAL with fallback noted) before gated steps trusted.
- [ ] §5.1 agent path: granted succeeds; un-granted refused at Keycloak with **zero Entra sign-in entry** (SC-004).
- [ ] §5.2 user path: in-team reaches downstream as user; non-member denied; WIF `aud` pinned (SC-005).

### 7.3 Captured sign-in-log JSON (A.6 — must show `federatedCredentialId`)

```json
// Paste the jq output of the A.6 query here. Redact nothing structural; the
// federatedCredentialId → FIC name mapping is the load-bearing evidence.
{
  "createdDateTime": "____",
  "appId": "<fugue-agents app id>",
  "servicePrincipalId": "____",
  "federatedCredentialId": "____",   // resolves to fugue-agent-mail-fic / fugue-agent-sites-fic
  "tokenIssuerName": "____",
  "status": { "errorCode": 0 }
}
```

### 7.4 Sign-off

```
T9 / Phase 5 live verification — sign-off

Operator:        __________ (name)
Tenant:          __________ (<tenant> id / primary domain)
fugue-agents app id: __________
Date/time (UTC): __________

Spikes:   #1 ____  #2 ____  #3 ____  #4 ____   (PASS / PARTIAL / FAIL)
A.5 secretless invariant (0 secrets / 0 certs): CONFIRMED / FAILED
Overall:  PASS / PARTIAL-with-fallback / BLOCKED
Notes / fallbacks documented: __________
```

**Gate:** this template must be fully filled (spikes #1–#3 PASS or PARTIAL-with-fallback, A.5 secretless confirmed, A.7 ticked, sign-in-log JSON captured, sign-off signed) **before production go-live** of the live capability broker (US6 / SC-007).

---

## References (provenance — not required reading mid-execution)

- Design + Appendices A/B/C: [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md)
- Spikes: [`#1`](../spikes/2026-06-10-spike-1-fic-signin-attribution.md) · [`#2`](../spikes/2026-06-10-spike-2-subclaim-fic-matching.md) · [`#3`](../spikes/2026-06-10-spike-3-resource-scoping-coverage.md) · [`#4`](../spikes/2026-06-10-spike-4-identity-chaining-e2e.md)
- Spec / plan: `.claude/specs/2026-06-16-keycloak-entra-wiring/spec.md` (US6, FR-012, NFR-010, NFR-012, SC-004, SC-005, SC-007, SC-011) · `.claude/plans/2026-06-16-keycloak-entra-wiring.md` (Phase 5)
- Host config: [`packages/host/.env.example`](../../packages/host/.env.example) · broker: `packages/host/src/adapters/keycloak-broker.ts`, `graph-capability.ts`
- HITL Teams go-live (separate app): [`docs/runbooks/azure-bot-hitl-provisioning.md`](azure-bot-hitl-provisioning.md)
