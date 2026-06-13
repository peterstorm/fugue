# Human-in-the-loop approvals in Microsoft Teams

Fugue can pause a DAG at a `humanReview` gate and resume it on a human decision
delivered through Microsoft Teams. The mechanism is durable: a paused run holds
no HTTP connection and survives host restarts (ADR-0060).

There are **two transports**. Both use the same durable engine; they differ only
in how the review is delivered and how the decision comes back.

| Transport | Delivery | Decision | Setup |
|---|---|---|---|
| **Webhook** (smoke-test) | Incoming Webhook posts an Adaptive Card | Card **links out** to a host approval page | Just a webhook URL |
| **Bot Framework** (in-Teams) | Bot posts a card proactively | **Approve/Reject buttons inside Teams** | Azure Bot + app manifest |

The Bot Framework transport is selected when `BOT_APP_ID`/`BOT_APP_PASSWORD` are
set; it takes precedence over `TEAMS_WEBHOOK_URL`.

## Run lifecycle

```
POST /dags/<id>/run            (HITL DAG)
  → 202 { runId, status: "queued" }            # non-HITL DAGs still return 200
  → worker executes until the humanReview gate
  → run PARKS (suspended), a Teams review card is posted
... (hours/days; nothing held) ...
  reviewer acts in Teams (button)  OR  POST /runs/<runId>/approve
  → decision recorded, run re-enqueued
  → worker resumes from the durable checkpoint → completes

GET  /runs/<runId>             # poll status: queued|running|suspended|completed|failed
POST /runs/<runId>/approve     # webhook/manual path; body { decision, ... }
POST /teams/messages           # Bot Framework inbound (button clicks); BF-JWT auth
```

`POST /runs/:runId/approve` body:

```jsonc
{ "decision": "approve" }
{ "decision": "reject", "reason": "..." }
{ "decision": "approve-with-edit", "newOutput": { /* ... */ } }
{ "decision": "reroute", "targetNodeId": "draft", "reason": "..." }
```

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `TEAMS_WEBHOOK_URL` | webhook transport | Incoming Webhook (Workflows) URL |
| `HITL_APPROVAL_BASE_URL` | webhook transport | Public host URL for the card's approval link (`<base>/runs/<id>`) |
| `BOT_APP_ID` | bot transport | Azure Bot / Entra app (client) id |
| `BOT_APP_PASSWORD` | bot transport | Bot app client secret |
| `BOT_TOKEN_URL` | optional | Override the BF token endpoint (single-tenant bots) |
| `HITL_RUN_TTL_SEC` | optional | TTL for persisted runs/decisions (default 7 days) |
| `HITL_LOCK_TTL_SEC` | optional | Single-flight lock TTL per execution slice (default 300s) |
| `HITL_WORKER_CONCURRENCY` | optional | Concurrent run slices (default 4) |

Setting any HITL transport also requires Redis (already a host dependency) and
constructs a BullMQ queue backend over `REDIS_URL`.

## Provisioning the Bot Framework transport (in-Teams buttons)

> Nothing below is needed for the webhook smoke-test transport.

1. **Create an Azure Bot resource** (Azure Portal → *Azure Bot*). Choose a
   *Multi-tenant* (or single-tenant) Microsoft App. Note the **App ID**.
2. **Create a client secret** for the app (Entra → App registrations → your app
   → Certificates & secrets). This is `BOT_APP_PASSWORD`; the App ID is
   `BOT_APP_ID`. For single-tenant, set `BOT_TOKEN_URL` to
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`.
3. **Set the messaging endpoint** on the Azure Bot to
   `https://<your-host>/teams/messages`. The host verifies the inbound Bot
   Framework JWT (issuer `https://api.botframework.com`, audience = `BOT_APP_ID`)
   against the BF JWKS — there is no shared secret on the inbound path.
4. **Enable the Microsoft Teams channel** on the Azure Bot.
5. **Package the Teams app**: zip `manifest.json` (in this directory) with a
   `color.png` (192×192) and `outline.png` (32×32) icon. `${{BOT_APP_ID}}` is
   substituted with your App ID (the Teams Developer Portal / Toolkit does this,
   or replace by hand).
6. **Upload / sideload** the app to your team (Teams → Apps → Manage your apps →
   Upload a custom app) and **add it to the channel** that should receive
   reviews. Adding the bot fires a `conversationUpdate` the host captures as the
   default conversation reference — proactive review cards post there.

### Verify

- Run a `humanReview` DAG → a card with **Approve**/**Reject** appears in the
  channel.
- Click a button → the card refreshes ("Approved by …") and `GET /runs/<id>`
  shows `completed`/`failed`.
- No card? Confirm the bot was added to the channel (the host log shows
  "captured conversation reference") and the messaging endpoint is reachable.

## Security notes

- The inbound `/teams/messages` endpoint is **not** behind the fugue team-token
  middleware; it authenticates the Bot Framework JWT itself and fails closed
  (401 on a bad token, 503 if the JWKS is briefly unreachable). The JWT is
  verified against the BF JWKS with an explicit `RS256` algorithm allowlist and a
  60s clock tolerance.
- The captured `serviceUrl` (where proactive cards are POSTed, with an app-only
  bearer token attached) is **allowlisted** to Microsoft Bot Framework / Teams
  hosts (`*.botframework.com`, `*.skype.com`, `smba.trafficmanager.net`). A
  forged `serviceUrl` is refused at capture and again before send, so the
  connector credential can never leak to an attacker host.
- A decision is only ever consumed once, at the gate it targets; a click on an
  already-resolved run refreshes the card without recording anything.
- A double-click / double-approval cannot double-run side-effecting nodes — a
  single-flight Redis lock serialises processing per run.

> **⚠ v1 authorization constraint (in-Teams buttons).** Unlike the HTTP approval
> path (`POST /runs/:runId/approve`), which authorizes the caller against the
> run's **owning DAG team**, the Teams **button** path does *not* yet bind the
> clicking user to the run's team: v1 keeps a single default conversation
> reference and there is no AAD→fugue-identity→team mapping. **Anyone who can
> click a card in the channel the bot was added to can approve/reject any run.**
> Install the bot **only** in a channel whose members are authorised approvers
> for *every* team whose runs gate through it. Per-team conversation routing and
> click-time authorization are tracked as a follow-up (ADR-0060 Consequences).
> For stricter isolation today, use the webhook transport + the authorized HTTP
> approval endpoint instead.
