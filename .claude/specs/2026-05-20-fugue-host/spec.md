# Feature: @fugue/host — Shared DAG Hosting Platform

**Spec ID:** 2026-05-20-fugue-host
**Created:** 2026-05-20
**Status:** Draft
**Owner:** @hansen142

## Summary

A shared DAG hosting platform that enables one host process per org, where teams submit DAG code via git and the host picks it up without redeploy. Eliminates ~15 files of per-DAG boilerplate (server setup, bootstrap, config, shutdown, wiring) so teams focus exclusively on domain logic. AI agents are the primary authors and consumers — all interfaces are machine-readable.

---

## User Scenarios

### US1: [P1] Git Sync & DAG Discovery

**As a** DAG author (human or AI agent)
**I want to** push DAG code to git and have it become live automatically
**So that** deploying a DAG requires no infrastructure knowledge or manual steps

**Why P1:** Core value proposition. Without this, the host has no DAGs to serve.

**Acceptance Scenarios:**
- Given a valid DAG at `dags/{team}/{name}/dag.ts` merged to main, When the host polls, Then the DAG is discovered, validated, and registered within poll interval + 5s
- Given a DAG with an invalid schema (missing required fields, malformed export), When the host attempts import, Then the DAG is rejected with a structured error log, existing version (if any) continues serving
- Given a DAG directory is removed from git, When the host syncs, Then the DAG is removed from the registry after in-flight runs drain
- Given the git remote is unreachable, When a poll fires, Then the host logs a warning and retries on next interval; existing DAGs remain active
- Given `bun.lockb` changed in the new commit, When the host syncs, Then `bun install --frozen-lockfile` runs before DAG import

### US2: [P1] DagRegistration Contract

**As a** DAG author
**I want to** export a single typed object from `dag.ts` that fully describes my DAG
**So that** I can focus on domain logic without understanding host internals

**Why P1:** The primary API surface for all teams and agents. Must be minimal, validatable, and well-typed.

**Acceptance Scenarios:**
- Given a module with a valid default export matching the DagRegistration shape, When the host imports it, Then the DAG is registered with all metadata intact
- Given a module with no default export, When the host imports it, Then a structured error is emitted referencing the expected export shape
- Given a module that throws on import (syntax error, missing dep), When the host attempts import, Then the error is caught, logged with file path, and the DAG is not registered
- Given a DagRegistration with optional fields omitted, When registered, Then sensible defaults are applied (timeout, concurrency, model)

### US3: [P1] Synchronous DAG Execution via HTTP

**As an** AI agent or internal service
**I want to** execute a DAG via HTTP and receive the result in the response
**So that** I can integrate DAG capabilities into my workflow with a single request

**Why P1:** The primary consumption pattern. Without this, registered DAGs can't be invoked.

**Acceptance Scenarios:**
- Given a registered DAG and valid input, When `POST /dags/:id/run` is called, Then the DAG executes and returns the result as JSON with 200
- Given invalid input (fails DAG's input schema), When the request arrives, Then 400 is returned with machine-readable JSON error describing which fields failed
- Given a DAG that exceeds its timeout, When the timeout fires, Then the run is aborted, partial state checkpointed, and 408 is returned with the run ID for resumption
- Given a request to a non-existent DAG ID, When the request arrives, Then 404 is returned with available DAG IDs listed
- Given the global concurrency limit (50) is reached, When a new request arrives, Then 429 is returned with `Retry-After` header
- Given a per-DAG concurrency limit (default 10) is reached, When a new request arrives for that DAG, Then 429 is returned

### US4: [P1] NodeContext Factory & Per-DAG Namespacing

**As the** host process
**I want to** construct NodeContext per request with shared infrastructure + per-request unique fields
**So that** DAGs get pre-wired dependencies without boilerplate and Redis keys never collide

**Why P1:** This is the "boilerplate elimination" — the core reason the host exists. Without it, teams wire their own context.

**Acceptance Scenarios:**
- Given a registered DAG with ID "billing/invoice-processor", When a run executes, Then cache keys are prefixed `fugue:billing/invoice-processor:cache:*` and checkpoint keys `fugue:billing/invoice-processor:{runId}:{nodeId}`
- Given two different DAGs use the same cache key string in their code, When both execute, Then their cache entries are isolated (no collision)
- Given per-request fields (runId, signal), When context is created, Then each request gets a unique runId and independent AbortSignal
- Given shared infrastructure (LLM client, tracer), When multiple requests execute concurrently, Then they share the same client instances (no per-request re-init)

### US5: [P1] Migration Path from customer-summary

**As the** team that built the first DAG app
**I want to** move `apps/customer-summary` into the host without regressions
**So that** it proves the host model works with a real, production DAG

**Why P1:** Validates the entire design against a known-working baseline.

**Acceptance Scenarios:**
- Given the existing customer-summary DAG re-expressed as a DagRegistration, When served by the host, Then all existing integration tests pass unchanged
- Given the migrated DAG, When executed, Then MLflow traces land with the same structure as before
- Given the migrated DAG with checkpointing, When a run is interrupted and resumed, Then checkpointing/resume works identically to the standalone app
- Given the migrated DAG, When served at its custom route `/summarize`, Then the route is accessible (backwards-compatible URL)

### US6: [P1] Redis as Hard Dependency

**As the** host process
**I want to** validate Redis connectivity at startup and refuse to start without it
**So that** there are no silent failures from missing cache/checkpoint infrastructure

**Why P1:** Redis is load-bearing for caching and checkpointing. Running without it produces silent data loss.

**Acceptance Scenarios:**
- Given Redis is unreachable at startup, When the host attempts to boot, Then it exits with a clear error message indicating Redis is required
- Given Redis becomes unreachable during operation, When a DAG run attempts cache/checkpoint, Then the run fails with a retriable error (not silent swallow)
- Given Redis is available at startup, When the host boots, Then readiness becomes 200 once at least one DAG is also loaded

### US7: [P2] Graceful Shutdown

**As an** operations team
**I want the** host to drain in-flight runs before exiting on SIGTERM
**So that** running DAG executions complete rather than being killed mid-flight

**Why P2:** Required for production zero-downtime deploys but not blocking basic functionality.

**Acceptance Scenarios:**
- Given SIGTERM is received, When the host begins shutdown, Then readiness immediately returns 503 (stop receiving new traffic via load balancer)
- Given in-flight runs exist, When shutdown begins, Then those runs are allowed to complete up to the drain timeout
- Given the drain timeout (configurable, default 30s) expires, When runs are still in-flight, Then they are forcibly aborted and the process exits
- Given no in-flight runs, When SIGTERM is received, Then the process exits within 1s

### US8: [P2] Health & Readiness Endpoints

**As a** load balancer / orchestrator (k8s)
**I want** health and readiness probes
**So that** traffic only routes to healthy hosts

**Why P2:** Standard production requirement, but host is usable without it in development.

**Acceptance Scenarios:**
- Given the host process is alive, When `GET /health` is called, Then 200 is always returned (liveness)
- Given Redis is connected and >=1 DAG is loaded, When `GET /readiness` is called, Then 200 is returned
- Given Redis is disconnected OR zero DAGs loaded, When `GET /readiness` is called, Then 503 is returned
- Given a request to `GET /dags`, When DAGs are loaded, Then a JSON array of `{id, team, version, route, loadedAt, healthy}` is returned

### US9: [P2] Asynchronous DAG Execution

**As an** AI agent orchestrating long-running workflows
**I want to** submit a DAG run and poll for completion
**So that** I don't need to hold an HTTP connection for 60+ seconds

**Why P2:** Critical for multi-step DAGs but sync mode covers the initial adoption use case.

**Acceptance Scenarios:**
- Given a registered DAG, When `POST /dags/:id/submit` is called, Then 202 is returned with `{runId, statusUrl}`
- Given a submitted run, When `GET /runs/:runId/status` is polled, Then it returns `{state: "running"|"completed"|"failed", result?, error?}`
- Given a completed async run, When the result is read, Then it is available for 1h (default, overridable in fugue.yaml)
- Given the retention period expires, When status is polled, Then 410 Gone is returned

### US10: [P2] CLI for Agent-Driven Authoring

**As an** AI agent authoring a new DAG
**I want** CLI commands to scaffold, validate, and test DAGs locally
**So that** I can verify correctness before pushing to git

**Why P2:** Dramatically improves agent authoring loop but DAGs can be authored without it (just push and see).

**Acceptance Scenarios:**
- Given `fugue validate dags/billing/invoice/dag.ts`, When the DAG has schema errors, Then structured JSON output lists each error with file location and fix suggestion
- Given `fugue test dags/billing/invoice/dag.ts`, When executed, Then the DAG runs with a fake LLM client against fixture inputs and reports pass/fail
- Given `fugue new my-dag --team billing`, When executed, Then a complete working DAG scaffold is created (not just skeleton — runnable immediately)

### US11: [P2] Secrets & Config Injection

**As a** DAG author
**I want to** declare required environment variables in `fugue.yaml`
**So that** the host injects them into my DAG's context without me reading `process.env`

**Why P2:** Prevents env var sprawl and makes DAG requirements explicit/documentable.

**Acceptance Scenarios:**
- Given a DAG declares `env: [SALESFORCE_TOKEN]` in fugue.yaml, When the host loads the DAG, Then the value is read from the host's environment and injected into context
- Given a declared env var is missing from the host environment, When the DAG loads, Then a warning is logged and the DAG is marked unhealthy (but still loaded — it may not need it for all paths)

### US12: [P2] Circuit Breaker / Auto-Disable

**As the** host operator
**I want** DAGs that fail repeatedly to be automatically disabled
**So that** one bad DAG doesn't consume resources or pollute error logs

**Why P2:** Safety mechanism, but the host is functional without it during early adoption.

**Acceptance Scenarios:**
- Given a DAG fails >5 times in 1 minute, When the threshold is breached, Then the DAG is marked disabled and returns 503 with explanation
- Given a disabled DAG, When a new version is synced from git, Then it is re-enabled (new code = new chance)
- Given a disabled DAG, When `GET /dags` is queried, Then it shows `healthy: false` with `disabledReason`

### US13: [P2] DAG-to-DAG Composition

**As a** DAG author building complex workflows
**I want to** invoke another DAG from within my DAG's node execution
**So that** I can compose capabilities without duplicating logic

**Why P2:** Enables powerful composition patterns. Blocked on schema validation design.

**Acceptance Scenarios:**
- Given DAG-A's node calls `ctx.invoke("billing/totals", input)`, When executed, Then DAG "billing/totals" runs in-process with zero network overhead and returns its result
- Given the target DAG doesn't exist, When invoke is called, Then a typed error is returned (not thrown)
- Given the invoked DAG fails, When the calling node receives the result, Then it gets a structured error it can handle or propagate
- [NEEDS CLARIFICATION: How is input/output type safety enforced at the boundary between composing DAGs? Schema validation mechanism TBD for architecture phase.]

### US14: [P3] LLM Cost Attribution

**As a** team lead
**I want to** see how much LLM spend my team's DAGs are consuming
**So that** I can optimize prompts and justify costs

**Why P3:** Observability enhancement. Valuable but not blocking adoption.

**Acceptance Scenarios:**
- Given DAG runs execute, When metrics are queried, Then per-DAG token usage (input/output) is available grouped by model
- Given a metrics endpoint, When queried, Then data is returned as JSON (not a dashboard — consumers build their own views)

### US15: [P3] Rollback via Git Revert

**As an** operator responding to a bad DAG push
**I want to** revert the commit in git and have the host pick up the old version
**So that** recovery is the same familiar git workflow

**Why P3:** The host doesn't need rollback logic — git revert + re-sync is the mechanism.

**Acceptance Scenarios:**
- Given a bad DAG version is live, When the commit is reverted in git, Then the next poll picks up the revert and loads the previous working code
- Given the host only keeps current version in memory (no version history), When a revert happens, Then it's treated as a normal sync (import the code at HEAD)

---

## Functional Requirements

### Core Host Lifecycle

- FR-001: Host MUST poll a git branch at a configurable interval (default 30s) and detect new commits by comparing SHAs
- FR-002: Host MUST discover DAGs by scanning `dags/*/*/dag.ts` convention (one level of team nesting)
- FR-003: Host MUST dynamically import discovered DAG modules using Bun's native TypeScript import with commit SHA cache-busting
- FR-004: Host MUST validate each imported module against the DagRegistration schema at load time; invalid DAGs MUST NOT be registered
- FR-005: Host MUST run `bun install --frozen-lockfile` when `bun.lockb` has changed between commits
- FR-006: Host MUST refuse to start if Redis is unreachable; exit with actionable error message
- FR-007: Host MUST identify each DAG version by git commit SHA — no in-memory version history

### DagRegistration Contract

- FR-010: DagRegistration MUST require a `dag` field containing a valid `DagDef` (existing framework type)
- FR-011: DagRegistration SHOULD support optional `route` override (defaults to `/dags/${dag.id}/run`)
- FR-012: DagRegistration SHOULD support optional `config` (timeout, maxConcurrent, model overrides)
- FR-013: The host MUST apply sensible defaults for all optional config fields when omitted

### HTTP API

- FR-020: Host MUST expose `POST /dags/:id/run` for synchronous execution
- FR-021: Host MUST expose `POST /dags/:id/submit` for asynchronous execution (P2)
- FR-022: Host MUST expose `GET /runs/:runId/status` for async run polling (P2)
- FR-023: Host MUST expose `GET /dags` listing all registered DAGs with metadata
- FR-024: Host MUST expose `GET /health` (liveness — always 200 if process alive)
- FR-025: Host MUST expose `GET /readiness` (200 when Redis connected + >=1 DAG loaded, else 503)
- FR-026: All error responses MUST be machine-readable JSON with fields: `error` (code), `message` (human), `details` (actionable context for agents), `dagId` (when applicable), `runId` (when applicable)
- FR-027: Host MUST return 429 with `Retry-After` when concurrency limits are hit (global or per-DAG)
- FR-028: Host MUST enforce per-DAG timeout (configurable, host-level max 120s); return 408 on timeout

### NodeContext & Namespacing

- FR-030: Host MUST construct NodeContext per request with shared infrastructure (LLM client, tracer) + per-request unique fields (runId, AbortSignal)
- FR-031: Host MUST auto-namespace all Redis keys by DAG ID: `fugue:{dagId}:cache:{key}` for cache, `fugue:{dagId}:{runId}:{nodeId}` for checkpoints
- FR-032: Host MUST provide a context factory per DAG that avoids re-initializing shared resources per request

### Checkpoint & Cache TTL

- FR-040: Host MUST support global TTL defaults for cache and checkpoint entries (configured in host config)
- FR-041: Host MUST support per-DAG TTL overrides (configured in `fugue.yaml`)
- FR-042: Checkpoints MUST be invalidated when DAG structure changes (different `dagFingerprint` = checkpoint rejected on resume)

### Concurrency

- FR-050: Host MUST enforce a global max concurrent execution limit (default: 50)
- FR-051: Host MUST enforce a per-DAG max concurrent execution limit (default: 10, overridable in `fugue.yaml`)

### Graceful Shutdown (P2)

- FR-060: On SIGTERM, host MUST immediately set readiness to 503 (stop accepting new work)
- FR-061: On SIGTERM, host MUST allow in-flight runs to drain up to a configurable timeout (default: 30s)
- FR-062: After drain timeout, host MUST forcibly abort remaining runs and exit

### Async Execution (P2)

- FR-070: Async run results MUST be retained for a configurable period (default: 1h, overridable per-DAG in fugue.yaml)
- FR-071: After retention expires, status endpoint MUST return 410 Gone
- FR-072: Async execution MUST use the existing queue infrastructure in the framework

### DAG Composition (P2)

- FR-080: Host MUST provide `invoke(dagId, input)` on NodeContext for in-process DAG-to-DAG calls
- FR-081: `invoke` MUST return a Result type (not throw) so callers can handle failure
- FR-082: `invoke` MUST fail with typed error if target DAG is not registered
- [NEEDS CLARIFICATION: FR-083: Schema validation mechanism for input/output type safety between composing DAGs — exact validation approach TBD for architecture phase]

### Circuit Breaker (P2)

- FR-090: Host MUST track failure count per DAG within a sliding time window
- FR-091: Host MUST auto-disable a DAG when failures exceed threshold (default: >5 in 1 minute)
- FR-092: Disabled DAGs MUST be re-enabled automatically when a new version is synced from git

### Secrets & Config (P2)

- FR-100: Host MUST read `fugue.yaml` per DAG for team, owner, env declarations, and limit overrides
- FR-101: Declared environment variables MUST be resolved from the host process environment (env vars only — no external secret store)
- FR-102: Missing declared env vars MUST produce a warning log; DAG is loaded but marked with degraded health

### CLI (P2)

- FR-110: CLI MUST output structured JSON for all validation and test results
- FR-111: CLI MUST include fix suggestions in validation error output (enabling agent self-correction)
- FR-112: CLI scaffold (`fugue new`) MUST produce a complete, immediately-runnable DAG (not just a skeleton)

---

## Non-Functional Requirements

### Performance

- NFR-001: Framework overhead (time from HTTP request received to DAG executor invoked) MUST be <50ms at P99
- NFR-002: Cold DAG import (first load from disk) MUST complete in <3s per DAG
- NFR-003: Git sync detection (poll -> SHA compare -> pull if changed) MUST complete within poll interval + 5s end-to-end from commit merge to DAG live
- NFR-004: Host MUST support 50 concurrent DAG executions globally without degradation

### Reliability

- NFR-010: A failing DAG import MUST NOT affect other already-registered DAGs
- NFR-011: A DAG runtime error MUST NOT crash the host process (isolation via error boundaries)
- NFR-012: Git sync failures MUST NOT affect serving of already-loaded DAGs
- NFR-013: Redis reconnection MUST be automatic after transient disconnection

### Operability

- NFR-020: Host MUST log structured JSON to stdout (no custom log sinks)
- NFR-021: All log entries MUST include `dagId` and `runId` when contextually available
- NFR-022: Host MUST expose per-DAG execution metrics (count, latency p50/p95/p99, error rate) via metrics endpoint

### Startup

- NFR-030: Host MUST boot and be ready (readiness 200) within 10s given Redis available and >=1 valid DAG on disk
- NFR-031: Host MUST validate all DAGs on startup before marking ready

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: Git commit merged to main -> DAG live and serving requests within poll interval + 5s (measured end-to-end in integration test)
- SC-002: Framework overhead (request-in to executor-start) P99 <50ms under 50 concurrent requests (measured via load test)
- SC-003: Cold import of a 10-node DAG with dependencies completes in <3s (measured in CI)
- SC-004: `apps/customer-summary` fully migrated: all existing tests pass, MLflow traces identical, checkpointing works — zero regressions
- SC-005: Invalid DAG push results in structured error output parseable by AI agent within 1 poll cycle (agent can self-correct without human)
- SC-006: Host survives 1000 sequential requests across 5 DAGs with zero memory leaks (RSS stays within 2x baseline after GC)
- SC-007: Graceful shutdown completes drain of in-flight requests within configured timeout, zero dropped runs (verified in integration test)
- SC-008: Two DAGs using identical cache key strings produce isolated results (zero cross-contamination, verified in integration test)

**Measurement approach:** Integration tests for SC-001, SC-004, SC-005, SC-008. Load test harness for SC-002, SC-006. CI benchmark for SC-003. Shutdown integration test for SC-007.

---

## Out of Scope

Explicitly NOT part of this feature:

- **Multi-tenant SaaS / external customers** — internal org only, no tenant isolation model
- **Multi-repo support** — single monorepo for all DAGs; zero multi-repo discovery
- **YAML/JSON DAG definitions** — TypeScript only, the type system is validation
- **Container-per-DAG / worker isolation** — same process, evolve later if needed
- **Hot-reload mid-execution** — in-flight runs complete on old version; new requests get new
- **Webhook-triggered sync** — poll only for now; webhook is future enhancement
- **Admin API (force sync, disable DAG)** — deferred; CLI + git revert covers operations
- **WebSocket/SSE real-time status** — polling only for async runs
- **Built-in authentication/authorization** — host has zero auth logic; org network/infra layer handles access
- **Notification system** — no Slack/email alerts from host; use external monitoring
- **External secret store integration** — env vars only; no Vault/k8s secrets API
- **Canary traffic splitting** — no percentage-based rollout; new version = full cutover
- **Per-DAG separate Redis instances** — single shared Redis, namespaced by key prefix
- **Dashboard UI** — JSON metrics only; consumers build their own views
- **DAG version history in memory** — current only; rollback = git revert + re-sync
- **"Who can deploy DAGs" access control** — that's git repo write access (PRs), not a host concern

---

## Open Questions

1. [NEEDS CLARIFICATION: DAG composition (`invoke`) schema validation — how is input/output type safety enforced between composing DAGs at runtime? Options include Zod schema declarations on DagRegistration, runtime structural checking, or compile-time-only guarantees. Deferred to architecture phase.]

2. [NEEDS CLARIFICATION: Circuit breaker recovery — should there be a manual re-enable mechanism (admin endpoint) in addition to auto-recovery on new git version? Currently spec says only auto-recovery, but an operator may want to re-enable without pushing a no-op commit.]

3. [NEEDS CLARIFICATION: Metrics retention and aggregation window — how long are per-DAG metrics kept? Rolling window (1h? 24h?) or since-boot? Affects memory usage and usefulness.]

---

## Dependencies

External systems this feature depends on:

- **Redis** — hard dependency for cache and checkpoint storage; host refuses to start without it
- **Git remote** — source of DAG code; host degrades gracefully (serves stale) if temporarily unreachable
- **LLM providers (Anthropic/OpenAI/Azure)** — required for DAG execution; detected from environment variables
- **MLflow / tracing backend** — for observability; DAGs run without it but traces are lost
- **@fugue/framework** — the existing DAG executor, state machine, types, and Result patterns

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Bad DAG crashes host process (unhandled rejection, infinite loop) | High — all teams down | Schema validation + timeout enforcement + circuit breaker auto-disable |
| Module cache / memory leak from repeated dynamic imports | Medium — gradual OOM | SHA cache-busting creates clean module instances; monitor RSS |
| Git sync stalls or fails silently | Medium — stale DAGs | Health check on "time since last successful sync"; alert if stale |
| LLM cost runaway from misbehaving DAG | High — budget impact | Per-DAG token budgets (P3), timeout as backstop |
| One team's dependency breaks another team's DAG | Medium — shared node_modules | Frozen lockfile, CI validation before merge, prefer fetch over SDKs |
| Agent generates invalid DAG repeatedly | Low — rejection is cheap | Structured errors with fix suggestions; agent self-corrects |
| Redis connection lost during execution | Medium — runs fail | Automatic reconnection + retriable error surfacing (not silent loss) |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| DAG | Directed Acyclic Graph — a workflow of nodes with typed edges. The unit of work in fugue. |
| DagRegistration | The TypeScript interface teams export from `dag.ts` — the contract between team code and host. |
| NodeContext | Per-execution context object containing pre-wired dependencies (LLM, cache, tracer, signal). |
| dagFingerprint | Hash of DAG structure (nodes + edges). Changes when topology changes, invalidating checkpoints. |
| Host | The single long-running process that serves all DAGs for an org. `@fugue/host`. |
| fugue.yaml | Per-DAG configuration file declaring team, owner, env requirements, and limit overrides. |
| Circuit breaker | Auto-disable mechanism that stops routing to DAGs exceeding failure thresholds. |
| Drain | Graceful shutdown phase where in-flight requests complete but no new ones are accepted. |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-20 | Initial draft from brainstorm + interview | @hansen142 |
