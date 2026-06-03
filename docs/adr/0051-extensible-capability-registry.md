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
   mappings. Built-in capabilities (`llm`, `cache`, `prompts`, `judgeLlm`) are the base set.
   Adapter packages augment this interface to register new capabilities.

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
// In @fugue/pg
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

### Validation

`validateCapabilities` switches from a hardcoded field lookup to a dynamic property access
on the context object. The compile-time bijection assertion is removed (the registry IS the
single source of truth now).

## Consequences

### Positive

- AI authors declare `requires: ["db"]` and get `ctx.db: PgCapability` — fully typed, non-null.
- Existing code unchanged: `requires: ["llm"]` works exactly as before.
- Adapter lifecycle (connection pools, graceful shutdown) is framework-managed.
- Health checks enable the host's degraded-state detection.
- The "write an adapter" recipe is < 50 LOC.

### Negative

- Module augmentation requires adapter packages to ship a `.d.ts` with the augmentation.
  AI tools that don't understand declaration merging may be confused — mitigated by
  `/// <reference types="..." />` patterns and clear documentation.
- Dynamic property access in `validateCapabilities` loses the switch-exhaustiveness guarantee.
  Mitigated: the validation iterates `node.requires` which is typed as `Capability[]` —
  any string not in `CapabilityRegistry` is already a compile error at the node definition site.

### Migration

Phase 1 (this ADR): Extract `CapabilityRegistry`, derive types, refactor validation.
No behavioral change. All existing tests pass without modification.
