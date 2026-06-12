# Spike 1 — FIC sign-in attribution

> **Date:** 2026-06-10 · **Spec anchors:** FR-SPK-001, SC-014, US7 ·
> **Gates:** Phase 5 Entra bridge (wave 4) — FIC wiring **variant A vs B** decision.
> **Design:** [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
> — "Verify before building" item #1; "FIC wiring — two variants".

## Objective

Confirm whether Microsoft Entra **sign-in logs surface which federated identity
credential (FIC) matched** on an app-only `client_credentials`-with-federated-credential
token request against the `fugue-agents` app.

The design's per-agent attribution argument for **variant A** (one FIC per
agent-type Keycloak client) over **variant B** (one funnel `entra-bridge`
client, one FIC) rests entirely on this. If Entra records the specific matched
FIC, variant A buys Entra-side, tamper-evident, per-agent-type forensics
"for free" (one FIC entry per type, well under the 20-FIC cap). If Entra
records nothing finer than "the `fugue-agents` app authenticated," then variant
A's only marginal forensic value over B is the distinct subject value visible
in the *inbound assertion* — and the attribution case for A weakens to "host
logs + `traceparent` plus a distinguishable `sub`," much closer to B.

**This spike measures forensic value, not feasibility.** Both variants are
known to work mechanically; the question is purely what Entra's audit surface
preserves.

## Background — what we are looking for

A federated `client_credentials` request (the WIF third case) sends:

- `grant_type=client_credentials`
- `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
- `client_assertion=<Keycloak service-account JWT>` (issuer/subject/audience
  matched against one of the app's FICs)
- `scope=https://graph.microsoft.com/.default`

Entra matches the assertion's `iss`/`sub`/`aud` against the FIC list on the app.
The forensic question: in the resulting **service principal sign-in log entry**
(`Microsoft.Graph` `auditLogs/signIns`, `signInEventTypes` =
`servicePrincipal`), is the **specific matched FIC identifiable** — by name, by
credential id, or by the inbound `sub`/`iss` — or is only the app/SP recorded?

## Verification procedure (ready-to-run)

### Prerequisites

- Entra tenant with admin rights to: register apps, add FICs, grant
  application permissions, and read sign-in logs (Reports Reader or
  Security Reader at minimum; or Graph `AuditLog.Read.All`).
- A `fugue-platform` Keycloak realm (or any OIDC issuer reachable from Entra
  over the public internet — Entra fetches the issuer's OIDC metadata and JWKS,
  so the issuer URL must be internet-resolvable) able to mint a
  service-account JWT with a controllable `sub` and `aud:
  api://AzureADTokenExchange`.
- Two distinct service-account clients in the realm (`agent-alpha`,
  `agent-beta`) to prove per-FIC discrimination.

### Steps

1. **Register** (or reuse) the `fugue-agents` app. Grant it one harmless
   app permission for which a call can be made (e.g. `User.Read.All`,
   admin-consented) so a downstream Graph call can confirm the token works.

2. **Add two FICs** to `fugue-agents` (`flexible FIC` / "other issuer"):
   - FIC `agent-alpha-fic`: `issuer` = realm issuer URL, `subject` =
     `agent-alpha`'s service-account `sub`, `audience` =
     `api://AzureADTokenExchange`.
   - FIC `agent-beta-fic`: same issuer, `subject` = `agent-beta`'s `sub`,
     same audience.
   Record each FIC's **name** and **credential object id** (`GET
   /applications/{id}/federatedIdentityCredentials`).

3. **Mint** an assertion as `agent-alpha` from Keycloak
   (`grant_type=client_credentials`, the `entra-exchange` scope so `aud` is
   `api://AzureADTokenExchange`). Decode it; confirm `iss`/`sub`/`aud` exactly
   match `agent-alpha-fic`.

4. **Exchange** at the tenant token endpoint:
   ```sh
   curl -s -X POST \
     "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
     -d "grant_type=client_credentials" \
     -d "client_id=${FUGUE_AGENTS_APP_CLIENT_ID}" \
     -d "scope=https://graph.microsoft.com/.default" \
     -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
     --data-urlencode "client_assertion=${KEYCLOAK_ASSERTION}"
   ```
   Expect HTTP 200 with an app-only Graph token. Note the wall-clock time (UTC).

5. **Repeat step 3–4 as `agent-beta`** so two sign-ins exist, one per FIC,
   minutes apart.

6. **Read the sign-in logs** after ingestion latency (allow up to ~15 min for
   service-principal sign-ins to appear):
   ```sh
   # Microsoft Graph — service principal sign-ins for the app, federated only.
   curl -s -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
     "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '${FUGUE_AGENTS_APP_CLIENT_ID}' and signInEventTypes/any(t: t eq 'servicePrincipal')&\$top=20" \
     | jq '.value[] | {createdDateTime, appId, servicePrincipalId, federatedCredentialId, tokenIssuerName, tokenIssuerType, status}'
   ```
   Inspect each entry for any field that names the matched FIC. Primary
   candidate field: **`federatedCredentialId`** (GUID of the matched FIC).
   Secondary signals: `tokenIssuerName` / `tokenIssuerType`, and whether the
   inbound `sub` is surfaced anywhere. Also check the **portal** view (Entra
   admin center → Sign-in logs → Service Principal Sign-ins → an entry →
   "Federated Credential" / "Authentication Details") which sometimes renders
   fields not yet in the v1.0 Graph schema (check `beta` Graph as well if v1.0
   omits `federatedCredentialId`).

## Pass / fail criteria

- **PASS** — the two sign-in entries are **distinguishable by the matched FIC**:
  `federatedCredentialId` (or an equivalent named field) differs between the
  `agent-alpha` and `agent-beta` exchanges and resolves back to the correct FIC.
  → Variant A delivers Entra-side, per-agent-type forensic attribution; recommend
  variant A and record the exact field name(s) for the wave-4 runbook.
- **PARTIAL** — the entries are distinguishable only by inbound `sub`/issuer (no
  `federatedCredentialId`), but the matched credential is still inferable.
  → Variant A retains *some* Entra-side value but it is weaker than "the log
  names the FIC"; document the actual discriminating field and re-weigh A vs B.
- **FAIL** — both entries are indistinguishable at the app/SP level (no field
  ties a sign-in to a specific FIC or inbound subject).
  → Variant A's marginal forensic value over B collapses to host logs +
  `traceparent`; revisit whether 20 FICs are worth the ceremony, or default to B
  plus strong host-side attribution.

## Outcome

**`PENDING-LIVE-VERIFICATION`**

Not observed. This environment has **no Entra tenant admin access** (no `az`
CLI, no tenant/app/FIC credentials; the only Azure secret present is an
*Azure OpenAI* endpoint, which is an LLM API and grants nothing on the Entra
control plane) and **no `fugue-platform` Keycloak realm** (no `kcadm.sh`, no
`keycloakConfigAsCode`, no realm export in-repo). The `login.microsoftonline.com`
host is network-reachable (HTTP 302 to the tenant chooser), but reachability
alone cannot exercise a federated token request or read audit logs without
tenant credentials.

The procedure above is ready to run as-is once a tenant + realm are available.
Per the project standard, no PASS is recorded for an unobserved result.

> **Forecast (explicitly not an observed result, do not cite as PASS):** public
> Microsoft documentation and the `signIns` schema include a
> `federatedCredentialId` property on service-principal sign-ins, which suggests
> a PASS is *likely*. This is a hypothesis to confirm, not a result. The spike
> must still be run before the variant A/B decision is committed in wave 4.

## References

- Design: [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
  — "FIC wiring — two variants" (variant A vs B), "Verify before building" #1,
  Design-decisions row "FIC wiring".
- [Entra workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)
- [client credentials with a federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential)
- [Microsoft Graph `signIns` resource type](https://learn.microsoft.com/en-us/graph/api/resources/signin) — inspect for `federatedCredentialId`, `tokenIssuerName`, `tokenIssuerType`.
- [federatedIdentityCredential resource](https://learn.microsoft.com/en-us/graph/api/resources/federatedidentitycredential)
