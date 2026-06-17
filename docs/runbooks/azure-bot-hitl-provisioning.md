# Runbook — Azure Bot + Entra provisioning for HITL Teams approvals (Phase 1′)

**Status:** authoring complete; **live provisioning + Teams smoke test DEFERRED to operator** (see [STATUS / HANDOFF](#status--handoff)).
**Owner of the live steps:** operator (Peter Hansen).
**Tracking:** GitHub issue [#24](https://github.com/peterstorm/fugue/issues/24) — must be completed before production HITL go-live.
**Scope:** the *in-Teams interactive* HITL transport (Bot Framework Approve/Reject Adaptive Cards). This is the operator-executed half of **Phase 1′ — HITL go-live** in
[`docs/team-security-and-capabilities.md` §7](../team-security-and-capabilities.md#7-implementation-plan--phases-files-data-flow-testing).

> **What this runbook is NOT.** It is *not* the `fugue-agents` Entra app +
> Workload-Identity-Federation runbook for the **capability broker** (LLM/Graph
> token minting). That is a separate Entra app and a separate deliverable —
> [`docs/team-security-and-capabilities.md` Appendix A](../team-security-and-capabilities.md#appendix-a--fugue-agents-entra-provisioning-runbook).
> The Azure Bot below uses its **own** Entra app registration (the bot's app id /
> password), unrelated to `fugue-agents`. Do not conflate the two.

---

## 0. Why this is purely an ops task

The HITL Teams code is **code-complete and merged** — the remaining work is Azure
provisioning + config, no code changes. The seams that exist today (all verified
against `main` at authoring time):

| Concern | Code (verified path) | Notes |
|---|---|---|
| Inbound messaging endpoint | `packages/host/src/http/router.ts:86` mounts `app.post("/teams/messages", …)` | Registered **before** the team-token auth middleware (Teams authenticates with a Bot Framework JWT, not a `fug_` token). Only mounted when `deps.teamsBot` is wired, i.e. when `BOT_APP_ID`/`BOT_APP_PASSWORD` are set. |
| Inbound auth (fail-closed) | `packages/host/src/hitl/adapters/bot/verify.ts` | Verifies the inbound `Authorization: Bearer <jwt>` against the Bot Framework JWKS; enforces issuer `https://api.botframework.com` and **audience = the bot's app id** (`BOT_APP_ID`), RS256 only. Any failure → 401; JWKS fetch failure → 503. |
| Activity handling | `packages/host/src/hitl/adapters/bot/messages-handler.ts` | `conversationUpdate` (bot added) → persist conversation reference (default + per-team via `HITL_TEAM_CHANNELS`); `invoke adaptiveCard/action` with our verb → **authorize the clicker against the run's team** (see below), then record the decision and refresh the card. |
| **In-Teams approver authz (per-team)** | `messages-handler.ts` + `hitl/identity.ts` (`approverTeamIdentity`) | The button click carries the clicker's `from.aadObjectId`; it is resolved through `HITL_APPROVER_TEAMS` (fail-closed on an unknown id) and gated on the SAME `canAccessDag` predicate the HTTP approve path uses, against the run's DAG-owning team. A non-member's (or unknown user's) click is refused and `recordDecision` is never called (SC-006). |
| Adaptive Card | `packages/host/src/hitl/adapters/bot/card.ts` | AdaptiveCard v1.4, Approve/Reject `Action.Execute` (verb `fugue.review`) with a required reason on reject. |
| Proactive send | `packages/host/src/hitl/adapters/bot/connector.ts` | Mints an app-only connector token via `client_credentials` using `BOT_APP_ID` + `BOT_APP_PASSWORD`; default token endpoint `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`, scope `https://api.botframework.com/.default`. Single-tenant bots override via `BOT_TOKEN_URL`. |
| `serviceUrl` allowlist | `packages/host/src/hitl/adapters/bot/trusted-host.ts` | The connector only ever sends its bearer token to `*.botframework.com` / `*.skype.com` / `smba.trafficmanager.net` (SSRF / credential-leak defence). |
| Suspend → 202 → poll | `packages/host/src/http/handlers/run-dag.ts:185` (`startRun`), returns `202 {runId}` | A DAG with a `humanReview` gate runs on the durable HITL engine instead of inline. |
| Approve (HTTP parity path) | `packages/host/src/http/handlers/runs.ts` — `POST /runs/:runId/approve`, `GET /runs/:runId` | The button path mirrors this; both end in `HitlRunService.recordDecision` (`packages/host/src/hitl/service.ts`). |
| Boot-time config pairing | `packages/host/src/domain/config.ts` (`superRefine`) | `BOT_APP_ID` set ⇒ `BOT_APP_PASSWORD` **required**; `BOT_TOKEN_URL` must be `https://`. The pair is enforced at startup, not on first review. |

> **In-Teams approver authorization (now enforced — read before installing).**
> As of Phase 4 (commit `86f82db`), the in-Teams button path **does** bind the
> clicking user to the run's owning team, at parity with the HTTP approve path.
> The clicker's `from.aadObjectId` is resolved through `HITL_APPROVER_TEAMS`
> (config map: `aadObjectId → team ids`) to an approver identity — **fail-closed on
> an unknown id** — and gated on the same `canAccessDag` check the HTTP path uses
> (`messages-handler.ts`; `approverTeamIdentity` in `hitl/identity.ts`). A
> non-member's or unmapped user's click is **refused without recording** (SC-006).
> Per-team conversation routing (`HITL_TEAM_CHANNELS`) additionally delivers each
> team's cards to its own channel.
>
> **Operational requirement:** you MUST populate `HITL_APPROVER_TEAMS` with the
> AAD object id → team mapping for every approver, or **no one** can approve (the
> gate fails closed — an empty/absent map authorizes nothing). The old
> "single-team-per-channel" deployment invariant is **no longer a security
> requirement** — cross-team approval is prevented by the authz gate itself —
> though per-team channels remain good practice for confidentiality.

---

## 1. Prerequisites

- A Microsoft 365 / Entra tenant with rights to create an **Azure Bot** resource
  and an **Entra app registration**, and to upload a **Teams app** (sideload or
  admin-approved) into the target team/channel.
- A **publicly reachable HTTPS** base URL for the running fugue host (the Bot
  Framework service must be able to POST to it). The messaging endpoint must be
  HTTPS.
- The fugue host deployable with environment variables (this is the only fugue-side
  change — all docs/config, no code).

---

## 2. Provision the Azure Bot + its Entra app registration

The Azure Bot resource carries a **Microsoft App ID** and an associated **client
secret**; these become `BOT_APP_ID` and `BOT_APP_PASSWORD`. The exact creation UI
varies; the load-bearing outputs are what the host needs.

1. **Azure portal → Create a resource → Azure Bot.**
   - Bot handle: e.g. `fugue-hitl-bot`.
   - **Type of App / Microsoft App ID:** create a **new** Entra app registration
     (single-tenant is the common case; if you choose single-tenant you MUST set
     `BOT_TOKEN_URL` in step 4). Record the **Microsoft App ID** → this is
     `BOT_APP_ID`.
2. **Create a client secret** for that app registration
   (App registrations → your bot app → Certificates & secrets → New client
   secret). Copy the **secret value** immediately → this is `BOT_APP_PASSWORD`.
   - SENSITIVE. Per `.env.example` and `config.ts`, never log or commit it.
3. **Enable the Microsoft Teams channel** on the Azure Bot
   (Azure Bot → Channels → Microsoft Teams → apply).

**Acceptance:** the bot has a Microsoft App ID, a valid (un-expired) client secret,
and the Teams channel enabled.

---

## 3. Set the messaging endpoint → `POST /teams/messages`

The Azure Bot's **Messaging endpoint** must point at the fugue host's bot route.

- Azure Bot → Configuration → **Messaging endpoint** =
  `https://<your-fugue-host>/teams/messages`
  (route verified at `packages/host/src/http/router.ts:86`).

**Acceptance:** the endpoint is saved and is HTTPS. (The route is only live once
`BOT_APP_ID`/`BOT_APP_PASSWORD` are configured on the host — see step 4 — because
`/teams/messages` is mounted only when `deps.teamsBot` is wired.)

---

## 4. Configure the fugue host

Set these on the host (cross-checked against
[`packages/host/.env.example`](../../packages/host/.env.example) and
`packages/host/src/domain/config.ts` — do not invent names):

| Variable | Value | Required? |
|---|---|---|
| `BOT_APP_ID` | the Azure Bot's Microsoft App ID (step 2.1) | enables the in-Teams transport |
| `BOT_APP_PASSWORD` | the client secret (step 2.2) — SENSITIVE | **required when `BOT_APP_ID` is set** (enforced at boot, `config.ts` superRefine) |
| `BOT_TOKEN_URL` | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` | **required for single-tenant bots**; omit for multi-tenant (defaults to the `botframework.com` login). Must be `https://`. |
| `HITL_APPROVAL_BASE_URL` | your public host URL (e.g. `https://fugue.example.com`) | recommended; used to build deep-links |
| `HITL_APPROVER_TEAMS` | JSON `aadObjectId → string[]` (team ids) for every approver, e.g. `{"<aad-oid>":["business-sales"]}` | **required for in-Teams approvals** — the button-path authz gate fails closed without it (no one can approve) |
| `HITL_TEAM_CHANNELS` | JSON `aadGroupId → fugue team id`, e.g. `{"<aad-group-id>":"business-sales"}` | optional; routes each team's cards to its own channel (confidentiality) |

Notes:
- Setting `BOT_APP_ID`/`BOT_APP_PASSWORD` **takes precedence over** `TEAMS_WEBHOOK_URL`
  when both are present (the in-Teams interactive transport wins).
- A host with **none** of the HITL vars set still boots and runs DAGs (a DAG
  declaring a `humanReview` gate returns 501 until a transport is configured).

**Acceptance:** the host boots without a config error (the `BOT_APP_ID` ⇒
`BOT_APP_PASSWORD` pairing and the `BOT_TOKEN_URL` https check both pass), and
`GET /health` is green.

---

## 5. Build + install the Teams app manifest

The Azure Bot needs a Teams app package (manifest + icons) so the bot can be added
to a channel.

1. Create a Teams app manifest (`manifest.json`) whose `bots[].botId` = `BOT_APP_ID`,
   with the `team`/`groupChat` scopes as needed and `supportsCalling`/`supportsVideo`
   = false.
2. Zip the manifest + a colour and outline icon; upload via Teams (Apps → Manage
   your apps → Upload a custom app) or your tenant's app catalog.
3. **Add the bot to the target channel.** This fires a `conversationUpdate`
   activity → the host persists the conversation reference
   (`messages-handler.ts` → `conversation-store.ts`), which is where proactive
   review cards will be posted.

**Acceptance:** the bot appears in the channel, and the host logs
`hitl/bot: captured default conversation reference for proactive reviews`
(and `captured per-team conversation reference` when the channel's `aadGroupId` is
mapped in `HITL_TEAM_CHANNELS`). Approval authorization is enforced per-team via
`HITL_APPROVER_TEAMS` (§0), so a card reaching the wrong channel still cannot be
actioned by a non-member — channel placement is now confidentiality, not the
access gate.

---

## 6. Manual smoke test — suspend → card → approve → resume

This is the end-to-end acceptance for go-live. Pick (or author) a DAG that declares
a `humanReview` gate so the run parks instead of completing inline.

1. **Suspend.** Trigger the DAG (`POST /dags/:dagId/run` with a valid team token).
   Because it gates on `humanReview`, the host hands it to the durable HITL engine
   and returns **`202 { runId, status: "queued" }`** instead of an
   inline result (`run-dag.ts:185-192`). Poll `GET /runs/:runId` until
   `status: "suspended"` with a `review.{nodeId,prompt}` (`runs.ts` `statusView`).
2. **Card delivered.** The `onHumanReview` hook fires the notifier, which posts the
   Adaptive Card (Approve/Reject, verb `fugue.review`) proactively into the channel
   via the connector (`connector.ts` → `sendToConversation`). Confirm the card
   appears in Teams with the output-under-review and the two buttons.
3. **Approve.** Click **Approve** on the card. Teams POSTs an
   `invoke adaptiveCard/action` to `https://<host>/teams/messages`; the handler
   verifies the Bot Framework JWT (`verify.ts`), parses the run/node ids
   (parse-don't-validate), confirms the gate is still open at that node, and calls
   `HitlRunService.recordDecision` (`messages-handler.ts` → `service.ts`). The card
   refreshes in place to "Approved by …".
   - *(Optional parity check: the same decision can be made out-of-band via
     `POST /runs/:runId/approve` `{ "decision": "approve" }` — `runs.ts`. Use this
     to sanity-check the engine independently of Teams.)*
4. **Resume.** `recordDecision` re-enqueues the run; the worker resumes it from its
   checkpoint and drives it to completion. Poll `GET /runs/:runId` until
   `status: "completed"` (with `output`). That transition — suspended → approved →
   completed — is the PASS condition.

**Acceptance (PASS):** a single run observed transitioning
`suspended` → (card delivered) → (Approve clicked) → `completed`, with the card
refreshing to the approved outcome. Record the `runId`, the UTC time, and the
observed final status.

> **Reject path (optional but recommended):** repeat with **Reject** + a reason and
> confirm the run resolves to `failed`/rejected per the DAG's gate handling and the
> card refreshes to "Rejected by …".

---

## STATUS / HANDOFF

**Live provisioning + Teams smoke test: DEFERRED — owner: operator (Peter Hansen).
NOT yet executed (no live Azure/M365 tenant at authoring time, 2026-06-16).**

This runbook (steps 1–6) is written and verified against the merged, code-complete
HITL Teams implementation on `main`. No code change is required to execute it —
it is Azure/M365 provisioning + host config only. Nothing below has been performed;
do not treat any step as done until the operator ticks it.

### Operator checklist (tick when done)

- [ ] **Azure Bot + Entra app created** — Microsoft App ID obtained; client secret created; Teams channel enabled (§2).
- [ ] **Messaging endpoint set** to `https://<host>/teams/messages` (§3).
- [ ] **`BOT_APP_ID` / `BOT_APP_PASSWORD` configured** on the host (+ `BOT_TOKEN_URL` if single-tenant); host boots clean, `/health` green (§4).
- [ ] **`HITL_APPROVER_TEAMS` populated** with every approver's `aadObjectId → team ids` (§4) — without it the button-path authz gate fails closed and no approval can be recorded.
- [ ] **Teams app manifest installed + bot added to its channel(s)** (§5); set `HITL_TEAM_CHANNELS` if routing per-team cards.
- [ ] **Cross-team refusal verified** — a click from a user NOT in `HITL_APPROVER_TEAMS` for the run's team is refused with "not authorized" and records nothing (SC-006).
- [ ] **Smoke test PASS** — one run observed `suspend → Adaptive Card delivered → Approve → resume → completed` (§6).
- [ ] **Result recorded** — `runId`, UTC time, and final status captured here (or in issue #24).

### Result record (operator fills in)

```
Date (UTC):        __________
Bot App ID:        __________ (do NOT record the secret)
Messaging endpoint: __________
Smoke-test runId:  __________
Outcome:           PASS / FAIL  — final status: __________
Notes:             __________
```

**Gate:** this checklist must be fully ticked (smoke test PASS, result recorded)
**before production HITL go-live.** Tracked on GitHub issue
[#24](https://github.com/peterstorm/fugue/issues/24).
