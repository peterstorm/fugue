#!/usr/bin/env bun
/**
 * HITL smoke driver — exercises the full ADR-0060 loop against a RUNNING host:
 *
 *   POST /dags/approval-demo/run   → 202 { runId }   (forks to the durable engine)
 *   GET  /runs/:runId  (poll)      → status: "suspended"  (parked for review)
 *   POST /runs/:runId/approve      → 200 { status: "resuming" }
 *   GET  /runs/:runId  (poll)      → status: "completed"  (+ final output)
 *
 * No Azure / Teams / bot credentials needed — approval is delivered over the
 * authenticated HTTP API. `run.sh` starts the host with the right env and then
 * runs this; or start the host yourself and run `bun examples/hitl-smoke/smoke.ts`.
 *
 * Env:
 *   ADMIN_TOKEN     (required) — bearer used for run + approve (admin sees all teams)
 *   SMOKE_BASE_URL  (default http://localhost:3000)
 *   SMOKE_DECISION  (default "approve"; try "reject" to see the run fail)
 */

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.ADMIN_TOKEN;
const DECISION = process.env.SMOKE_DECISION ?? "approve";
const DAG_ID = "approval-demo";

if (!TOKEN) {
  console.error("ADMIN_TOKEN is required (the host's ADMIN_TOKEN). Set it and retry.");
  process.exit(2);
}

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (step: string, detail?: unknown) =>
  console.log(`\n▶ ${step}${detail !== undefined ? `\n${JSON.stringify(detail, null, 2)}` : ""}`);

/** The host wraps handler results in `{ ok, data, … }`; the status view is `data`. */
const unwrap = (body: Record<string, unknown>): Record<string, unknown> =>
  (body.data as Record<string, unknown> | undefined) ?? body;

/** Poll GET /runs/:id until `want` (or a terminal status), up to `timeoutMs`. */
const pollUntil = async (
  runId: string,
  want: "suspended" | "completed",
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}`, { headers: auth });
    last = unwrap((await res.json()) as Record<string, unknown>);
    const status = last.status;
    if (status === want || status === "failed") return last; // matched, or terminal — surface it
    await sleep(400);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for '${want}' (last: ${JSON.stringify(last)})`);
};

/** Build the decision body for the chosen decision kind. */
const decisionBody = (): Record<string, unknown> => {
  if (DECISION === "reject") return { decision: "reject", reason: "smoke: rejected for demo", actor: "smoke-script" };
  return { decision: "approve", actor: "smoke-script" };
};

const main = async () => {
  // 1. Trigger — a humanReview DAG forks to the durable engine and returns 202.
  const runRes = await fetch(`${BASE}/dags/${DAG_ID}/run`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ orderId: "order-42", amount: 25 }),
  });
  const runBody = (await runRes.json()) as Record<string, unknown>;
  log(`POST /dags/${DAG_ID}/run → ${runRes.status}`, runBody);
  if (runRes.status !== 202 || typeof runBody.runId !== "string") {
    throw new Error(`expected 202 + runId; got ${runRes.status}. Is HITL enabled (TEAMS_WEBHOOK_URL set)?`);
  }
  const runId = runBody.runId;

  // 2. Poll until parked for review.
  const suspended = await pollUntil(runId, "suspended");
  if (suspended.status !== "suspended") throw new Error(`run did not park: ${JSON.stringify(suspended)}`);
  log("Run SUSPENDED (awaiting human review)", suspended);

  // 3. Approve (or reject) over the authenticated HTTP API.
  const approveRes = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(decisionBody()),
  });
  log(`POST /runs/${runId}/approve (${DECISION}) → ${approveRes.status}`, await approveRes.json());
  if (!approveRes.ok) throw new Error(`approve failed: HTTP ${approveRes.status}`);

  // 4. Poll until terminal.
  const terminal = await pollUntil(runId, "completed");
  log("Run TERMINAL", terminal);

  const expected = DECISION === "reject" ? "failed" : "completed";
  if (terminal.status !== expected) {
    throw new Error(`expected terminal status '${expected}', got '${terminal.status}'`);
  }
  console.log(`\n✅ HITL loop OK — run ${runId} reached '${terminal.status}' after a '${DECISION}' decision.`);
};

main().catch((e) => {
  console.error(`\n❌ HITL smoke failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
