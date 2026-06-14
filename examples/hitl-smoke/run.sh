#!/usr/bin/env bash
#
# Turnkey HITL smoke test (ADR-0060) — zero Azure / Teams / bot credentials.
#
# Starts (or reuses) Redis, boots the fugue host with this directory as the local
# DAG repo and HITL enabled via the webhook transport, then drives the full
# suspend → approve → resume loop and tears everything down.
#
#   bun run hitl:smoke              # from repo root (see root package.json)
#   bash examples/hitl-smoke/run.sh
#
# Override the decision: SMOKE_DECISION=reject bash examples/hitl-smoke/run.sh
# See the Adaptive Card: TEAMS_WEBHOOK_URL=https://webhook.site/<id> bash examples/hitl-smoke/run.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOST_LOG="$(mktemp -t fugue-hitl-host.XXXXXX.log)"
PORT="${PORT:-3000}"
REDIS_PORT="${REDIS_PORT:-6379}"

# --- Host env -----------------------------------------------------------------
export PORT
export REDIS_URL="${REDIS_URL:-redis://localhost:${REDIS_PORT}}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-smoke-admin-token-0123456789}"   # >=16 chars
export DAGS_LOCAL_PATH="$HERE"                                       # contains dags/demo/approval/dag.ts
export DAGS_REPO_URL="${DAGS_REPO_URL:-local-smoke}"                # required by schema, ignored in local mode
# Enables HITL (BullMQ queue + webhook notifier). A notify failure is NON-FATAL —
# the run still parks — so any https URL works. Point at webhook.site to see the card.
export TEAMS_WEBHOOK_URL="${TEAMS_WEBHOOK_URL:-https://example.com/teams-smoke-webhook}"
# The smoke DAG has no LLM node; a placeholder key satisfies config without any network.
export LLM_PROVIDER="${LLM_PROVIDER:-anthropic}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-smoke-placeholder}"

STARTED_REDIS=""
HOST_PID=""

cleanup() {
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  [[ -n "$STARTED_REDIS" ]] && podman stop "$STARTED_REDIS" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 1. Redis -----------------------------------------------------------------
if (echo >"/dev/tcp/localhost/${REDIS_PORT}") 2>/dev/null; then
  echo "• Redis already reachable on ${REDIS_PORT}"
else
  echo "• Starting throwaway Redis on ${REDIS_PORT} (podman)…"
  podman run --rm -d --name fugue-hitl-redis -p "${REDIS_PORT}:6379" redis:7-alpine >/dev/null
  STARTED_REDIS="fugue-hitl-redis"
  sleep 1
fi

# --- 2. Boot the host ---------------------------------------------------------
echo "• Booting fugue host (log: $HOST_LOG)…"
( cd "$ROOT" && bun packages/host/src/main.ts ) >"$HOST_LOG" 2>&1 &
HOST_PID=$!

# --- 3. Wait for readiness ----------------------------------------------------
echo "• Waiting for http://localhost:${PORT}/health …"
for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "• Host is up."
    break
  fi
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    echo "✖ Host process exited during startup. Last log lines:"; tail -n 30 "$HOST_LOG"; exit 1
  fi
  sleep 0.4
done

if ! curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "✖ Host did not become ready. Last log lines:"; tail -n 30 "$HOST_LOG"; exit 1
fi

# --- 4. Drive the loop --------------------------------------------------------
SMOKE_BASE_URL="http://localhost:${PORT}" bun "$HERE/smoke.ts"
