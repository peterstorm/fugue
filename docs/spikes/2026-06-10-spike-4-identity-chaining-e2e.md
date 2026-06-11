# Spike #4 — Identity-chaining end-to-end on Keycloak 26.6 (user → agent → Entra)

> **Date:** 2026-06-10 · **Wave:** 1 · **Task:** T3 (verification spike, docs only)
> **Spec anchors:** FR-SPK-004, SC-014, US5, FR-W3-008
> **Status / Outcome:** **`PENDING-LIVE-VERIFICATION`** — no live Keycloak 26.6
> + `fugue-platform` realm was reachable from this environment (evidence in
> [§4](#4-outcome)). The procedure below is complete and ready to run the moment
> infra is up.
>
> This spike is the **HARD GATE** for the wave-3 *user-initiated* capability path.
> It does **not** introduce or run automated tests (`new_tests_required: false`);
> it is a manual verification runbook plus its recorded result.

Design context:
[identity-scoped capabilities plan](../plans/2026-06-10-identity-scoped-capabilities.md)
("Verify before building" item #4) and the
[lead-desk BFF plan](../plans/2026-06-09-lead-desk-bff-dashboard.md)
(verified token-exchange V2 semantics: `sub` stays user, `azp` becomes agent;
WIF assertion audience `api://AzureADTokenExchange`).

---

## 1. Objective & hypothesis

### Objective

Prove that the **composed** user→agent→Entra chain works end-to-end on the
target Keycloak **26.6**, even though the individual features
(Standard Token Exchange V2, JWT Authorization Grant, WIF) are each documented as
individually supported. The composed flow is the open risk
(lead-desk plan, "Is this enough?" residual table: *"Identity-chaining end-to-end
flow status not explicitly labeled in 26.6"*).

The chain under test (the wave-3 **user-initiated** broker path,
identity-scoped-capabilities plan §"For user-initiated runs"):

```
user token (aud: fugue-host, sub: USER)
   │  broker step 1 — Standard Token Exchange V2 (subject = user token)
   │  requesting client = the agent's fugue-platform client
   ▼
exchanged token   sub = USER (unchanged)   azp = AGENT_CLIENT_ID   aud = <internal downstream>
   │  broker step 2 — re-exchange / mint toward the Entra bridge
   │  request the `entra-exchange` client scope (hardcoded aud mapper)
   ▼
WIF assertion     aud = api://AzureADTokenExchange   (issuer = fugue-platform realm)
   │  broker step 3 — client_credentials to Entra, client_assertion = WIF assertion
   ▼
Entra app-only access token for Graph/Dynamics  (FIC matched on issuer+sub+aud)
```

### Hypothesis (what must hold for the gate to PASS)

- **H1 — Exchange preserves the user subject.** A Standard Token Exchange V2 of a
  *user's* access token, performed by the agent's confidential client, returns an
  access token whose **`sub` is still the user** and whose **`azp` is the agent
  client** (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`). This is
  the single-hop `sub`+`azp` delegation attribution the design relies on in lieu
  of an `act` claim.
- **H2 — Audience can be pinned to the Entra bridge.** A token carrying the
  `entra-exchange` client scope is minted with **`aud: api://AzureADTokenExchange`**
  and only that audience (so it is rejected by every internal resource server —
  the anti-replay side effect the plan calls out).
- **H3 — The chain composes.** The output of the user-token exchange can be carried
  forward to produce the WIF assertion (H2) **without** the exchange rejecting the
  flow — i.e. the user-context exchange and the Entra-audience pinning coexist in
  one broker invocation. Keycloak's V1 (impersonation) deprecation/removal does
  **not** break this V2 path on 26.6.
- **H4 — Entra accepts the assertion.** Entra's federated identity credential on
  `fugue-agents` matches the assertion's `issuer` + `subject` + `audience`
  (case-sensitive) and returns an **app-only** Graph/Dynamics access token via
  `client_credentials` with `client_assertion`.

Gate PASSES only if **H1–H4 all hold with observed token evidence.** Any failure
→ gate FAILS and wave-3's user-initiated path is blocked pending redesign.

> **Scope note.** H4 (the Entra hop) belongs to wave-4 infra but is included here
> because the gate is the *end-to-end* chain. If only H1–H3 can be verified against
> Keycloak (no Entra tenant access), record a **PARTIAL PASS (Keycloak segment)**
> and keep H4 `PENDING` rather than claiming the full gate.

---

## 2. Verification procedure

### 2.0 Prerequisites

| Need | Detail |
|---|---|
| Keycloak | **26.6.x** running with the `fugue-platform` realm imported. The config repo currently pins **26.3.1** — see [§4](#4-outcome); bump `keycloak.version` + the `Dockerfile` base image to 26.6 for this spike. |
| Realm | `fugue-platform` with: a `lead-desk` confidential client (or any auth-code client to obtain a user token), an agent client (e.g. `agent-lead-opener`, confidential + service accounts), the `entra-exchange` client scope. The realm does **not exist yet** (wave-3 deliverable) — stand up a throwaway realm for the spike if the real one is not built. |
| A user token | Either a real auth-code login through `lead-desk`, or — for the spike — enable Direct Access Grants on a test client and use ROPC to fetch a user token quickly. |
| Entra (H4 only) | `fugue-agents` app registration with one federated identity credential whose `issuer` = `https://<kc-host>/realms/fugue-platform`, `subject` = the agent client's service-account `sub`, `audience` = `api://AzureADTokenExchange`; ≥1 application permission admin-consented. |
| Tooling | `curl`, `jq`. Helper below decodes a JWT payload. |

```bash
# JWT payload decoder (base64url-safe)
jwtpay() { cut -d. -f2 <<<"$1" | tr '_-' '/+' | awk '{l=length%4; if(l)$0=$0 substr("===",1,4-l)}1' | base64 -d 2>/dev/null | jq .; }

KC=https://localhost:8443           # Keycloak base URL
REALM=fugue-platform
TOKEN=$KC/realms/$REALM/protocol/openid-connect/token
AGENT_ID=agent-lead-opener          # agent confidential client
AGENT_SECRET=__from_realm__
WEBUI_ID=lead-desk                  # auth-code client (user token source)
WEBUI_SECRET=__from_realm__
```

### 2.1 Keycloak config required (config-as-code shape)

These mirror the existing `secondbrands` package
(`java-configuration/.../secondbrands/steps/`). The DSL excerpts below match
`ClientPlanBuilder` (`ClientStep.java`) and `ClientScopeRepresentation`
(`ClientScopesStep.java`) so the spike config can graduate into the real
`fugue-platform` `ClientStep`/`ClientScopesStep` unchanged.

**(a) Token Exchange V2 enabled.** On 26.2+ Standard Token Exchange V2 is the
supported feature flag. Start Keycloak with it on:

```bash
# build/start arg
--features=token-exchange:v2
# (V1 is Preview+Deprecated on 26.6 — do NOT enable token-exchange:v1)
```

Per-client, the requesting (agent) client must be permitted to exchange. In V2
this is the **Standard Token Exchange** toggle on the client
(`Capability config → Standard Token Exchange`), i.e. on the client representation
`attributes["standard.token.exchange.enabled"]="true"`. Add to the agent client in
the builder:

```java
.client("agent-lead-opener")
    .withDisplayName("Agent — lead-opener")
    .confidential()
    .disableStandardFlow()
    .disableDirectAccessGrants()
    .enableServiceAccounts()         // service-account sub = FIC subject
    // standard token exchange v2 enabled (requesting client for the user-token hop)
    .add()
```

**(b) The `entra-exchange` audience client scope.** An **optional** client scope
carrying a *hardcoded-audience* protocol mapper that stamps
`aud: api://AzureADTokenExchange`. Shape mirrors `ClientScopesStep`'s
`ClientScopeRepresentation` usage:

```java
var entraExchange = new ClientScopeRepresentation();
entraExchange.setName("entra-exchange");
entraExchange.setDescription("Audience-pins tokens to the Entra WIF endpoint");
entraExchange.setProtocol("openid-connect");
entraExchange.setAttributes(Map.of(
        "include.in.token.scope", "true",
        "display.on.consent.screen", "false"));

var audMapper = new ProtocolMapperRepresentation();
audMapper.setName("entra-exchange-audience");
audMapper.setProtocol("openid-connect");
audMapper.setProtocolMapper("oidc-audience-mapper");      // hardcoded audience
audMapper.setConfig(Map.of(
        "included.custom.audience", "api://AzureADTokenExchange",
        "access.token.claim", "true",
        "id.token.claim", "false",
        "introspection.token.claim", "false"));
entraExchange.setProtocolMappers(List.of(audMapper));
// create the scope, then assign as an OPTIONAL scope to the agent client
```

Assign `entra-exchange` as an **optional** client scope on the agent client (so it
is only present when explicitly requested via `scope=entra-exchange`), plus the
per-downstream scope mirror (`msgraph:mail.send`, etc.) as optional scopes — the
Keycloak policy grant per the identity-scoped-capabilities plan §"Keycloak side".

> **Open verification item #2 (carried from the plan).** If a sub-claim mapper is
> used to make the service-account `sub` the predictable `service-account-<client_id>`,
> confirm its exact byte output matches Entra's case-sensitive FIC `subject`
> before committing. Step 2.4 surfaces the exact `sub` to copy into the FIC.

### 2.2 Step 1 — get a user token

```bash
# Spike shortcut: ROPC against a direct-access client. In prod this is the
# lead-desk auth-code login; the only thing that matters is sub = a real user.
USER_TOKEN=$(curl -sk $TOKEN \
  -d grant_type=password -d client_id=$WEBUI_ID -d client_secret=$WEBUI_SECRET \
  -d username=testuser -d password=__pw__ -d scope=openid \
  | jq -r .access_token)

jwtpay "$USER_TOKEN"      # EXPECT: "sub": "<user-uuid>", "azp": "lead-desk"
```

### 2.3 Step 2 — Standard Token Exchange V2 of the user token (H1)

The agent client exchanges the **user's** token. `requested_token_type` omitted →
access token; `audience` selects the internal downstream client.

```bash
EXCHANGED=$(curl -sk $TOKEN \
  -u "$AGENT_ID:$AGENT_SECRET" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$USER_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d audience=fugue-host \
  | tee /tmp/exch.json | jq -r .access_token)

cat /tmp/exch.json | jq .          # capture full response (errors included)
jwtpay "$EXCHANGED"
# EXPECT (H1):  "sub" == <user-uuid from 2.2>   AND   "azp" == "agent-lead-opener"
#               "aud" includes "fugue-host"
```

> Note the documented V2 constraints (lead-desk plan §"one design-altering
> constraint"): `subject_token` **must** be an access token (✓ above); V2 does
> **not** accept an `actor_token` and does **not** stamp `act`; V2 **rejects**
> DPoP/mTLS-bound subject tokens with `invalid_request`. Use a plain bearer user
> token for this spike.

### 2.4 Step 3 — produce the WIF assertion pinned to Entra (H2 + H3)

Carry the user-context exchanged token forward and request the `entra-exchange`
scope so the output is audience-pinned to the Entra endpoint. (If the chosen
broker design mints this as a fresh exchange of `$EXCHANGED`, use the exchange
form; if it mints directly off the agent service account for the Entra hop, use
`client_credentials` — run whichever the wave-3 broker implements. Both shown.)

```bash
# Variant 1 — re-exchange the user-context token, narrowing audience to Entra:
WIF=$(curl -sk $TOKEN \
  -u "$AGENT_ID:$AGENT_SECRET" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$EXCHANGED" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d scope=entra-exchange \
  | tee /tmp/wif.json | jq -r .access_token)

# Variant 2 — mint the assertion directly off the agent service account:
WIF=$(curl -sk $TOKEN \
  -d grant_type=client_credentials -d client_id=$AGENT_ID -d client_secret=$AGENT_SECRET \
  -d scope=entra-exchange \
  | tee /tmp/wif.json | jq -r .access_token)

jwtpay "$WIF"
# EXPECT (H2): "aud" == "api://AzureADTokenExchange"  (and NOT any internal aud)
# EXPECT (H3): the call in 2.3 succeeded AND this call succeeded (chain composes)
# RECORD the assertion's "sub" — this is the value the Entra FIC subject must match.
```

### 2.5 Step 4 — Entra exchange (H4)

```bash
# Entra v2 token endpoint; client_assertion = the WIF assertion from 2.4
TENANT=__entra_tenant_id__
APP=__fugue_agents_app_client_id__
GRAPH=$(curl -s "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d grant_type=client_credentials \
  -d client_id=$APP \
  -d scope=https://graph.microsoft.com/.default \
  -d client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer \
  -d client_assertion="$WIF" \
  | tee /tmp/graph.json | jq .)
GRAPH_TOKEN=$(jq -r .access_token /tmp/graph.json)
jwtpay "$GRAPH_TOKEN"
# EXPECT (H4): a Graph token; "roles" (app permissions) present, NO "scp"/user claims
#              (app-only). On failure Entra returns AADSTS70021 (no matching FIC) etc.
```

---

## 3. Pass / fail criteria

| ID | Check (from token dumps captured above) | PASS iff |
|---|---|---|
| H1 | `$EXCHANGED` payload | `sub` equals the user uuid from `$USER_TOKEN`; `azp == "agent-lead-opener"`; HTTP 200 |
| H2 | `$WIF` payload | `aud == "api://AzureADTokenExchange"` and no internal audience present; HTTP 200 |
| H3 | both 2.3 and 2.4 returned `access_token` (no `error` in `/tmp/exch.json`, `/tmp/wif.json`) | both succeed in one broker run |
| H4 | `/tmp/graph.json` | contains `access_token`; payload is app-only (`roles` present, no user `scp`); HTTP 200 |
| **Gate** | — | **all of H1–H4 PASS.** H1–H3 PASS with H4 `PENDING` → record **PARTIAL PASS (Keycloak segment)**, gate not yet cleared. Any explicit failure → **FAIL** |

Negative controls (should fail — confirms pinning works):
- The `$WIF` token presented to an internal `fugue-host` resource server → **must
  be rejected** (audience mismatch). Confirms the anti-replay side effect.
- An exchange attempt by a client **without** Standard Token Exchange enabled →
  **must return `access_denied`/`invalid_client`**. Confirms Keycloak is the PEP.

---

## 4. Outcome

**`PENDING-LIVE-VERIFICATION`** — live infra was unavailable in this environment.
The procedure above was **not executed**; no PASS is claimed.

Evidence gathered 2026-06-10 from this environment:

| Probe | Result |
|---|---|
| Common Keycloak ports `localhost:8080` / `:8443` | **closed** (`nc -z` both refused) |
| `docker` CLI | **not installed** (`docker not available`) |
| `podman` machine `podman-machine-default` | present but **down** — `Cannot connect to Podman socket … connection refused`; last up ~4 weeks ago. Nothing can be stood up without starting it. |
| `keycloakConfigAsCode` Keycloak version | **26.3.1** (`Dockerfile: FROM quay.io/keycloak/keycloak:26.3.1`; `pom.xml: <keycloak.version>26.3.1`) — **not 26.6**, the spike's target. V2 exchange (26.2+) is present at 26.3.1, but the 26.6 JWT-grant-supported + identity-chaining story this gate targets is not. |
| `fugue-platform` realm package | **does not exist.** Only `toolbox` and `secondbrands` realm packages exist under `java-configuration/.../configuration/`. The realm and the agent client / `entra-exchange` scope this spike exercises are unbuilt wave-3 deliverables. |
| Entra `fugue-agents` app + FIC | not provisioned (wave-4 deliverable); no tenant access from here. |

**Why this is honest, not a deferral.** Three independent blockers each
individually prevent execution: (1) no container runtime is live to run any
Keycloak; (2) the available config pins 26.3.1, not the 26.6 the gate names; and
(3) the `fugue-platform` realm + agent client + `entra-exchange` scope + Entra FIC
that the chain runs through have not been built yet. The spike cannot legitimately
report PASS/FAIL until at least a 26.6 Keycloak with a throwaway realm matching
§2.1 is reachable.

**To run it (unblock checklist):**
1. `podman machine start` (or install/start Docker).
2. Bump `keycloak.version` → `26.6.x` and the `Dockerfile` base image; rebuild.
   Bring up `keycloakConfigAsCode/docker/docker-compose.local.yml`.
3. Apply the §2.1 config (agent client with Standard Token Exchange + service
   accounts; `entra-exchange` optional scope) to a `fugue-platform` realm (real,
   once wave-3 builds it, or a throwaway for the spike).
4. Run §2.2 → §2.4 and record H1–H3 with `jwtpay` dumps. If an Entra tenant +
   `fugue-agents` FIC are available, run §2.5 for H4; otherwise mark H4 `PENDING`
   and record **PARTIAL PASS (Keycloak segment)**.
5. Replace this section with the captured token payloads (redact secrets; `sub`
   uuids and `azp`/`aud` claims are the load-bearing evidence) and the final
   verdict.

---

## 5. References

- Design — verification item #4 + broker user-initiated path:
  [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
  (§"For user-initiated runs", §"Verify before building" #4, §"Mechanics" —
  `aud: api://AzureADTokenExchange` hardcoded-audience `entra-exchange` scope).
- Verified V2 semantics + residual gap this gate closes:
  [2026-06-09-lead-desk-bff-dashboard.md](../plans/2026-06-09-lead-desk-bff-dashboard.md)
  (§"one design-altering constraint" — V2 internal→internal, no `act`, access-token
  subject only, rejects DPoP/mTLS subject; §"Living without act" — `sub`+`azp`;
  §"Is this enough?" residual row — *"Identity-chaining end-to-end flow status not
  explicitly labeled in 26.6"*).
- Keycloak [Token Exchange](https://www.keycloak.org/securing-apps/token-exchange) ·
  [OAuth Identity and Authorization Chaining Across Domains](https://www.keycloak.org/securing-apps/oauth-identity-authorization-chaining-across-domains) ·
  [Standard Token Exchange GA (26.2)](https://www.keycloak.org/2025/05/standard-token-exchange-kc-26-2) ·
  [26.6.0 release notes](https://www.keycloak.org/2026/04/keycloak-2660-released) ·
  [JWT Authorization Grant](https://www.keycloak.org/2026/01/jwt-authorization-grant)
- Entra [workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) ·
  [client credentials with a federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential)
- House config patterns this spike mirrors:
  `keycloakConfigAsCode/java-configuration/src/main/java/dk/secondbrand/keycloak/configuration/secondbrands/steps/ClientStep.java`
  (`ClientPlanBuilder` DSL) and `.../secondbrands/steps/ClientScopesStep.java`
  (`ClientScopeRepresentation` + protocol-mapper shape).
