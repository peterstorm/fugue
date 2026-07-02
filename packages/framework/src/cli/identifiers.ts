// Generated-identifier accounting for the AuthoredDag pipeline (deterministic-
// core convergence, Phase B).
//
// Owns the kebab→identifier case helpers, the JS reserved-word list, and —
// crucially — the NAME CONSTRUCTORS for every identifier `authored-codegen`
// emits (schema consts, fan-in consts, llm factories, dag factory/opts names,
// import names). Codegen consumes these constructors directly and the
// collision accounting (`generatedIdentifiersFor` / `dagLevelIdentifiers` /
// `RESERVED_IDENTIFIERS`) is built FROM them, so the emitted names and the
// parse-time collision check cannot drift apart. This lets `authored.ts`
// reject identifier collisions at PARSE time with a precise message naming
// both sides — instead of letting the validation gauntlet surface a
// duplicate-declaration SyntaxError the author/LLM has to decode.
//
// Pure data + pure functions, no imports — `authored.ts`,
// `authored-codegen.ts`, `new-templates.ts` and `types.ts` all depend on this
// module, never the reverse.

export const pascalCase = (kebab: string): string =>
  kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export const camelCase = (kebab: string): string => {
  const pascal = pascalCase(kebab);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

/**
 * ECMAScript reserved words (plus the contextual/strict-mode set — including
 * `eval`/`arguments`, which strict mode forbids as binding names; generated
 * modules are always strict — and the literal keywords). A node id whose
 * camelCase form lands here would emit `const default = …` — a SyntaxError.
 */
export const JS_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "default", "case", "new", "class", "function", "return", "const", "let",
  "var", "if", "else", "for", "while", "do", "switch", "break", "continue",
  "throw", "try", "catch", "finally", "void", "typeof", "instanceof", "in",
  "of", "delete", "yield", "await", "async", "static", "super", "this",
  "null", "true", "false", "enum", "export", "import", "extends",
  "implements", "interface", "package", "private", "protected", "public",
  "with", "debugger", "eval", "arguments",
]);

// ---------------------------------------------------------------------------
// Name constructors — the single source of truth for every identifier the
// authored codegen emits. `authored-codegen.ts` calls these at every emission
// site; the accounting sets below are derived from the same functions.
// ---------------------------------------------------------------------------

/** Output-schema const for a node: `fetch-record` → `FetchRecordSchema`. */
export const schemaConstName = (id: string): string => `${pascalCase(id)}Schema`;

/**
 * Fan-in schema const for a join/assemble node: `merge` → `MergeFanIn`.
 * Emitted only when the node's role receives a keyed fan-in, but claimed for
 * EVERY node (see the conservatism note on `generatedIdentifiersFor`).
 */
export const fanInConstName = (id: string): string => `${pascalCase(id)}FanIn`;

/** LLM node factory (the injectable model seam): `summarize` → `createSummarize`. */
export const llmFactoryName = (id: string): string => `create${pascalCase(id)}`;

/** Module-level node const for non-llm nodes: `fetch-record` → `fetchRecord`. */
export const nodeConstName = (id: string): string => camelCase(id);

/**
 * The `<camel>Node` identifier claimed for llm nodes: `summarize` →
 * `summarizeNode`. Current codegen never BINDS it — the structure expression
 * calls `create<Pascal>(model)` directly, so this name never reaches the
 * emitted file. It is claimed anyway so an llm id `foo` can never collide
 * with a sibling `foo-node` if codegen ever starts binding the factory result.
 */
export const llmNodeRefName = (id: string): string => `${camelCase(id)}Node`;

/**
 * The identifier a node contributes to the structure expression: the llm ref
 * for llm nodes (dead today — see `llmNodeRefName`), the plain const otherwise.
 * `kind` is the node's authored kind string (structural, like
 * `IdentifierSource`, so this module stays import-free).
 */
export const nodeRefName = (id: string, kind: string): string =>
  kind === "llm" ? llmNodeRefName(id) : nodeConstName(id);

/** The exported DAG factory for llm scaffolds: `lead-opener` → `createLeadOpenerDag`. */
export const dagFactoryName = (dagName: string): string => `create${pascalCase(dagName)}Dag`;

/** The factory-opts interface for llm scaffolds: `lead-opener` → `LeadOpenerDagOpts`. */
export const dagOptsInterfaceName = (dagName: string): string => `${pascalCase(dagName)}DagOpts`;

/** The DAG input-schema const every scaffold declares. */
export const INPUT_SCHEMA_NAME = "InputSchema";

/** The pinned-model const llm factory scaffolds declare. */
export const DEFAULT_MODEL_NAME = "DEFAULT_MODEL";

/** The dag binding non-llm scaffolds declare (`const dag = define…`). */
export const DAG_CONST_NAME = "dag";

/** The `DagRegistration` const every scaffold declares and default-exports. */
export const REGISTRATION_CONST_NAME = "registration";

// ---------------------------------------------------------------------------
// Import names — what `buildImports` (authored-codegen) can emit. Kept here so
// the reserved-identifier accounting and the emitted import lines share one
// catalogue.
// ---------------------------------------------------------------------------

/** Node kind → framework factory import name (emitted when the kind is present). */
export const NODE_FACTORY_NAME = {
  fetch: "createFetchNode",
  transform: "createTransformNode",
  llm: "createLlmNode",
  "human-review": "createHumanReviewNode",
  source: "createSourceNode",
} as const;

/**
 * DAG shape → `define*` helper import name. `types.ts` re-derives its
 * `SHAPE_HELPER` (with `satisfies Record<Shape, string>` exhaustiveness over
 * the canonical `DAG_SHAPES`) from this object — one catalogue, checked there.
 */
export const SHAPE_HELPER_NAME = {
  linear: "defineLinearDag",
  "fan-out": "defineFanOut",
  diamond: "defineDiamond",
  router: "defineRouter",
  sources: "defineSources",
} as const;

/**
 * Import names emitted independent of node kinds/shape: `z` (zod), `ok`, the
 * llm extras `confidence` + `LlmNodeDef`, and the `DagRegistration` contract
 * type. Type-only imports still reserve their name — TypeScript rejects a
 * const that redeclares an imported binding, type-only or not.
 */
export const FIXED_IMPORT_NAME = {
  zod: "z",
  ok: "ok",
  confidence: "confidence",
  llmNodeDefType: "LlmNodeDef",
  dagRegistrationType: "DagRegistration",
} as const;

/**
 * Identifiers the generated `dag.ts` imports or declares regardless of node
 * ids — every import name `buildImports` can emit plus the fixed local
 * consts. A node whose generated identifiers land here would produce a
 * duplicate declaration. (`input` is claimed defensively: node bodies bind
 * `input`/`_input` parameters, and reserving the module-level name keeps the
 * generated file unambiguous even though a shadowed const would compile.)
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  DAG_CONST_NAME,
  "input",
  REGISTRATION_CONST_NAME,
  ...Object.values(FIXED_IMPORT_NAME),
  ...Object.values(NODE_FACTORY_NAME),
  ...Object.values(SHAPE_HELPER_NAME),
]);

// ---------------------------------------------------------------------------
// Collision accounting — built FROM the constructors above.
// ---------------------------------------------------------------------------

/**
 * The slice of an authored node the identifier enumeration needs. Structural
 * (not `AuthoredNode`) so this module stays import-free — `authored.ts`
 * imports us, not the other way around.
 */
export interface IdentifierSource {
  readonly id: string;
  readonly kind: string;
}

/**
 * Every identifier `authored-codegen` can emit for a node, derived from the
 * same name constructors codegen calls:
 *   - `nodeConstName(id)`   — the node const (non-llm ref)
 *   - `llmNodeRefName(id)`  — claimed for llm nodes though never bound today
 *                             (see the rationale on `llmNodeRefName`)
 *   - `llmFactoryName(id)`  — the llm factory
 *   - `schemaConstName(id)` — the output schema const
 *   - `fanInConstName(id)`  — the fan-in schema const (join/assemble roles)
 *
 * Conservative on purpose: the FanIn / llm entries are claimed even when the
 * node's current role wouldn't emit them, so a refinement that changes a
 * node's role can never introduce a collision the schema already accepted.
 */
export const generatedIdentifiersFor = (node: IdentifierSource): readonly string[] => [
  nodeConstName(node.id),
  ...(node.kind === "llm" ? [llmNodeRefName(node.id), llmFactoryName(node.id)] : []),
  schemaConstName(node.id),
  fanInConstName(node.id),
];

/**
 * DAG-level identifiers derived from the DAG name, via the same constructors
 * codegen emits with. `InputSchema` is emitted by EVERY scaffold;
 * `DEFAULT_MODEL`, `create<Pascal>Dag` and the `<Pascal>DagOpts` interface
 * only by the --llm factory scaffolds — but all are claimed unconditionally
 * (see the conservatism note on `generatedIdentifiersFor`).
 */
export const dagLevelIdentifiers = (dagName: string): readonly string[] => [
  INPUT_SCHEMA_NAME,
  DEFAULT_MODEL_NAME,
  dagFactoryName(dagName),
  dagOptsInterfaceName(dagName),
];
