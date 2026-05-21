# ADR 0036: Layered Error Handling

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0030 (state machine with pure transitions), ADR 0032 (framework independence), ADR 0035 (Hono HTTP server)

## Context

The host encounters errors from two distinct layers:

1. **Host-level errors:** Git clone/pull failures, module import errors, DAG validation failures, concurrency limits exceeded, timeouts, Redis unavailability, configuration problems.
2. **Framework-level errors:** DAG execution failures (`FrameworkError` from `@fugue/framework`) — node execution errors, routing failures, checkpoint failures.

Both types of errors must ultimately be mapped to HTTP responses. The HTTP layer needs to produce machine-readable JSON with appropriate status codes, human-readable messages, and enough context for operators to diagnose issues.

The question is: should there be one unified error type across both layers? Should errors from the framework be wrapped? Or should each layer maintain its own error space with the HTTP layer mapping both independently?

Key forces:
- Framework independence (ADR 0032): the framework's error types are its own; the host should not dictate their shape.
- Exhaustiveness: the HTTP error mapper should be provably complete — every error variant maps to a status code, enforced by TypeScript's `never` guard.
- Operator experience: error responses must be actionable. Operators need to know whether the problem is infrastructure (host) or business logic (DAG).

## Options Considered

1. **Layered error handling: `HostError` DU for host concerns, `FrameworkError` passes through, HTTP layer maps both (chosen)**
   - Pros:
     - Each layer owns its error space. Host errors evolve independently of framework errors.
     - Exhaustive mapping in the HTTP layer: TypeScript's `never` check ensures every `HostError` kind is handled.
     - Framework errors pass through without wrapping — no information loss, no redundant nesting.
     - Operators can distinguish infrastructure failures (host errors → usually 5xx) from input/logic failures (framework errors → usually 4xx/5xx depending on cause).
     - Framework independence preserved: host doesn't need to understand framework error internals to serve them.
   - Cons:
     - HTTP error mapper must handle two distinct error types. Slightly more code in the error handler middleware.
     - No single "look up any error" type — must check both `HostError` and `FrameworkError` discriminants.

2. **Single unified error type across both layers**
   - Pros:
     - One discriminated union for all errors. Single pattern match in the HTTP layer.
     - Simpler mental model: "an error is an error."
   - Cons:
     - Couples framework error evolution to host. Adding a new `FrameworkError` variant forces a host release.
     - Violates framework independence (ADR 0032) — framework would need to use host-defined error types, or host would need to redefine all framework errors.
     - Bloated union: host errors (infrastructure) and framework errors (execution) have fundamentally different semantics. Combining them produces a grab-bag type.

3. **Exception-based error handling (throw/catch)**
   - Pros:
     - Familiar pattern. No `Result` type ceremony.
     - Error propagation is automatic (bubbles up call stack).
   - Cons:
     - Loses exhaustiveness — no TypeScript mechanism to enforce all exception types are caught.
     - Untestable transitions: functions that throw can't return "here's what went wrong" for the caller to inspect without try/catch.
     - Side-effectful: throwing is a hidden control flow path. Contradicts the pure transition model (ADR 0030).
     - Exception types are structurally opaque at the type level — `catch(e: unknown)` provides no compile-time guarantees.

## Decision

**`HostError` is a discriminated union for host-level concerns. `FrameworkError` from `@fugue/framework` passes through unchanged. The HTTP error-handler middleware maps both to appropriate HTTP status codes and machine-readable JSON responses.**

Concrete design:

- **HostError DU:** `packages/host/src/domain/host-error.ts`
  - 14 variants covering: git failures (`git-clone-failed`, `git-pull-failed`, `git-timeout`), import errors (`import-failed`, `validation-failed`, `no-default-export`), runtime errors (`dag-not-found`, `dag-disabled`, `concurrency-exceeded`, `timeout`), infrastructure (`redis-unavailable`, `bun-install-failed`, `config-invalid`), input validation (`input-validation-failed`), and async concerns (`async-result-expired`).
  - Each variant carries context-specific fields (e.g., `dag-not-found` carries `dagId` and `available` DAG list).

- **HTTP mapping:** `packages/host/src/http/middleware/error-handler.ts`
  - Pattern matches on `HostError.kind` → HTTP status code (see plan §4.9 mapping table).
  - For `FrameworkError`: maps execution failures to 500, timeout to 408, cancellation to 499.
  - Uses `never` guard: `default: const _exhaustive: never = error;` — adding a new `HostError` variant without handling it is a compile error.

- **Response shape:** All error responses follow a consistent structure:
  ```typescript
  { error: string; message: string; details?: unknown; dagId?: string; runId?: string }
  ```
  `error` is the machine-readable code (the `kind` field). `message` is human-readable. `details` carries structured context (e.g., Zod issues for validation errors).

- **Domain functions return `Result`:** All host domain functions (transitions, registry builders, concurrency acquire) return `Result<T, HostError>` — never throw. Only adapter boundaries (git spawn, module import) may produce exceptions, which are caught and mapped to `HostError` at the adapter boundary itself.

- **Framework error pass-through:** When `runDag()` returns a framework error, the host does not wrap it in a `HostError`. The error-handler middleware recognizes both types and maps each appropriately. This preserves full framework error context (stack traces, node IDs, execution state) in the response.

## Consequences

**Positive:**

- Exhaustive error handling enforced at compile time. Every `HostError` variant has a defined HTTP mapping. New variants without mappings fail the type checker.
- Clear operator experience: HTTP responses distinguish infrastructure failures (host errors, usually operator-actionable) from execution failures (framework errors, usually DAG-author-actionable).
- Framework errors pass through without information loss. No wrapping, no re-serialization, no dropped context.
- Testable: error mapping is a pure function from `HostError | FrameworkError` → `{ status, body }`. Unit-testable without HTTP infrastructure.
- Consistent response shape across all error types. API consumers parse one JSON structure regardless of error source.

**Negative:**

- Two error types to handle in the HTTP layer. The error-handler middleware has two branches (one for `HostError`, one for `FrameworkError`). Slightly more code than a single unified type.
- If the framework adds new `FrameworkError` variants, the host's pass-through mapping may produce generic 500s for unrecognized variants until the host is updated. Mitigated: the pass-through uses a sensible default (500) for unknown framework errors.
- `Result<T, HostError>` pervasive in domain code adds syntactic overhead compared to throw/catch. Every caller must handle the error case explicitly. This is a feature (forces error handling) but increases verbosity.
- Error serialization for HTTP responses may lose information (e.g., stack traces are included in non-production but stripped in production for security). Must configure this carefully to balance debuggability and information exposure.
