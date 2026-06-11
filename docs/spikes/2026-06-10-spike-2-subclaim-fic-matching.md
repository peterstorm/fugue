# Spike 2 — sub-claim mapper × FIC matching

> **Date:** 2026-06-10 · **Spec anchors:** FR-SPK-002, SC-014, US7 ·
> **Gates:** Phase 5 Entra bridge (wave 4) — FIC subject wiring mechanism.
> **Design:** [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
> — "Verify before building" item #2; "Mechanics (both variants)".

## Objective

Confirm that a Keycloak **sub-claim protocol mapper** that rewrites a
service-account's `sub` to the predictable form **`service-account-<client_id>`**
produces a value that **survives Entra's case-sensitive FIC `subject` match**,
exactly as minted — so FIC `subject` values can be written *ahead* of client
creation (config-as-code) instead of read-then-pinned after the `ClientStep`
assigns a random UUID `sub`.

This is the hinge of the design's mechanics note: the service-account `sub` is
"a UUID assigned at client creation, so FIC subjects cannot be written ahead of
time" unless the mapper makes `sub` predictable. Entra matches FIC
`issuer`/`subject`/`audience` **exactly and case-sensitively**; any divergence
(case, prefix, whitespace, or the realm emitting the UUID `sub` instead of the
mapped value) means the assertion silently fails to match and the token request
is rejected. We must prove the *minted* `sub` is byte-for-byte what we wrote
into the FIC.

## Background — the failure modes being ruled out

1. **Mapper does not win.** If the realm still emits the UUID `sub` (mapper
   misconfigured, or a built-in `sub` claim overrides the custom mapper), the
   FIC subject we pre-wrote (`service-account-<client_id>`) never matches.
2. **Case / format drift.** Keycloak's `client_id` casing, or any normalization
   on either side, yields e.g. `service-account-Agent-Alpha` minted vs
   `service-account-agent-alpha` in the FIC. Entra match is case-sensitive →
   silent reject.
3. **Audience drift.** The `entra-exchange` mapper must pin
   `aud: api://AzureADTokenExchange`. If `aud` is an array, an extra entry, or a
   different string, the FIC `audience` match fails independently of `subject`.
4. **Issuer drift.** The realm issuer URL in the assertion `iss` must equal the
   FIC `issuer` exactly (trailing slash, scheme, port — see broker-port note in
   the framework doc).

## Verification procedure (ready-to-run)

### Prerequisites

- A `fugue-platform` Keycloak realm reachable from Entra (public issuer URL +
  JWKS).
- Admin on the realm (`kcadm.sh` or admin REST) and a service-account client
  `agent-alpha`.
- The `fugue-agents` Entra app + admin to create/inspect FICs.

### Steps

1. **Configure the sub mapper** on `agent-alpha` (or on a dedicated client scope
   it carries). Two candidate approaches — test whichever the realm config uses:
   - a **hardcoded-claim** mapper writing `sub = service-account-agent-alpha`,
     or
   - Keycloak's built-in service-account `sub` behavior, confirming whether it
     already emits `service-account-<client_id>` for service accounts.
   Also attach the **`entra-exchange`** client scope (hardcoded
   `aud: api://AzureADTokenExchange`).

2. **Mint** a service-account token and **decode** it (do not eyeball — assert
   exact bytes):
   ```sh
   TOKEN=$(curl -s -X POST \
     "${REALM_ISSUER}/protocol/openid-connect/token" \
     -d grant_type=client_credentials \
     -d client_id=agent-alpha \
     -d client_secret="${AGENT_ALPHA_SECRET}" \
     -d scope=entra-exchange | jq -r .access_token)

   PAYLOAD=$(printf '%s' "$TOKEN" | cut -d. -f2 \
     | tr '_-' '/+' | sed 's/$/==/' | base64 -d 2>/dev/null)
   echo "$PAYLOAD" | jq '{iss, sub, aud}'
   ```
   Capture the **exact** `iss`, `sub`, `aud` strings (note `aud` string-vs-array).

3. **Create the FIC** on `fugue-agents` using **the captured strings verbatim**
   (copy-paste, not retyped): `issuer` = captured `iss`, `subject` = captured
   `sub`, `audience` = `api://AzureADTokenExchange`.

4. **Exchange** the assertion (same `curl` as Spike 1, step 4). A **200 with an
   app-only Graph token** proves all three matched; a **400/401**
   (`AADSTS700213` "No matching federated identity record found for presented
   assertion …", or `AADSTS700024`/`AADSTS50027` for audience/format issues)
   pinpoints which field diverged.

5. **Negative control — prove case-sensitivity bites.** Edit the FIC `subject`
   to flip one character's case (`service-account-Agent-alpha`), re-exchange,
   and confirm it now **fails** with `AADSTS700213`. This proves the match is
   genuinely case-sensitive and the PASS in step 4 was not coincidental.

6. **Reproducibility — prove predictability.** Delete and recreate `agent-alpha`
   via the `ClientStep` path; confirm the *new* client (new UUID) still mints
   `sub = service-account-agent-alpha` and matches the **unchanged** FIC. This
   is the whole point: FIC subject written ahead of client creation, no
   read-then-pin.

## Pass / fail criteria

- **PASS** — step 4 returns a Graph token, step 5 fails as expected
  (case-sensitivity confirmed), and step 6 matches without touching the FIC.
  → Sub-claim mapper is viable; FIC subjects are config-as-code
  (`service-account-<client_id>`), no read-then-pin needed. Record the exact
  mapper config and the verbatim `iss`/`sub`/`aud` strings for the wave-3/4
  runbook.
- **PARTIAL** — token issues only when the FIC subject is the read-after-creation
  UUID, or only with a casing the mapper produces non-deterministically.
  → Mapper approach is not safe for ahead-of-time config; fall back to the
  **read-then-pin** mechanic (read the service-account `sub` after `ClientStep`,
  then write the FIC). Document why.
- **FAIL** — no mapper configuration yields a predictable, case-stable `sub`
  that Entra matches, or `aud`/`iss` cannot be pinned to the FIC's expected
  exact values.
  → Blocker for variant A's ahead-of-time wiring; escalate (read-then-pin, or
  reconsider variant B's single funnel client whose `sub` is pinned once).

## Outcome

**`PENDING-LIVE-VERIFICATION`**

Not observed. No `fugue-platform` Keycloak realm exists in this environment
(no `kcadm.sh`, no `keycloakConfigAsCode` directory, no realm export in-repo)
and no Entra tenant admin access exists to create or test a FIC (the only Azure
credential present is an Azure OpenAI LLM endpoint, which confers nothing on the
Entra control plane). Both halves of the match — minting the assertion and
configuring/exercising the FIC — are therefore unobservable here.

The procedure above is ready to run once a realm and tenant are available. Per
the project standard, no PASS is claimed for an unobserved result. The
case-sensitivity negative control (step 5) and the recreate-and-rematch
reproducibility check (step 6) are mandatory parts of the run — a single 200 is
necessary but not sufficient to call this PASS.

## References

- Design: [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
  — "Mechanics (both variants)" (sub-claim mapper, `entra-exchange` audience
  scope), "Verify before building" #2.
- [Keycloak protocol mappers](https://www.keycloak.org/docs/latest/server_admin/#_protocol-mappers)
  (hardcoded claim / sub mapping; service-account behavior)
- [Entra federated identity credential — subject/issuer/audience match](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust)
  (case-sensitive exact match semantics)
- [client credentials with a federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential)
  (`AADSTS700213` no-matching-FIC error)
