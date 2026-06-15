# Fugue

DAG-shaped, durable runtime for LLM-bearing workflows. Typed orchestration of multi-step AI pipelines with crash-resume, human-in-the-loop gates, identity-scoped capabilities, freshness-aware state management, and production observability.

## Packages

The framework and its adapters version in lockstep (currently **0.2.0**) and publish under the `@fuguejs/*` scope.

| Package | Name | Description |
|---------|------|-------------|
| [`packages/framework`](packages/framework/) | `@fuguejs/framework` | Core DAG runtime — node types, state-machine executor, source nodes, capabilities, `Result` types, branded IDs, and the `fugue` CLI |
| [`packages/host`](packages/host/) | `@fuguejs/host` | Production HTTP host — git sync, auth, concurrency, circuit breakers, durable HITL approvals, identity-scoped capability brokering |
| [`packages/document-source`](packages/document-source/) | `@fuguejs/document-source` | `DocumentSource` capability — typed file refs, caching parser, adapter contract |
| [`packages/adapter-fs`](packages/adapter-fs/) | `@fuguejs/fs` | Filesystem `DocumentSource` adapter (root-confined) |
| [`packages/adapter-ms-graph`](packages/adapter-ms-graph/) | `@fuguejs/ms-graph` | Microsoft Graph / OneDrive / SharePoint `DocumentSource` adapter |
| [`packages/adapter-pg`](packages/adapter-pg/) | `@fuguejs/pg` | PostgreSQL capability adapter |
| [`packages/xlsx`](packages/xlsx/) | `@fuguejs/xlsx` | Workbook parsing (`.xlsx` → typed rows) |
| [`packages/examples`](packages/examples/) | `@fuguejs/examples` | Ten golden, lint-clean example DAGs (`01`–`10`) |
| [`apps/customer-summary`](apps/customer-summary/) | `@fuguejs/customer-summary` | Example DAG app — CRM summarization pipeline with a Python eval harness |
| [`examples/hitl-smoke`](examples/hitl-smoke/) | `@fuguejs/hitl-smoke` | End-to-end human-in-the-loop suspend/approve/resume smoke test |

## Quick Start

```bash
# Install dependencies (Bun workspace)
bun install

# Run all tests (3,097 tests across 10 packages, all green;
# ~35 Redis-gated tests skip automatically without a running Redis)
bun run test

# Type check every package
bun run typecheck

# Verify the shipped docs' relative links still resolve
bun run check:docs
```

### Scaffold a DAG with the CLI

The framework ships a `fugue` CLI. Run it via `bunx` from a package that depends on `@fuguejs/framework`:

```bash
bunx fugue new my-team/my-dag --shape linear --llm   # scaffold a lint-clean DAG
bunx fugue lint dags/my-team/my-dag                   # validate shape + wiring
bunx fugue describe dags/my-team/my-dag               # report required capabilities
bunx fugue capabilities                               # list built-in capabilities
```

See **[Writing LLM DAGs](packages/framework/docs/llm-dag-authoring.md)** for the full authoring guide.

### Run the host locally with the example DAG

```bash
# Start Redis (required for the host)
redis-server --daemonize yes

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

A production container image is at [`packages/host/Dockerfile`](packages/host/Dockerfile) — see the [Deployment Guide](packages/host/docs/deployment.md).

## Documentation

**Authoring**
- **[Writing LLM DAGs](packages/framework/docs/llm-dag-authoring.md)** — the canonical authoring guide (nodes, edges, `$input` wiring, capabilities, HITL gates, the CLI)
- **[DAG Type System](packages/framework/docs/dag-type-system.md)** — how `defineDag` makes illegal graphs unrepresentable
- **[Adapter Authoring](packages/framework/docs/adapter-authoring.md)** — add a new capability + adapter
- **[Writing DAGs for the Host](packages/host/docs/writing-dags.md)** — the `DagRegistration` + `fugue.yaml` deploy contract

**Operating the host**
- **[Host README](packages/host/README.md)** — architecture, configuration, HTTP API reference
- **[Deployment Guide](packages/host/docs/deployment.md)** — container + Redis + OpenShift deployment
- **[Authentication](packages/host/docs/auth.md)** — admin / team-token / OIDC auth and team isolation
- **[Human-in-the-Loop in Teams](packages/host/docs/hitl-teams.md)** — approval transports (webhook + Bot Framework)

**Reference**
- **[ADR Index](docs/adr/README.md)** — 60 Architecture Decision Records
- **[Features](docs/features.md)** — the feature surface, end to end
- **[Observability Backends](docs/observability-backends.md)** / **[Tracing Pipeline](docs/tracing-pipeline.md)** — MLflow + Azure AI Foundry
- **[Eval Pipeline](docs/eval-pipeline.md)** — the customer-summary evaluation harness
- **[Requirements](docs/requirements.md)** — requirement traceability (FR/NFR/SC)

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   DAGs Repo     │     │     Fugue Host       │     │      Clients        │
│   (git)         │────▶│     (Bun + Hono)     │◀────│      (HTTP)         │
│                 │     │                      │     │                     │
│ dags/           │     │ • Sync loop          │     │ POST /dags/:id/run  │
│   team/dag/     │     │ • Auth (token + JWT) │     │ GET  /dags          │
│     dag.ts      │     │ • Concurrency        │     │ GET  /runs/:id      │
│     prompts/    │     │ • Circuit breakers   │     │ POST /runs/:id/     │
│     fugue.yaml  │     │ • Capability broker  │     │        approve      │
└─────────────────┘     │ • Durable HITL queue │     │ GET  /health        │
                        │ • Graceful stop      │     └─────────────────────┘
                        └──────────┬───────────┘
                                   │
                          ┌────────┴────────┐
                          │     Redis       │
                          │ • Tokens        │
                          │ • Cache         │
                          │ • Checkpoints   │
                          │ • HITL run store│
                          └─────────────────┘
```

A DAG can suspend at a **human-review gate**, persist its state to Redis, and resume when an approver responds over HTTP or in Microsoft Teams. Nodes reach the outside world only through **capabilities** (LLM, cache, prompts, HTTP, clock, documents, …); under identity-scoped operation the host mints a per-identity, downscoped token (Keycloak token exchange) before handing a capability to a node.

## Key Design Principles

- **Functional Core / Imperative Shell** — domain logic is pure; I/O lives in adapters
- **Parse, don't validate** — raw strings cross the boundary once and become branded (`DagId`, `RunId`, `NodeId`, `GitSha`, `NonEmptyString`); illegal states are unrepresentable
- **`Result<T, E>`** — no exceptions cross module boundaries; all errors are typed
- **Exhaustive matching** — `ts-pattern` + `.exhaustive()` ensures every state is handled
- **Capabilities, not ambient I/O** — a node declares `requires`, and only the declared capabilities appear (typed and non-null) on its context
- **Explicit input wiring** — no node implicitly receives the DAG input; the request flows only along explicit `$input` (`DAG_INPUT`) edges
- **Error isolation** — one broken DAG doesn't affect others (NFR-010)
- **Immutable registries** — each sync produces a fresh frozen snapshot

## Development

```bash
bun install              # Install all workspace dependencies
bun run test             # Run all tests (3,097 across 10 packages)
bun run typecheck        # Type check all packages
bun run check:docs       # Verify shipped-doc relative links
bun run infra:up         # Start Redis + MLflow (requires podman)
bun run hitl:smoke       # End-to-end human-in-the-loop smoke test
```
