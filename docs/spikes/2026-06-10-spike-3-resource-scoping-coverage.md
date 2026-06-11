# Spike 3 — resource-scoping coverage

> **Date:** 2026-06-10 · **Spec anchors:** FR-SPK-003, SC-014, US7 ·
> **Gates:** Phase 5 Entra bridge (wave 4) — resource-scoping policies as the
> Entra-side bound on the union-permission token.
> **Design:** [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
> — "Verify before building" item #3; "Bounding the union — resource-scoping
> policies, not more apps".

## Objective

Confirm that the two Entra-native resource-scoping mechanisms the design relies
on to bound the `fugue-agents` union-permission token **actually cover the Graph
surfaces the agents need** — *and no more*:

1. **`Sites.Selected`** (instead of `Sites.Read.All` / `Sites.ReadWrite.All`)
   grants the app access to **exactly the specific SharePoint sites** the agents
   operate on, and **denies** every other site.
2. **Exchange application access policies** restrict `Mail.Send` (and any
   `Mail.Read`) to **only the lead-desk shared mailbox**, and **deny** sending
   as / reading any other tenant mailbox.

This is the linchpin of the "one app, broad token, narrowed *where* it can act"
trade-off. The design explicitly accepts that app-only tokens cannot be
downscoped per request (`.default` carries the full union every time); the
*only* Entra-side containment is these two policies. If either fails to cover a
needed operation, an agent breaks; if either fails to *deny* out-of-scope
targets, the blast-radius bound the whole one-app decision depends on is
illusory. Both directions must be proven.

## Background — the two policies

- **`Sites.Selected`** is an application permission that grants *no* site access
  by itself. Per-site grants are written via Graph
  (`POST /sites/{siteId}/permissions`) with a `read`/`write`/`fullControl` role
  bound to the `fugue-agents` app's identity. The token still carries
  `Sites.Selected` for every call; SharePoint enforces per-site at the resource.
- **Exchange application access policy** (`New-ApplicationAccessPolicy`,
  Exchange Online PowerShell) ties the app's `Mail.*` application permissions to
  a **mail-enabled security group**; the app can only act on mailboxes that are
  members of that group. `Mail.Send` as a non-member mailbox returns
  `ErrorAccessDenied`.

## Verification procedure (ready-to-run)

### Prerequisites

- `fugue-agents` app holding `Mail.Send` and `Sites.Selected` as
  **application** permissions, admin-consented.
- An app-only Graph token for `fugue-agents` (obtained via the FIC exchange of
  Spike 1/2, or directly with the app secret for this isolation test).
- Tenant admin for: Graph site-permission grants; Exchange Online PowerShell
  (`New-ApplicationAccessPolicy`).
- Targets: the **lead-desk shared mailbox** (`leaddesk@<tenant>`), one
  **in-scope SharePoint site** (the site(s) agents use), one **out-of-scope
  control mailbox**, and one **out-of-scope control site**.

### Part A — `Sites.Selected` coverage

1. **Grant** the in-scope site to the app:
   ```sh
   curl -s -X POST -H "Authorization: Bearer ${GRAPH_ADMIN_TOKEN}" \
     -H "Content-Type: application/json" \
     "https://graph.microsoft.com/v1.0/sites/${IN_SCOPE_SITE_ID}/permissions" \
     -d '{"roles":["write"],"grantedToIdentities":[{"application":{"id":"'"${FUGUE_AGENTS_APP_CLIENT_ID}"'","displayName":"fugue-agents"}}]}'
   ```
2. **Positive** — with the **app-only** token, exercise the real operations the
   agents need against the in-scope site (list/read the document library,
   read/write the specific drive items). Expect 200/201.
   ```sh
   curl -s -H "Authorization: Bearer ${APP_TOKEN}" \
     "https://graph.microsoft.com/v1.0/sites/${IN_SCOPE_SITE_ID}/drive/root/children" | jq '.value | length'
   ```
3. **Negative** — same token against the **out-of-scope** site. Expect **403
   `accessDenied`** (proves `Sites.Selected` is not silently behaving like
   `Sites.Read.All`).

### Part B — Exchange application access policy coverage

4. **Create** the policy scoping `fugue-agents` to a group containing only the
   lead-desk mailbox:
   ```powershell
   New-ApplicationAccessPolicy `
     -AppId $fugueAgentsAppId `
     -PolicyScopeGroupId leaddesk-scope@$tenant `
     -AccessRight RestrictAccess `
     -Description "fugue-agents: lead-desk mailbox only"
   ```
   Then `Test-ApplicationAccessPolicy -Identity leaddesk@$tenant -AppId $fugueAgentsAppId`
   → expect `AccessCheckResult: Granted`; run the same `Test-` against the
   control mailbox → expect `Denied`.
5. **Positive** — with the **app-only** token, send mail **from the lead-desk
   mailbox** (the actual agent operation):
   ```sh
   curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer ${APP_TOKEN}" \
     -H "Content-Type: application/json" \
     "https://graph.microsoft.com/v1.0/users/leaddesk@${TENANT}/sendMail" \
     -d '{"message":{"subject":"spike-3","body":{"contentType":"Text","content":"resource-scoping coverage check"},"toRecipients":[{"emailAddress":{"address":"sink@'"${TENANT}"'"}}]},"saveToSentItems":false}'
   ```
   Expect **202 Accepted**, and confirm the message actually lands.
6. **Negative** — same token, `sendMail` from the **control mailbox**. Expect
   **403 `ErrorAccessDenied` / `ApplicationAccessPolicy`**.
7. **Propagation note:** Exchange application access policy changes can take up
   to ~30 min to take effect; if a negative check unexpectedly passes
   immediately after policy creation, re-run after the propagation window before
   recording a result.

## Pass / fail criteria

- **PASS** — Part A: in-scope site operations the agents need all succeed (2),
  out-of-scope site is denied (3). **And** Part B: send-from-lead-desk succeeds
  and is delivered (5), control mailbox is denied (6).
  → Both resource-scoping mechanisms cover the needed surfaces while denying the
  rest; the one-app union-with-policies design is sound for wave 4. Record the
  exact site ids, the scope group, and every Graph surface that was exercised.
- **PARTIAL** — a needed operation is denied (under-coverage: a real Graph
  surface the agents require isn't reachable under the policy), **or** an
  out-of-scope target is *not* denied (over-coverage / containment hole).
  → Enumerate the specific gap. Under-coverage may mean a missing per-site role
  (`write` vs `read` vs `fullControl`) or a Graph surface `Sites.Selected`
  doesn't govern. Over-coverage is a blast-radius hole that must be resolved
  before wave 4 — possibly the design's "apps per permission *tier*" escalation.
- **FAIL** — either mechanism cannot express the needed scoping at all (e.g. an
  agent Graph surface is not site-scoped and `Sites.Selected` cannot bound it,
  or `Mail.Send` cannot be restricted to a single mailbox).
  → The Entra-side bound the one-app decision depends on does not hold for that
  surface; escalate to permission-tier apps or rethink the capability.

## Outcome

**`PENDING-LIVE-VERIFICATION`**

Not observed. This environment has **no Entra tenant admin access**, **no
Exchange Online PowerShell connection**, and **no `fugue-agents` app or
app-only Graph token** (the only Azure credential present is an Azure OpenAI
LLM endpoint, which grants nothing on Graph, SharePoint, or Exchange). The
target lead-desk mailbox and the specific SharePoint sites are likewise not
reachable from here. None of the positive or negative checks can be exercised.

Code-side context that bounds the surfaces to test (verified in-repo, not a
substitute for the live run): `packages/adapter-ms-graph/src/index.ts` shows the
Graph adapter calls `https://graph.microsoft.com/v1.0` with `.default`-scoped
app-only tokens and operates on drives / sites / drive-items — i.e. the
SharePoint surfaces Part A must cover. The mail-send surface (Part B) is the
lead-desk capability from the design. The exact site ids and scope group are
deployment artifacts not present in this repo and must be supplied at run time.

The procedure above is ready to run once a tenant, the `fugue-agents` app, the
lead-desk mailbox, and the target sites are available. Both the positive
(coverage) and negative (containment) checks are mandatory — a green positive
path alone does **not** justify a PASS, because the entire value of these
policies is what they *deny*. Per the project standard, no PASS is claimed for
an unobserved result.

## References

- Design: [2026-06-10-identity-scoped-capabilities.md](../plans/2026-06-10-identity-scoped-capabilities.md)
  — "Bounding the union — resource-scoping policies, not more apps",
  "Escalation path — apps per permission *tier*", "Verify before building" #3.
- Code seam (SharePoint surfaces): `packages/adapter-ms-graph/src/index.ts`
- [Sites.Selected overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
  · [grant per-site permissions](https://learn.microsoft.com/en-us/graph/api/site-post-permissions)
- [Limit mailbox access — Exchange application access policies](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
  · [`New-ApplicationAccessPolicy`](https://learn.microsoft.com/en-us/powershell/module/exchange/new-applicationaccesspolicy)
  · [`Test-ApplicationAccessPolicy`](https://learn.microsoft.com/en-us/powershell/module/exchange/test-applicationaccesspolicy)
