# Fugue

DAG-shaped, durable runtime for LLM-bearing workflows. Typed orchestration of multi-step AI pipelines with crash-resume, human-in-the-loop gates, freshness-aware state management, and production observability.

## Packages

| Package | Description |
|---------|-------------|
| [`@fugue/framework`](packages/framework/) | Core DAG runtime — node types, execution engine, Result types, branded IDs |
| [`@fugue/host`](packages/host/) | Production HTTP host — git sync, auth, concurrency, circuit breakers |
| [`@fugue/customer-summary`](apps/customer-summary/) | Example DAG app — CRM summarization pipeline |

## Quick Start

```bash
# Install dependencies
bun install

# Run all tests (3118 tests across 3 packages)
bun run test

# Type check all packages
bun run typecheck

# Start Redis (required for host)
redis-server --daemonize yes

# Run the host locally with the example DAG
DAGS_LOCAL_PATH=$(pwd)/apps/customer-summary \
DAGS_REPO_URL=https://unused.git \
REDIS_URL=redis://localhost:6379 \
ADMIN_TOKEN=$(openssl rand -base64 32) \
LLM_PROVIDER=azure \
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com \
AZURE_OPENAI_API_KEY=your-key \
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini \
AZURE_OPENAI_API_VERSION=2025-04-01-preview \
bun run packages/host/src/main.ts
```

## Documentation

- **[Host README](packages/host/README.md)** — Architecture, configuration, API reference
- **[Writing DAGs](packages/host/docs/writing-dags.md)** — How to author and deploy DAGs
- **[Deployment Guide](packages/host/docs/deployment.md)** — OpenShift deployment step-by-step
- **[Authentication](packages/host/docs/auth.md)** — Team tokens, admin operations, security model
- **[ADR Index](docs/adr/README.md)** — Architecture Decision Records
- **[Requirements](docs/requirements.md)** — Requirement traceability (FR/NFR/SC)

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   DAGs Repo     │     │   Fugue Host    │     │    Clients      │
│   (git)         │────▶│   (Bun + Hono)  │◀────│   (HTTP)        │
│                 │     │                 │     │                 │
│ dags/           │     │ • Sync loop     │     │ POST /dags/x/run│
│   team/dag/     │     │ • Auth          │     │ GET /dags       │
│     dag.ts      │     │ • Concurrency   │     │ GET /health     │
│     prompts/    │     │ • Circuit break │     └─────────────────┘
└─────────────────┘     │ • Graceful stop │
                        └────────┬────────┘
                                 │
                        ┌────────┴────────┐
                        │     Redis       │
                        │ • Tokens        │
                        │ • Cache         │
                        │ • Checkpoints   │
                        └─────────────────┘
```

## Key Design Principles

- **Functional Core / Imperative Shell** — Domain logic is pure; I/O lives in adapters
- **Result\<T, E\>** — No exceptions cross module boundaries; all errors are typed
- **Branded Types** — `DagId`, `RunId`, `NodeId`, `GitSha` prevent argument-swap bugs
- **Exhaustive Matching** — `ts-pattern` + `.exhaustive()` ensures all states are handled
- **Error Isolation** — One broken DAG doesn't affect others (NFR-010)
- **Immutable Registries** — Each sync produces a fresh frozen snapshot

## Development

```bash
bun install              # Install all workspace dependencies
bun run test             # Run all 3118 tests
bun run typecheck        # Type check all packages
bun run infra:up         # Start Redis + MLflow (requires podman)
```
