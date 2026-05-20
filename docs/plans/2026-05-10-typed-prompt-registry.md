# Plan: Typed prompt registry — registry-scoped factories

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Constrain `LlmNodeConfig.promptName`,
`LlmWithToolsNodeConfig.promptName`, and `EvalJudgeNodeConfig.rubricTemplateId`
to the literal union of registered prompt names. Authors writing
`promptName: "syntesis"` get an edit-time error instead of a
`prompt-not-found` runtime failure on the first request that hits
the typo'd LLM node.

**Touches:**
- `packages/framework/src/prompts/registry.ts` — generic registry type
- `packages/framework/src/prompts/index.ts` — new factory entry point
- `packages/framework/src/types/node.ts` — `PromptAccess<Names>`
- `packages/framework/src/nodes/llm.ts` — typed factory wrapper
- `packages/framework/src/nodes/llm-with-tools.ts` — same
- `packages/framework/src/nodes/eval-judge.ts` — typed factory wrapper for `rubricTemplateId`
- `apps/customer-summary/src/bootstrap.ts` — switch to typed registry
- `apps/customer-summary/src/dag/nodes/synthesize.ts`,
  `apps/customer-summary/src/dag/nodes/grounding-guardrail.ts` (any LLM node) — go through the typed factory
- New: `docs/adr/0019-typed-prompt-registry.md`

---

## Problem

Today the chain is:

```ts
// bootstrap
const prompts = FilePromptRegistry({ dir, registryPath });

// node
const synthesize = createLlmNode({
  id: "synthesize",
  promptName: "synthesis",   // <- string; typo lands at runtime
  // ...
});
```

`prompt-not-found` is a `FrameworkError` kind that surfaces when
`ctx.prompts.get(name)` returns `null`. The discovery point is the
first request that runs the LLM node — typically caught in a smoke
test or a dev iteration, but the failure mode is still "wait and
see," not "fail to compile."

The *facts* the type system needs to enforce this:

1. The registered prompt names are statically known. `registry.json`
   is a build-time artifact in every shipped configuration.
2. The names are stable — adding/removing a prompt is a deliberate
   code change, not config-driven runtime behavior.
3. Authors call exactly one factory per node helper; there's a
   natural place to bind the registry's name union.

---

## Non-goals

- **Codegen from `registry.json`.** Tempting but introduces a build
  step and a generated `.d.ts` file. The plan instead reads the names
  as a `const` tuple at registry-construction time. Authors who want
  codegen can layer it on; out of scope here.
- **Typing the registry's `version` / `hash` fields.** The mismatch
  detection (registry-vs-file-hash) is a runtime concern. Out of scope.
- **Threading prompt-name unions through `NodeContext`.** That would
  parameterize `NodeContext` over `PromptNames` and propagate to every
  node factory's `ctx` parameter. Heavy, with marginal value — the
  win lives at the `promptName: ...` field on the node config. Out of
  scope.
- **Constraining `system` prompt strings.** They're inline literals
  written by the author, not registry-resolved. Untyped is fine.

---

## Design

### 1. Generic `PromptRegistry<Names>`

`packages/framework/src/prompts/registry.ts`:

```ts
export interface PromptRegistry<Names extends string = string> {
  /** Async load — full content + version + hash. */
  load(name: Names): Promise<Result<PromptEntry, FrameworkError>>;
  /** Sync get — content only, used by `ctx.prompts`. */
  get(name: Names): string | null;
  /** The static set of registered names. Useful for introspection. */
  readonly names: ReadonlySet<Names>;
}
```

The current `PromptRegistry` doesn't have a `get` — `PromptAccess` is
a separate sync wrapper. Consolidate: `PromptRegistry` carries both
async `load` and sync `get`. The runtime-cached map is shared.

### 2. Constructor takes a literal name tuple

```ts
export const createPromptRegistry = <const Names extends readonly string[]>({
  dir,
  registryPath,
  names,
}: {
  readonly dir: string;
  readonly registryPath: string;
  readonly names: Names;
}): PromptRegistry<Names[number]> => {
  // ... read files, build map, validate against registry.json hashes ...
};
```

`<const Names>` preserves the literal tuple. `Names[number]` is the
union of declared prompt names. Authors write:

```ts
const prompts = createPromptRegistry({
  dir: promptsDir,
  registryPath: join(promptsDir, "registry.json"),
  names: ["synthesis", "synthesis-system", "summary-eval-rubric"] as const,
});
```

The names list is the contract. The constructor cross-checks against
`registry.json` at startup — extra names in the JSON are fine
(forward-compat); missing names from the JSON throw. This is the
fail-fast moment.

The `as const` is required to preserve the literal tuple. Without it
TS widens to `string[]` and `Names[number] = string`. We could
auto-widen via `<const Names extends readonly string[]>` (TypeScript
5.0+) — that handles authors who forget `as const`.

### 3. Typed factories — registry-scoped

The cleanest threading is to expose factories *off the registry
itself*:

```ts
export interface PromptRegistry<Names extends string = string> {
  load(name: Names): Promise<Result<PromptEntry, FrameworkError>>;
  get(name: Names): string | null;
  readonly names: ReadonlySet<Names>;

  /** Typed `createLlmNode` whose `promptName` is constrained to `Names`. */
  createLlmNode<I, O, const Id extends string>(
    config: Omit<LlmNodeConfig<I, O, Id>, "promptName"> & { promptName: Names },
  ): NodeDef<I, O, FrameworkError> & { readonly id: Id };

  createLlmWithToolsNode<I, O, const Id extends string>(
    config: Omit<LlmWithToolsNodeConfig<I, O, Id>, "promptName"> & { promptName?: Names },
  ): NodeDef<I, O, FrameworkError> & { readonly id: Id };

  createEvalJudgeNode(
    config: Omit<EvalJudgeNodeConfig, "rubricTemplateId"> & { rubricTemplateId?: Names },
  ): EvalJudgeNodeDef;
}
```

Authors use:

```ts
const synthesize = prompts.createLlmNode({
  id: "synthesize",
  promptName: "synthesis",       // ✓
  // promptName: "syntesis",     // ✗ — type error
  // ...
});
```

The bare `createLlmNode` from `@ai-summary/framework` still exists for
authors who don't want registry-coupling — it accepts `promptName:
string`. Module-level shape:

```ts
import { createLlmNode } from "@ai-summary/framework";   // string-typed
prompts.createLlmNode(...)                                // typed against Names
```

Two doors, both supported. The typed version is the recommended
default; the bare version is the escape hatch for tests or dynamic
construction.

### 4. `ctx.prompts` keeps its `string`-shaped API

`PromptAccess { get(name: string): string | null }` stays loose —
runtime nodes might want to look up prompt names dynamically (rare
but possible, e.g. an LLM that picks its own prompt). The
node-author-facing API where typing matters is the *factory*, not
the runtime context.

If we wanted to tighten `ctx.prompts.get` too, we'd thread `Names`
through `NodeContext` — explicitly out of scope (see non-goals). The
typed factory pattern gets the win without that thread.

### 5. Migration

`apps/customer-summary/src/bootstrap.ts`:

```ts
// before
const prompts = FilePromptRegistry({ dir: promptsDir, registryPath });

// after
const prompts = createPromptRegistry({
  dir: promptsDir,
  registryPath,
  names: ["synthesis", "synthesis-system", "summary-eval-rubric"] as const,
});
```

`apps/customer-summary/src/dag/nodes/synthesize.ts`:

```ts
// before
import { createLlmNode } from "@ai-summary/framework";
const synthesize = createLlmNode({ id: "synthesize", promptName: "synthesis", ... });

// after — pass the registry in via opts, call its factory
export const createSynthesizeNode = (
  prompts: PromptRegistry<"synthesis" | "synthesis-system" | "summary-eval-rubric">,
  model?: string,
  opts: SynthesizeOpts = {},
) => prompts.createLlmNode({ id: "synthesize", promptName: "synthesis", ... });
```

The wiring becomes "the registry owns the factory; nodes are built
through it." Adds one parameter to each node-builder function in the
app — bounded.

Alternative wiring: declare a typed `Prompts` symbol once and import
it directly into node files. Less testable (singleton); not
recommended.

### 6. Runtime parity

The runtime registry behavior is unchanged:
- File reads happen at `load` / `get` time (or on first construction
  if eagerly loaded).
- Hash mismatches still surface as `prompt-not-found`.
- `ctx.prompts.get(name)` still returns `null` for unregistered
  names — the typed factories prevent registered nodes from
  *requesting* unregistered names, but `ctx.prompts` itself remains
  permissive.

---

## Test plan

- **Type-level.** New `__type-checks/typed-prompts.ts`:

  ```ts
  const prompts = createPromptRegistry({
    dir: ".", registryPath: "./registry.json",
    names: ["a", "b"] as const,
  });

  void prompts.createLlmNode({
    id: "n",
    // @ts-expect-error — "c" is not a registered prompt
    promptName: "c",
    inputSchema: ..., outputSchema: ..., model: "...", buildInput: ...,
  });
  ```

- **Runtime.** Existing `eval-judge-prompt.test.ts`,
  prompt-loading tests stay green. The constructor's "names list
  vs registry.json" cross-check gets a new test:

  - Names list contains a name not in registry.json → throws at
    construction.
  - `registry.json` contains a name not in the names list → no-op
    (forward-compat).

- **App integration.** The `customer-summary` smoke test
  (`scaffold.test.ts`) verifies the registry construction succeeds
  with the real `registry.json`.

---

## ADR 0019

- **Context:** Prompt names are statically known (`registry.json` is
  a build-time artifact) but typed as `string` everywhere they're
  consumed. `prompt-not-found` failures land on the first request,
  not at compile time, despite the registry being known at boot.
- **Decision:** `PromptRegistry<Names>` carries the literal name
  union. The registry constructor takes a `const`-asserted name
  tuple. The registry exposes typed `createLlmNode` /
  `createLlmWithToolsNode` / `createEvalJudgeNode` factories whose
  prompt-name fields are constrained to `Names`. The bare,
  string-typed factories from the package barrel stay for tests and
  dynamic construction.
- **Consequences:** Prompt-name typos fail at edit time when the
  author goes through the registry's factory. Two doors (typed via
  registry vs untyped via barrel) — the typed door is the recommended
  default. Adds one constructor parameter (`names`) and shifts
  factory ownership to the registry instance.

---

## Risks

1. **Two doors confuse new authors.** Mitigated by docs in
   `library-ux.md` §1 — record the registry as the primary path; the
   bare factories are explicitly "escape hatch."
2. **Names list duplicates `registry.json`.** Authors must keep both
   in sync. Constructor cross-check catches the easy case (name in
   list but not in JSON). The reverse (in JSON but not in list) is a
   silent forward-compat path. Could codegen the names list from
   `registry.json` if the duplication becomes painful — out of scope
   here.
3. **`Names[number]` is a wide string union.** TypeScript handles
   unions with hundreds of literal strings without issue; we don't
   expect prompt-registry sizes that stress this.
4. **Registry methods on the same shape as bare factories.** The
   factories returned by the registry must match the exact return
   types of the bare factories (`NodeDef<I, O, FrameworkError> & {
   readonly id: Id }`). Add a structural compatibility test to
   prevent drift.
