# Brainstorm Summary

**Building:** A shared DAG hosting platform (`@fugue/host`) that enables one host process per org, where teams submit DAG code via git and the host picks it up without redeploy — optimized for AI agent authorship.

**Approach:** GitOps-based host with poll/webhook sync. Single Bun process auto-discovers DAGs from a git repo by convention (`dags/{team}/{dag-name}/dag.ts`). Bun's native TS import + cache-busting via commit SHA enables hot-reload without restart.

**Key Constraints:**
- DAGs are TypeScript with executable `run` functions (can't be pure data/JSON)
- Bun can import .ts directly (no compile step needed)
- Framework already has branded `DagDef`, `NodeContext`, `Result<T,E>` patterns that must be preserved
- One host per org, not per team — simplicity over isolation
- AI agents are primary consumers — API must be machine-readable

**In Scope:**
- Git sync mechanism (poll + webhook)
- DAG discovery and dynamic import with validation
- `DagRegistration` contract (what teams export)
- HTTP server with per-DAG routes (sync + async execution)
- Redis namespacing per DAG (cache + checkpoints)
- NodeContext factory (per-process shared deps + per-request unique fields)
- Health/readiness endpoints + per-DAG status
- LLM cost attribution per DAG
- Graceful shutdown with in-flight drain
- CLI for agent-driven DAG authoring/validation
- Migration path from `apps/customer-summary`
- Secrets/config injection per DAG (via `fugue.yaml`)
- Circuit breaker / auto-disable for bad DAGs
- Rollback to previous DAG version

**Out of Scope:**
- Multi-tenant SaaS / external customers
- YAML/JSON DAG definitions (TypeScript only)
- Container-per-DAG isolation (start same-process, evolve later)
- Hot-reload mid-execution (in-flight runs complete on old version)
- Multi-repo support (single monorepo for now)
- Canary traffic splitting (future phase)
- Built-in auth (infrastructure layer handles this)
- WebSocket/SSE real-time status (future phase)

**Open Questions:**
- DQ-1 through DQ-15 documented in `docs/plans/2026-05-13-fugue-runtime-design.md`
- Each design question needs individual specification
- Key load-bearing decisions: DQ-2 (discovery/loading), DQ-3 (DagRegistration contract), DQ-11 (NodeContext factory)
