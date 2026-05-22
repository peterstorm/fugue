# Extracted Memories from Claude Code Session

**Latest Session ID:** 019e4ec0-87ed-7a63-ac58-1f2c98f40d2e  
**Latest Timestamp:** 2026-05-22T08:15:01Z  
**Model:** claude-opus-4.6 (high thinking level)

> **Previous session:** 019e2b72-ec22-75ab-a805-404a69ebc155 (2026-05-15T11:43:32Z, framework PR review)

## Latest Session: @fugue/host HTTP API & Authentication Design

## Session Context

- **Project:** Fugue (feat/initial-setup branch)
- **PR Scope:** 363 files changed, 62,518 insertions
- **Focus:** Framework package (112 non-test source + 85 test files)
- **Branch:** feat/initial-setup
- **CWD:** /Users/hansen142/dev/agentic/fugue

## Key Extracted Memories

### 1. Comprehensive PR Review Architecture
**Type:** architecture | **Confidence:** 0.92 | **Priority:** 8  
**Tags:** pr-review, workflow, agents, automation, code-quality

Comprehensive PR review uses parallel specialized agents instead of inline reviews. Seven agents are dispatched via subagent system:
1. **loom:code-reviewer** — CLAUDE.md compliance and bugs
2. **loom:silent-failure-hunter** — Either patterns and silent failures
3. **loom:pr-test-analyzer** — Test coverage gaps
4. **loom:type-design-analyzer** — Invariants and encapsulation
5. **loom:comment-analyzer** — Comment accuracy
6. **loom:architecture-agent** (auto-triggered) — FC/IS adherence and coupling analysis
7. **loom:code-simplifier** — Polish after fixes

Each agent produces a Machine Summary with CRITICAL_COUNT and ADVISORY_COUNT for automation hook parsing.

---

### 2. Auto-Trigger Condition for Architecture Review
**Type:** decision | **Confidence:** 0.88 | **Priority:** 7  
**Tags:** pr-review, architecture-review, auto-trigger, framework, feat-initial-setup

**Auto-trigger:** PR with >500 additions **OR** >10 files changed  
**This PR status:** 363 files + 62,518 insertions → **Architecture-agent ACTIVE**

Architecture review includes:
- FC/IS pattern adherence
- Coupling analysis
- Testability scoring
- Service design assessment
- Refactoring priorities
- Unresolved questions

---

### 3. Deterministic PR Review Workflow
**Type:** pattern | **Confidence:** 0.85 | **Priority:** 7  
**Tags:** pr-review, workflow, review-trigger, git-diff, agent-dispatch

**File identification:**
```bash
git diff main...HEAD --name-only
git diff --cached --name-only
```

**Review trigger logic:**
- **Always:** code-reviewer (general quality)
- **If error handling changed:** silent-failure-hunter
- **If tests or new logic added:** pr-test-analyzer
- **If types added/modified:** type-design-analyzer
- **If comments/docs added:** comment-analyzer
- **If >500 additions OR >10 files:** architecture-agent ← **THIS PR**
- **After fixes pass:** code-simplifier

**Delegation recommendations:** security-expert, java-test-engineer, ts-test-engineer, nextjs-frontend-design (as determined by each agent)

---

### 4. Framework Review Scope
**Type:** context | **Confidence:** 0.82 | **Priority:** 6  
**Tags:** framework, pr-review, test-coverage, type-design, error-handling

**File count:** 197 changed (112 source + 85 test)

**Modules reviewed:** cache/, checkpoint/, dag-runtime/, executor/, llm/, nodes/, observer/, queue/, queue-bullmq/, scheduler/, shared/, state-machine/, sugar/, tracing/, types/

**Review aspects:**
- Code quality (CLAUDE.md patterns)
- Error handling (Either-based silent failure prevention)
- Test coverage (unit + integration + property tests)
- Type invariants (branded IDs, sealed types)
- Comments/documentation
- Architecture (FC/IS, coupling, testability, service boundaries)

---

### 5. Framework PR Release Workflow
**Type:** pattern | **Confidence:** 0.79 | **Priority:** 5  
**Tags:** pr-workflow, checklist, framework, code-review, release-readiness

**Pre-PR workflow:**
1. Write code
2. Run: `pr-review code errors`
3. Fix critical issues
4. Commit
5. Stage all changes
6. Run: `pr-review all`
7. Address critical and important issues
8. Run delegated reviews (security-expert, java-test-engineer, ts-test-engineer, nextjs-frontend-design as recommended)
9. Run: `pr-review simplify`
10. Create PR

**Key principle:** Simplify runs last to polish after other issues are resolved.

---

### 6. Machine Summary Block (Automation Contract)
**Type:** decision | **Confidence:** 0.9 | **Priority:** 8  
**Tags:** pr-review, automation, machine-summary, hooks, critical

**MANDATORY block at end of review (even if counts are zero):**

```
### Machine Summary
CRITICAL_COUNT: {number}
ADVISORY_COUNT: {number}
CRITICAL: {each critical finding on own line}
ADVISORY: {each non-critical finding on own line}
```

**Why:** This block is parsed by automated hooks — omitting it breaks automation. Every review output must include this.

---

## Extracted Entities

| Entity | Type | Relationship |
|--------|------|--------------|
| **feat/initial-setup** | concept | branch on Fugue project with 363 files, 62,518 insertions focused on framework implementation |
| **Fugue framework** | project | public surface barrel deliberately narrow, re-exports only documented entries from src/index.ts with ADR/plan citations |
| **comprehensive PR review** | process | uses 7 parallel specialized agents (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent, code-simplifier) |
| **architecture-agent** | tool | auto-triggers when PR has >500 additions OR >10 files changed |
| **Machine Summary** | concept | is parsed by automated hooks for CRITICAL_COUNT, ADVISORY_COUNT, and findings aggregation |
| **framework package** | concept | has 15 modules: cache, checkpoint, dag-runtime, executor, llm, nodes, observer, queue, queue-bullmq, scheduler, shared, state-machine, sugar, tracing, types |

---

## Related Existing Memories

From previous sessions on Fugue (state-transition observability phases):
- ADR-0024: LLM types in types layer
- ADR-0025: Freshness witness contract
- ADR-0026: Human intervention telemetry
- ADR-0027: Bucketed confidence calibration
- Phase 1: sideEffects taxonomy (~120 LoC + 80 tests)
- Phase 2: route evidence + bucketed confidence
- Phase 3: Freshness witness contract (~450 LoC + 300 tests, in runtime integration)
- Phase 4: HumanInterventionEvent as first-class telemetry
- Phase 5: Documentation and MLflow exporter polish

---

## Recommendations (from 2026-05-15 session)

1. **Activate all 7 review agents** for this PR (auto-triggered architecture review is active)
2. **Machine Summary block is critical** — all agents must include it for automation to work
3. **Framework focus areas:**
   - Type invariants (branded IDs hardened in ADR-0027 #1.6, #1.7)
   - Error handling with Either patterns (silent failure prevention)
   - Test coverage completeness (property tests, cross-process Redis validation)
   - Coupling analysis (15 modules need clear boundaries)
4. **Expect delegation recommendations** to: java-test-engineer, ts-test-engineer, security-expert as code-reviewer discovers issues
5. **Run simplify last** after all critical/important issues are fixed

---

## 2026-05-22 Session: @fugue/host HTTP API & Authentication

### 7. @fugue/host HTTP API Design
**Type:** architecture | **Confidence:** 0.95 | **Priority:** 9  
**Tags:** http-api, endpoints, error-codes, observability, @fugue/host, hono

**Four endpoints:**
- `GET /health` — Liveness probe (503 if unavailable)
- `GET /readiness` — Readiness probe with DAG count and phase (503 if not ready)
- `GET /dags` — List all registered DAGs with metadata (id, route, description, version, healthy flag)
- `POST /dags/:id/run` — Execute DAG with JSON input

**Response codes:**
- `200` — Success (with `runId`, `durationMs`, DAG output)
- `400` — Invalid ID / bad JSON body / input validation failed
- `404` — DAG not found (includes list of available DAGs)
- `408` — Timeout (with `runId` for future resumption)
- `429` — Concurrency limit exceeded (per-DAG or global, includes `Retry-After: 5`)
- `503` — Host booting/draining, DAG disabled, or circuit breaker open

**Response shape:** All JSON with discriminated error/success variants (ok: boolean discriminant).

---

### 8. Host Boot Sequence
**Type:** architecture | **Confidence:** 0.93 | **Priority:** 9  
**Tags:** lifecycle, startup, initialization, redis, dag-discovery, @fugue/host

**Sequential startup:**
1. Validate Redis connectivity (PING) — reject with actionable error if unreachable (FR-006)
2. Build `SyncConfig` from `HostConfig` (local path vs git repo URL + branch)
3. Initial clone/load all DAG modules into `Registry`
4. Wire Hono router with dependencies injected via closure (no global state)
5. Inject `HostState` into all routes via middleware context variable
6. Serve HTTP on configured port

**Key invariant:** HostState is immutable reference passed through request context; state mutations (concurrency tokens, circuit breaker) are managed via getDeps/setDeps closures for testability.

---

### 9. Bearer Token Authentication Design (Planned)
**Type:** decision | **Confidence:** 0.82 | **Priority:** 8  
**Tags:** authentication, security, bearer-token, middleware, kubernetes-probes

**Requirements:**
- Optional `API_TOKEN` field in `HostConfigSchema` (Zod)
- When token is set, all DAG routes require `Authorization: Bearer <token>`
- **Health routes MUST bypass auth** (GET /health, GET /readiness) — Kubernetes probes depend on unauthenticated access
- Development mode: no token configured → all routes accessible (dev ergonomics)

**Implementation strategy:**
- Add new middleware after error-handler, before DAG routes
- Extract Authorization header, validate Bearer token format
- Reject with 403 + structured error response if missing/invalid
- Add new `HostError` variant: `{ kind: "unauthorized" }`
- Health routes registered **before** auth middleware (no guard applied)

---

### 10. Router Dependency Injection Pattern
**Type:** pattern | **Confidence:** 0.88 | **Priority:** 7  
**Tags:** router, dependency-injection, testability, middleware, hono

**RouterDeps interface:**
```typescript
interface RouterDeps extends RunDagDeps {
  readonly getHostState: () => HostState;
  readonly logger: ErrorHandlerLogger;
}
```

**Middleware chain:**
1. `app.onError()` — Error handler (outermost, catches all errors)
2. `app.use("*", ...)` — State injection middleware (sets HostState in context.Variables)
3. `app.get("/health", ...)` — Health routes (no middleware guards)
4. `app.get("/readiness", ...)` — Readiness route (no middleware guards)
5. Future: Auth middleware (guards non-health routes)
6. `app.get("/dags", ...)` — List DAGs
7. `app.post("/dags/:id/run", ...)` — Execute DAG (with concurrency/circuit guards already inside handler)

**No global state:** All dependencies injected via closure, making handlers completely testable without mocks.

---

### 11. Concurrency Token Management Pattern
**Type:** pattern | **Confidence:** 0.89 | **Priority:** 8  
**Tags:** concurrency, atomicity, error-handling, token-release, synchronous-barrier

**Guarantee:** In run-dag handler:
```typescript
try {
  // 1. Acquire token (fails with 429 if exhausted)
  const token = deps.getConcurrency()...
  // 2. Execute DAG
  const result = await deps.executeDag(...)
} finally {
  // 3. SYNCHRONOUS release (no await) ensures atomicity within event-loop tick
  const current = deps.getConcurrency();
  deps.setConcurrency(release(current, token));
}
```

**Critical:** Release must NOT be async. Single-threaded JavaScript event loop guarantees read-transform-write atomicity within a tick, preventing lost tokens or double-release races.

**Scope:** Per-DAG limit checked, global limit checked, both enforced.

---

### 12. Error Handler Middleware Security Sanitization
**Type:** gotcha | **Confidence:** 0.88 | **Priority:** 8  
**Tags:** security, error-handler, information-leakage, observability, logging

**Client-facing vs server-side:**
- **HTTP response:** Generic message ("An unexpected error occurred") — NEVER stack traces or internal details
- **Server logs:** Full error chain with stack trace, cause messages, context for debugging
- **Structured logging:** Error logged with level, message, stack, cause details, timestamp as JSON

**Exhaustive error mapping:** All HostError kinds explicitly mapped to HTTP status codes via ts-pattern `.exhaustive()`. Unhandled errors trapped, logged, and returned as generic 500.

**Discriminant-based routing:** Error handler checks for HostError discriminant (`kind` field), wraps framework errors, prevents leakage of internal implementation details.

---

### 13. Health Endpoint Auth Bypass Rationale
**Type:** decision | **Confidence:** 0.90 | **Priority:** 9  
**Tags:** kubernetes-probes, health-checks, orchestration, probe-polling, auth-bypass

**Why health endpoints cannot require auth:**
1. **Kubernetes probes** (liveness, readiness, startup) are **unauthenticated HTTP requests** sent by orchestration layer
2. Probes poll every 10-30s continuously during pod startup, running, updates, termination
3. If probes hit 403/401, k8s marks pod as unhealthy → immediate termination/restart (cascading failures)
4. No way to pass token to k8s probes without external configuration per environment
5. Standard practice: health endpoints are **always public**, protected by network policy / firewall, not bearer token

**Scope:** GET /health and GET /readiness must **completely bypass auth middleware**, even when token is configured.

---

## Extracted Entities (2026-05-22 session)

| Entity | Type | Relationship |
|--------|------|-------------|
| **@fugue/host** | project | exposes 4 HTTP endpoints via Hono router with dependency-injected handlers |
| **GET /health** | concept | liveness probe, 200 (ok) or 503 (unavailable), no auth |
| **GET /readiness** | concept | readiness probe with DAG count and phase, 200 (ready) or 503, no auth |
| **POST /dags/:id/run** | concept | executes DAG with JSON input, returns 200 (success with runId/durationMs) or error |
| **Bearer Token Auth** | concept | planned middleware for DAG protection; health routes bypass |
| **RouterDeps** | concept | interface for injecting concurrency, circuit, executor, clock into handlers |
| **Concurrency Model** | concept | acquire-execute-release with synchronous finally-block release for atomicity |
| **Error Handler Middleware** | concept | exhaustively maps all HostError kinds to status codes; sanitizes client responses |
| **Kubernetes Probes** | concept | drive health endpoint access; probes are unauthenticated, cannot be auth-gated |

---

## Next Steps (Planned, from 2026-05-22 session)

1. **Implement bearer token auth middleware**
   - Add `API_TOKEN` optional field to `HostConfigSchema`
   - Create `auth.ts` middleware in `http/middleware/`
   - Apply middleware after state injection, skip health routes
   - Add `unauthorized` HostError variant

2. **Wire into router**
   - Register health routes first (no guards)
   - Register auth middleware
   - Register DAG routes

3. **Test coverage**
   - Auth middleware tests: valid token, missing token, invalid token, health bypass
   - Integration tests: authenticated DAG execution, unauthenticated reject
   - Property tests: token format validation

4. **Documentation**
   - Add to `packages/host/docs/auth.md` (already exists in changed files list)
   - Update README with environment variable examples

---

## Session Metadata

**Branch:** feat/fugue-host  
**Focus:** @fugue/host package HTTP layer + auth design  
**Model:** claude-opus-4.6 (high thinking level)  
**Key investigation:** Explored router, handlers, config, error-handler, startup to understand architecture before implementing auth  
**Outcome:** Comprehensive HTTP API design documented + auth strategy clarified + implementation plan ready
