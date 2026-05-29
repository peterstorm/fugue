# ADR 0032: Framework Independence

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0033 (DagRegistration as host contract), ADR 0001 (single-package layered modules)

## Context

The monorepo contains two primary packages: `@fugue/framework` (the DAG execution engine — defines `DagDef`, `NodeDef`, `runDag`, `NodeContext`) and `@fugue/host` (the new hosting platform that clones DAG code, validates it, and serves it over HTTP).

A critical architectural boundary must be drawn between these two. The framework was designed to be usable standalone: in unit tests, CLI scripts, and custom runtimes that have nothing to do with the host. DAG authors import `@fugue/framework` directly to define their DAGs. The host also needs framework types to execute DAGs.

The question is: should the framework know about the host? Should there be shared types between them? Or should the dependency be strictly one-directional?

Two forces pull in different directions:
1. **Convenience:** If the framework exported host-aware types (e.g., `DagRegistration` with HTTP metadata), DAG authors would get a single import for everything.
2. **Coupling cost:** If the framework imports from or references the host, it can no longer be used standalone without pulling in host dependencies. The framework's independence — a key design property — would be destroyed.

## Options Considered

1. **Strict one-way dependency: host imports framework, framework has zero knowledge of host (chosen)**
   - Pros:
     - Framework remains fully standalone — usable in tests, CLIs, notebooks, or alternative runtimes without host.
     - DAG authors can develop and test DAGs locally using only `@fugue/framework`, without running the host.
     - Clear ownership: framework owns execution semantics, host owns deployment semantics. No conflation.
     - Import-graph lint (existing from ADR 0001) can mechanically enforce the boundary.
   - Cons:
     - DAG authors need two imports: `@fugue/framework` for `DagDef`/nodes, `@fugue/host` for `DagRegistration`. Slightly more ceremony.
     - Host must adapt framework types at the boundary (e.g., constructing `NodeContext` from host infrastructure) — no framework helpers for this.

2. **Framework aware of host (bidirectional dependency)**
   - Pros:
     - Single package for DAG authors to import.
     - Framework could provide host-optimized utilities (e.g., HTTP-aware context builders).
   - Cons:
     - Destroys framework independence. Framework can no longer be used without host on the dependency graph.
     - Circular dependency risk (host depends on framework depends on host types).
     - Every host change potentially forces a framework release — coupling their evolution.
     - Breaks existing consumers who use framework standalone (tests, CLI tools).

3. **Shared "common" package between host and framework**
   - Pros:
     - Avoids circular deps while sharing types.
     - Could hold `DagRegistration` and other contract types.
   - Cons:
     - Unnecessary indirection for two packages. A third package adds build/release/versioning overhead.
     - The "common" package inevitably becomes a grab bag of unrelated types — a shallow module.
     - `DagRegistration` is fundamentally a *host* concept (deployment metadata); placing it in a shared package obscures ownership.

## Decision

**`@fugue/framework` has zero imports from or dependency on `@fugue/host`. The host imports framework types (`DagDef`, `NodeContext`, `runDag`) as a consumer. DAG code in the dags repository also imports `@fugue/framework` directly.**

Concrete enforcement:

- **Import direction:** `@fugue/host` → `@fugue/framework` (allowed). `@fugue/framework` → `@fugue/host` (forbidden).
- **DAG imports:** DAG code imports `@fugue/framework` for execution types and `@fugue/host` for `DagRegistration` only.
- **Lint rule:** The existing import-graph lint (`scripts/check-imports.ts` from ADR 0001) is extended to verify `packages/framework/src/**` never imports from `packages/host/**`.
- **NodeContext construction:** The host's `node-context-factory.ts` adapter constructs `NodeContext` using framework's public API (`makeNodeContext` or direct construction). The framework doesn't provide host-specific helpers.
- **Type compatibility:** The host declares `@fugue/framework` as a `dependencies` entry in `packages/host/package.json`. Framework types (`DagDef`, `NodeDef`, etc.) are consumed as-is; no wrappers or re-exports.

## Consequences

**Positive:**

- Framework remains a standalone, general-purpose DAG execution engine. It can power other runtimes (serverless functions, CLI batch jobs, embedded use cases) without modification.
- Clear architectural boundary enables independent evolution. Framework can ship breaking changes to its internal execution model without touching host code (and vice versa), as long as the public API contract holds.
- DAG authors can develop and test entirely locally with `bun test` — no host process needed. The framework's testing utilities work without host.
- The boundary is mechanically verifiable via lint, not just convention.

**Negative:**

- DAG authors must import from two packages (`@fugue/framework` for DagDef, `@fugue/host` for DagRegistration). Minor ergonomic cost.
- The host must implement NodeContext construction logic that could hypothetically be a framework utility. This keeps the framework clean but means the host owns more adapter code.
- If the framework's `NodeContext` interface changes, the host's factory adapter must be updated. This coupling is intentional (host *is* a consumer) but means framework changes can break host builds.
