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

// ---------------------------------------------------------------------------
// Lexical rules — the single source for the kebab/identifier regexes every
// authoring surface enforces (`authored.ts` schema, `compose.ts` / `new.ts`
// arg parsing, `authored-codegen.ts` key emission). One copy here so the
// vocabularies can never drift apart.
// ---------------------------------------------------------------------------

/**
 * kebab-case, lowercase, single internal dashes — a valid DAG id / directory
 * segment and the convention `team` and case labels follow everywhere.
 */
export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * KEBAB whose first segment starts with a LETTER. Node ids and the DAG name
 * feed codegen'd identifiers (`const <camel> = …`, `interface <Pascal>DagOpts`)
 * — `2fast` camelCases to `2fast`, which is not a valid JS identifier and
 * would only surface as a SyntaxError at gauntlet time.
 */
export const KEBAB_IDENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A valid JS identifier — field names must match so codegen can emit dotted access. */
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Branded lexical types — parse, don't validate. The `parse*` smart
// constructors below are the ONLY producers, so holding one of these proves
// the corresponding regex already passed; downstream signatures narrow to the
// brand instead of re-validating (or trusting) a bare string.
// ---------------------------------------------------------------------------

/** A `KEBAB`-validated string (team names, case labels). */
export type Kebab = string & { readonly __brand: "Kebab" };

/**
 * A `KEBAB_IDENT`-validated string (node ids, DAG names) — the only strings
 * safe to feed the name constructors below, since they camelCase/PascalCase
 * into emitted JS identifiers.
 */
export type KebabIdent = string & { readonly __brand: "KebabIdent" };

/** The sole `Kebab` producer: `null` unless `KEBAB` matches. */
export const parseKebab = (raw: string): Kebab | null =>
  KEBAB.test(raw) ? (raw as Kebab) : null;

/** The sole `KebabIdent` producer: `null` unless `KEBAB_IDENT` matches. */
export const parseKebabIdent = (raw: string): KebabIdent | null =>
  KEBAB_IDENT.test(raw) ? (raw as KebabIdent) : null;

/**
 * The full ECMAScript LineTerminator set as a regex character-class body:
 * `\r`, `\n`, U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR). JS
 * honors ALL FOUR as source line terminators — including terminating `//`
 * comments — so free text that codegen interpolates into a comment must
 * exclude exactly this set or an author/LLM-supplied purpose could break out
 * of the comment into code position. Single-sourced here (spelled with
 * escapes, never raw characters) so the schema rejection (`authored.ts`
 * SINGLE_LINE) and the emission-site scrub (`authored-codegen.ts` comment())
 * can never again agree on an incomplete set.
 */
const LINE_TERMINATOR_CLASS = "\\r\\n\\u2028\\u2029";

/**
 * Free text that is safe in a single-line context: non-empty and containing
 * no JS line terminator (see `LINE_TERMINATOR_CLASS`). The authoring schema
 * applies this to every purpose / description / enum value.
 */
export const SINGLE_LINE = new RegExp(`^[^${LINE_TERMINATOR_CLASS}]+$`);

/**
 * Global matcher over runs of JS line terminators — the defense-in-depth
 * scrub `authored-codegen`'s comment() applies at the emission site (safe to
 * share despite the `g` flag: it is only used with `String.replace`, which
 * does not depend on `lastIndex`).
 */
export const LINE_TERMINATORS = new RegExp(`[${LINE_TERMINATOR_CLASS}]+`, "g");

/**
 * The `{{` prompt-placeholder opener. The runtime prompt renderer
 * (`interpolatePrompt`, `nodes/llm.ts`) replaceAll-substitutes any literal
 * `{{field}}` whose name matches a buildInput var — so authored free text
 * that codegen splices into a generated prompt BODY (node purpose, enum
 * values) must never contain `{{`, or a purpose like "… {{text}} …" would
 * silently splice runtime input into the prompt while passing the entire
 * gauntlet (which never renders prompts). Single-sourced here (mirroring
 * `SINGLE_LINE` / `LINE_TERMINATORS`) so the schema rejection (`authored.ts`)
 * and the emission-site scrub (`authored-codegen.ts` promptText()) can never
 * disagree on the sequence.
 */
export const TEMPLATE_OPEN = /\{\{/;

/**
 * Global matcher for the emission-site scrub (safe to share despite the `g`
 * flag: only used with `String.replace`, which does not depend on `lastIndex`).
 * A LOOKAHEAD (`\{(?=\{)` — not the literal `\{\{`) so the second brace stays
 * in scan: replacing the literal pair with `"{ {"` re-creates `{{` from odd /
 * overlapping brace runs (`"{{{text}}"` → `"{ {{text}}"`, still a live
 * placeholder), while the lookahead scrub is idempotent — no `{{` survives.
 */
export const TEMPLATE_OPENERS = /\{(?=\{)/g;

/**
 * The `@fugue-body` integrity-marker token. `structuralProjection`
 * (`authored-codegen.ts`) collapses everything between `// @fugue-body-start`
 * and `// @fugue-body-end` before hashing, so free text that codegen splices
 * into a `//` comment (node purpose, dag description, field descriptions, enum
 * values) must never carry the token: an injected fake START would exclude a
 * node's id/schema/imports from the integrity hash (structural tampering goes
 * undetected — fail-OPEN), and a fake END would break the hash the moment a
 * human implements the real placeholder body (fail-CLOSED). Single-sourced here
 * (mirroring `SINGLE_LINE` / `TEMPLATE_OPEN`) so the schema rejection
 * (`authored.ts` NO_FUGUE_BODY_MARKER) and the emission-site scrub
 * (`authored-codegen.ts` comment() / promptText()) can never disagree on the
 * sequence.
 */
export const FUGUE_BODY_MARKER = /@fugue-body/;

/**
 * Global matcher for the emission-site scrub (safe to share despite the `g`
 * flag: only used with `String.replace`, which does not depend on `lastIndex`).
 * Matches the literal `@fugue-body` token; the scrub replaces the leading `@`
 * with a full-width `＠` (U+FF20) so the token no longer parses as a marker
 * while staying human-legible in the emitted comment.
 */
export const FUGUE_BODY_MARKERS = /@(?=fugue-body)/g;

// Narrowed to the branded `KebabIdent` — the module's invariant is "only a
// parsed KebabIdent is safe to reshape into a JS identifier". A bare `string`
// param would let an unvalidated name (`2fast`, `default`, `a b`) slip in and
// produce an illegal identifier; taking `KebabIdent` makes that
// unrepresentable. `pascalCase` is module-private (no external callers — its
// only callers are `camelCase` just below and the name constructors further
// down, all of which already hold a `KebabIdent`); `camelCase` stays exported
// for the parse-time reserved-word check in `authored.ts`, but narrowed the
// same way.
const pascalCase = (kebab: KebabIdent): string =>
  kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export const camelCase = (kebab: KebabIdent): string => {
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

// Node-level constructors take the branded `KebabIdent` — the parse-time
// guarantee that camelCase/PascalCase yields a valid JS identifier.

/** Output-schema const for a node: `fetch-record` → `FetchRecordSchema`. */
export const schemaConstName = (id: KebabIdent): string => `${pascalCase(id)}Schema`;

/**
 * Fan-in schema const for a join/assemble node: `merge` → `MergeFanIn`.
 * Emitted only when the node's role receives a keyed fan-in, but claimed for
 * EVERY node (see the conservatism note on `generatedIdentifiersFor`).
 */
export const fanInConstName = (id: KebabIdent): string => `${pascalCase(id)}FanIn`;

/** LLM node factory (the injectable model seam): `summarize` → `createSummarize`. */
export const llmFactoryName = (id: KebabIdent): string => `create${pascalCase(id)}`;

/** Module-level node const for non-llm nodes: `fetch-record` → `fetchRecord`. */
export const nodeConstName = (id: KebabIdent): string => camelCase(id);

/**
 * The `<camel>Node` identifier claimed for llm nodes: `summarize` →
 * `summarizeNode`. Current codegen never BINDS it — the structure expression
 * calls `create<Pascal>(model)` directly, so this name never reaches the
 * emitted file. It is claimed anyway so an llm id `foo` can never collide
 * with a sibling `foo-node` if codegen ever starts binding the factory result.
 */
export const llmNodeRefName = (id: KebabIdent): string => `${camelCase(id)}Node`;

/**
 * The identifier a node contributes to the structure expression: the llm ref
 * for llm nodes (dead today — see `llmNodeRefName`), the plain const otherwise.
 * `kind` is the closed authored kind vocabulary (`AuthoredNodeKind` — derived
 * in-module from `NODE_FACTORY_NAME`, so this module stays import-free).
 */
export const nodeRefName = (id: KebabIdent, kind: AuthoredNodeKind): string =>
  kind === "llm" ? llmNodeRefName(id) : nodeConstName(id);

// The two DAG-level constructors take the branded `KebabIdent`, exactly like
// the node-level constructors above: both the authored pipeline (`dag.name`)
// and `fugue new`'s path argument PascalCase the name into emitted JS
// identifiers (`create<Pascal>Dag`, `<Pascal>DagOpts`), so a digit-leading
// name like `2fast` would emit `interface 2fastDagOpts` — a SyntaxError the
// brand makes unrepresentable at every call site.

/** The exported DAG factory for llm scaffolds: `lead-opener` → `createLeadOpenerDag`. */
export const dagFactoryName = (dagName: KebabIdent): string => `create${pascalCase(dagName)}Dag`;

/** The factory-opts interface for llm scaffolds: `lead-opener` → `LeadOpenerDagOpts`. */
export const dagOptsInterfaceName = (dagName: KebabIdent): string => `${pascalCase(dagName)}DagOpts`;

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
 * The closed authored node-kind vocabulary, derived from the factory
 * catalogue's keys — the same set `authored.ts` builds its discriminated
 * union from. Kept here (not imported) so this module stays import-free.
 */
export type AuthoredNodeKind = keyof typeof NODE_FACTORY_NAME;

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
 * Fixed-SPELLING import names — names whose spelling never depends on node
 * ids or the DAG name. EMISSION is gated per name (`buildImports`): `z` and
 * the `DagRegistration` type are always emitted; `ok` only when a
 * fetch/transform/source node needs a placeholder body; `confidence` and the
 * `LlmNodeDef` type only when an llm node is present. RESERVATION is
 * unconditional — all five names sit in `RESERVED_IDENTIFIERS` regardless of
 * kinds/shape (the same conservatism as `generatedIdentifiersFor`: a
 * refinement that adds the first llm node must not introduce a collision the
 * schema already accepted). Type-only imports still reserve their name —
 * TypeScript rejects a const that redeclares an imported binding, type-only
 * or not.
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
  // `opts` is the llm dag-factory's parameter binding (`export const
  // create<Pascal>Dag = (opts: … = {}) =>`), and the structure expression —
  // which references node consts by name — is evaluated INSIDE that factory
  // scope. A node id `opts` would be shadowed by the parameter, so the
  // factory would pass `{}` to defineDag instead of the node const and fail
  // only deep in the gauntlet with an opaque id-mismatch error.
  "opts",
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
  readonly id: KebabIdent;
  readonly kind: AuthoredNodeKind;
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
export const dagLevelIdentifiers = (dagName: KebabIdent): readonly string[] => [
  INPUT_SCHEMA_NAME,
  DEFAULT_MODEL_NAME,
  dagFactoryName(dagName),
  dagOptsInterfaceName(dagName),
];
