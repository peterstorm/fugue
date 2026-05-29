# Architecture Plan: @fugue/host — Shared DAG Hosting Platform

**Plan ID:** 2026-05-20-fugue-host  
**Created:** 2026-05-20  
**Status:** Approved  
**Spec:** `.claude/specs/2026-05-20-fugue-host/spec.md`

---

## 1. Summary

A deep-module DAG hosting platform implemented as a pure state machine with adapter boundaries. The host clones a separate git repo containing DAG code, validates and registers DAGs into an immutable snapshot, and serves them over HTTP via Hono. The framework (`@fugue/framework`) remains fully standalone — it has zero knowledge of the host. The entire monorepo renames from `@ai-summary/*` to `@fugue/*` in the same PR.

---

## 2. Architectural Decisions

### AD-1: State Machine with Pure Transitions

**Choice:** Model host lifecycle as a discriminated union of states (`HostState`) with pure transition functions. Side effects happen only at adapter boundaries.

**Why:** Enables 90%+ unit testability without mocks. Every state transition can be property-tested. Simplicity axis — one model explains the entire host lifecycle.

**Rejected:**
- Event-sourced (overkill for single-instance, adds replay complexity)
- Imperative controller (untestable, state scattered across mutable fields)

---

### AD-2: Immutable Registry Snapshot

**Choice:** Registry is an immutable `ReadonlyMap<DagId, RegisteredDag>` frozen per sync cycle. HTTP handlers read the current snapshot reference; sync produces a new snapshot atomically.

**Why:** No concurrent mutation bugs. Handlers never see a half-loaded registry. Simple reference swap on sync completion.

**Rejected:**
- Mutable Map with locks (complexity, race conditions)
- Copy-on-write with structural sharing (unnecessary — registry is small)

---

### AD-3: Framework Independence

**Choice:** `@fugue/framework` has zero imports from or dependency on `@fugue/host`. The host imports framework types (`DagDef`, `NodeContext`, `runDag`) as a consumer. DAG code in the dags repo also imports `@fugue/framework` directly.

**Why:** Framework remains usable standalone (tests, CLI tools, other runtimes). Host is optional infrastructure.

**Rejected:**
- Framework aware of host (coupling, breaks standalone use)
- Shared "common" package between host and framework (unnecessary indirection)

---

### AD-4: DagRegistration as Host Contract

**Choice:** DAG authors export a `DagRegistration` object from `dag.ts`. This is defined in `@fugue/host` (not framework), validated with Zod at import time. It wraps a `DagDef` with host-specific metadata.

**Why:** Clean separation — `DagDef` is a framework concept (execution shape), `DagRegistration` is a host concept (deployment metadata). Framework stays unaware.

**Rejected:**
- Extending DagDef with host fields (pollutes framework types)
- Separate metadata file (splits related information, harder to validate atomically)

---

### AD-5: Raw Git via Bun.spawn

**Choice:** Shell out to `git` via `Bun.spawn("git", ...)` for clone/pull/rev-parse. Wrapped in a `GitAdapter` port.

**Why:** Simplicity. No git library dependency. Git CLI is universally available in containers. Adapter boundary makes it testable via fake.

**Rejected:**
- isomorphic-git (incomplete, no shallow clone support, heavy)
- simple-git (wrapper adds no value over spawn)

---

### AD-6: Hono HTTP Server

**Choice:** Hono for the HTTP layer, consistent with existing `apps/customer-summary`.

**Why:** Already in use, lightweight, TypeScript-native, fast on Bun.

**Rejected:**
- Express (heavy, callback-based)
- Elysia (unfamiliar API, less ecosystem)

---

### AD-7: Layered Error Handling

**Choice:** `HostError` discriminated union for host-level concerns (sync failures, import errors, registry problems, concurrency limits). Framework errors (`FrameworkError`) pass through unchanged to HTTP responses.

**Why:** Each layer owns its error space. No leaky abstractions. HTTP layer maps both to appropriate status codes.

**Rejected:**
- Single unified error type (couples framework to host evolution)
- Exception-based (loses exhaustiveness, untestable transitions)

---

### AD-8: Concurrency Limiter as Pure State

**Choice:** Global and per-DAG concurrency tracked as a pure counter state (`{ current: number; max: number }`). `acquire` returns `Result<Token, "at-capacity">`. `release` decrements.

**Why:** Testable without timers or async. HTTP layer calls acquire before dispatching, release in finally.

**Rejected:**
- Semaphore class with internal async queue (opaque, harder to test)
- External rate limiter (overkill for single instance)

---

### AD-9: Circuit Breaker as Pure State Machine

**Choice:** Per-DAG circuit breaker with states `closed | open | half-open`, pure transition on each `recordSuccess` / `recordFailure` call. Time-based recovery via injected clock.

**Why:** Fully testable with deterministic clock. No timers in the core.

**Rejected:**
- Library (opossum etc — hidden state, non-functional)
- Simple counter without half-open (no recovery path without git push)

---

### AD-10: Big-Bang Rename @ai-summary → @fugue

**Choice:** Rename all packages from `@ai-summary/*` to `@fugue/*` in the same PR as host introduction.

**Why:** Clean break. Monorepo is private. No external consumers to migrate. One PR avoids split-brain naming.

**Rejected:**
- Gradual migration with aliases (complexity for zero benefit in private monorepo)
- Keep old name (confusing when "fugue" is the product name)

---

### AD-11: Single Instance, In-Memory State

**Choice:** Host runs as single instance. All state (registry, concurrency counters, circuit breakers) lives in-memory. Only async run results persist to Redis.

**Why:** Simplicity. No distributed coordination. Sufficient for org-internal workload. Scale-up path is vertical (bigger box) then horizontal later if needed.

**Rejected:**
- Redis-backed state for HA (premature, adds latency, complexity)
- Multi-instance with leader election (way overkill)

---

### AD-12: Separate Dags Repository

**Choice:** DAG code lives in a separate git repository. Host clones it at startup, polls for changes. Dev mode supports a local directory path instead.

**Why:** Teams push DAG code without touching host infra. Git is the deployment mechanism. Separation of concerns.

**Rejected:**
- DAGs in host monorepo (couples DAG authoring to host releases)
- Package registry (npm publish for each DAG — too heavy)

---

### AD-13: Config via Zod Env + YAML

**Choice:** Host-level config from Zod-validated environment variables. Per-DAG config from `fugue.yaml` colocated with DAG code, parsed with `yaml` library + Zod schema.

**Why:** Env vars for infrastructure (12-factor). YAML for DAG-author-facing config (readable, version-controlled with DAG code).

**Rejected:**
- All env vars (too many per-DAG knobs)
- All YAML (infrastructure secrets don't belong in git)
- JSON config (less readable than YAML for humans)

---

### AD-14: OTel Tracing for Host Operations

**Choice:** Full OpenTelemetry instrumentation for host-level operations (sync, import, request lifecycle). Framework already has its own tracing; host adds host-specific spans.

**Why:** Production observability. Traces sync latency, import failures, request routing.

**Rejected:**
- Console logging only (insufficient for production debugging)
- Custom tracing (reinventing OTel)

---

## 3. File Structure

### New Package: `packages/host/`

```
packages/host/
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts                          # Entry point (bootstrap + serve)
│   ├── host.ts                           # Top-level orchestration (imperative shell)
│   │
│   ├── domain/                           # Pure functional core
│   │   ├── host-state.ts                 # HostState DU + transition functions
│   │   ├── registry.ts                   # Immutable registry snapshot type + builders
│   │   ├── dag-registration.ts           # DagRegistration type + Zod schema
│   │   ├── concurrency.ts               # Pure concurrency limiter state + transitions
│   │   ├── circuit-breaker.ts            # Pure circuit breaker state machine
│   │   ├── host-error.ts                 # HostError discriminated union
│   │   └── config.ts                     # HostConfig type + Zod env schema + fugue.yaml schema
│   │
│   ├── adapters/                         # Imperative shell / side-effect boundaries
│   │   ├── git-sync.ts                   # Git clone/pull/rev-parse via Bun.spawn
│   │   ├── module-loader.ts             # Dynamic import + DagRegistration validation
│   │   ├── node-context-factory.ts      # Constructs NodeContext per-request with namespacing
│   │   └── async-result-store.ts        # Redis-backed async run result storage
│   │
│   ├── http/                             # HTTP layer (Hono)
│   │   ├── router.ts                     # Route definitions
│   │   ├── middleware/
│   │   │   ├── concurrency-guard.ts     # 429 when at capacity
│   │   │   └── error-handler.ts         # Maps HostError/FrameworkError → HTTP response
│   │   ├── handlers/
│   │   │   ├── run-dag.ts               # POST /dags/:id/run (sync execution)
│   │   │   ├── submit-dag.ts            # POST /dags/:id/submit (async, P2)
│   │   │   ├── run-status.ts            # GET /runs/:runId/status (P2)
│   │   │   ├── list-dags.ts            # GET /dags
│   │   │   ├── health.ts               # GET /health, GET /readiness
│   │   │   └── metrics.ts              # GET /metrics (P3)
│   │   └── response.ts                  # Typed response builders (machine-readable JSON)
│   │
│   ├── sync/                             # Sync orchestration
│   │   ├── sync-loop.ts                 # Poll timer + sync orchestration
│   │   └── diff.ts                      # Detect added/removed/changed DAGs between snapshots
│   │
│   ├── lifecycle/                        # Process lifecycle
│   │   ├── startup.ts                   # Boot sequence (validate Redis, initial clone, load DAGs)
│   │   ├── shutdown.ts                  # Graceful drain on SIGTERM (P2)
│   │   └── signals.ts                   # Signal handlers
│   │
│   └── __tests__/                        # Tests colocated
│       ├── host-state.test.ts
│       ├── registry.test.ts
│       ├── concurrency.test.ts
│       ├── circuit-breaker.test.ts
│       ├── config.test.ts
│       ├── git-sync.test.ts
│       ├── module-loader.test.ts
│       ├── node-context-factory.test.ts
│       ├── sync-loop.test.ts
│       ├── handlers/
│       │   ├── run-dag.test.ts
│       │   ├── list-dags.test.ts
│       │   └── health.test.ts
│       └── integration/
│           ├── full-lifecycle.test.ts
│           └── dag-isolation.test.ts
```

### Rename: All Existing Packages

```
# package.json name field changes:
packages/framework/package.json    → name: "@fugue/framework"
apps/customer-summary/package.json → name: "@fugue/customer-summary"
package.json (root)                → name: "fugue"

# All import paths change:
@ai-summary/framework → @fugue/framework
```

### Modified Files (rename touches)

Every `.ts` file importing `@ai-summary/framework` — mechanical find-and-replace.

### Dags Repo Structure (separate repository, reference only)

```
fugue-dags/                           # Separate git repo
├── bun.lockb
├── package.json                      # depends on @fugue/framework
├── dags/
│   └── {team}/
│       └── {dag-name}/
│           ├── dag.ts                # exports DagRegistration (default export)
│           ├── fugue.yaml            # per-DAG config (team, env, limits)
│           └── nodes/
│               └── *.ts              # node implementations
```

---

## 4. Component Design

### 4.1 HostState — Pure State Machine

**Responsibility:** Model the host lifecycle as explicit states with deterministic transitions.

**States (DU):**

```typescript
type HostState =
  | { readonly phase: "booting"; readonly startedAt: number }
  | { readonly phase: "syncing"; readonly registry: Registry; readonly syncStartedAt: number }
  | { readonly phase: "ready"; readonly registry: Registry; readonly lastSyncAt: number; readonly lastSyncSha: string }
  | { readonly phase: "degraded"; readonly registry: Registry; readonly reason: DegradedReason; readonly since: number }
  | { readonly phase: "draining"; readonly registry: Registry; readonly drainStartedAt: number; readonly inflightCount: number }
  | { readonly phase: "stopped" };

type DegradedReason = "redis-disconnected" | "sync-failed" | "no-dags-loaded";
```

**Transitions (pure functions):**

```typescript
// Each returns new HostState or HostError
const bootComplete: (registry: Registry, sha: string, now: number) => HostState;
const syncStarted: (state: HostState, now: number) => HostState;
const syncCompleted: (state: HostState, registry: Registry, sha: string, now: number) => HostState;
const syncFailed: (state: HostState, now: number) => HostState;
const beginDrain: (state: HostState, now: number) => HostState;
const drainComplete: () => HostState;
const redisDied: (state: HostState, now: number) => HostState;
const redisRecovered: (state: HostState, now: number) => HostState;
```

**Data flow:** `sync-loop` → calls transition → stores new state → HTTP reads current state for readiness.

---

### 4.2 Registry — Immutable Snapshot

**Responsibility:** Hold all currently-registered DAGs as a frozen, queryable structure.

**Interface:**

```typescript
interface RegisteredDag {
  readonly id: DagId;
  readonly team: string;
  readonly route: string;            // e.g. "/dags/billing:invoice/run"
  readonly dag: DagDef;              // framework type, opaque to host
  readonly inputSchema: z.ZodType;   // from DagRegistration
  readonly config: DagConfig;        // resolved from fugue.yaml
  readonly loadedAt: number;
  readonly sha: string;              // git commit that produced this version
  readonly healthy: boolean;
  readonly disabledReason?: string;
}

interface Registry {
  readonly dags: ReadonlyMap<DagId, RegisteredDag>;
  readonly loadedAt: number;
  readonly sha: string;
}

// Builders (pure)
const emptyRegistry: () => Registry;
const withDag: (r: Registry, dag: RegisteredDag) => Registry;
const withoutDag: (r: Registry, id: DagId) => Registry;
const freeze: (dags: RegisteredDag[], sha: string, now: number) => Registry;
```

**Key invariant:** Once frozen, a Registry is never mutated. New sync → new Registry instance.

---

### 4.3 Git Syncer — Adapter

**Responsibility:** Clone a git repo, detect new commits, pull changes.

**Interface (port):**

```typescript
interface GitPort {
  readonly clone: (url: string, target: string, opts?: { branch?: string; depth?: number }) => Promise<Result<void, HostError>>;
  readonly pull: (repoPath: string) => Promise<Result<void, HostError>>;
  readonly currentSha: (repoPath: string) => Promise<Result<string, HostError>>;
  readonly hasLockfileChanged: (repoPath: string, fromSha: string, toSha: string) => Promise<Result<boolean, HostError>>;
}
```

**Implementation:** `Bun.spawn("git", [...args])` with timeout, stderr capture, exit code mapping to `HostError`.

**Dev mode:** When config `DAGS_LOCAL_PATH` is set (local path, not a URL), skip clone/pull — just read the directory directly. `currentSha` returns a hash of file mtimes.

---

### 4.4 Module Loader

**Responsibility:** Dynamically import DAG modules, validate against `DagRegistration` schema, handle import errors.

**Interface:**

```typescript
interface LoadResult {
  readonly id: DagId;
  readonly registration: DagRegistration;
}

const loadDagModule: (
  modulePath: string,
  sha: string,
) => Promise<Result<LoadResult, HostError>>;

const discoverDagPaths: (dagsRoot: string) => Promise<string[]>;
```

**Key behaviors:**
- `import(modulePath + "?v=" + sha)` for cache-busting
- Validates default export against `DagRegistrationSchema` (Zod)
- Catches thrown errors during import (syntax, missing deps) → `HostError { kind: "import-failed" }`
- Never crashes the host process

---

### 4.5 NodeContext Factory

**Responsibility:** Construct `NodeContext` per-request with shared infrastructure + per-request unique fields + DAG-namespaced Redis keys.

**Interface:**

```typescript
interface SharedInfra {
  readonly llm: LlmClient;
  readonly redis: Redis;
  readonly tracer: Tracer;
  readonly contentFilter: ContentFilter | null;
}

const createNodeContextForDag: (
  shared: SharedInfra,
  dag: RegisteredDag,
  runId: RunId,
  signal: AbortSignal,
) => NodeContext;
```

**Key behaviors:**
- Cache adapter wraps Redis with key prefix `fugue:{dagId}:cache:`
- Checkpoint writer wraps Redis with key prefix `fugue:{dagId}:{runId}:`
- `runId` is fresh UUID per request (or caller-supplied for resume)
- `signal` is per-request AbortSignal (timeout-controlled)
- LLM client, tracer are shared singleton references (no per-request init)

**Framework independence:** Factory uses `makeNodeContext` from `@fugue/framework` — standard API, no special host knowledge needed in framework.

---

### 4.6 HTTP Router (Hono)

**Responsibility:** Route HTTP requests to handlers. Read from registry snapshot. Enforce concurrency.

**Routes:**

| Method | Path | Handler | Priority |
|--------|------|---------|----------|
| POST | `/dags/:id/run` | Sync execution | P1 |
| POST | `/dags/:id/submit` | Async submission | P2 |
| GET | `/runs/:runId/status` | Async poll | P2 |
| GET | `/dags` | List registered DAGs | P1 |
| GET | `/health` | Liveness (always 200) | P1 |
| GET | `/readiness` | Readiness check | P1 |
| GET | `/metrics` | Per-DAG metrics | P3 |

**Request flow (sync execution):**

```
Request → concurrency-guard middleware → handler:
  1. Look up DAG in registry snapshot → 404 if missing
  2. Validate input against DAG's input schema → 400 if invalid
  3. Check circuit breaker state → 503 if open
  4. Acquire per-DAG concurrency token → 429 if at capacity
  5. Create NodeContext via factory
  6. Call runDag(dag.dag, input, ctx) with timeout
  7. Map Result to HTTP response (200/408/500)
  8. Record success/failure in circuit breaker
  9. Release concurrency token (finally)
```

**Response shape (all errors):**

```typescript
interface ErrorResponse {
  readonly error: string;      // machine-readable code
  readonly message: string;    // human description
  readonly details?: unknown;  // actionable context
  readonly dagId?: string;
  readonly runId?: string;
}
```

---

### 4.7 Concurrency Limiter — Pure State

**Responsibility:** Track global and per-DAG in-flight execution counts.

**Interface:**

```typescript
interface ConcurrencyState {
  readonly global: { readonly current: number; readonly max: number };
  readonly perDag: ReadonlyMap<DagId, { readonly current: number; readonly max: number }>;
}

type AcquireToken = { readonly dagId: DagId; readonly acquiredAt: number };

const acquire: (state: ConcurrencyState, dagId: DagId, now: number) 
  => Result<{ state: ConcurrencyState; token: AcquireToken }, "global-at-capacity" | "dag-at-capacity">;

const release: (state: ConcurrencyState, token: AcquireToken) 
  => ConcurrencyState;
```

**Defaults:** Global max 50, per-DAG max 10 (overridable in `fugue.yaml`).

---

### 4.8 Circuit Breaker — Pure State Machine

**Responsibility:** Auto-disable DAGs that fail repeatedly.

**States:**

```typescript
type CircuitState =
  | { readonly state: "closed"; readonly failureCount: number; readonly windowStart: number }
  | { readonly state: "open"; readonly openedAt: number; readonly reason: string }
  | { readonly state: "half-open"; readonly testRequestAllowed: boolean };

const recordSuccess: (s: CircuitState, now: number) => CircuitState;
const recordFailure: (s: CircuitState, now: number, threshold: number, windowMs: number) => CircuitState;
const attemptReset: (s: CircuitState, now: number, cooldownMs: number) => CircuitState;
const forceReset: () => CircuitState;  // called on new git version
```

**Threshold:** >5 failures in 60s → open. New git SHA → force reset.

---

### 4.9 HostError — Discriminated Union

**Responsibility:** Type-safe error space for all host-level concerns.

```typescript
type HostError =
  | { readonly kind: "git-clone-failed"; readonly url: string; readonly message: string }
  | { readonly kind: "git-pull-failed"; readonly message: string }
  | { readonly kind: "git-timeout"; readonly operation: string }
  | { readonly kind: "import-failed"; readonly path: string; readonly message: string; readonly stack?: string }
  | { readonly kind: "validation-failed"; readonly path: string; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "no-default-export"; readonly path: string }
  | { readonly kind: "dag-not-found"; readonly dagId: string; readonly available: readonly string[] }
  | { readonly kind: "dag-disabled"; readonly dagId: string; readonly reason: string }
  | { readonly kind: "concurrency-exceeded"; readonly scope: "global" | "dag"; readonly dagId?: string }
  | { readonly kind: "timeout"; readonly dagId: string; readonly runId: string; readonly timeoutMs: number }
  | { readonly kind: "redis-unavailable"; readonly operation: string }
  | { readonly kind: "bun-install-failed"; readonly message: string }
  | { readonly kind: "config-invalid"; readonly message: string }
  | { readonly kind: "input-validation-failed"; readonly dagId: string; readonly issues: readonly ZodIssue[] }
  | { readonly kind: "async-result-expired"; readonly runId: string };
```

**Mapping to HTTP:**

| HostError kind | HTTP status |
|---|---|
| dag-not-found | 404 |
| input-validation-failed, validation-failed | 400 |
| concurrency-exceeded | 429 |
| timeout | 408 |
| dag-disabled | 503 |
| redis-unavailable | 503 |
| async-result-expired | 410 |
| import-failed, git-* | 500 (internal, log detail) |

---

### 4.10 Config

**Responsibility:** Parse and validate host configuration from environment + per-DAG YAML.

**Host config (env vars, Zod schema):**

```typescript
const HostConfigSchema = z.object({
  // Git
  DAGS_REPO_URL: z.string(),                    // git URL or local path (dev mode)
  DAGS_REPO_BRANCH: z.string().default("main"),
  DAGS_POLL_INTERVAL_MS: z.coerce.number().default(30_000),
  DAGS_LOCAL_PATH: z.string().optional(),       // override: skip git, use local dir
  
  // Redis
  REDIS_URL: z.string(),
  
  // HTTP
  PORT: z.coerce.number().default(3000),
  
  // Concurrency
  MAX_GLOBAL_CONCURRENCY: z.coerce.number().default(50),
  DEFAULT_DAG_CONCURRENCY: z.coerce.number().default(10),
  DEFAULT_DAG_TIMEOUT_MS: z.coerce.number().default(60_000),
  MAX_DAG_TIMEOUT_MS: z.coerce.number().default(120_000),
  
  // Shutdown
  DRAIN_TIMEOUT_MS: z.coerce.number().default(30_000),
  
  // LLM
  LLM_PROVIDER: z.enum(["anthropic", "openai", "azure"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  
  // Tracing
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  MLFLOW_TRACKING_URI: z.string().optional(),
  MLFLOW_EXPERIMENT_ID: z.string().optional(),
  
  // Async results
  ASYNC_RESULT_TTL_MS: z.coerce.number().default(3_600_000), // 1h
  
  // Circuit breaker
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),
  CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().default(60_000),
});
```

**Per-DAG config (`fugue.yaml` schema):**

```typescript
const FugueYamlSchema = z.object({
  team: z.string(),
  owner: z.string().optional(),
  env: z.array(z.string()).default([]),         // required env vars
  maxConcurrent: z.number().optional(),         // override per-dag limit
  timeoutMs: z.number().optional(),             // override timeout
  route: z.string().optional(),                 // custom route path
  cacheTtlMs: z.number().optional(),
  checkpointTtlMs: z.number().optional(),
  asyncResultTtlMs: z.number().optional(),
});
```

---

### 4.11 DagRegistration Contract

**Responsibility:** The typed contract DAG authors export from `dag.ts`.

```typescript
// Defined in @fugue/host — NOT in @fugue/framework
// (DAG authors import this type from @fugue/host or a thin @fugue/dag-contract package)

import type { DagDef } from "@fugue/framework";
import { z } from "zod";

interface DagRegistration {
  readonly dag: DagDef;
  readonly inputSchema: z.ZodType<unknown>;     // validates HTTP input before execution
  readonly meta?: {
    readonly description?: string;
    readonly version?: string;
  };
}

// Zod schema for runtime validation of the export shape
const DagRegistrationSchema = z.object({
  dag: z.custom<DagDef>((v) => v && typeof v === "object" && "id" in v && "nodes" in v && "edges" in v),
  inputSchema: z.custom<z.ZodType>((v) => v && typeof v === "object" && "parse" in v),
  meta: z.object({
    description: z.string().optional(),
    version: z.string().optional(),
  }).optional(),
});
```

**Key design choice:** `inputSchema` is mandatory — every DAG declares what input it accepts. The host validates incoming HTTP payloads against this before execution. This replaces the per-app Zod schema that currently lives in `server.ts`.

---

### 4.12 Sync Loop

**Responsibility:** Periodic polling of git repo, detecting changes, orchestrating reload.

**Flow:**

```
1. Wait poll interval
2. git rev-parse HEAD → compare to lastSyncSha
3. If same → no-op, back to 1
4. git pull
5. Check if bun.lockb changed → run bun install if so
6. Discover DAG paths (glob dags/*/*/dag.ts)
7. For each path: loadDagModule() → collect results
8. Build new Registry from successful loads
9. Atomically swap registry reference
10. Force-reset circuit breakers for DAGs with new SHA
11. Log summary (added/removed/failed/unchanged)
12. Back to 1
```

**Error isolation:** A single DAG import failure does NOT block others. Summary log shows which failed and why.

---

### 4.13 Dockerfile + Entrypoint

```dockerfile
FROM oven/bun:1.2-alpine

RUN apk add --no-cache git

WORKDIR /app

# Copy host package + framework
COPY packages/framework/ packages/framework/
COPY packages/host/ packages/host/
COPY package.json bun.lockb ./

RUN bun install --frozen-lockfile --production

# DAGs are cloned at runtime, not baked into image
ENV DAGS_REPO_URL=""
ENV REDIS_URL=""
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "packages/host/src/index.ts"]
```

**Key:** DAGs are NOT in the image. They're cloned at startup from `DAGS_REPO_URL`. This means DAG deploys don't require image rebuilds.

---

### 4.14 @ai-summary → @fugue Rename

**Scope:** Mechanical find-and-replace across entire monorepo.

**Changes:**
1. `packages/framework/package.json` → `"name": "@fugue/framework"`
2. `apps/customer-summary/package.json` → `"name": "@fugue/customer-summary"`
3. Root `package.json` → `"name": "fugue"`
4. All `import ... from "@ai-summary/framework"` → `"@fugue/framework"`
5. All `import ... from "@ai-summary/framework/redis"` → `"@fugue/framework/redis"`
6. All `import ... from "@ai-summary/framework/advanced"` → `"@fugue/framework/advanced"`
7. All `import ... from "@ai-summary/framework/testing"` → `"@fugue/framework/testing"`
8. All `import ... from "@ai-summary/framework/bullmq"` → `"@fugue/framework/bullmq"`
9. `workspace:*` references in dependency declarations

**Verification:** `bun install && bun run typecheck && bun run test` must pass after rename.

---

## 5. Implementation Phases

### Phase 1: Foundation (can be parallelized internally)

**Wave 1A: Rename** (blocker for everything else)
- [ ] Rename `@ai-summary/*` → `@fugue/*` across monorepo
- [ ] Update root package.json
- [ ] `bun install && bun run typecheck && bun run test`

**Wave 1B: Pure Domain Core** (parallelizable after 1A)
- [ ] `packages/host/package.json` + `tsconfig.json`
- [ ] `domain/host-error.ts` — HostError DU
- [ ] `domain/config.ts` — Zod env schema + fugue.yaml schema
- [ ] `domain/registry.ts` — Registry type + builders
- [ ] `domain/dag-registration.ts` — DagRegistration + validation schema
- [ ] `domain/concurrency.ts` — pure concurrency limiter
- [ ] `domain/circuit-breaker.ts` — pure circuit breaker state machine
- [ ] `domain/host-state.ts` — HostState DU + transitions

**Tests for 1B:** Unit tests for every pure function (property tests for state transitions).

---

### Phase 2: Adapters (depends on Phase 1B)

**Wave 2A: Git + Module Loader** (parallelizable)
- [ ] `adapters/git-sync.ts` — GitPort implementation via Bun.spawn
- [ ] `adapters/module-loader.ts` — dynamic import + validation
- [ ] `sync/diff.ts` — detect DAG changes between snapshots
- [ ] `sync/sync-loop.ts` — poll timer + orchestration

**Wave 2B: NodeContext Factory** (parallelizable with 2A)
- [ ] `adapters/node-context-factory.ts` — per-request context with namespacing
- [ ] `adapters/async-result-store.ts` — Redis-backed result storage (P2)

**Tests for 2:** Integration tests with real git repo (tmp dir), adapter tests with Redis testcontainer.

---

### Phase 3: HTTP Layer (depends on Phase 2)

- [ ] `http/response.ts` — typed response builders
- [ ] `http/middleware/error-handler.ts` — HostError/FrameworkError → HTTP
- [ ] `http/middleware/concurrency-guard.ts` — acquire/release around handlers
- [ ] `http/handlers/health.ts` — /health + /readiness
- [ ] `http/handlers/list-dags.ts` — GET /dags
- [ ] `http/handlers/run-dag.ts` — POST /dags/:id/run (sync execution)
- [ ] `http/router.ts` — wire all routes

**Tests for 3:** Handler unit tests with fake registry/deps. Integration test with real HTTP.

---

### Phase 4: Lifecycle + Integration (depends on Phase 3)

- [ ] `lifecycle/startup.ts` — boot sequence
- [ ] `lifecycle/signals.ts` — SIGTERM handler
- [ ] `lifecycle/shutdown.ts` — graceful drain (P2)
- [ ] `host.ts` — top-level orchestration wiring everything together
- [ ] `index.ts` — entry point

**Tests for 4:** Full lifecycle integration test (boot → sync → register → serve → respond → shutdown).

---

### Phase 5: Migration + Deployment (depends on Phase 4)

- [ ] Migrate `apps/customer-summary` to DagRegistration format in dags repo
- [ ] Verify all existing tests pass against host-served DAG
- [ ] `Dockerfile`
- [ ] Verify builds + runs in container
- [ ] P2: `http/handlers/submit-dag.ts` + `http/handlers/run-status.ts` (async)

---

### Phase 6: P2 Features (depends on Phase 5)

- [ ] Graceful shutdown with drain
- [ ] Async execution (submit + poll)
- [ ] Circuit breaker integration into request flow
- [ ] DAG-to-DAG composition (`ctx.invoke`)
- [ ] Secrets/config injection from fugue.yaml `env` declarations

---

## 6. Testing Strategy

### 6.1 Domain (Pure Functions) — Unit Tests

**Coverage target:** 100% of transition functions.

| Component | Test approach | Key scenarios |
|-----------|--------------|---------------|
| HostState | Property tests | All valid transition sequences, invalid transition rejection |
| Registry | Unit | Build, freeze, lookup, withDag, withoutDag idempotence |
| Concurrency | Property tests | acquire/release balance, capacity limits, concurrent acquire race |
| Circuit Breaker | Unit + property | State transitions, window expiry, threshold edge, force reset |
| Config | Unit | Valid env, missing required, coercion, fugue.yaml parse |
| DagRegistration | Unit | Valid export, missing fields, invalid shapes, defaults applied |

**Tools:** `bun test`, `fast-check` for property tests.

---

### 6.2 Adapters — Integration Tests

| Component | Test approach | Key scenarios |
|-----------|--------------|---------------|
| Git Sync | Integration (tmp repo) | Clone, pull, SHA detection, lockfile change detection, unreachable remote |
| Module Loader | Integration (fixture DAGs) | Valid import, syntax error, missing dep, no default export, invalid schema |
| NodeContext Factory | Unit (mock Redis) | Key namespacing, isolation between DAGs, shared infra reuse |
| Async Result Store | Integration (Redis) | Store, retrieve, TTL expiry, 410 after expiry |

**Infra:** Temp git repos via `Bun.spawn("git init")`. Redis via testcontainer or local.

---

### 6.3 HTTP — Handler Tests

| Component | Test approach | Key scenarios |
|-----------|--------------|---------------|
| run-dag handler | Unit (fake registry) | Valid request → 200, invalid input → 400, missing DAG → 404, timeout → 408, concurrency → 429 |
| list-dags handler | Unit | Returns all registered DAGs with metadata |
| health handler | Unit | Liveness always 200, readiness based on state |
| error-handler middleware | Unit | Every HostError kind → correct HTTP status |
| concurrency-guard | Unit | Acquire success → proceed, acquire fail → 429 with Retry-After |

---

### 6.4 Integration — End-to-End

| Scenario | What it proves |
|----------|---------------|
| Full lifecycle | Boot → sync → register → serve → respond → shutdown |
| DAG isolation | Two DAGs with same cache key → isolated Redis entries |
| Sync picks up changes | Push to test repo → poll → new DAG live |
| Invalid DAG doesn't break others | Bad DAG in repo → error logged, other DAGs still serve |
| customer-summary migration | Existing DAG runs through host, same results |
| Circuit breaker triggers | Failing DAG auto-disables after threshold |

---

### 6.5 Test Boundaries

**What we DON'T mock:**
- Framework `runDag` — test with real framework executor against simple test DAGs
- Redis — use real Redis in integration tests (testcontainer)
- Git — use real git in integration tests (tmp repos)

**What we DO fake:**
- LLM client — `FakeLlmClient` from framework for DAG execution tests
- Time — injectable `now()` clock for circuit breaker and concurrency tests
- Git remote — local bare repo for sync tests

---

## 7. Key Invariants

1. **Registry immutability** — Once a `Registry` is frozen, no mutation occurs. HTTP handlers hold a reference; sync produces a new one.
2. **Namespace isolation** — All Redis keys for DAG X contain `fugue:{dagId}:`. No key collision possible between DAGs.
3. **Framework independence** — `@fugue/framework` never imports from `@fugue/host`. Verified by lint rule.
4. **Error exhaustiveness** — Every `HostError` kind is handled in the HTTP error mapper (enforced by `never` guard in switch).
5. **Concurrency balance** — Every `acquire` has a matching `release` in a `finally` block. Property test: after N acquire+release pairs, state returns to zero.
6. **Sync isolation** — A failing DAG import never prevents other DAGs from loading. The sync loop collects all results then builds the registry from successes only.
7. **No thrown exceptions in domain** — All domain functions return `Result`. Only adapters may throw (caught at boundary).

---

## 8. Migration: customer-summary → DagRegistration

The existing `apps/customer-summary` migrates to the dags repo format:

```typescript
// fugue-dags/dags/cx/customer-summary/dag.ts
import { defineDag } from "@fugue/framework";
import { z } from "zod";
import type { DagRegistration } from "@fugue/host";
import { createSummaryDag } from "./summary-dag.js";

const registration: DagRegistration = {
  dag: createSummaryDag(/* source injected by host via context */),
  inputSchema: z.object({
    customer_id: z.string().min(1),
    resume_run_id: z.string().optional(),
  }),
  meta: {
    description: "Generate customer summary from CRM conversations",
    version: "1.0.0",
  },
};

export default registration;
```

**Backwards compatibility:** The host supports a `route` override in `fugue.yaml` so the migrated DAG can keep serving at `/summarize` in addition to the canonical `/dags/cx:customer-summary/run`.

---

## 9. Open Design Notes

1. **DagRegistration package location:** `DagRegistration` type is defined in `@fugue/host`. DAG authors in the dags repo depend on `@fugue/host` for the type only (or we extract a thin `@fugue/dag-contract` package if host deps become heavy). Decision: start in host, extract later if needed.

2. **Source injection:** The current `customer-summary` injects a `ConversationSource` at DAG creation time. In host mode, this becomes a capability on NodeContext or a constructor arg in the DAG factory. The DagRegistration can accept a factory function `(ctx: HostContext) => DagDef` instead of a static `DagDef` for DAGs that need host-provided resources.

3. **Input routing for resume:** The current `resume_run_id` in request body triggers resume logic. The host generalizes this: `POST /dags/:id/run` with body `{ input: {...}, resumeRunId?: string }`.

4. **Dev mode:** When `DAGS_LOCAL_PATH` is set, skip git entirely. Watch filesystem for changes (or poll mtimes). Enables `bun run packages/host/src/index.ts` locally pointing at a directory.
