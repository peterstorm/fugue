# @fugue/host

The Fugue Host is a production-grade runtime that discovers, loads, and serves DAG-based AI workflows via HTTP. It polls a git repository for DAG definitions, validates them at load time, and exposes them as authenticated REST endpoints with concurrency limiting, circuit breaking, and graceful shutdown.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Fugue Host                                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  HTTP Layer (Hono)                                            │  │
│  │  /health  /readiness  /admin/*  /dags  /dags/:id/run         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────┐  ┌────────────┴─────────┐  ┌──────────────────┐    │
│  │ Auth     │  │ Domain (pure)         │  │ Sync Loop        │    │
│  │ Middleware│  │ • HostState machine   │  │ • git pull       │    │
│  │          │  │ • Registry (immutable) │  │ • module load    │    │
│  │          │  │ • Concurrency limiter  │  │ • registry swap  │    │
│  │          │  │ • Circuit breaker      │  │                  │    │
│  └──────────┘  └───────────────────────┘  └──────────────────┘    │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Adapters (imperative)                                       │  │
│  │  • GitSync (Bun.spawn → git)    • ModuleLoader (import())   │  │
│  │  • TokenStore (Redis)           • NodeContextFactory         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Infrastructure                                              │  │
│  │  Redis (tokens, cache, checkpoints)   LLM (Azure/OpenAI)    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start (Local Development)

```bash
# 1. Start Redis
redis-server --daemonize yes

# 2. Set up a DAGs directory following the convention
mkdir -p /tmp/my-dags/dags/my-team/my-dag
# Create your dag.ts there (see "Writing a DAG" below)

# 3. Run the host
DAGS_LOCAL_PATH=/tmp/my-dags \
DAGS_REPO_URL=https://unused.git \
REDIS_URL=redis://localhost:6379 \
ADMIN_TOKEN=$(openssl rand -base64 32) \
LLM_PROVIDER=azure \
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com \
AZURE_OPENAI_API_KEY=your-key \
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini \
PORT=3000 \
bun run packages/host/src/main.ts
```

## Configuration

All configuration is via environment variables, validated at startup with Zod.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAGS_REPO_URL` | Yes | — | Git URL for the DAGs repository |
| `DAGS_REPO_BRANCH` | No | `main` | Branch to track |
| `DAGS_POLL_INTERVAL_MS` | No | `30000` | Git polling interval (ms) |
| `DAGS_LOCAL_PATH` | No | — | If set, skips git clone and reads from this path (dev mode) |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `PORT` | No | `3000` | HTTP listen port |
| `ADMIN_TOKEN` | Yes | — | Admin bearer token (min 16 chars) |
| `LLM_PROVIDER` | No | `anthropic` | `anthropic`, `openai`, or `azure` |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | If provider=azure | — | Azure endpoint URL |
| `AZURE_OPENAI_API_KEY` | If provider=azure | — | Azure API key |
| `AZURE_OPENAI_DEPLOYMENT` | If provider=azure | — | Azure deployment name |
| `AZURE_OPENAI_API_VERSION` | No | `2025-03-01-preview` | Azure API version |
| `MAX_GLOBAL_CONCURRENCY` | No | `50` | Max concurrent DAG runs (all DAGs) |
| `DEFAULT_DAG_CONCURRENCY` | No | `10` | Default per-DAG concurrency limit |
| `DEFAULT_DAG_TIMEOUT_MS` | No | `60000` | Default per-DAG timeout (ms) |
| `MAX_DAG_TIMEOUT_MS` | No | `120000` | Maximum allowed DAG timeout |
| `DRAIN_TIMEOUT_MS` | No | `30000` | Grace period for shutdown drain |
| `CIRCUIT_BREAKER_THRESHOLD` | No | `5` | Failures before circuit opens |
| `CIRCUIT_BREAKER_WINDOW_MS` | No | `60000` | Circuit breaker sliding window |
| `DEFAULT_CACHE_TTL_MS` | No | `300000` | Default cache entry TTL (5 min) |
| `DEFAULT_CHECKPOINT_TTL_MS` | No | `86400000` | Default checkpoint TTL (24 hr) |

## HTTP API

See [`docs/auth.md`](docs/auth.md) for full auth documentation.

### Unauthenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe — always `200` if process is alive |
| GET | `/readiness` | Readiness — `200` with `dagCount` when ready, `503` when not |

### Admin (requires `ADMIN_TOKEN`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/teams` | Create a team token |
| GET | `/admin/teams` | List provisioned teams |
| DELETE | `/admin/teams/:team` | Revoke a team token |

### DAG Execution (requires any valid token)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dags` | List registered DAGs with metadata |
| POST | `/dags/:id/run` | Execute a DAG (input validated, team-scoped) |

## Writing a DAG

See the full guide in [`docs/writing-dags.md`](docs/writing-dags.md).

## Tests

```bash
bun test                    # All tests (3118 across 3 packages)
bun test packages/host      # Host tests only (499 tests)
bun run typecheck           # TypeScript validation
```
