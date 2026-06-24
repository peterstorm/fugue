#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# keycloak-smoke.sh — prove the fugue identity + permission model against a LIVE
# fugue-platform Keycloak realm, WITHOUT any Entra provisioning.
#
# What it proves (the three things wiring this up actually buys us):
#   1. IDENTITY    — the agent client authenticates with its own credentials and
#                    gets a token bearing its own `sub`/`azp` (a real, distinct,
#                    cryptographic identity for the team's agents).
#   2. PERMISSION  — the token carries EXACTLY the scopes the client was granted
#                    in config-as-code (ClientStep.java). A GRANTED scope is
#                    present; an UN-granted scope is silently omitted by Keycloak
#                    (assigning the optional scope IS the authorization, AD-5).
#   3. WIF SHAPE   — the `entra-exchange` scope stamps `aud: api://AzureADTokenExchange`
#                    on the access token only — the exact assertion the host would
#                    later present to Entra. Proven here without ever calling Entra.
#
# It does NOT need: the fugue-agents Entra app, FICs, Graph consent, or any cloud.
# (An OPTIONAL Entra leg runs only if ENTRA_TENANT_ID + ENTRA_CLIENT_ID are set;
#  it will fail with AADSTS70021 until the operator provisions the app + FIC —
#  that's expected and is NOT a failure of the identity/permission model.)
#
# ── Run it from anywhere that can reach the realm (VPN, or an in-cluster jump
#    pod). This laptop CANNOT reach keycloak.onr.oister.dk (HTTP 000) — you need
#    the corporate VPN or a `oc rsh` jump box on the cluster.
#
# Prereqs:  bash, curl, jq.
# Required env:
#   AGENT_CLIENT_SECRET   client secret of the agent client (read from Keycloak
#                         admin console / sealed secret AFTER the realm is applied).
# Optional env (with defaults):
#   KC_HOST               default: keycloak.onr.oister.dk   (stage/ONR public route)
#   KC_REALM              default: fugue-platform
#   AGENT_CLIENT_ID       default: fugue-host-direct-sales   (the per-team identity)
#   GRANTED_SCOPE         default: msgraph:mail.send          (this client HAS it)
#   UNGRANTED_SCOPE       default: msgraph:sites.read         (this client LACKS it)
#   ENTRA_TENANT_ID       (optional) enables the live Entra WIF leg
#   ENTRA_CLIENT_ID       (optional) the fugue-agents app id
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

KC_HOST="${KC_HOST:-keycloak.onr.oister.dk}"
KC_REALM="${KC_REALM:-fugue-platform}"
AGENT_CLIENT_ID="${AGENT_CLIENT_ID:-fugue-host-direct-sales}"
GRANTED_SCOPE="${GRANTED_SCOPE:-msgraph:mail.send}"
UNGRANTED_SCOPE="${UNGRANTED_SCOPE:-msgraph:sites.read}"

ISSUER="https://${KC_HOST}/realms/${KC_REALM}"
TOKEN_URL="${ISSUER}/protocol/openid-connect/token"
ENTRA_AUDIENCE="api://AzureADTokenExchange"

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FATAL: '$bin' not found on PATH" >&2; exit 2; }
done
if [[ -z "${AGENT_CLIENT_SECRET:-}" ]]; then
  echo "FATAL: set AGENT_CLIENT_SECRET (the '${AGENT_CLIENT_ID}' client secret from Keycloak)." >&2
  exit 2
fi

# Decode a JWT payload (base64url, no padding) → pretty JSON. Pure, no network.
jwtpay() { cut -d. -f2 <<<"$1" | tr '_-' '/+' | awk '{l=length%4; if(l)$0=$0 substr("===",1,4-l)}1' | base64 -d 2>/dev/null | jq .; }

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Mint a client_credentials token for the agent, requesting $1 as the scope set.
# Echoes the raw access_token (empty on HTTP error).
mint() {
  local scope="$1"
  curl -sS -X POST "$TOKEN_URL" \
    -d grant_type=client_credentials \
    -d client_id="$AGENT_CLIENT_ID" \
    --data-urlencode client_secret="$AGENT_CLIENT_SECRET" \
    --data-urlencode scope="$scope" \
    | jq -r '.access_token // empty'
}

echo "═══════════════════════════════════════════════════════════════════════════"
echo " fugue-platform identity + permission smoke test (no Entra required)"
echo "   issuer:  $ISSUER"
echo "   client:  $AGENT_CLIENT_ID"
echo "═══════════════════════════════════════════════════════════════════════════"

# ── 1. IDENTITY + 3. WIF SHAPE: mint with the granted scope + entra-exchange ──
hdr "[1] IDENTITY — mint a token as '${AGENT_CLIENT_ID}' (granted scope + entra-exchange)"
GRANTED_TOKEN="$(mint "${GRANTED_SCOPE} entra-exchange")"
if [[ -z "$GRANTED_TOKEN" ]]; then
  no "could not mint a token — check connectivity to ${KC_HOST}, client id, and secret"
  echo; echo "Cannot continue without a token. (If HTTP 000: you're not on the VPN / in-cluster.)" >&2
  exit 1
fi
ok "minted an access token (client authenticated with its own credentials)"
PAYLOAD="$(jwtpay "$GRANTED_TOKEN")"

iss="$(jq -r '.iss' <<<"$PAYLOAD")"
sub="$(jq -r '.sub' <<<"$PAYLOAD")"
azp="$(jq -r '.azp' <<<"$PAYLOAD")"
[[ "$iss" == "$ISSUER" ]]               && ok "iss == ${ISSUER}"                  || no "iss mismatch: got '${iss}'"
[[ -n "$sub" && "$sub" != "null" ]]     && ok "sub present (distinct identity): ${sub}" || no "sub missing"
[[ "$azp" == "$AGENT_CLIENT_ID" ]]      && ok "azp == ${AGENT_CLIENT_ID}"         || no "azp mismatch: got '${azp}'"

hdr "[3] WIF SHAPE — entra-exchange stamps the Entra federation audience"
# aud may be a string or an array; normalise to a newline list and grep.
aud_has() { jq -e --arg a "$1" '(.aud // empty) | (if type=="array" then index($a) else . == $a end)' <<<"$PAYLOAD" >/dev/null 2>&1; }
aud_has "$ENTRA_AUDIENCE" && ok "aud contains ${ENTRA_AUDIENCE} (ready to present to Entra WIF)" \
                          || no "aud does NOT contain ${ENTRA_AUDIENCE} — check entra-exchange scope mapper"

# ── 2. PERMISSION: granted scope present, un-granted scope omitted ──
hdr "[2] PERMISSION — the token carries exactly what the client was granted"
scope_has() { tr ' ' '\n' <<<"$(jq -r '.scope // ""' <<<"$PAYLOAD")" | grep -qx "$1"; }
scope_has "$GRANTED_SCOPE" && ok "GRANTED scope present: ${GRANTED_SCOPE}" \
                           || no "expected granted scope '${GRANTED_SCOPE}' is missing"

# Negative control: request a scope this client was NOT granted. Keycloak silently
# omits unassigned optional scopes — proving "assigning the scope IS the grant".
hdr "[2b] PERMISSION (negative control) — un-granted scope is refused/omitted"
UNGRANTED_TOKEN="$(mint "${UNGRANTED_SCOPE}")"
if [[ -z "$UNGRANTED_TOKEN" ]]; then
  # Some Keycloak configs hard-error on an unknown/forbidden scope — also a valid refusal.
  ok "Keycloak refused to issue a token for un-granted scope '${UNGRANTED_SCOPE}' (hard refusal)"
else
  UNG_SCOPES="$(jwtpay "$UNGRANTED_TOKEN" | jq -r '.scope // ""')"
  if tr ' ' '\n' <<<"$UNG_SCOPES" | grep -qx "$UNGRANTED_SCOPE"; then
    no "un-granted scope '${UNGRANTED_SCOPE}' WAS issued — privilege leak! scopes: ${UNG_SCOPES}"
  else
    ok "un-granted scope '${UNGRANTED_SCOPE}' was OMITTED from the token (fail-closed at grant level)"
  fi
fi

# ── OPTIONAL: live Entra WIF leg (only if an Entra app is configured) ──
if [[ -n "${ENTRA_TENANT_ID:-}" && -n "${ENTRA_CLIENT_ID:-}" ]]; then
  hdr "[4] ENTRA WIF (optional) — present the assertion to Entra for an app-only token"
  ENTRA_RESP="$(curl -sS -X POST "https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token" \
    -d grant_type=client_credentials \
    -d client_id="${ENTRA_CLIENT_ID}" \
    -d scope="https://graph.microsoft.com/.default" \
    -d client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer \
    --data-urlencode client_assertion="${GRANTED_TOKEN}")"
  if jq -e '.access_token' >/dev/null 2>&1 <<<"$ENTRA_RESP"; then
    ok "Entra returned an app-only Graph token — full chain works end to end"
  else
    err="$(jq -r '.error // "unknown"' <<<"$ENTRA_RESP")"
    desc="$(jq -r '.error_description // ""' <<<"$ENTRA_RESP" | head -1)"
    printf '  \033[33mINFO\033[0m Entra rejected the assertion (%s). Expected until the fugue-agents\n' "$err"
    printf '       app + FIC are provisioned (runbook §4). NOT a failure of identity/permission.\n'
    printf '       detail: %s\n' "$desc"
  fi
else
  hdr "[4] ENTRA WIF — skipped (ENTRA_TENANT_ID / ENTRA_CLIENT_ID not set). No Entra needed for the above."
fi

echo
echo "═══════════════════════════════════════════════════════════════════════════"
printf ' Result: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m\n' "$pass" "$fail"
echo "═══════════════════════════════════════════════════════════════════════════"
[[ "$fail" -eq 0 ]]
