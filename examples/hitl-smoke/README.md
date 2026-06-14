# HITL smoke test (ADR-0060)

Proves the durable **suspend → human decision → resume** loop end-to-end with
**zero Azure / Teams / bot credentials**. The Bot Framework (in-Teams buttons) is
just one notifier transport; this uses the low-ceremony **webhook** transport to
*enable* HITL and delivers the decision over the authenticated **HTTP API**.

## Run it

```bash
bun run hitl:smoke
# or:
bash examples/hitl-smoke/run.sh
```

`run.sh` starts (or reuses) Redis, boots the host with this directory as the local
DAG repo + HITL enabled, then drives the loop and tears everything down. Expected tail:

```
▶ POST /dags/approval-demo/run → 202   { "runId": "…" }
▶ Run SUSPENDED (awaiting human review)   { "review": { "prompt": "Approve this refund? …" } }
▶ POST /runs/…/approve (approve) → 200
▶ Run TERMINAL   { "status": "completed", "output": { "status": "refund-executed", … } }
✅ HITL loop OK
```

## What it exercises

| Step | Mechanism |
|------|-----------|
| Trigger | `POST /dags/approval-demo/run` — the DAG declares a `humanReview` gate, so the run **forks to the durable engine** and returns `202 { runId }` |
| Park | the run suspends after the `review` node; checkpoint + status persist in Redis |
| Notify | the webhook notifier POSTs an Adaptive Card; **a failure is non-fatal** — the run stays parked |
| Decide | `POST /runs/:runId/approve` — authenticated, team-authorized (admin sees all) |
| Resume | the BullMQ worker re-enqueues and runs `finalize`, reaching `completed` |

## Variations

```bash
SMOKE_DECISION=reject bun run hitl:smoke                     # run ends 'failed' instead
TEAMS_WEBHOOK_URL=https://webhook.site/<your-id> bun run hitl:smoke   # actually SEE the card land
```

## Files

```
dags/demo/approval/dag.ts     draft → review[humanReview gate] → finalize   (transform-only, no LLM)
dags/demo/approval/fugue.yaml team: demo
smoke.ts                      the loop driver (trigger → poll → approve → poll)
run.sh                        turnkey orchestrator (Redis + host + smoke + teardown)
```

## Without the host (even cheaper)

The suspend/resume/decision state machine is already covered by the test suite:

```bash
bun run test:redis        # Redis-backed HITL stores + engine
# or: bun test packages/host   (in-memory fakes, no Redis)
```

## Going to real Teams (later)

Set `BOT_APP_ID` / `BOT_APP_PASSWORD`, point the bot's messaging endpoint at
`https://<host>/teams/messages`, and install it in a channel. Same engine — only
the transport changes. That step needs an Azure Bot registration (company tenant).
