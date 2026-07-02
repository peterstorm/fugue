// Generated-identifier accounting for the AuthoredDag pipeline (deterministic-
// core convergence, Phase B).
//
// Owns the kebab→identifier case helpers, the JS reserved-word list, and the
// per-node enumeration of every identifier `authored-codegen` emits. This lets
// `authored.ts` reject identifier collisions at PARSE time with a precise
// message naming both sides — instead of letting the validation gauntlet
// surface a duplicate-declaration SyntaxError the author/LLM has to decode.
//
// Pure data + pure functions, no imports — `authored.ts` and
// `authored-codegen.ts` both depend on this module, never the reverse.

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
 * ECMAScript reserved words (plus the contextual/strict-mode set and the
 * literal keywords). A node id whose camelCase form lands here would emit
 * `const default = …` — a SyntaxError.
 */
export const JS_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "default", "case", "new", "class", "function", "return", "const", "let",
  "var", "if", "else", "for", "while", "do", "switch", "break", "continue",
  "throw", "try", "catch", "finally", "void", "typeof", "instanceof", "in",
  "of", "delete", "yield", "await", "async", "static", "super", "this",
  "null", "true", "false", "enum", "export", "import", "extends",
  "implements", "interface", "package", "private", "protected", "public",
]);

/**
 * Identifiers the generated `dag.ts` imports or declares regardless of node
 * ids: the import names `buildImports` can emit plus the fixed local consts.
 * A node whose generated identifiers land here would produce a duplicate
 * declaration.
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  "dag", "input", "registration", "z", "ok", "confidence",
  "createFetchNode", "createTransformNode", "createLlmNode",
  "createHumanReviewNode", "createSourceNode",
  "defineLinearDag", "defineFanOut", "defineDiamond", "defineRouter", "defineSources",
]);

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
 * Every identifier `authored-codegen` can emit for a node:
 *   - `camelCase(id)`            — the node const (non-llm ref)
 *   - `camelCase(id) + "Node"`   — the llm node local inside its factory
 *   - `"create" + pascalCase(id)`— the llm factory
 *   - `pascalCase(id) + "Schema"`— the output schema const
 *   - `pascalCase(id) + "FanIn"` — the fan-in schema const (join/assemble roles)
 *
 * Conservative on purpose: the FanIn / llm entries are claimed even when the
 * node's current role wouldn't emit them, so a refinement that changes a
 * node's role can never introduce a collision the schema already accepted.
 */
export const generatedIdentifiersFor = (node: IdentifierSource): readonly string[] => {
  const pascal = pascalCase(node.id);
  const camel = camelCase(node.id);
  return [
    camel,
    ...(node.kind === "llm" ? [`${camel}Node`, `create${pascal}`] : []),
    `${pascal}Schema`,
    `${pascal}FanIn`,
  ];
};

/**
 * DAG-level identifiers derived from the DAG name (emitted only for --llm
 * factory scaffolds, but claimed unconditionally — see the conservatism note
 * on `generatedIdentifiersFor`).
 */
export const dagLevelIdentifiers = (dagName: string): readonly string[] => [
  "InputSchema",
  "DEFAULT_MODEL",
  `create${pascalCase(dagName)}Dag`,
];
