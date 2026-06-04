# ADR-0051: Extensible Capability Registry

## Status

Accepted

## Context

Fugue's capability system (`requires: ["llm", "cache", "prompts", "judgeLlm"]`) validates
at run start that every node's declared requirements are satisfied. However, the system is
a closed, 4-member union — it cannot represent integrations like databases, HTTP APIs,
vector stores, or any other I/O dependency an AI workflow might need.

When an AI builds a workflow and encounters a need for a database call, it must:

1. Instantiate and lifecycle-manage a client outside the framework
2. Manually map errors to `Result<T, FrameworkError>`
3. Figure out how to wire the client into the node's `run` function

The framework already solves all three concerns for LLM calls via the `LlmClient` capability.
Extending this pattern to arbitrary integrations makes AI-authored workflows dramatically
simpler — the AI declares what it needs, the runtime validates and injects it.

## Decision

Open the capability system from a fixed union to an **extensible interface registry** using
TypeScript module augmentation:

1. **`CapabilityRegistry`** — a global interface declaring capability name → client type
   mappings. Built-in capabilities (`llm`, `cache`, `prompts`, `judgeLlm`, `http`) are the
   base set (`http` joins via item 5 below). Adapter packages augment this interface to
   register new capabilities.

2. **`Capability`** — derived as `keyof CapabilityRegistry` (was a hardcoded union).

3. **`CapabilityFields`** — becomes a type alias for `CapabilityRegistry` (backward compat).

4. **`CapabilityHandle<K>`** — runtime lifecycle wrapper: `{ name, client, connect?, close?, healthCheck? }`.
   Adapters produce these; the runtime calls `connect()` at boot and `close()` at shutdown.

5. **`HttpCapability`** — ships with the framework (no separate package). Every AI workflow
   does HTTP. Returns `Result<T, FrameworkError>`, validates responses against Zod schemas.

6. **`createFetchNode`** gains an optional `requires` parameter so fetch nodes can declare
   capabilities beyond the default empty set.

### Module augmentation pattern (adapter packages)

```ts
// In @fugue/pg — illustrative subset; the shipped PgCapability also has
// `execute` and `queryRaw` (see packages/adapter-pg/src/index.ts).
export interface PgCapability {
  query<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>>;
  queryOne<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>>;
}

declare module "@fugue/framework" {
  interface CapabilityRegistry {
    db: PgCapability;
  }
}
```

`CapabilityRegistry` is, by design, a **shared kernel**: every adapter package
co-owns it via `declare module`. A consequence is that `Capability =
keyof CapabilityRegistry` is a function of the importing app's dependency
closure, and capability-name validity/collision is resolved at **runtime**
(`topoSortHandles` rejects duplicate handle names at boot; `validateCapabilities`
fails closed on names that collide with reserved infra fields), not at the type
level. This is the accepted cost of open extensibility.

### Validation

`validateCapabilities` switches from a hardcoded field lookup to a dynamic property access
on the context object. The compile-time bijection assertion is removed (the registry IS the
single source of truth now).

## Consequences

### Positive

- AI authors declare `requires: ["db"]` and get `ctx.db: PgCapability` — fully typed, non-null.
- Existing code unchanged: `requires: ["llm"]` works exactly as before.
- Adapter lifecycle (connection pools, graceful shutdown) is framework-managed.
- Health checks lay the groundwork for the host's degraded-state detection (aggregation via `checkHealth` exists; periodic host polling is a follow-up).
- The "write an adapter" recipe is < 50 LOC.

### Negative

- Module augmentation requires adapter packages to ship a `.d.ts` with the augmentation.
  AI tools that don't understand declaration merging may be confused — mitigated by
  `/// <reference types="..." />` patterns and clear documentation.
- Dynamic property access in `validateCapabilities` loses the switch-exhaustiveness guarantee.
  Mitigated: the validation iterates `node.requires` which is typed as `Capability[]` —
  any string not in `CapabilityRegistry` is already a compile error at the node definition site.

### Migration

Delivered in four phases on the same branch (the code carries `@satisfies
ADR-0051` markers; Phase 4 is labelled with its phase number, the earlier
markers are unnumbered):

- **Phase 1 — Registry types.** Extract `CapabilityRegistry`, derive `Capability` as
  `keyof`, refactor `validateCapabilities` to dynamic property lookup. The type refactor
  itself is behavior-preserving, but existing test contexts gain the new nullable `http`
  field (mechanical `http: null` additions across the suite).
- **Phase 2 — Host lifecycle.** `CapabilityHandle` connect/close sequencing in the host:
  topological sort over `dependsOn`, connect in dependency order, close in reverse, and
  close the connected prefix (plus the failing handle itself) on an aborted boot.
- **Phase 3 — `@fugue/pg` adapter.** First out-of-tree capability package exercising the
  module augmentation pattern end-to-end.
- **Phase 4 — Capability tracing.** Opt-in OTel span wrapping via `withTracedCapability`.

New behavior shipped alongside: the built-in `HttpCapability` (item 5) and the
`createFetchNode` `requires` parameter (item 6).
