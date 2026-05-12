# ADR 0024: LLM client contracts live in `types/`, not `llm/`

**Status:** Accepted
**Date:** 2026-05-12
**Plan ref:** `docs/plans/2026-05-12-framework-review-remediation-pass-4.md` §4.2 (D6)
**Supersedes (partially):** ADR 0012's "structural widening" workaround for the `LlmRuntime` parameter on `sendWithTools`.

## Context

`LlmClient`, `LlmRequest`, `LlmResponse`, `SendWithToolsRequest`, `ToolDef`, and `ToolContext` lived in `packages/framework/src/llm/{client,tools}.ts`. The capability-typed `NodeContext` in `types/node.ts` imported `LlmClient` from `llm/client.ts`. `llm/tools.ts` in turn imported `TypedNodeContext` from `types/node.ts`. That produced a three-step cross-layer cycle:

```
types/node.ts  ─▶  llm/client.ts  ─▶  llm/tools.ts  ─▶  types/node.ts
```

To avoid the cycle, `LlmClient.sendWithTools(req, runtime: LlmRuntime)` took a structurally-typed minimal handle (`{ tracer?, signal? }`) and the concrete clients (`AnthropicLlmClient`, `OpenAILlmClient`, `FakeLlmClient`) cast it to `NodeContext` at the dispatch boundary before forwarding to tools:

```ts
async sendWithTools<O>(req, runtime: LlmRuntime) {
  // `runtime`'s static type is the minimum because llm/client.ts can't
  // import NodeContext (cycle). Cast here is the single sanctioned widening.
  const ctx = runtime as NodeContext;
  // ...
}
```

The cast was load-bearing in the wrong way:

- Tool authors could pass a bare `LlmRuntime` and the type system would accept it. If any tool read `ctx.cache` / `ctx.logger` / `ctx.runId`, runtime would crash on `undefined` access against a static type that promised structure.
- Tests passed `{ tracer: null, signal: undefined }` literally, which the type checker reported as fine — masking the real contract.
- Documentation in the comment block at every client implementation ("callers wiring tools MUST pass a `NodeContext`") substituted for a type-level guarantee.

The cycle existed because `LlmClient` and `NodeContext` lived on opposite sides of a layer split that no longer makes sense: both are core domain contracts, and the `llm/` directory's purpose is provider-specific *implementations*.

## Options Considered

1. **Keep the cycle, drop the cast by routing `sendWithTools` calls through a narrowing helper in `nodes/llm-with-tools.ts`.** Hides the widening behind a different layer but doesn't fix the type — callers of `LlmClient.sendWithTools` directly (tests, custom nodes) still see the wrong signature.

2. **Move `LlmClient` and its companions into `types/llm.ts`.** Both `LlmClient` and `NodeContext` now sit in the same `types/` layer. `sendWithTools` can take `NodeContext` directly. The 3-step cross-directory cycle collapses to a 2-step type-only cycle within `types/`, which TypeScript erases at runtime.

3. **Invert the dependency: make `NodeContext` import `LlmClient` indirectly by stripping `llm: LlmClient | null` from `NodeContext` entirely** and threading it as a separate constructor arg. Loses the capability-typed `requires: ["llm"]` ergonomics; tool authors would write `await opts.llm.send(...)` instead of `ctx.llm.send(...)`.

## Decision

**Take option 2.**

New layout (in `packages/framework/src/types/`):

```ts
// types/llm.ts
import type { NodeContext, TypedNodeContext } from "./node.js";

export type ToolName = string & { readonly [__toolNameBrand]: void };
export type ToolContext = TypedNodeContext<readonly ["llm"]>;
export interface ToolDef<I, O> { name: ToolName; /* ... */ run(input, ctx: ToolContext); }
export interface LlmRequest<O> { /* ... */ }
export interface LlmResponse<O> { /* ... */ }
export interface SendWithToolsRequest<O> { /* ... */ }
export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  sendWithTools<O>(req: SendWithToolsRequest<O>, ctx: NodeContext): Promise<Result<LlmResponse<O>, FrameworkError>>;
}

// types/node.ts
import type { LlmClient } from "./llm.js";
export interface BaseNodeContext { /* ..., llm: LlmClient | null, ... */ }
```

`llm/tools.ts` retains the **runtime** smart constructors (`tool()`, `toolName()`, `assertValidToolName()`, `ensureToolNames()`) — these have no dependency on `types/node.ts` and pair naturally with the brand they produce. `llm/client.ts` is deleted; consumers import directly from `types/llm.ts` or via the `@ai-summary/framework/llm` barrel.

`LlmRuntime` is gone. The three production clients lose the `as NodeContext` cast; `sendWithTools` now reads `ctx.tracer` and `ctx.signal` directly. Tool authors who only need `LlmRuntime`-equivalent fields still get them — `ctx: NodeContext` is a structural superset.

## Consequences

**Positive:**

- One signature for `LlmClient.sendWithTools`. The contract is "you give me a `NodeContext`, I give it to your tools." No cast.
- Custom-node authors and test fixtures that previously passed `{ tracer: null, signal: undefined }` literals now fail to compile — they have to construct a proper `NodeContext` via `makeNodeContext({ runId, dagId, ... })`. The type-level guarantee replaces the prior documentation.
- `LlmRuntime` (and its corresponding "structural minimum" comment block at every client) is deleted.
- The 2-step intra-`types/` type-only cycle that remains is invisible to runtime — TypeScript's type-only imports are erased at emit.

**Negative:**

- The `llm/client.ts` shim path no longer exists. Any external consumer (none today, per `README.md` §"Adding to the public surface") with `import { LlmClient } from "@ai-summary/framework/llm/client.js"` would break. Mitigated by the framework's pre-1.0 status — the public surface is the `llm/` barrel, which still re-exports everything.
- ADR 0012's `interface LlmClient` shape in its decision section is now stale on the `sendWithTools` parameter (`LlmRuntime` → `NodeContext`). Left in place; this ADR is the supersession record.

## Non-goals

- **Removing `LlmRuntime` from any public export surface.** It was never exported through the main barrel; the type died with `llm/client.ts`.
- **Re-architecting `ToolContext` so it doesn't depend on `TypedNodeContext`.** The remaining 2-step type-only cycle is acceptable; the cross-directory cycle is the one that mattered.
- **Re-litigating the `Capability` / `requires` design.** Out of scope; that's ADR 0019 territory.
