# AI-Friendly DAG Authoring — Plan

**Date:** 2026-05-26
**Branch:** feat/fugue-host (continuation)
**Status:** Proposed — P0 ready to start

## Overview

Make it dramatically easier for an LLM (or a human pair-programming with one) to
generate correct Fugue DAGs end-to-end. Today the floor is good — `defineDag`
gives literal-id-typed edges, the validator throws at module load, and
`docs/llm-dag-authoring.md` is dense enough to one-shot a simple DAG — but the
ceiling has clear gaps. This plan groups improvements into three priority tiers
based on **correctness leverage per LOC**.

The recurring lever: **convert "construct arbitrary topology" into "pick from a
small menu of shapes and fill 3 slots."** Each item below either narrows the
authoring surface, accelerates the edit→validate loop, or makes existing DAGs
machine-introspectable so they can be composed.

Existing assets we build on:

- `defineDag` / `defineDagFromArray` — branded constructors with module-load
  validation (`packages/framework/src/executor/define-dag.ts`).
- `defineLinearDag` — first shape helper (`packages/framework/src/executor/define-linear-dag.ts`).
- `docs/llm-dag-authoring.md` — LLM-targeted prose reference.
- `zodToJsonSchema` (`packages/framework/src/llm/zod-schema.ts`) — exists but
  used only internally for LLM tool calls.
- `GET /dags` (`packages/host/src/http/handlers/list-dags.ts`) — currently
  returns id/route/description/version/healthy only.

---

## P0 — biggest correctness leverage, low cost

These three together convert the LLM authoring loop from "wire arbitrary edges,
hope they're valid, run the host to find out" into "pick a shape, fill the
slots, run a CLI that prints structured diagnostics."

### P0-1 — Shape helpers beyond `defineLinearDag`

**Priority:** 1st (largest correctness win, isolated change)
**Estimated effort:** Small — each helper is ~30 LOC over `defineDagFromArray`
**Breaking change:** No (additive)

#### Problem

`defineLinearDag` covers A→B→C. But the next-most-common shapes (fan-out,
diamond, conditional router) still require hand-written edge arrays. Edge typos
and missing `kind: "default"` edges are exactly the class of mistakes an LLM
makes when composing nontrivial topology. The validator catches them at module
load, but the LLM has no way to *avoid* generating them in the first place.

#### Deepening

Add three more pattern constructors that mirror the conventions in
`docs/llm-dag-authoring.md` "Common Patterns" section:

```ts
// 1. Fan-out: one source, N parallel siblings, optional convergence node
defineFanOut({
  id: "fan-out",
  source: fetchNode,
  branches: [fetchCrm, fetchBilling, fetchSupport],
  join?: mergeNode,        // if present, becomes outputNodeId; else last branch wins
});

// 2. Diamond: source → branches[] → join (the canonical fan-out + fan-in)
defineDiamond({
  id: "diamond",
  source: sourceNode,
  branches: [branchA, branchB],
  join: joinNode,
});

// 3. Router: classifier → cases keyed by predicate, plus required default
defineRouter({
  id: "router",
  classifier: classifierNode,
  cases: {
    "simple-category": { when: (out) => out.category === "simple", to: simpleHandler },
    "complex-category": { when: (out) => out.category === "complex", to: complexHandler },
  },
  default: fallbackHandler,
  outputNodeId?: NodeId,    // optional; else last-active-node semantics apply
});
```

Each is sugar over `defineDagFromArray` + edge construction with the same
module-load validation. The `defineRouter` constructor **enforces** the
`kind: "default"` edge by requiring a `default` field — eliminating the
else-totality error class entirely for the routed pattern.

#### Files

- `packages/framework/src/executor/define-fan-out.ts` (new)
- `packages/framework/src/executor/define-diamond.ts` (new)
- `packages/framework/src/executor/define-router.ts` (new)
- `packages/framework/src/executor/index.ts` — add exports
- `packages/framework/src/__tests__/define-fan-out.test.ts` (new)
- `packages/framework/src/__tests__/define-diamond.test.ts` (new)
- `packages/framework/src/__tests__/define-router.test.ts` (new)
- `docs/llm-dag-authoring.md` — replace the hand-written examples in "Common
  Patterns" with calls to the helpers; keep `defineDag` examples for the
  "manual mode" section.

#### Acceptance

- Each helper has at least one happy-path test, one invalid-input test
  (validates that the underlying `defineDag` validator still runs), and one
  test confirming the output `DagDef` has the expected shape.
- `bun run typecheck` clean.
- `docs/llm-dag-authoring.md` examples updated and continue to compile via the
  `defineLinearDag` test pattern (or a new `compile-only` test file that
  imports each example).

---

### P0-2 — `fugue lint` / `fugue describe` CLI

**Priority:** 2nd (closes the edit→validate loop)
**Estimated effort:** Small — ~80 LOC over the existing validator
**Breaking change:** No (new binary)

#### Problem

Today the only way an LLM (or its harness) can know a `dag.ts` is valid is to
either:

1. Run the host (slow, requires Redis + git + env vars), or
2. Write a unit test that imports the DAG (requires scaffolding).

Both produce stack traces, not structured diagnostics. `DagDefinitionError`
already carries a typed `FrameworkError` in its `.detail` field — we just don't
have a CLI that prints it as JSON.

#### Deepening

Add a CLI that imports a DAG file, catches `DagDefinitionError` /
`HostError` from the module-loader path, and prints structured JSON
diagnostics on stderr (with file/line where available) and a 0/non-zero exit
code.

Two subcommands:

```bash
# Lint: import the file, emit JSON diagnostics, exit 0/1
bunx fugue lint dags/cx/customer-summary/dag.ts
# → {"ok": true} on success
# → {"ok": false, "errors": [{ "kind": "edge-endpoint-missing", "node": "...", "message": "..." }]} on failure

# Describe: print the resolved DAG shape, waves, capabilities, prompts
bunx fugue describe dags/cx/customer-summary/dag.ts
# → JSON with: id, route, inputSchema (JSON Schema), outputNodeId, waves, prompts[], capabilities[]
```

`describe` reuses the existing `validateDagShape` pipeline plus
`zodToJsonSchema` and the host's prompt loader (`packages/host/src/adapters/module-loader.ts`).
The wave plan is what `topoSort` already produces internally — surface it.

#### Files

- `packages/framework/bin/fugue.ts` (new — thin CLI entry)
- `packages/framework/src/cli/lint.ts` (new — pure logic)
- `packages/framework/src/cli/describe.ts` (new)
- `packages/framework/package.json` — add `bin: { fugue: "./bin/fugue.ts" }`
  and ensure it's executable under `bunx`.
- `packages/framework/src/__tests__/cli/lint.test.ts` (new — uses temp
  fixture DAG files in `__tests__/fixtures/`)
- `packages/framework/src/__tests__/cli/describe.test.ts` (new)
- `docs/llm-dag-authoring.md` — add a "Verifying" section explaining the CLI.

#### Acceptance

- `lint` exits 0 on a valid DAG, 1 on invalid, prints JSON to stdout on both
  paths (stderr reserved for unexpected errors).
- `describe` JSON output is stable enough that an LLM tool can parse it
  (snapshot test).
- CLI tests use real fixture files, not mocks of the validator (validator is
  fast and pure — mocking would obscure breakage).
- The CLI shares zero logic with the host's sync loop — it's a thin wrapper
  around `defineDag`'s thrown error, deliberately.

---

### P0-3 — `GET /dags/:id/manifest`

**Priority:** 3rd (enables cross-DAG composition)
**Estimated effort:** Small — ~60 LOC + handler tests
**Breaking change:** No (new endpoint)

#### Problem

`GET /dags` returns only id/route/description/version/healthy. An LLM that
wants to call an existing DAG from a new one (or even just understand its
input/output) must read source. There's no way to ask "what does this DAG
accept and produce?"

#### Deepening

Add `GET /dags/:id/manifest` returning a stable JSON document:

```jsonc
{
  "id": "customer-summary",
  "route": "/dags/customer-summary/run",
  "description": "Summarizes customer data using LLM",
  "version": "1.0.0",
  "inputSchema": { /* JSON Schema from zodToJsonSchema(reg.inputSchema) */ },
  "outputSchema": { /* JSON Schema for outputNodeId's outputSchema */ },
  "nodes": [
    { "id": "fetch-data", "kind": "fetch", "sideEffects": "reads" },
    { "id": "synthesize", "kind": "llm", "model": "claude-sonnet-4-...", "promptName": "synthesis" }
  ],
  "edges": [ { "from": "fetch-data", "to": "synthesize" } ],
  "prompts": ["synthesis", "synthesis-system"],
  "capabilities": ["llm", "prompts", "cache"]
}
```

This is exactly what an LLM authoring a *new* DAG needs to know about an
*existing* one without reading its source.

#### Files

- `packages/host/src/http/handlers/manifest.ts` (new)
- `packages/host/src/http/router.ts` — register `GET /dags/:id/manifest`
- `packages/host/src/http/response.ts` — add `DagManifestResponse` type
- `packages/host/src/__tests__/handlers/manifest.test.ts` (new)
- `packages/host/docs/writing-dags.md` — add "Manifest endpoint" section
- `docs/llm-dag-authoring.md` — add "Discovering existing DAGs" section

#### Acceptance

- Manifest is deterministic for a given registry snapshot (snapshot test).
- Auth: same as `GET /dags` (any valid token).
- 404 with structured error if DAG id not found.
- Handler is a pure function over the immutable registry — no I/O beyond
  reading state and emitting a response.

---

## P1 — significant quality-of-life

These reduce specific friction points but don't fundamentally reshape the
authoring loop the way P0 does.

### P1-1 — `mergeInputs` helper for fan-in nodes

**Priority:** 1st within P1
**Estimated effort:** Trivial — ~15 LOC
**Breaking change:** No (additive)

#### Problem

When a node has 2+ incoming edges, its input is `{ [sourceId]: output }`. The
LLM has to hand-construct `z.object({ "fetch-crm": CrmSchema, "fetch-billing":
BillingSchema })`. Two failure modes: (1) misspelling a source id, (2)
mis-shaping the object (e.g. wrapping it in a nested key). Both are silent
until the input validation fails at runtime.

#### Deepening

A type-level constructor that *forces* the correct shape:

```ts
// packages/framework/src/executor/merge-inputs.ts
export const mergeInputs = <S extends Record<string, z.ZodTypeAny>>(
  sources: S,
): z.ZodObject<S> => z.object(sources);
```

Trivial wrapper, but the call site documents intent ("this node is a join of
these sources") and the generic forces a flat object keyed by source id.
Combined with `defineDiamond`/`defineFanOut`, the helper can even be
auto-applied — those constructors *know* their join node has N inputs.

#### Files

- `packages/framework/src/executor/merge-inputs.ts` (new)
- `packages/framework/src/executor/index.ts` — export
- `packages/framework/src/__tests__/merge-inputs.test.ts` (new)
- `docs/llm-dag-authoring.md` — update "Input Wiring Rules" table to point to
  `mergeInputs`.

---

### P1-2 — Prompt-placeholder linting at module load

**Priority:** 2nd within P1
**Estimated effort:** Small — ~50 LOC + tests
**Breaking change:** No (new validation; existing valid DAGs are unaffected)

#### Problem

`createLlmNode({ promptName: "synthesis", buildInput: (i) => ({ a, b }) })`
references a prompt template. The template has `{{a}} {{b}} {{c}}`. The `{{c}}`
placeholder never gets filled — silent failure at runtime, gives back a prompt
with a literal `{{c}}` to the LLM. Type system can't catch it (templates are
plain text). But we can lint it.

#### Deepening

At DAG load time (in `packages/host/src/adapters/module-loader.ts`, where
prompts are already loaded), for each `createLlmNode`:

1. Parse `{{placeholders}}` from the template text.
2. Snapshot the keys `buildInput` produces against a fake `inputSchema` sample
   (or require `buildInput`'s return type to be inferable — likely simpler:
   actually invoke `buildInput` against a generated example from the schema).
3. Diff. Report unfilled placeholders and unused `buildInput` keys as warnings
   (or errors, behind a config flag, since we want to keep tolerance for
   templates that intentionally include LLM-format placeholders like
   `{{thinking}}`).

Decision needed during implementation: warning vs hard error. Lean **error
during `fugue lint`, warning at runtime** — fail fast for the LLM author, but
don't break production for a template the operator can fix.

#### Files

- `packages/framework/src/prompts/lint-template.ts` (new — pure)
- `packages/host/src/adapters/module-loader.ts` — invoke linter after loading
  prompts
- `packages/framework/src/__tests__/prompts/lint-template.test.ts` (new)
- `docs/llm-dag-authoring.md` — document placeholder convention.

---

### P1-3 — Machine-readable factory catalog

**Priority:** 3rd within P1
**Estimated effort:** Small — generated artifact + a generator
**Breaking change:** No (new file)

#### Problem

`docs/llm-dag-authoring.md` is 431 lines of prose. Great for one-shot human
context, but a programmatic harness that wants to validate "is the LLM picking
a valid factory?" has to parse prose. A machine-readable JSON sibling lets
tooling list valid factories, their config schemas, and which kind of node
they produce.

#### Deepening

Generate `docs/llm-dag-authoring.json` from the framework's exported types:

```json
{
  "version": "1",
  "factories": {
    "createFetchNode": {
      "kind": "fetch",
      "configSchema": { /* JSON Schema for FetchNodeConfig */ },
      "summary": "External data retrieval"
    },
    "createTransformNode": { ... },
    "createLlmNode": { ... }
  },
  "dagConstructors": {
    "defineDag": { ... },
    "defineLinearDag": { ... },
    "defineFanOut": { ... }
  },
  "patterns": ["linear", "fan-out", "diamond", "router", "guarded"]
}
```

Build step generates this from the source — never hand-written. Drift between
the prose doc and the JSON is then a CI failure rather than a slow rot.

#### Files

- `packages/framework/scripts/generate-factory-catalog.ts` (new)
- `docs/llm-dag-authoring.json` (generated)
- `package.json` — add `build:docs` script
- CI job that runs the generator and fails if the file is out of date.

---

## P2 — nice to have

Lower correctness leverage; these are ergonomic accelerators rather than
correctness multipliers.

### P2-1 — `fugue scaffold` CLI

**Priority:** 1st within P2
**Estimated effort:** Small-medium — ~150 LOC + template files

#### Problem

A new DAG requires: a directory, a `dag.ts` with imports and `DagRegistration`
default export, optional `prompts/`, optional `fugue.yaml`. An LLM can generate
all of it, but reliable boilerplate generation is exactly what a scaffold does
better — and frees the LLM to focus on the domain logic.

#### Deepening

```bash
bunx fugue scaffold dag --team cx --id my-thing --shape linear --node-types fetch,transform,llm
```

Generates a working directory with a `dag.ts` using `defineLinearDag`, stub
schemas (LLM fills in), a `prompts/` skeleton if `llm` is among the node
types, and a `fugue.yaml`.

#### Files

- `packages/framework/src/cli/scaffold.ts` (new)
- `packages/framework/templates/dag-linear.ts.tmpl` (new)
- `packages/framework/templates/dag-router.ts.tmpl` (new)
- `packages/framework/src/__tests__/cli/scaffold.test.ts` (new — runs scaffold
  into a tmpdir, then `fugue lint`s the output)

---

### P2-2 — Generated typed clients for cross-DAG calls

**Priority:** 2nd within P2
**Estimated effort:** Medium — depends on P0-3 (manifest)
**Breaking change:** No (additive)

#### Problem

Today a DAG can't easily call another DAG with type safety. If `enrich`
depends on the output of `customer-summary`, the author either duplicates the
output schema, imports it (creating cross-DAG source coupling), or does an
HTTP call with `unknown` typing.

#### Deepening

`fugue gen-clients --out src/dag-clients.ts` queries `GET /dags/*/manifest`
(or reads from a local DAGs repo) and emits a typed HTTP client per DAG:

```ts
export const customerSummary = createDagClient<CustomerSummaryInput, CustomerSummaryOutput>({
  route: "/dags/customer-summary/run",
});
```

This is conceptually `tRPC` for DAGs. Worth doing only after manifests exist
and only if cross-DAG calls become a common pattern.

#### Files

- `packages/framework/src/cli/gen-clients.ts` (new)
- `packages/framework/src/client/create-dag-client.ts` (new — runtime helper)
- Tests + docs.

---

## Sequencing

1. **P0-1** first — pure additive, no dependencies, biggest correctness win.
2. **P0-2** next — depends on nothing (just wraps existing `defineDag`); makes
   subsequent work testable from the LLM side.
3. **P0-3** after — small handler, but worth landing after P0-2 so we can use
   `fugue describe` to seed manifest tests.
4. **P1-1, P1-2, P1-3** can interleave — each is independent.
5. **P2-1** depends on P0-1 (templates use the shape helpers).
6. **P2-2** depends on P0-3 (manifest is the source of truth for client gen).

## Non-goals

- **Visual DAG editor.** Out of scope; keeps the surface a code-first contract.
- **A runtime-mutable registry (define DAGs via API).** Out of scope; git is
  the source of truth (FR-001).
- **DAG composition via importing other DAGs as sub-nodes.** Tempting but
  significant runtime work (capability composition, span nesting,
  observability merging). Defer until manifests + typed clients prove the
  cross-DAG use case is real.

## Resolved decisions

1. **P0-1 — `defineRouter` predicate type:** **expose both shapes.** Each
   case accepts either the ergonomic `when: (out) => boolean` form (the helper
   generates a `Predicate` with a synthesized `label`/`version: 1`) **or** a
   full `whenPredicate: Predicate<T>` for callers who want explicit version
   control, `minConfidence` gates, or custom labels. The two are mutually
   exclusive per case (a type-level XOR).
2. **P1-2 — placeholder linting tolerance:** **error during `fugue lint`,
   warning at runtime.** Fail fast for LLM authors generating a DAG file;
   don't break production for an operator who's mid-fix. Escape hatch: a
   `// fugue:allow-unbound={{name}}` line comment in the template marks a
   placeholder as intentionally unfilled.
3. **P0-3 — manifest auth:** **same team-isolation model as `GET /dags`.**
   Schemas can be sensitive (PII field names, internal model identifiers), so
   tokens see only DAGs from teams they're authorized for.
