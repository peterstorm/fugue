# ADR 0033: DagRegistration as Host Contract

**Status:** Accepted  
**Date:** 2026-05-20  
**Spec ref:** `.claude/specs/2026-05-20-fugue-host/spec.md`  
**Related:** ADR 0032 (framework independence), ADR 0031 (immutable registry snapshot)

## Context

DAG authors need a way to expose their DAG code to the host platform. The host must know: what `DagDef` to execute, what input schema to validate HTTP payloads against, and optional metadata (description, version). This information must be discoverable at import time so the host can validate DAGs during the sync cycle.

The framework already defines `DagDef` — the execution shape (nodes, edges, routing). But `DagDef` is purely an execution concern; it knows nothing about HTTP input validation, deployment metadata, or host-specific configuration. The host needs *more* than a `DagDef`.

The question is: where should this "more" live? Should we extend `DagDef` with host fields? Should we create a separate metadata file? Or should there be a typed wrapper contract that DAG authors export?

Key forces:
- Framework independence (ADR 0032) forbids adding host concepts to framework types.
- Atomic validation is desirable — the host should validate everything about a DAG in one import, not piece together information from multiple files.
- The contract must be Zod-validatable at runtime since DAG code is dynamically imported from a separate git repo (untrusted boundary).

## Options Considered

1. **`DagRegistration` type defined in `@fuguejs/host`, wrapping `DagDef` with host metadata, Zod-validated at import time (chosen)**
   - Pros:
     - Clean separation: `DagDef` is a framework concept (execution shape), `DagRegistration` is a host concept (deployment contract).
     - Atomic validation: one `import()` + one Zod parse validates the entire DAG contract.
     - Type-safe: DAG authors get compile-time errors if they forget `inputSchema`.
     - `inputSchema` is mandatory — every DAG explicitly declares what HTTP input it accepts. No implicit `any`.
     - Framework stays unaware of host (ADR 0032 preserved).
   - Cons:
     - DAG authors must import from `@fuguejs/host` for the `DagRegistration` type (additional dependency).
     - If host becomes heavy (many deps), DAG projects pull in those deps transitively. Mitigated: `DagRegistration` is just a type + Zod schema with no heavy deps.

2. **Extend `DagDef` with optional host fields (e.g., `inputSchema`, `meta`)**
   - Pros:
     - Single type for DAG authors to think about.
     - No additional package import needed.
   - Cons:
     - Violates framework independence (ADR 0032). Framework would need to know about `inputSchema`, HTTP concerns, host metadata.
     - Pollutes framework types with deployment concerns that mean nothing in standalone/test usage.
     - Optional fields mean the host can't rely on their presence — must validate anyway, but without type-level enforcement.

3. **Separate metadata file alongside DAG code (e.g., `dag.meta.json` or `fugue.yaml` for all metadata)**
   - Pros:
     - No code coupling between DAG implementation and host contract.
     - Could be edited by non-developers (YAML is approachable).
   - Cons:
     - Splits related information across files. `inputSchema` (a Zod type) cannot be expressed in YAML/JSON without a custom DSL.
     - Two files to validate instead of one — more failure modes.
     - Harder to keep in sync: rename a field in the DAG and forget to update the metadata file.
     - No compile-time safety for the contract shape.

## Decision

**DAG authors export a `DagRegistration` object as the default export from `dag.ts`. `DagRegistration` is defined in `@fuguejs/host` (not framework), wraps a `DagDef` with `inputSchema` and optional `meta`, and is Zod-validated at import time.**

Concrete design:

- **Definition file:** `packages/host/src/domain/dag-registration.ts`
- **Shape:**
  ```typescript
  interface DagRegistration {
    readonly dag: DagDef;
    readonly inputSchema: z.ZodType<unknown>;  // mandatory — validates HTTP input
    readonly meta?: {
      readonly description?: string;
      readonly version?: string;
    };
  }
  ```
- **Runtime validation schema:** `DagRegistrationSchema` (Zod) validates the shape of the dynamic import's default export. Checks that `dag` has the expected `DagDef` structure, `inputSchema` has a `.parse` method, and `meta` (if present) matches the expected shape.
- **Import flow:** The module loader (`adapters/module-loader.ts`) calls `import(modulePath)`, extracts `.default`, and parses it with `DagRegistrationSchema.safeParse()`. Failures produce `HostError { kind: "validation-failed" }` or `{ kind: "no-default-export" }`.
- **`inputSchema` is mandatory:** Every DAG declares what input it accepts. The host validates incoming HTTP payloads against this schema before execution. This replaces per-app ad-hoc Zod validation (e.g., the inline schema in `apps/customer-summary/server.ts`).
- **Host-specific config (`fugue.yaml`)** remains separate — it covers operational concerns (team ownership, concurrency limits, timeouts) that aren't part of the code contract. `DagRegistration` is the *code* contract; `fugue.yaml` is the *ops* contract.

## Consequences

**Positive:**

- Single atomic validation at import time. If the parse succeeds, the host knows it has a valid DAG with a valid input schema — no further checks needed at request time.
- Mandatory `inputSchema` eliminates an entire class of runtime errors: malformed input reaching DAG execution. Every DAG explicitly documents and enforces its input contract.
- Framework types stay clean. `DagDef` remains a pure execution concern. Host concepts don't leak into the framework.
- Type safety for DAG authors: TypeScript enforces the contract at write time, Zod enforces it at import time. Two layers of protection.

**Negative:**

- DAG authors take a dependency on `@fuguejs/host` for the `DagRegistration` type. If host grows heavy dependencies, this becomes a concern. Mitigation: `DagRegistration` and its schema have zero heavy deps (only Zod, which DAGs already use for `inputSchema`). If this becomes an issue, we can extract a thin `@fuguejs/dag-contract` package.
- Dynamic import validation has a cost: Zod parse on every DAG load. Negligible — happens once per sync cycle per DAG, not on the request hot path.
- The contract is structural (Zod validates shape, not semantics). A DAG could export a syntactically valid `DagRegistration` with a nonsensical `inputSchema`. The host can't catch semantic errors — only execution failures reveal those.

## Trust Model

**The dags repository is fully trusted.** Dynamic `import()` executes arbitrary module-level code *before* Zod validation can reject the export shape. This is a fundamental characteristic of ESM: the module body runs as a side effect of importing.

Consequences:

- Any top-level code in `dag.ts` (or its transitive imports) runs in the host process at import time. This includes network calls, file system access, and environment variable reads.
- Zod validation gates **registry registration**, not **code execution**. A module that passes `import()` but fails Zod validation has already executed its top-level effects.
- If the dags repository is compromised, the attacker achieves RCE in the host process. This is equivalent to compromising any production dependency.

This is acceptable because:

1. Only code merged to the configured branch is imported (host pulls from a specific branch, default `main`).
2. The dags repository requires the same access controls as production infrastructure — branch protection, required reviews, CI checks.
3. If an attacker can push to the dags repo's main branch, they already have equivalent access to production secrets (same org, same trust boundary).
4. The module loader wraps `import()` in try/catch to prevent host crashes from module-level exceptions, but this is a stability measure, not a security boundary.

**If multi-tenant or untrusted DAG sources are needed in future**, consider:
- Worker-per-DAG isolation (Bun workers with limited capabilities)
- VM sandboxing (isolated-vm or similar)
- WASM execution (compile DAG to WASM, run in restricted sandbox)
- These are P3+ scope and would require a fundamentally different module loading architecture.
