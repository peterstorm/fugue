# Design: Fugue Host — Shared DAG Hosting Platform

**Created:** 2026-05-13
**Updated:** 2026-05-20
**Status:** Brainstorm → Design Questions
**Goal:** One host per org. Teams submit DAGs via git. Host picks them up without redeploy. AI agents are the primary authors of DAG code.

---

## Problem

Today, building a new DAG-powered application requires duplicating ~15 files of boilerplate from `apps/customer-summary`:

- Server setup (Hono, routes, health/readiness endpoints)
- Bootstrap (LLM client selection, Redis connection, tracing init, prompt registry)
- Config loading (env vars, Zod validation)
- Graceful shutdown (flush traces, disconnect Redis)
- Request handling (abort controllers, timeouts, run ID generation)
- Checkpointing wiring (Redis adapter → NodeContext)
- Cache wiring (Redis adapter → NodeContext)

The actual creative work per DAG is small: node implementations, DAG definition (edges/nodes), and prompts. Everything else is identical across applications.

For 2-3 teams adopting the framework in the next 6 months, this boilerplate is a real adoption barrier. Each team would need to understand and maintain infrastructure code that has nothing to do with their domain.

---

## Key Design Principles

1. **One host per org** — not per team, not per DAG. Single running process serves all teams.
2. **GitOps-based DAG loading** — teams push code to git, host picks it up without redeploy.
3. **AI agents are the primary consumers** — the framework API, CLI, and error messages must be optimized for machine consumption.
4. **No traditional deploy pipeline for DAGs** — merging to main = live within seconds.
5. **Progressive disclosure** — simple DAGs require minimal knowledge; complexity is opt-in.

---

## Non-Goals

- **Multi-tenant SaaS / external customers** — this is internal, within a trusted org.
- **YAML/JSON DAG definitions** — DAGs are TypeScript. The type system is the validation layer.
- **Hot-reload mid-execution** — in-flight runs complete on old version; new requests get new version.
- **Container-per-DAG isolation** — trust teams, enforce via code review + CI. Evolve to worker isolation if needed.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  AI Agent (Claude, Cursor, etc.)                             │
│  - Reads @fugue/framework types + llms.txt                   │
│  - Generates DAG definitions, nodes                          │
│  - Uses CLI: fugue validate / fugue test / fugue run --dry   │
└────────────────────────┬─────────────────────────────────────┘
                         │ pushes code via PR
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Git Repo: org/fugue-dags (monorepo)                         │
│                                                              │
│  dags/                                                       │
│    billing/                                                  │
│      invoice-processor/                                      │
│        dag.ts            ← DagRegistration (default export)  │
│        nodes/                                                │
│        prompts/                                              │
│        fugue.yaml        ← team, owner, limits, secrets      │
│        fixtures/         ← test inputs                       │
│    customer/                                                 │
│      summary/                                                │
│        dag.ts                                                │
│  host/                                                       │
│    index.ts              ← FugueHost config (5 lines)        │
└────────────────────────┬─────────────────────────────────────┘
                         │ host polls (30s) or webhook
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Fugue Host (single Bun process, one per org)                │
│                                                              │
│  ┌────────────┐  ┌───────────────┐  ┌─────────────────────┐ │
│  │ Git Syncer │  │ DAG Registry  │  │ HTTP Router (Hono)  │ │
│  │ (poll/hook)│─▶│ (validate +   │─▶│ POST /dags/:id/run  │ │
│  └────────────┘  │  import)      │  │ POST /dags/:id/submit│ │
│                  └───────────────┘  │ GET /dags            │ │
│                                     │ GET /runs/:id/status │ │
│                                     │ GET /health          │ │
│                                     └─────────────────────┘ │
│                                                              │
│  Shared Infrastructure:                                      │
│  - Redis (cache, checkpointing, namespaced per dagId)        │
│  - LLM clients (auto-detected from env)                      │
│  - Tracing (MLflow / Azure AI Foundry / OTLP)               │
└──────────────────────────────────────────────────────────────┘
```

---

## Three-Layer Model

```
┌─────────────────────────────────────────────┐
│  Team's Code (DAG definitions)              │
│  - Node implementations (run functions)     │
│  - DAG wiring (nodes + edges)               │
│  - Prompts                                  │
│  - Domain-specific config (fugue.yaml)      │
└─────────────────────┬───────────────────────┘
                      │ exports DagRegistration
                      ▼
┌─────────────────────────────────────────────┐
│  @fugue/host (this package)                 │
│  - Git sync + DAG discovery                 │
│  - HTTP server (Hono)                       │
│  - Bootstrap (LLM, Redis, tracing)          │
│  - Request lifecycle (abort, timeout, runId)│
│  - Health / readiness                       │
│  - Graceful shutdown                        │
│  - Namespace isolation (Redis key prefix)   │
│  - LLM cost metering per DAG               │
└─────────────────────┬───────────────────────┘
                      │ uses
                      ▼
┌─────────────────────────────────────────────┐
│  @fugue/framework (existing library)        │
│  - DAG executor                             │
│  - State machine kernel                     │
│  - Tracing / content filter                 │
│  - Caching / checkpointing                  │
│  - LLM clients                              │
│  - Retry / error handling                   │
└─────────────────────────────────────────────┘
```

**Naming decision:** Call it `@fugue/host`, NOT `@fugue/runtime`. The framework IS the runtime (executor, state machine, transitions). The host provides process lifecycle, HTTP serving, and dependency wiring.

---

## Design Questions (For Individual Resolution)

Each of these needs a dedicated design decision. They are ordered by dependency — later questions may depend on earlier answers.

---

### DQ-1: Git Sync Mechanism

**Question:** How does the host detect and pull new DAG code from git?

**Context:** The host needs to watch a git repo (or repos) and load new/changed DAGs without process restart. Bun can import TypeScript directly, and dynamic `import()` with a cache-busting specifier (commit SHA) creates fresh module instances.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Poll (30s)** | `setInterval` → `git fetch` → compare SHAs → `git pull` if changed | Dead simple, works everywhere, no infra | 30s delay, wasted git fetches |
| **B: Webhook + poll fallback** | GitHub/GitLab webhook hits `POST /admin/sync` → immediate pull. Poll as fallback. | Near-instant sync on push | Requires webhook config, needs auth on admin endpoint |
| **C: ArgoCD sidecar** | ArgoCD watches the repo, syncs to a shared volume. Host watches the volume. | Reuse existing GitOps infra | Adds ArgoCD dependency, indirection layer |

**Recommendation:** Start with A (poll). Add B (webhook) when 30s latency matters. Skip C — the host IS its own mini-ArgoCD.

**Sub-questions:**
- Single repo (monorepo with host + all DAGs) or separate repos per team?
- If separate repos: how does the host know which repos to watch? A manifest?

---

### DQ-2: DAG Discovery & Loading

**Question:** How does the host find, validate, and import DAG modules from disk?

**Context:** After `git pull`, the host needs to discover which DAGs exist, validate they're well-formed, and dynamically import them. Bun's `import()` can load `.ts` directly.

**The sync loop (conceptual):**
```typescript
async function syncDags() {
  const remoteSha = await git.fetchRemoteHead("origin", "main");
  if (remoteSha === currentSha) return;
  
  await git.pull();
  if (await git.fileChanged("bun.lockb", currentSha, remoteSha)) {
    await $`bun install --frozen-lockfile`;
  }
  
  const dagFiles = glob.sync("./dags/*/*/dag.ts");
  for (const file of dagFiles) {
    const mod = await import(`${file}?v=${remoteSha}`);
    const reg = DagRegistrationSchema.safeParse(mod.default);
    if (!reg.success) { log.error(...); continue; }
    registry.upsert(reg.data);
  }
}
```

**Sub-questions:**
- Convention: `dags/{team}/{dag-name}/dag.ts` — is one level of team nesting enough?
- Should DAGs be individually toggleable (enable/disable without removing code)?
- What happens when a DAG is removed from git? Remove from registry immediately? Drain in-flight then remove?
- Should the host validate DAGs before swapping (canary load: import → validate schema → dry-run → swap)?

---

### DQ-3: DagRegistration Contract

**Question:** What is the exact TypeScript interface teams export from their `dag.ts`?

**Context:** This is the PRIMARY API surface for teams (and agents). It must be:
- Minimal for the common case
- Extensible for advanced cases
- Validatable at load time (Zod schema for runtime checking)

**Current proposal:**

```typescript
interface DagRegistration<I = unknown, O = unknown> {
  readonly dag: DagDef;
  readonly route?: string;          // Override, defaults to /dags/${dag.id}/run
  readonly config?: DagConfig;      // Per-DAG overrides
}

interface DagConfig {
  readonly timeout?: number;        // Per-DAG timeout (ms)
  readonly maxConcurrent?: number;  // Max parallel runs
  readonly model?: string;          // LLM model override
  readonly judgeModel?: string;     // Eval judge model
}
```

**Open design choices:**
- Option A: `DagDef` stays as-is (contains `run` functions inline). Registration is just metadata wrapper. No framework changes needed.
- Option B: Separate declaration from implementation. `DagDef` becomes pure graph; `run` functions supplied separately. Enables visualization without importing deps.
- **Recommendation:** Option A. The `defineDag` API already works well. Agents can generate it in a single pass.

**Sub-questions:**
- Should prompts be declared in the registration or loaded separately?
- Should the registration declare required env vars / secrets?
- Should it declare its capabilities summary (for the `/dags` discovery endpoint)?

---

### DQ-4: Process Isolation Model

**Question:** Should DAGs run in the host's main thread or in isolated workers?

**Context:** A misbehaving DAG (infinite loop, memory leak, unhandled rejection) could crash the entire host process, affecting all teams.

**Options:**

| Option | Isolation | Performance | Complexity |
|--------|-----------|-------------|------------|
| **A: Same process** | None (trust teams) | Best (no IPC) | Simplest |
| **B: Bun Workers** | Thread-level | Good (MessagePort IPC) | Medium (serialize ctx) |
| **C: Child processes** | Process-level | Worst (spawn overhead) | High |

**Recommendation:** Start with A. Guardrails:
- `AbortSignal` timeout per execution (already exists)
- Schema validation on import (reject bad DAGs before they run)
- If a DAG fails N times in T minutes, auto-disable it
- Evolve to B if a team actually crashes the host

**Key concern for B:** `NodeContext` contains non-serializable objects (LLM client, Redis connection, tracer). Workers would need their own connections or a proxy pattern. This is significant complexity.

---

### DQ-5: Dependency Management

**Question:** How do DAGs declare and resolve their dependencies (npm packages)?

**Context:** DAGs are TypeScript that may need external packages (e.g., Salesforce SDK, custom parsers). But the host is a single process with one `node_modules`.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Monorepo deps** | All deps in root `package.json`. Host runs `bun install` after pull if lockfile changed. | Simple, consistent | One team adding a dep affects everyone. Version conflicts. |
| **B: Framework-only** | DAGs may ONLY import from `@fugue/framework` + Bun built-ins. External calls via `fetch`. | Zero dep conflicts | Limiting (no SDKs) |
| **C: Pre-bundled** | Teams esbuild their DAG into a single .js file. All deps inlined. | Full isolation | Loses TypeScript source (harder to debug), build step per team |

**Recommendation:** Start with A with a constraint: DAGs should prefer `fetch` + framework capabilities. If a team genuinely needs an SDK, it goes in root `package.json` via PR. For 2-3 teams this is fine.

**Rule:** No `package.json` per DAG directory. One lockfile for the whole repo. One `node_modules`.

---

### DQ-6: Secrets & Environment Config Per DAG

**Question:** How do DAGs declare and receive secrets/config without touching `process.env`?

**Context:** Different DAGs need different API keys (CRM tokens, internal service URLs). The host should inject these — DAGs should never read `process.env` directly.

**Proposed approach — `fugue.yaml` per DAG:**
```yaml
# dags/billing/invoice-processor/fugue.yaml
team: billing
owner: @hansen142
env:
  - SALESFORCE_TOKEN      # host reads from its env / secret store
  - BILLING_API_URL
limits:
  timeout_ms: 60000
  max_concurrent: 10
  max_llm_tokens_per_run: 100000
```

**Sub-questions:**
- How does the host resolve secrets? (env vars? Vault? k8s secrets mounted as env?)
- Should DAGs receive secrets via `NodeContext` (typed) or a generic `config` bag?
- Should `fugue.yaml` be validated by the CLI before merge?

---

### DQ-7: Redis Namespacing & Resource Isolation

**Question:** How do multiple DAGs share a single Redis instance safely?

**Context:** Cache keys and checkpoint keys could collide between DAGs. The host must auto-namespace.

**Proposed approach:**
- Key format: `fugue:{dagId}:{runId}:{nodeId}` for checkpoints
- Key format: `fugue:{dagId}:cache:{key}` for LLM response cache
- Each DAG gets a `ContextCacheAdapter` pre-configured with its namespace

**Sub-questions:**
- Should teams be able to opt into a separate Redis instance?
- Should there be per-DAG memory quotas (Redis key TTLs, max key count)?
- How does this interact with the existing `RedisCache` and `RedisCheckpointer`?

---

### DQ-8: Observability & Cost Attribution

**Question:** How do you attribute LLM costs, trace data, and errors to specific teams/DAGs?

**Context:** One host, multiple teams, shared LLM API keys. Teams need to see their own costs and traces.

**Proposed approach:**
- Every trace span carries `dag.id` and `dag.team` attributes
- LLM client wrapper counts tokens per call, attributes to `dagId`
- Metrics endpoint: `GET /admin/metrics` → per-DAG token usage, latency p99, error rate
- No separate tracing backends — teams filter by tag in MLflow/Grafana

**Sub-questions:**
- Should there be per-DAG LLM token budgets (hard limits)?
- How are alerts configured per team? (Slack channel in `fugue.yaml`?)
- Should the host expose a dashboard UI or just JSON metrics?

---

### DQ-9: Sync vs. Async DAG Execution

**Question:** Should the host support both synchronous and asynchronous (fire-and-forget) DAG execution?

**Context:** Some DAGs are fast (<5s, simple extraction). Some are slow (60s+, multi-step LLM chains). HTTP connections shouldn't hang for 60 seconds.

**Options:**

| Mode | Endpoint | Behavior |
|------|----------|----------|
| **Sync** | `POST /dags/:id/run` | Execute, wait, return result. Timeout at N seconds. |
| **Async** | `POST /dags/:id/submit` | Return 202 + `runId` immediately. Poll for result. |
| **Webhook callback** | `POST /dags/:id/submit` + `callback_url` | Return 202. POST result to callback when done. |

**Recommendation:** Support both sync and async from day one. The BullMQ queue layer already exists in the framework. The host just needs:
- Sync: `runDag()` directly
- Async: enqueue to BullMQ, return `runId`, expose `GET /runs/:runId/status`

**Sub-questions:**
- Should DAGs declare whether they're sync-only, async-only, or both?
- For async: where is the result stored? Redis with TTL? A results table?
- Should there be a WebSocket/SSE endpoint for real-time status updates?

---

### DQ-10: AI Agent Experience & CLI Design

**Question:** What is the optimal interface for AI agents authoring DAGs?

**Context:** Agents (Claude, Cursor, Copilot) are the primary DAG authors. They need:
- Clear types to follow (TypeScript signatures + JSDoc)
- Structured feedback (JSON errors, not prose)
- A CLI that validates their work before commit

**Proposed CLI commands:**
```bash
fugue new {dag-name} --team {team}         # Scaffold DAG directory
fugue validate {path/to/dag.ts}            # Schema + type check
fugue test {path/to/dag.ts}                # Run with FakeLlmClient
fugue run {path} --input '{...}' --dry-run # Validate input, show plan
fugue run {path} --input '{...}'           # Execute locally
fugue api-schema --format json             # Export framework API for agents
```

**Sub-questions:**
- Should there be a `llms.txt` or `AGENTS.md` at repo root — a condensed API reference for agent context windows?
- Should the CLI output include "fix suggestions" for validation errors? (Agent can self-correct)
- Should `fugue new` generate a complete working DAG (not just skeleton) that the agent then modifies?
- Should validation errors reference specific JSDoc / type definitions the agent should read?

---

### DQ-11: NodeContext Factory & Request Lifecycle

**Question:** How does the host construct `NodeContext` per request, given some fields are per-process and some per-request?

**Context:** `NodeContext` has 10+ fields:
- **Per-process** (shared): `llm`, `cache`, `checkpointWriter`, `observer`, `contentFilter`, `judgeLlm`
- **Per-request** (unique): `runId`, `dagId`, `signal` (AbortController), `prompts` (DAG-specific)

The host needs to efficiently construct context per request without re-initializing shared resources.

**Proposed pattern:**
```typescript
// Host builds a "context factory" per DAG at load time
function createContextFactory(dag: DagRegistration, sharedDeps: SharedDeps) {
  const dagPrompts = loadPrompts(dag); // once at load
  const namespacedCache = namespacedAdapter(sharedDeps.cache, dag.dag.id);
  
  return (runId: RunId, signal: AbortSignal): NodeContext => ({
    runId,
    dagId: dag.dag.id,
    llm: sharedDeps.llm,
    judgeLlm: sharedDeps.judgeLlm,
    cache: namespacedCache,
    checkpointWriter: sharedDeps.checkpointWriter,
    observer: sharedDeps.observer,
    contentFilter: sharedDeps.contentFilter,
    prompts: dagPrompts,
    signal,
    logger: sharedDeps.logger,
    tracer: sharedDeps.tracer,
  });
}
```

**Sub-questions:**
- Should teams be able to inject custom middleware into the request lifecycle?
- Should the host support per-request context enrichment (e.g., extract user ID from auth header → inject into context)?
- Should there be a request-scoped logger (with `runId`, `dagId` pre-bound)?

---

### DQ-12: Health, Readiness & DAG-Level Status

**Question:** What health/status endpoints does the host expose?

**Proposed endpoints:**
| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /health` | Liveness (process alive) | Always 200 |
| `GET /readiness` | Ready to serve (Redis up, at least 1 DAG loaded) | 200 or 503 |
| `GET /dags` | List all loaded DAGs with metadata | `[{id, team, route, version, loadedAt}]` |
| `GET /dags/:id/health` | Per-DAG health (error rate, disabled?) | `{healthy, errorRate, lastRun}` |
| `GET /admin/sync` | Trigger manual git sync | 200 |
| `GET /admin/metrics` | Per-DAG metrics (tokens, latency, errors) | JSON |

**Sub-questions:**
- Should per-DAG health auto-disable a DAG if error rate exceeds threshold?
- Should there be a "canary" mode where a new DAG version gets 10% traffic before full rollout?

---

### DQ-13: Rollback & Safety

**Question:** What happens when a bad DAG is pushed to main?

**Scenarios:**
1. DAG fails schema validation → never loaded, old version stays active, error logged
2. DAG loads but crashes on first request → auto-disable after N failures in T minutes?
3. DAG passes validation but produces wrong results → needs manual rollback (revert commit)

**Proposed safety mechanisms:**
- **Canary validation:** On sync, import DAG in isolation first. Call `dag.validate()` (schema check + dry-run). Only swap into live registry if passes.
- **Circuit breaker:** If a DAG fails >5 times in 1 minute, auto-disable and alert team owner.
- **Instant rollback:** `POST /admin/rollback/:dagId` → revert to previous loaded version (keep one version back in memory).
- **Git revert fallback:** If automated rollback isn't enough, `git revert` + host re-syncs.

**Sub-questions:**
- Should there be a "staging" branch concept? (DAGs on `staging` loaded in a shadow mode, not serving traffic?)
- How much history should the host keep? (last N versions per DAG for instant rollback?)

---

### DQ-14: Migration Path from customer-summary

**Question:** How does the existing `apps/customer-summary` app migrate to this model?

**Current state:**
- `apps/customer-summary/` — standalone app with bootstrap, server, config, nodes, DAG
- ~15 files, ~800 LoC of infrastructure code
- ~5 files, ~300 LoC of actual DAG logic

**Migration plan:**
1. Extract bootstrap/server/config logic into `@fugue/host`
2. Move DAG logic into `dags/customer/summary/` in the registry repo format
3. Express `customer-summary` as a `DagRegistration` with `route: "/summarize"` (backwards-compat)
4. Verify: all existing tests pass, MLflow traces land, checkpointing/resume works
5. Delete `apps/customer-summary/` — it's now just a directory in the DAGs repo

**Target state for customer-summary:**
```
dags/customer/summary/
  dag.ts                    # DagRegistration (default export)
  nodes/
    fetch-customer.ts
    extract-features.ts
    synthesize.ts
    grounding-guardrail.ts
    assemble-response.ts
  prompts/
    synthesis.md
    synthesis-system.md
  fugue.yaml                # team: customer, owner: @hansen142
  fixtures/
    sample-input.json
```

---

### DQ-15: The Host Entry Point

**Question:** What does the host's own code look like?

**Proposed (the entire host configuration):**
```typescript
// host/index.ts
import { FugueHost } from "@fugue/host";

const host = FugueHost.create({
  dagSource: {
    type: "git",
    branch: "main",
    path: "dags",              // scan dags/**/dag.ts
    pollInterval: 30_000,      // 30s
  },
  redis: { url: process.env.REDIS_URL },
  llm: "auto",                // auto-detect from ANTHROPIC_API_KEY / OPENAI_API_KEY / AZURE_*
  tracing: {
    exporter: "mlflow",
    uri: process.env.MLFLOW_TRACKING_URI,
    sampleRatio: 0.1,
  },
});

export default host.serve({ port: 3000 });
```

**Sub-questions:**
- Should this support a builder pattern for more complex setups?
- Should there be a `fugue.host.yaml` config file alternative to code?
- Should the host be runnable as a CLI command? (`fugue serve --config host.yaml`)

---

## Decisions Already Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package name | `@fugue/host` (not `runtime`) | Framework IS the runtime. Host provides lifecycle + HTTP. |
| DAG loading | GitOps (poll + hot-reload) | No deploy pipeline per DAG. Git push = live. |
| Process model | Single host per org | Simplicity. Teams don't manage infra. |
| TypeScript-only DAGs | Yes | Type system = validation. Agents read types well. |
| DagDef keeps run functions | Option A (no separation) | No framework changes. Works for agents now. |
| Redis namespacing | Mandatory, auto-prefixed by dagId | Prevent key collisions between DAGs. |
| Worker isolation | Not yet (same process) | Start simple. Evolve if a DAG crashes the host. |
| DAG dependencies | Monorepo root package.json | One lockfile. DAGs prefer fetch + framework caps. |

---

## Open Questions (From Original Plan, Updated)

1. ~~Multiple LLM clients per DAG~~ → **Solved.** `NodeDef.requires` already supports `"llm"` and `"judgeLlm"` separately. Per-node model selection = model-routing client, not N clients.

2. ~~Shared node libraries~~ → **Deferred.** Copy-paste for 2-3 teams. Extract `@fugue/nodes-common` when a 3rd consumer appears with the exact same contract.

3. **Background/async DAG runs** → DQ-9 above.

4. **Per-DAG Redis namespacing** → DQ-7 above. Mandatory.

5. **Auth/authz** → Infrastructure layer. Host provides a middleware hook, not built-in auth.

6. **Webhook/event triggers** → Phase 2. BullMQ already enables queue consumption. Host needs alternate entry point (queue consumer alongside HTTP server).

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bad DAG crashes host | Medium | High (all teams down) | Schema validation, circuit breaker, auto-disable |
| Git sync fails | Low | Medium (stale DAGs) | Poll fallback, health check on sync age |
| Module cache leak (memory) | Medium | Medium | Import with SHA cache-bust, monitor memory, periodic restart |
| LLM cost runaway | Medium | High (budget) | Per-DAG token budgets, alert on threshold |
| Team A's dep breaks team B | Low | Medium | Frozen lockfile, CI validation before merge |
| Agent generates invalid DAG | High | Low (rejected at validation) | Structured CLI errors with fix suggestions |

---

## Implementation Phases (Tentative)

**Phase 1: Extract @fugue/host core**
- Git syncer (poll-based)
- DAG discovery + validation + dynamic import
- HTTP router (run endpoint + health)
- NodeContext factory with namespacing
- Migrate customer-summary as proof

**Phase 2: CLI + Agent Experience**
- `fugue validate` / `fugue test` / `fugue new`
- `llms.txt` for agent context
- Structured JSON output for all commands
- Error messages with fix suggestions

**Phase 3: Production Hardening**
- Circuit breaker / auto-disable
- Webhook sync support
- Async execution mode (BullMQ integration)
- Per-DAG metrics + cost attribution
- Admin API (sync, rollback, disable/enable)

**Phase 4: Advanced**
- Worker isolation (if needed)
- Canary deployments (shadow mode)
- Multi-repo support
- Event/webhook triggers for DAGs

---

## References

- Current bootstrap code: `apps/customer-summary/src/bootstrap.ts`
- Current server code: `apps/customer-summary/src/server.ts`
- Framework types: `packages/framework/src/types/`
- DAG definition API: `packages/framework/src/types/dag.ts`
- Node definition: `packages/framework/src/types/node.ts`
- Example DAG: `apps/customer-summary/src/dag/summary-dag.ts`

---

*This document captures brainstorm + design question decomposition. Each DQ should be resolved independently (via loom specify or dedicated design session) before implementation begins.*
