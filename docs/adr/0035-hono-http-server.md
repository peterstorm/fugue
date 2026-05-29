# ADR 0035: Hono HTTP Server

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0036 (layered error handling), ADR 0030 (state machine with pure transitions)

## Context

The host exposes an HTTP API for DAG execution (`POST /dags/:id/run`), registry inspection (`GET /dags`), and health/readiness probes (`GET /health`, `GET /readiness`). An HTTP framework is needed to handle routing, middleware composition (error handling, concurrency guards), request parsing, and response building.

The monorepo already uses Hono in `apps/customer-summary` for its HTTP layer. The team has operational experience with it. The host's HTTP needs are straightforward: typed routes, middleware pipeline, JSON request/response, no SSR or static file serving.

The runtime is Bun, which has its own native HTTP server (`Bun.serve`). The question is whether to use Bun's raw server directly, adopt the existing Hono dependency, or bring in a different framework.

## Options Considered

1. **Hono (chosen)**
   - Pros:
     - Already in use in the monorepo (`apps/customer-summary`). Team familiarity, proven patterns.
     - TypeScript-native with excellent type inference for route parameters and middleware context.
     - Lightweight (~14KB). No bloat for features we don't need.
     - First-class Bun support — uses `Bun.serve` under the hood for maximum performance.
     - Middleware composition is clean and composable (`app.use()`).
     - Active maintenance, growing ecosystem, Web Standards API alignment (`Request`/`Response`).
   - Cons:
     - External dependency (though already present in the monorepo).
     - Abstracts over `Bun.serve` — slight indirection vs. raw server.

2. **Express**
   - Pros:
     - Most widely used Node.js HTTP framework. Vast middleware ecosystem.
     - Extremely well-documented. Every edge case has a Stack Overflow answer.
   - Cons:
     - Callback-based API (`.use((req, res, next) => ...)`) feels dated in async/await TypeScript.
     - Heavy for what we need. Express pulls in many sub-dependencies.
     - No native TypeScript types — `@types/express` is a separate package with imperfect inference.
     - Not optimized for Bun. Would use Node.js compatibility layer instead of native `Bun.serve`.
     - Inconsistent with existing monorepo code (which uses Hono).

3. **Elysia (Bun-native framework)**
   - Pros:
     - Built specifically for Bun. Claims fastest benchmarks.
     - TypeScript-first with schema validation built in.
   - Cons:
     - Unfamiliar API — team has no operational experience.
     - Smaller ecosystem and community than Hono.
     - Opinionated patterns (decorators, method chaining) differ from the functional middleware style used elsewhere in the codebase.
     - Would require learning a new framework for no clear benefit over Hono (which is already fast on Bun).

4. **Raw `Bun.serve` without a framework**
   - Pros:
     - Zero dependencies. Maximum performance. Full control.
   - Cons:
     - No routing abstraction — must implement path matching, parameter extraction, method dispatch manually.
     - No middleware composition — error handling, concurrency guards, logging all become hand-rolled.
     - Reinventing framework functionality that Hono provides for 14KB.
     - Harder to maintain: custom routing code is less readable than declarative route definitions.

## Decision

**Use Hono for the HTTP layer, consistent with the existing `apps/customer-summary` application.**

Concrete design:

- **File:** `packages/host/src/http/router.ts` defines all routes using Hono's `app.get()` / `app.post()` API.
- **Middleware pipeline:**
  1. Error handler (`http/middleware/error-handler.ts`) — catches thrown errors, maps `HostError` and `FrameworkError` DUs to appropriate HTTP status codes and machine-readable JSON responses.
  2. Concurrency guard (`http/middleware/concurrency-guard.ts`) — acquires per-DAG concurrency token before handler execution, releases in `finally`. Returns 429 with `Retry-After` when at capacity.
- **Handlers:** Each route handler is a separate file in `http/handlers/` — `run-dag.ts`, `list-dags.ts`, `health.ts`. Handlers receive typed context, read from the registry snapshot, and return typed responses.
- **Response builders:** `http/response.ts` provides typed builder functions for success and error responses, ensuring consistent JSON shape across all endpoints.
- **Bun integration:** Hono runs on top of `Bun.serve` with zero adapter code — Hono's `export default app` pattern works natively in Bun.
- **Testing:** Handlers are tested with Hono's `app.request()` test utility — no real HTTP server needed for unit tests.

## Consequences

**Positive:**

- Consistency across the monorepo. Same HTTP patterns in `apps/customer-summary` and `packages/host`. Contributors move between them without learning a new framework.
- Minimal bundle impact. Hono is ~14KB — negligible in a server-side package.
- Excellent TypeScript DX: route parameters are inferred, middleware can extend the context type, response types are checked.
- Hono's middleware model maps cleanly to our layered error handling (ADR 0036) and concurrency guard patterns.
- Native Bun performance — Hono delegates to `Bun.serve` without compatibility layers.

**Negative:**

- External dependency — subject to upstream breaking changes. Mitigated: Hono has a stable API and semantic versioning. Pin to a specific minor version.
- Slight abstraction over `Bun.serve`. If we needed raw WebSocket or streaming behavior, Hono's abstractions might not cover it. Current API is pure request/response JSON — well within Hono's sweet spot.
- If the team ever moves away from Bun (unlikely), Hono still works (it's runtime-agnostic) but we'd lose the Bun-specific performance benefits. Not a real concern given current commitment to Bun.
