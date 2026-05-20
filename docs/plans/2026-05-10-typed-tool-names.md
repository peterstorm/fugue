# Plan: Typed tool names — uniqueness + edit-time identity

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Constrain tool-name uniqueness within an LLM-with-tools
node at the type level. Authors registering two tools with the same
name get an edit-time error instead of a runtime
`Duplicate tool name "..."` thrown by `ensureToolNames` at the first
LLM call. Each tool's literal name flows through to the construction
site so authors can reference tool names statically.

**Touches:**
- `packages/framework/src/llm/tools.ts` — `ToolDef<I, O, Name>`,
  `tool()` constructor preserves literal name
- `packages/framework/src/nodes/llm-with-tools.ts` —
  `LlmWithToolsNodeConfig.tools` typed for uniqueness
- `packages/framework/src/llm/spans.ts` /
  `packages/framework/src/llm/anthropic-client.ts` /
  `packages/framework/src/llm/openai-client.ts` — internal callers
  unaffected (they iterate the array; runtime shape unchanged)
- New: `docs/adr/0020-typed-tool-names.md`

---

## Problem

`ToolDef.name` is `string`. `LlmWithToolsNodeConfig.tools` is
`readonly ToolDef<unknown, unknown>[]`. At construction time, two
tools can share a name — silently. The runtime `ensureToolNames` check
inside `createLlmWithToolsNode` catches it on first dispatch, throwing
`Duplicate tool name "..."`. The duplicate then becomes:

- A surprising failure when the LLM tries to call the tool (the
  framework can't disambiguate which body to invoke).
- A late-binding error — observed only when `sendWithTools` actually
  fires, not when the node is constructed.

The known shape of the data:

1. Tools within a single LLM node are a fixed, statically-listed set.
2. Tool names are user-authored literals (not config-driven).
3. The dispatch is keyed on those literals — uniqueness is a hard
   correctness requirement.

This is the canonical case for type-level uniqueness checking on
tuples.

---

## Non-goals

- **Cross-node tool-name uniqueness.** Two LLM nodes in the same DAG
  may legitimately register tools with the same name (different
  bodies, different capabilities). Per-node uniqueness only.
- **Tool-name interpolation into prompts.** If the prompt says "you
  have access to lookup_deals_by_customer," the framework doesn't
  cross-check the name in the prompt against the registered tools.
  Out of scope.
- **Replacing the `ensureToolNames` runtime check.** Stays as
  defense-in-depth for tools assembled programmatically (e.g.
  `[...baseTools, ...customTools]`) where the type-level uniqueness
  check can't run.

---

## Design

### 1. `ToolDef<I, O, Name>`

`packages/framework/src/llm/tools.ts`:

```ts
export interface ToolDef<I, O, Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly run: (input: I, ctx: NodeContext) => Promise<O>;
}

export const tool = <I, O, const Name extends string>(
  def: ToolDef<I, O, Name>,
): ToolDef<I, O, Name> => {
  assertValidToolName(def.name);
  return def;
};
```

The `<const Name>` preserves the literal name through the
constructor. Authors who use `tool({ name: "lookup_deals", ... })`
get a `ToolDef<I, O, "lookup_deals">` back, not the wide
`ToolDef<I, O, string>`.

`assertValidToolName` (the regex check) stays — it catches malformed
names (`"My Tool"`, etc.) at construction.

### 2. Uniqueness mapped type

```ts
type Names<T extends readonly ToolDef<unknown, unknown, string>[]> =
  T[number]["name"];

/**
 * For each tool in `T`, check whether its name appears anywhere else in `T`.
 * If the name (after removing this tool's contribution) still appears in the
 * tuple's name union, mark this slot as a duplicate.
 *
 * Implementation note: there is no clean "is unique in tuple" combinator in
 * TypeScript's type algebra. We rely on the fact that a single literal `N`
 * removed from a union containing exactly one occurrence of `N` yields
 * `never`. If `N` still extends the post-removal union, there must be at
 * least two occurrences of `N`.
 */
export type UniqueToolNames<
  T extends readonly ToolDef<unknown, unknown, string>[],
> = {
  readonly [K in keyof T]: T[K] extends ToolDef<infer I, infer O, infer N>
    ? N extends string
      ? N extends Exclude<Names<T>, N>
        ? {
            readonly __error: `Duplicate tool name '${N}'`;
            readonly _tool: ToolDef<I, O, N>;
          }
        : T[K]
      : T[K]
    : T[K];
};
```

`Exclude<Names<T>, N>` removes `N` from the names union. If `N`
appears exactly once in `T`, the result no longer contains `N`, and
`N extends Exclude<Names<T>, N>` evaluates to `false` — the slot
keeps its real type. If `N` appears twice or more, `Exclude` only
removes one occurrence (TS unions are sets, not multisets, so this
is actually a misnomer — `Exclude` removes the type entirely if it
matches), so we use a different formulation.

**Correct formulation.** TypeScript unions are deduplicated, so
`"a" | "b" | "a" === "a" | "b"`. Detecting duplicates within a tuple
requires looking at *positions*, not the union. Use a position-based
approach:

```ts
type DuplicateAt<
  T extends readonly ToolDef<unknown, unknown, string>[],
  K extends keyof T,
> =
  T[K] extends ToolDef<unknown, unknown, infer N>
    ? // Is there ANY OTHER position with the same name?
      {
        readonly [J in keyof T]: J extends K
          ? never  // skip self
          : T[J] extends ToolDef<unknown, unknown, N>
            ? "duplicate"
            : never;
      }[keyof T] extends "duplicate"
      ? true
      : false
    : false;

export type UniqueToolNames<
  T extends readonly ToolDef<unknown, unknown, string>[],
> = {
  readonly [K in keyof T]: DuplicateAt<T, K> extends true
    ? {
        readonly __error: T[K] extends ToolDef<unknown, unknown, infer N>
          ? `Duplicate tool name '${N}'`
          : "Duplicate tool name";
      }
    : T[K];
};
```

This walks each position, then walks all other positions, and checks
for a name match. Quadratic in the number of tools — fine for typical
tool counts (≤ 20). If a duplicate exists at any position, that
position's expected type becomes the `__error` sentinel and the
compiler reports it.

### 3. Apply to `LlmWithToolsNodeConfig`

```ts
export interface LlmWithToolsNodeConfig<
  I, O,
  Id extends string = string,
  Tools extends readonly ToolDef<unknown, unknown, string>[] = readonly ToolDef<unknown, unknown, string>[],
> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly model: string;
  readonly tools: Tools & UniqueToolNames<Tools>;
  // ... rest unchanged ...
}

export const createLlmWithToolsNode = <
  I, O,
  const Id extends string = string,
  const Tools extends readonly ToolDef<unknown, unknown, string>[] = readonly ToolDef<unknown, unknown, string>[],
>(
  config: LlmWithToolsNodeConfig<I, O, Id, Tools>,
): NodeDef<I, O, FrameworkError> & { readonly id: Id } => { ... };
```

The `<const Tools>` is required so the literal tuple flows in (with
each tool's literal name preserved). Without `const`, TS widens to
`ToolDef<unknown, unknown, string>[]` and `Names<T> = string` — no
uniqueness check possible.

### 4. Runtime check stays

`ensureToolNames(tools)` continues to run inside the node's `run`
function — defense-in-depth for tools spread from a non-literal
source:

```ts
const baseTools = [...] as const;
const node = createLlmWithToolsNode({
  tools: [...baseTools, customTool],   // type-checked uniqueness within this literal
  // ...
});
```

The spread of `baseTools` doesn't lose its types (TS preserves the
elements) so `UniqueToolNames` still runs over the merged tuple.
However, in some cases TS widens the merged tuple — the runtime check
catches the case the type system missed.

### 5. Migration

The `customer-summary` app doesn't currently use
`createLlmWithToolsNode` (the example file
`enrich-with-tools.example.ts` is reference material). Migration is
internal:

- `tool()` constructor: add `<const Name>` generic.
- `createLlmWithToolsNode`: add `<const Tools>` generic and constrain
  `tools` with `UniqueToolNames`.
- Existing tests in `llm-with-tools-factory.test.ts` continue to pass
  because they use `tool({...})` with literal names — the constructor
  upgrades catch the type, the factory upgrade enforces uniqueness.

---

## Test plan

- **Type-level uniqueness.** `__type-checks/typed-tools.ts`:

  ```ts
  void createLlmWithToolsNode({
    id: "n",
    inputSchema: ..., outputSchema: ..., model: "...",
    buildUser: ...,
    tools: [
      tool({ name: "alpha", description: "", inputSchema: ..., outputSchema: ..., run: ... }),
      // @ts-expect-error — duplicate tool name 'alpha'
      tool({ name: "alpha", description: "", inputSchema: ..., outputSchema: ..., run: ... }),
    ],
  });
  ```

- **Type-level non-duplicate.** Same shape with two distinct names —
  compiles cleanly.

- **Runtime smoke.** `llm-with-tools-factory.test.ts` already
  exercises the duplicate-name error path. Verify it still throws
  for tools assembled through code paths that bypass the type check
  (e.g. when the array is built up dynamically with widened types).

---

## ADR 0020

- **Context:** Tool-name uniqueness is a hard correctness requirement
  but enforced only at runtime by `ensureToolNames`. The type system
  has the information (literal names within a literal tuple) to
  catch duplicates at edit time.
- **Decision:** `ToolDef` carries a `Name extends string` generic.
  `tool()` constructor preserves the literal via `<const Name>`.
  `LlmWithToolsNodeConfig.tools` constrains the tuple via a
  `UniqueToolNames` mapped type that walks each position and reports
  duplicates as `__error` sentinels in the compiler diagnostic.
- **Consequences:** Duplicate tool names fail at edit time when both
  registrations are literals. The runtime check stays for dynamic
  construction. Quadratic mapped-type recursion is acceptable for
  realistic tool counts (≤ 20).

---

## Risks

1. **Quadratic instantiation cost.** `UniqueToolNames` walks
   `O(n²)` positions. For 20 tools, that's 400 conditional-type
   evaluations — within TS's budget. For 100+, risky. Realistic tool
   counts are well under 20; document the bound.
2. **Spread-tuple widening.** When authors spread a `const`-typed
   array into the `tools` literal, TS sometimes widens the merged
   tuple to a regular array. The uniqueness check then no-ops. The
   runtime check is the safety net.
3. **Generic surface growth on `createLlmWithToolsNode`.** Already 3
   generics (`I, O, Id`); adding `Tools` makes 4. TS infers all four
   from arguments. Verified by the existing test file.
4. **Error message verbosity.** The `__error` sentinel object
   appears in compiler diagnostics. The `'Duplicate tool name 'X''`
   string is the visible part; the surrounding object shape is
   noise. TS doesn't have a way to surface only the message string —
   accept the noise.

---

## Sequencing

Independent of the reroute-target plan and the prompt-registry plan.
All three can ship in parallel; none depend on each other.

Recommended order: **C → A → B**.
- C is the smallest (one file plus a test).
- A is bounded but threads a generic through several APIs.
- B touches the registry and bootstrap; biggest blast radius but
  cleanest external story.
