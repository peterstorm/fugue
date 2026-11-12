// AuthoredDag → code (deterministic-core convergence, Phase B2).
//
// Pure string builders: given a validated `AuthoredDag`, emit a `dag.ts`
// (plus one prompt file per LLM node) using the SAME idioms as the golden
// `fugue new` templates — shape helpers, factory pattern for the model seam,
// bucketed confidence, fan-in schemas keyed by source-node id, `$input`
// edges. ZERO LLM involvement: everything structural is derived from the
// description. The LLM (via `fugue compose`) only ever edits the AuthoredDag
// JSON; this module is the deterministic half of that loop.
//
// RELATIONSHIP TO `new-templates.ts` (deliberate, not drift): the golden
// templates are human-education scaffolds with realistic example bodies and
// teaching comments; THIS module is the machine generator — fail-closed
// unimplemented bodies, prompts derived from `purpose`, and the
// regenerate-from-`dag.authored.json` workflow. Both stay compliant with the
// same idioms because the idiom surface is single-sourced: every emitted NAME
// comes from the `identifiers.ts` constructors (which also feed the
// parse-time collision accounting), and the llm-factory boilerplate
// (`llmFactoryPreamble` / `llmDagFactoryOpen` / `llmConfidenceReturn` /
// `registration`) is imported from `new-templates.ts` verbatim.
//
// Node input schemas are DERIVED from the topology, not authored:
//   linear    — node i consumes node i-1's output (first consumes the input)
//   fan-out/  — source consumes the input; branches consume the source;
//   diamond     the join consumes a fan-in keyed by branch ids
//   router    — classifier consumes the input; handlers consume its output
//   sources   — sources consume nothing; join consumes a fan-in keyed by
//               source ids; assemble consumes { join, $input }

import { createHash } from "node:crypto";
import { match, P } from "ts-pattern";
import { mapItemSpec, mapOutputSpec, structureRefs, terminalRefs } from "./authored.js";
import type {
  AuthoredChildDag,
  AuthoredChildNode,
  AuthoredDag,
  AuthoredMapNode,
  AuthoredNode,
  FieldType,
  SchemaSpec,
} from "./authored.js";
import {
  llmConfidenceReturn,
  llmDagFactoryOpen,
  llmFactoryPreamble,
  registration,
  type PromptFile,
  type TemplateCtx,
} from "./new-templates.js";
import {
  CHILD_MODEL_NAME,
  DAG_CONST_NAME,
  DEFAULT_MODEL_NAME,
  FIXED_IMPORT_NAME,
  FRAMEWORK_NAMESPACE_NAME,
  FUGUE_BODY_MARKERS,
  FUGUE_BODY_TOKEN,
  IDENT,
  INPUT_SCHEMA_NAME,
  LINE_TERMINATORS,
  TEMPLATE_OPENERS,
  NODE_FACTORY_NAME,
  SHAPE_HELPER_NAME,
  childLocalName,
  dagFactoryName,
  fanInConstName,
  llmFactoryName,
  nodeRefName,
  schemaConstName,
  type KebabIdent,
} from "./identifiers.js";
import { CONFIDENCE_FIELD } from "./vocabulary.js";

/** The llm node variant — the only kind that owns a prompt. */
type LlmNode = Extract<AuthoredNode, { kind: "llm" }>;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

// IDENT is single-sourced in `identifiers.ts` — the same rule the authoring
// schema enforces on field names.
const key = (name: string): string => (IDENT.test(name) ? name : JSON.stringify(name));

/**
 * Every free-text interpolation into a `//` comment goes through here: any JS
 * line terminator (\r, \n, U+2028, U+2029 — `LINE_TERMINATORS`, single-sourced
 * in `identifiers.ts` with the schema's SINGLE_LINE) would otherwise break out
 * of the comment into code position. The authoring schema already rejects
 * multi-line purpose / description fields — this is the defense-in-depth at
 * the emission site, scrubbing with the SAME character class so the two
 * layers can never disagree on the set.
 *
 * A comment also lands BETWEEN the `@fugue-body` markers `structuralProjection`
 * collapses before hashing, so an injected literal `@fugue-body` token would
 * forge a marker region (fail-open structural tampering or a fail-closed hash
 * break). The schema already rejects the token in every free-text field — this
 * mirrors that as an emission-site scrub, neutering `@fugue-body` → `＠fugue-body`
 * (`FUGUE_BODY_MARKERS`, single-sourced in `identifiers.ts`) so the two layers
 * can never disagree on the sequence.
 */
const comment = (text: string): string =>
  text.replace(LINE_TERMINATORS, " ").replace(FUGUE_BODY_MARKERS, "＠");

/**
 * Every free-text interpolation into a PROMPT BODY goes through here: a
 * literal `{{field}}` in authored text would be replaceAll-substituted with
 * runtime input by the prompt renderer (`interpolatePrompt`) — silent
 * injection the gauntlet can never see (it never renders prompts). The
 * authoring schema already rejects `{{` in purpose / description / enum
 * values — this is the defense-in-depth at the emission site (mirrors
 * `comment()`), scrubbing with the SAME sequence (`TEMPLATE_OPENERS`,
 * single-sourced in `identifiers.ts`) so the two layers can never disagree.
 * The matcher is a lookahead on the FIRST brace of each `{{` pair, so the
 * replacement only inserts a space after it — idempotent over odd/overlapping
 * brace runs (`{{{text}}`, `{{{{`), where replacing the literal pair would
 * re-create a live `{{`.
 *
 * Prompt bodies do not sit inside the `@fugue-body` regions, but authored free
 * text (node purpose, enum values) reaches BOTH a prompt AND a `//` comment, so
 * this mirrors `comment()`'s `@fugue-body` scrub (`FUGUE_BODY_MARKERS`,
 * single-sourced in `identifiers.ts`) to keep the two emission surfaces
 * identically hardened behind the schema.
 */
const promptText = (text: string): string =>
  text.replace(TEMPLATE_OPENERS, "{ ").replace(FUGUE_BODY_MARKERS, "＠");

function zodExpr(type: FieldType): string {
  return match(type)
    .with({ kind: "string" }, () => "z.string()")
    .with({ kind: "number" }, () => "z.number()")
    .with({ kind: "boolean" }, () => "z.boolean()")
    .with({ kind: "enum" }, (entry) => `z.enum([${entry.values.map((value) => JSON.stringify(value)).join(", ")}])`)
    .with({ kind: "array" }, (entry) => `z.array(${schemaExpr(entry.element)})`)
    .exhaustive();
}

function schemaExpr(spec: SchemaSpec, indent = ""): string {
  const fields = spec.fields
    .map((field) => `${indent}  ${key(field.name)}: ${zodExpr(field.type)},${field.description ? ` // ${comment(field.description)}` : ""}`)
    .join("\n");
  return `z.object({\n${fields}\n${indent}})`;
}

/** LLM node outputs always carry bucketed confidence (the framework idiom). */
const withConfidence = (spec: SchemaSpec): SchemaSpec =>
  spec.fields.some((f) => f.name === "confidence")
    ? spec
    : { fields: [...spec.fields, CONFIDENCE_FIELD] };

const schemaConst = (name: string, spec: SchemaSpec): string =>
  `const ${name} = ${schemaExpr(spec)};`;

const BODY_NODE_KINDS: ReadonlySet<AuthoredNode["kind"]> = new Set([
  "fetch",
  "source",
  "transform",
]);

/**
 * Executable-body factories share the stable framework namespace that body
 * authors use for Result helpers. Structural factory calls keep the namespace
 * live even after every human-owned body has been replaced.
 */
const nodeFactory = (kind: AuthoredNode["kind"]): string =>
  BODY_NODE_KINDS.has(kind)
    ? `${FRAMEWORK_NAMESPACE_NAME}.${NODE_FACTORY_NAME[kind]}`
    : NODE_FACTORY_NAME[kind];

const unimplementedBody = (node: AuthoredNode): string =>
  `${FRAMEWORK_NAMESPACE_NAME}.err(${FRAMEWORK_NAMESPACE_NAME}.frameworkError.validation(${JSON.stringify(node.id)}, ${JSON.stringify(`generated body for '${node.id}' is unimplemented`)}, "body"))`;

// ---------------------------------------------------------------------------
// Per-node code
// ---------------------------------------------------------------------------

interface NodePlan {
  readonly node: AuthoredNode;
  /** Schema const name for this node's output. */
  readonly outName: string;
  /**
   * Effective output spec (LLM nodes get confidence injected). `null` exactly
   * for human-review nodes — their gate is a typed passthrough, so no schema
   * const is emitted for them.
   */
  readonly outSpec: SchemaSpec | null;
  /** Expression for the node's input schema const; null for source nodes. */
  readonly inExpr: string | null;
  /** Var identifier referenced in the structure call for non-LLM nodes. */
  readonly ref: string;
  /** Factory binding for LLM nodes; null for every other node kind. */
  readonly llmFactory: string | null;
  /** Whether emitting this node expression needs the DAG's selected model. */
  readonly needsModel: boolean;
}

type ChildNodePlan = Omit<NodePlan, "node" | "outSpec"> & Readonly<{
  readonly node: AuthoredChildNode;
  readonly outSpec: SchemaSpec;
}>;

const purposeComment = (node: AuthoredNode): string => `// ${node.id} — ${comment(node.purpose)}`;

// ---------------------------------------------------------------------------
// Integrity: structure is machine-owned, placeholder bodies are yours
// ---------------------------------------------------------------------------

/**
 * Markers delimiting a HUMAN-OWNED placeholder body inside an otherwise
 * machine-generated declaration. Only `fetch` / `source` / `transform` nodes
 * emit them (llm `buildInput` is generated glue, human-review gates have no
 * body). `structuralProjection` collapses each marked region so the integrity
 * hash covers the machine-owned STRUCTURE (imports, schemas, ids, wiring,
 * registration) but NOT the body you are instructed to implement — resolving
 * the "DO NOT EDIT" ⇄ "implement the placeholders" contradiction.
 *
 * CROSS-REPO COUPLING SURFACE — loom's `fugue-generated-integrity` engine rule
 * (loom/engine `src/linter/programmatic/fugue-generated-integrity.ts`) is a
 * consumer of, and depends byte-for-byte on, all four of:
 *   1. the banner line format `// @fugue-integrity sha256:<64-hex>` (lowercase
 *      hex, on its own line — stamped by `stampGenerated` below);
 *   2. the COMMENT-ONLY PRELUDE: every line above that banner line is blank or
 *      a `//` comment (the rule fails closed on real code above the banner,
 *      which would escape the hash);
 *   3. these two marker strings, exactly;
 *   4. the collapse rule (`structuralProjection` below): sha256 over the
 *      projection of everything AFTER the banner line, utf-8, hex.
 * Neither repo imports the other — a drift in any of the four silently breaks
 * loom's wave-gate verification.
 */
// Derived from the single-sourced `FUGUE_BODY_TOKEN` (`identifiers.ts`) so the
// region delimiters, the schema-rejection matcher, and the emission-site scrub
// all spell the token exactly once — `// @fugue-body-start` / `-end`, unchanged.
export const FUGUE_BODY_START = `// ${FUGUE_BODY_TOKEN}-start`;
export const FUGUE_BODY_END = `// ${FUGUE_BODY_TOKEN}-end`;

/** Everything between a body-start and the next body-end (inclusive) collapses
 *  to one canonical marker: the region's COUNT and ORDER stay in the hash (a
 *  node body cannot be added/removed/reordered undetected) while its CONTENTS
 *  are free to implement. A body that carries the literal end marker fails
 *  CLOSED — the lazy match ends the region early, the body's tail lands in the
 *  projection, and the hash breaks (a false positive, not a bypass). The
 *  actual circumvention is fail-OPEN: deliberately wrapping hand-edited
 *  STRUCTURE in fake markers so it escapes the projection — that, like
 *  stripping the banner outright, is outside the accidental-edit threat model
 *  this rule targets. */
export const structuralProjection = (body: string): string =>
  body.replace(
    new RegExp(`${FUGUE_BODY_START}[\\s\\S]*?${FUGUE_BODY_END}`, "g"),
    FUGUE_BODY_START,
  );

/**
 * Stamp generated TypeScript using the complete cross-repository integrity
 * contract documented beside the markers and projection above. Pure and
 * deterministic: the same AuthoredDag reproduces the same structural hash.
 * Regeneration still replaces implemented body regions, so overwriting a
 * non-empty directory requires `--force`.
 */
export const stampGenerated = (body: string): string => {
  const hash = createHash("sha256").update(structuralProjection(body), "utf-8").digest("hex");
  return (
    "// @generated by `fugue new --from` / `fugue compose` — regenerate structure from dag.authored.json;\n" +
    "// implement only the @fugue-body regions (structure is integrity-hashed)\n" +
    `// @fugue-integrity sha256:${hash}\n` +
    body
  );
};

// Every unimplemented body returns the same node-attributed typed refusal.
// The body property (comment + callback) is wrapped in @fugue-body markers so
// implementing it does not trip the integrity hash; ids and schemas stay
// outside the markers and remain hashed.

const fetchNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = ${nodeFactory("fetch")}({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Unimplemented — replace this typed refusal with the real fetch for: ${comment(p.node.purpose)}
  fetch: async (_input) => ${unimplementedBody(p.node)},
  ${FUGUE_BODY_END}
});`;

const sourceNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = ${nodeFactory("source")}({
  id: ${JSON.stringify(p.node.id)},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Unimplemented — replace this typed refusal with the real fetch for: ${comment(p.node.purpose)}
  fetch: async () => ${unimplementedBody(p.node)},
  ${FUGUE_BODY_END}
});`;

const transformNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = ${nodeFactory("transform")}({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Unimplemented — replace this typed refusal with the real mapping for: ${comment(p.node.purpose)}
  transform: (_input) => ${unimplementedBody(p.node)},
  ${FUGUE_BODY_END}
});`;

const humanReviewNode = (p: NodePlan): string => `${purposeComment(p.node)}
// Human-review gate: the run SUSPENDS here and waits for a decision
// (approve / reject / approve-with-edit / reroute) before continuing.
const ${p.ref} = ${nodeFactory("human-review")}({
  id: ${JSON.stringify(p.node.id)},
  schema: ${p.inExpr},
  prompt: ${JSON.stringify(`Approve: ${p.node.purpose}?`)},
});`;

/** Prompt placeholders must be identifier-ish — sanitize fan-in keys. */
const placeholderName = (fieldKey: string): string => fieldKey.replace(/[^A-Za-z0-9_]/g, "_");

type LlmPromptInput = Readonly<{
  readonly source: string;
  readonly encoding: "scalar" | "json";
}>;

type LlmNodeEmissionOptions = Readonly<{
  readonly explicitReturnType?: boolean;
}>;

const llmNode = (
  p: NodePlan,
  promptName: string,
  inputs: readonly LlmPromptInput[],
  options: LlmNodeEmissionOptions = {},
): string => {
  const explicitReturnType = options.explicitReturnType ?? true;
  if (p.llmFactory === null) {
    throw new Error(`authored-codegen invariant: LLM node '${p.node.id}' has no factory binding`);
  }
  const buildInputEntries = inputs
    .map((input) => {
      const value = `input[${JSON.stringify(input.source)}]`;
      const encoded = input.encoding === "json" ? `JSON.stringify(${value})` : value;
      return `${key(placeholderName(input.source))}: ${encoded}`;
    })
    .join(", ");
  const returnType = explicitReturnType
    ? `: LlmNodeDef<z.infer<typeof ${p.inExpr}>, z.infer<typeof ${p.outName}>>`
    : "";
  return `${purposeComment(p.node)}
const ${p.llmFactory} = (
  model: string,
)${returnType} => {
  const node = ${nodeFactory("llm")}({
    id: ${JSON.stringify(p.node.id)},
    inputSchema: ${p.inExpr},
    outputSchema: ${p.outName},
    promptName: ${JSON.stringify(promptName)},
    model,
    buildInput: (input) => ({ ${buildInputEntries} }),
  });
${llmConfidenceReturn}
};`;
};

const llmPrompt = (
  dag: AuthoredDag,
  node: LlmNode,
  promptName: string,
  inputs: readonly LlmPromptInput[],
): PromptFile => {
  const vars = inputs
    .map((input) => {
      const placeholder = placeholderName(input.source);
      return `${placeholder}${input.encoding === "json" ? " (JSON)" : ""}: {{${placeholder}}}`;
    })
    .join("\n");
  const outSpec = withConfidence(node.output);
  const jsonShape = outSpec.fields
    .map((f) =>
      f.type.kind === "enum"
        ? // JSON.stringify (matching zodExpr) — a schema-legal enum value that
          // contains a double quote must not garble the prompt's shape hint.
          // promptText — a `{{` inside a value must not open a placeholder.
          `"${f.name}": ${f.type.values.map((v) => promptText(JSON.stringify(v))).join(" | ")}`
        : `"${f.name}": ${f.type.kind}`,
    )
    .join(", ");
  return {
    name: promptName,
    body: `You are a node in the ${dag.name} pipeline. Task: ${promptText(node.purpose)}

Input:
${vars}

Respond as JSON: { ${jsonShape} }.
Set confidence by how much signal the input carries — never use a number.
`,
  };
};

// ---------------------------------------------------------------------------
// The scaffold builder
// ---------------------------------------------------------------------------

interface AuthoredScaffold {
  readonly dagTs: string;
  readonly prompts: readonly PromptFile[];
}

interface Plans {
  readonly byId: Map<string, NodePlan>;
  readonly llmCount: number;
}

const nodeLlmCount = (node: AuthoredNode): number =>
  match(node)
    .with({ kind: "llm" }, () => 1)
    .with({ kind: "map" }, (map) =>
      map.child.nodes.filter((child) => child.kind === "llm").length)
    .otherwise(() => 0);

// `<prompt-name>.txt` is one filesystem component. Authored identifiers are
// ASCII, so string length is byte length for every logical prompt name here.
const PROMPT_FILE_SUFFIX = ".txt";
const FILESYSTEM_COMPONENT_MAX_LENGTH = 255;
const PROMPT_NAME_MAX_LENGTH = FILESYSTEM_COMPONENT_MAX_LENGTH - PROMPT_FILE_SUFFIX.length;

/** Preserve readable names when possible; adapt overlong identities with full SHA-256. */
const boundedPromptName = (logicalName: string): string => {
  if (logicalName.length <= PROMPT_NAME_MAX_LENGTH) return logicalName;
  const digest = createHash("sha256").update(logicalName, "utf-8").digest("hex");
  const suffix = `~${digest}`;
  return `${logicalName.slice(0, PROMPT_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
};

/** DAG name for one LLM, `<dag>-<node>` for many, then bounded for disk. */
const promptNameFor = (dag: AuthoredDag, id: string, llmCount: number): string =>
  boundedPromptName(llmCount === 1 ? dag.name : `${dag.name}-${id}`);

const childPromptNameFor = (dag: AuthoredDag, map: AuthoredMapNode, id: string): string =>
  boundedPromptName(`${dag.name}-${map.id}@${id}`);

const planNodes = (dag: AuthoredDag): Plans => {
  const byId = new Map<string, NodePlan>();
  let llmCount = 0;
  for (const node of dag.nodes) {
    const count = nodeLlmCount(node);
    llmCount += count;
    const outSpec = match(node)
      .with({ kind: "human-review" }, () => null)
      .with({ kind: "llm" }, (entry) => withConfidence(entry.output))
      .with({ kind: "map" }, (entry) => mapOutputSpec(entry))
      .otherwise((entry) => entry.output);
    byId.set(node.id, {
      node,
      outName: schemaConstName(node.id),
      outSpec,
      inExpr: null, // filled by wiring
      ref: nodeRefName(node.id, node.kind),
      llmFactory: node.kind === "llm" ? llmFactoryName(node.id) : null,
      needsModel: count > 0,
    });
  }
  return { byId, llmCount };
};

const planChildNodes = (nodes: readonly AuthoredChildNode[]): Map<string, ChildNodePlan> =>
  new Map(nodes.map((node) => [node.id, {
    node,
    outName: childLocalName(schemaConstName(node.id)),
    outSpec: node.kind === "llm" ? withConfidence(node.output) : node.output,
    inExpr: null,
    ref: childLocalName(nodeRefName(node.id, node.kind)),
    llmFactory: node.kind === "llm" ? childLocalName(llmFactoryName(node.id)) : null,
    needsModel: node.kind === "llm",
  }] as const));

/** Resolve one child plan or refuse the unknown-child map invariant. */
const childPlanOf = (plans: Map<string, ChildNodePlan>, id: string): ChildNodePlan => {
  const found = plans.get(id);
  if (found === undefined) throw new Error(`authored map invariant: unknown child node '${id}'`);
  return found;
};

/** Fan-in schema const over a set of upstream plans (keys = node ids). */
const fanInConst = (name: string, upstream: readonly NodePlan[], extra?: readonly (readonly [string, string])[]): string => {
  const entries = [
    ...upstream.map((u) => `  ${key(u.node.id)}: ${effectiveOutName(u)},`),
    ...(extra ?? []).map(([k, v]) => `  ${key(k)}: ${v},`),
  ].join("\n");
  return `const ${name} = z.object({\n${entries}\n});`;
};

/**
 * A human-review node's effective output schema is the reviewed (upstream)
 * schema — resolved during wiring and stored in `inExpr` (review gates are
 * typed passthroughs). A null `inExpr` here means a caller asked for the
 * gate's schema BEFORE wiring resolved it — an internal ordering bug, never
 * an authoring error, so it throws (matching the `plan()` invariant) instead
 * of silently emitting `z.never()` into the generated module.
 */
const effectiveOutName = (p: NodePlan): string => {
  if (p.node.kind !== "human-review") return p.outName;
  if (p.inExpr === null) {
    throw new Error(
      `authored-codegen invariant: human-review node '${p.node.id}' reached effectiveOutName before wiring`,
    );
  }
  return p.inExpr;
};

/**
 * One parameterized structure-wiring emitter for both scopes: the root DAG
 * (buildAuthoredScaffold) and a mapped child (emitChildStructure). The
 * per-shape wiring contract — which upstream output each node consumes and how
 * fan-ins are keyed — exists here once; the two scopes are thin adapters that
 * differ only in the naming adapter (node-ref expression, fan-in const
 * naming), the root-input expression, join requiredness, and pedagogical
 * comment emission. A new Shape is implemented once, here.
 */
interface StructureWiringScope {
  /** The scope's emitted id: the DAG name (root) or the child DAG id (mapped child). */
  readonly scopeId: string;
  /** Plan accessor — throws with the scope's own invariant message. */
  readonly plan: (id: string) => NodePlan;
  /** Store the wired input expression on the scope's plan map. */
  readonly setInput: (id: string, expression: string) => void;
  /** Node-ref-to-expression resolution (root: nodeExprRef; child: the LLM factory binding). */
  readonly nodeRefOf: (plan: NodePlan) => string;
  /** Fan-in const naming (root: fanInConstName; child: childLocalName(fanInConstName)). */
  readonly fanInNameOf: (joinId: KebabIdent) => string;
  /** The scope's root input expression: INPUT_SCHEMA_NAME (root) or the item-schema expression (child). */
  readonly rootInput: string;
  /** A mapped child fan-out requires a join; the root fan-out allows an optional join. */
  readonly joinRequired: boolean;
  /** Fan-in consts and their comments land here (root: extraDecls; child: local extras). */
  readonly pushDecl: (decl: string) => void;
  /** Pedagogical fan-in comments (root emits; the mapped child emits none). */
  readonly fanInComments: (
    context: "fan-out-join" | "sources-join" | "sources-assemble",
  ) => readonly string[];
  /** Router default-arm comment (root: " // REQUIRED"; mapped child: ""). */
  readonly routerDefaultSuffix: string;
}

/** Pedagogical fan-in comments, adapter-local: the root emitter's teaching
 *  comments for each fan-in const; the mapped-child emitter emits none. */
const FAN_IN_COMMENTS: Readonly<
  Record<"fan-out-join" | "sources-join" | "sources-assemble", readonly string[]>
> = {
  "fan-out-join": [
    `// The join sees every branch keyed by its node id — keys MUST equal the\n// incoming set (\`fugue lint\` enforces this).`,
  ],
  "sources-join": [
    `// Join: fan-in keyed by the source node ids (\`fugue lint\` checks the key set).`,
  ],
  "sources-assemble": [
    `// Assemble: fan-in over the join + the request via the "$input" slot.\n// Declaring "$input" is what makes \`defineSources\` add the DAG_INPUT edge.`,
  ],
};

const emitStructureWiring = (
  structure: AuthoredDag["structure"],
  scope: StructureWiringScope,
): string => {
  const { plan, setInput, nodeRefOf, fanInNameOf, rootInput, joinRequired, pushDecl, fanInComments, routerDefaultSuffix } = scope;
  return match(structure)
    .with({ shape: "linear" }, (linear) => {
      let previous = rootInput;
      for (const id of linear.order) {
        setInput(id, previous);
        previous = effectiveOutName(plan(id));
      }
      return `${SHAPE_HELPER_NAME.linear}({
  id: ${JSON.stringify(scope.scopeId)},
  nodes: [${linear.order.map((id) => nodeRefOf(plan(id))).join(", ")}],
})`;
    })
    .with({ shape: "fan-out" }, { shape: "diamond" }, (fan) => {
      setInput(fan.source, rootInput);
      const sourceOut = effectiveOutName(plan(fan.source));
      for (const id of fan.branches) setInput(id, sourceOut);
      let joinPart = "";
      if (fan.join !== undefined) {
        const fanInName = fanInNameOf(fan.join);
        for (const comment of fanInComments("fan-out-join")) pushDecl(comment);
        pushDecl(fanInConst(fanInName, fan.branches.map(plan)));
        setInput(fan.join, fanInName);
        joinPart = `\n  join: ${nodeRefOf(plan(fan.join))},`;
      } else if (joinRequired) {
        throw new Error(`authored map invariant: child '${scope.scopeId}' fan-out has no join`);
      }
      return `${SHAPE_HELPER_NAME[fan.shape]}({\n  id: ${JSON.stringify(scope.scopeId)},\n  source: ${nodeRefOf(plan(fan.source))},\n  branches: [${fan.branches.map((id) => nodeRefOf(plan(id))).join(", ")}],${joinPart}\n})`;
    })
    .with({ shape: "router" }, (router) => {
      setInput(router.classifier, rootInput);
      const classifierOut = effectiveOutName(plan(router.classifier));
      for (const entry of router.cases) setInput(entry.to, classifierOut);
      setInput(router.default, classifierOut);
      const cases = router.cases
        .map(
          (entry) => `    ${key(entry.label)}: {\n      when: (out) => (out as z.infer<typeof ${classifierOut}>).${entry.when.field} === ${JSON.stringify(entry.when.equals)},\n      to: ${nodeRefOf(plan(entry.to))},\n    },`,
        )
        .join("\n");
      return `${SHAPE_HELPER_NAME.router}({\n  id: ${JSON.stringify(scope.scopeId)},\n  classifier: ${nodeRefOf(plan(router.classifier))},\n  cases: {\n${cases}\n  },\n  default: ${nodeRefOf(plan(router.default))},${routerDefaultSuffix}\n})`;
    })
    .with({ shape: "sources" }, (sources) => {
      const joinFanIn = fanInNameOf(sources.join);
      for (const comment of fanInComments("sources-join")) pushDecl(comment);
      pushDecl(fanInConst(joinFanIn, sources.sources.map(plan)));
      setInput(sources.join, joinFanIn);
      const assembleFanIn = fanInNameOf(sources.assemble);
      for (const comment of fanInComments("sources-assemble")) pushDecl(comment);
      pushDecl(fanInConst(assembleFanIn, [plan(sources.join)], [["$input", rootInput]]));
      setInput(sources.assemble, assembleFanIn);
      return `${SHAPE_HELPER_NAME.sources}({\n  id: ${JSON.stringify(scope.scopeId)},\n  sources: [${sources.sources.map((id) => nodeRefOf(plan(id))).join(", ")}],\n  join: ${nodeRefOf(plan(sources.join))},\n  assemble: ${nodeRefOf(plan(sources.assemble))},\n})`;
    })
    .exhaustive();
};

/** One node's emitted declaration plus the prompt files it owns (LLM nodes, maps). */
type NodeEmission = Readonly<{
  declaration: string;
  prompts: readonly PromptFile[];
}>;

/** A node kind that owns no prompt. */
const promptless = (declaration: string): NodeEmission => ({ declaration, prompts: [] });

const indent = (value: string, spaces: number): string => {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => line.length === 0 ? line : `${prefix}${line}`).join("\n");
};

const emitChildStructure = (
  child: AuthoredChildDag,
  plans: Map<string, ChildNodePlan>,
  itemSchema: SchemaSpec,
): { readonly expression: string; readonly extras: readonly string[] } => {
  const plan = (id: string): ChildNodePlan => childPlanOf(plans, id);
  const setInput = (id: string, expression: string): void => {
    plans.set(id, { ...plan(id), inExpr: expression });
  };
  const itemExpr = schemaExpr(itemSchema, "  ");
  const extras: string[] = [];
  const ref = (node: NodePlan): string => {
    if (node.node.kind !== "llm") return node.ref;
    if (node.llmFactory === null) {
      throw new Error(`authored map invariant: child LLM '${node.node.id}' has no factory binding`);
    }
    return `${node.llmFactory}(${CHILD_MODEL_NAME})`;
  };

  const expression = emitStructureWiring(child.structure, {
    scopeId: child.id,
    plan,
    setInput,
    nodeRefOf: ref,
    fanInNameOf: (joinId) => childLocalName(fanInConstName(joinId)),
    rootInput: itemExpr,
    joinRequired: true,
    pushDecl: (decl) => {
      extras.push(decl);
    },
    fanInComments: () => [],
    routerDefaultSuffix: "",
  });

  return { expression, extras };
};

/** One mapped child node's declaration, and its prompt when it is an LLM child. */
const emitChildNode = (
  dag: AuthoredDag,
  map: AuthoredMapNode,
  itemSpec: SchemaSpec,
  childPlan: ChildNodePlan,
): NodeEmission =>
  match(childPlan.node)
    .returnType<NodeEmission>()
    .with({ kind: "fetch" }, () => promptless(fetchNode(childPlan)))
    .with({ kind: "source" }, () => promptless(sourceNode(childPlan)))
    .with({ kind: "transform" }, () => promptless(transformNode(childPlan)))
    .with({ kind: "llm" }, (llm) => {
      const promptName = childPromptNameFor(dag, map, llm.id);
      const inputs = llmPromptInputs(
        { input: itemSpec, nodes: map.child.nodes, structure: map.child.structure },
        childPlan,
      );
      return {
        declaration: llmNode(childPlan, promptName, inputs, { explicitReturnType: false }),
        prompts: [llmPrompt(dag, llm, promptName, inputs)],
      };
    })
    .exhaustive();

/**
 * Authored fan scheduling (F1 PR-D, AD-8): emitted only when present, so
 * authors who declare nothing get a byte-identical generated module and the
 * definition-time defaults apply (FR-001, FR-046). The estimator is a
 * closed-union literal; JSON.stringify pins it as a string literal.
 */
const schedulingConfigLines = (node: AuthoredMapNode): readonly string[] => [
  ...(node.childConcurrency !== undefined ? [`    childConcurrency: ${node.childConcurrency},`] : []),
  ...(node.estimator !== undefined ? [`    estimator: ${JSON.stringify(node.estimator)},`] : []),
];

const emitMapNode = (
  dag: AuthoredDag,
  plan: NodePlan,
  node: AuthoredMapNode,
): NodeEmission => {
  if (plan.inExpr === null) {
    throw new Error(`authored map invariant: map node '${node.id}' reached codegen before input wiring`);
  }
  const itemSpec = mapItemSpec(dag, node);
  const plans = planChildNodes(node.child.nodes);
  // Child wiring resolves each plan's input first; the plans are read after it.
  const child = emitChildStructure(node.child, plans, itemSpec);
  const childPlans = structureRefs(node.child.structure).map(([childId]) => childPlanOf(plans, childId));
  const childNodes = childPlans.map((childPlan) => emitChildNode(dag, node, itemSpec, childPlan));
  const declarations = [
    ...childPlans.map((childPlan) => schemaConst(childPlan.outName, childPlan.outSpec)),
    ...child.extras,
    ...childNodes.map((emitted) => emitted.declaration),
  ];

  const parameter = plan.needsModel ? `${CHILD_MODEL_NAME}: string` : "";
  // The child's collected-output schema is single-sourced: the terminal's
  // already-emitted `$child_<Pascal>Schema` const serves both config roles
  // (its outSpec equals `childOutputSpec(node.child)` — both derive from the
  // terminal via `withConfidence`/`childNodeOutputSpec`), so one schema
  // instance is emitted instead of three, and the mapping identity check
  // (`isAuthoredCollectGather` compares references) still binds to the exact
  // identities the authored constructor captured.
  const terminalId = terminalRefs(node.child.structure)[0];
  if (terminalId === undefined) {
    throw new Error(`authored map invariant: child '${node.child.id}' has no terminal output`);
  }
  const terminalPlan = childPlanOf(plans, terminalId);
  const declaration = [
    purposeComment(node),
    `const ${plan.ref} = (${parameter}) => {`,
    ...(declarations.length === 0 ? [] : [indent(declarations.join("\n\n"), 2), ""]),
    `  return ${nodeFactory("map")}({`,
    `    id: ${JSON.stringify(node.id)},`,
    `    inputSchema: ${plan.inExpr},`,
    `    widthFrom: ${JSON.stringify(node.widthFrom)},`,
    `    maxWidth: ${node.maxWidth},`,
    ...schedulingConfigLines(node),
    `    child: ${child.expression.replace(/\n/g, "\n    ")},`,
    `    childOutputSchema: ${terminalPlan.outName},`,
    `    collectedItemSchema: ${terminalPlan.outName},`,
    `    gather: { kind: "collect", field: ${JSON.stringify(node.gather.field)} },`,
    "  });",
    "};",
  ].join("\n");
  return { declaration, prompts: childNodes.flatMap((emitted) => emitted.prompts) };
};

/**
 * Build the full `dag.ts` + prompt files from a validated AuthoredDag.
 * Deterministic and pure.
 */
export const buildAuthoredScaffold = (dag: AuthoredDag): AuthoredScaffold => {
  const { byId, llmCount } = planNodes(dag);
  const plan = (id: string): NodePlan => {
    const p = byId.get(id);
    if (!p) throw new Error(`authored-codegen invariant: unknown node '${id}' (schema validation should have rejected this)`);
    return p;
  };
  const setInput = (id: string, expr: string): void => {
    byId.set(id, { ...plan(id), inExpr: expr });
  };

  // One canonical iteration order for EVERY emitted section — parse already
  // canonicalizes `dag.nodes` to this order, but deriving it here keeps the
  // emitted bytes independent of the nodes array even for a value that
  // bypassed the brand (tests) — schema consts, node decls, and prompts can
  // never disagree.
  const orderedIds = structureOrder(dag);
  // Output schema consts (skip human-review — passthrough)
  const schemaDecls = [
    schemaConst(INPUT_SCHEMA_NAME, dag.input),
    ...orderedIds.flatMap((id) => {
      const p = plan(id);
      return p.outSpec ? [schemaConst(p.outName, p.outSpec)] : [];
    }),
  ];
  // Wiring resolves every node's input before any node is declared.
  const wired = wireRootStructure(dag, plan, setInput);
  // Node declarations (structure order = declaration order)
  const nodes = orderedIds.map((id) => emitRootNode(dag, llmCount, plan(id)));

  const dagTs = assembleDagModule(dag, llmCount > 0, {
    schemaDecls,
    extraDecls: wired.extraDecls,
    nodeDecls: nodes.map((emitted) => emitted.declaration),
    structureExpr: wired.structureExpr,
  });
  return { dagTs, prompts: nodes.flatMap((emitted) => emitted.prompts) };
};

/**
 * Wire inputs per shape + build the root structure expression. One
 * parameterized emitter for both scopes (root and mapped child) — the
 * per-shape wiring contract exists once; this adapter differs only in naming,
 * the root-input expression, optional join, and the pedagogical comments.
 */
const wireRootStructure = (
  dag: AuthoredDag,
  plan: (id: string) => NodePlan,
  setInput: (id: string, expr: string) => void,
): Readonly<{ structureExpr: string; extraDecls: readonly string[] }> => {
  const extraDecls: string[] = [];
  const structureExpr = emitStructureWiring(dag.structure, {
    scopeId: dag.name,
    plan,
    setInput,
    nodeRefOf: nodeExprRef,
    fanInNameOf: fanInConstName,
    rootInput: INPUT_SCHEMA_NAME,
    joinRequired: false,
    pushDecl: (decl) => {
      extraDecls.push(decl);
    },
    fanInComments: (context) => FAN_IN_COMMENTS[context],
    routerDefaultSuffix: " // REQUIRED",
  });
  return { structureExpr, extraDecls };
};

/** One root node's declaration, and the prompts it owns (an LLM node, or a map's LLM children). */
const emitRootNode = (dag: AuthoredDag, llmCount: number, p: NodePlan): NodeEmission =>
  match(p.node)
    .returnType<NodeEmission>()
    .with({ kind: "fetch" }, () => promptless(fetchNode(p)))
    .with({ kind: "source" }, () => promptless(sourceNode(p)))
    .with({ kind: "transform" }, () => promptless(transformNode(p)))
    .with({ kind: "human-review" }, () => promptless(humanReviewNode(p)))
    .with({ kind: "llm" }, (llm) => {
      const promptName = promptNameFor(dag, llm.id, llmCount);
      const inputs = llmPromptInputs(dag, p);
      return { declaration: llmNode(p, promptName, inputs), prompts: [llmPrompt(dag, llm, promptName, inputs)] };
    })
    .with({ kind: "map" }, (map) => emitMapNode(dag, p, map))
    .exhaustive();

const scaffoldHeader = (dag: AuthoredDag): string => `// ${dag.name} — ${comment(dag.description)}
//
// Generated deterministically from dag.authored.json (via \`fugue new --from\`
// or \`fugue compose\`). The STRUCTURE is authoritative and integrity-hashed —
// edit dag.authored.json and regenerate rather than rewiring by hand. Node
// bodies between the "@fugue-body" markers are yours to implement: untouched
// bodies fail closed, and the regions are EXCLUDED from the integrity hash, so
// filling them in is expected and safe.`;

/** The DAG binding: a model-parameterized factory when any node needs a model, else a plain const. */
const dagBinding = (dag: AuthoredDag, hasLlm: boolean, structureExpr: string): string =>
  hasLlm
    ? `${llmFactoryPreamble(dag.name)}

${llmDagFactoryOpen(dag.name)}
  ${structureExpr.replace(/\n/g, "\n  ")};`
    : `const ${DAG_CONST_NAME} = ${structureExpr};`;

/** The emitted sections of a generated `dag.ts`, each already in declaration order. */
type ScaffoldSections = Readonly<{
  schemaDecls: readonly string[];
  extraDecls: readonly string[];
  nodeDecls: readonly string[];
  structureExpr: string;
}>;

const assembleDagModule = (dag: AuthoredDag, hasLlm: boolean, sections: ScaffoldSections): string => {
  const ctx: TemplateCtx = {
    name: dag.name,
    team: dag.team,
    llm: hasLlm,
  };
  return [
    scaffoldHeader(dag),
    "",
    buildImports(dag, hasLlm),
    "",
    sections.schemaDecls.join("\n\n"),
    ...(sections.extraDecls.length > 0 ? ["", sections.extraDecls.join("\n")] : []),
    "",
    sections.nodeDecls.join("\n\n"),
    "",
    dagBinding(dag, hasLlm, sections.structureExpr),
    "",
    registration(ctx, hasLlm ? `${dagFactoryName(dag.name)}()` : DAG_CONST_NAME, dag.description),
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

/**
 * Structure roles in dependency order, so declarations always precede use.
 * Derived from `structureRefs` (the schema's own structural walk) rather than
 * a hand-duplicated per-shape switch — one walk, one order.
 */
const structureOrder = (dag: AuthoredDag): readonly string[] =>
  structureRefs(dag.structure).map(([id]) => id);

/**
 * Structure references invoke an LLM factory, invoke a map factory (with a
 * model when its child needs one), or use the plain const for ordinary nodes.
 */
const nodeExprRef = (plan: NodePlan): string => {
  if (plan.node.kind === "llm") {
    if (plan.llmFactory === null) {
      throw new Error(`authored-codegen invariant: LLM node '${plan.node.id}' has no factory binding`);
    }
    return `${plan.llmFactory}(opts.model ?? ${DEFAULT_MODEL_NAME})`;
  }
  if (plan.node.kind === "map") {
    return plan.needsModel
      ? `${plan.ref}(opts.model ?? ${DEFAULT_MODEL_NAME})`
      : `${plan.ref}()`;
  }
  return plan.ref;
};

/**
 * Prompt inputs carry their encoding with their source field. Fan-in objects
 * and authored arrays use JSON; scalar direct fields preserve scalar coercion.
 */
const llmPromptInputs = (
  graph: {
    readonly input: SchemaSpec;
    readonly nodes: readonly AuthoredNode[];
    readonly structure: AuthoredDag["structure"];
  },
  p: NodePlan,
): readonly LlmPromptInput[] => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const direct = (spec: SchemaSpec): readonly LlmPromptInput[] =>
    spec.fields.map((field) => ({
      source: field.name,
      encoding: field.type.kind === "array" ? "json" : "scalar",
    }));
  const fanIn = (ids: readonly string[]): readonly LlmPromptInput[] =>
    ids.map((source) => ({ source, encoding: "json" }));
  const fieldsOf = (id: KebabIdent): readonly LlmPromptInput[] => {
    const node = byId.get(id);
    if (node === undefined || node.kind === "human-review") return [];
    return direct(node.kind === "map" ? mapOutputSpec(node) : node.output);
  };

  // Exhaustive: a newly-added Shape must fail compilation here until its
  // input-field semantics are explicitly implemented.
  return match(graph.structure)
    .returnType<readonly LlmPromptInput[]>()
    .with({ shape: "linear" }, ({ order }) => {
      // Human-review gates are typed passthroughs — walk back to the nearest
      // predecessor that actually produces fields (mirrors effectiveOutName).
      const producer = order
        .slice(0, Math.max(order.indexOf(p.node.id), 0))
        .findLast((id) => byId.get(id)?.kind !== "human-review");
      return producer === undefined ? direct(graph.input) : fieldsOf(producer);
    })
    .with({ shape: P.union("fan-out", "diamond") }, (fan) => {
      if (p.node.id === fan.source) return direct(graph.input);
      if (p.node.id === fan.join) return fanIn(fan.branches);
      return fieldsOf(fan.source);
    })
    .with({ shape: "router" }, (router) =>
      p.node.id === router.classifier ? direct(graph.input) : fieldsOf(router.classifier))
    .with({ shape: "sources" }, (sources) => {
      if (p.node.id === sources.join) return fanIn(sources.sources);
      if (p.node.id === sources.assemble) return fanIn([sources.join, "$input"]);
      return []; // a source node consumes nothing
    })
    .exhaustive();
};

// Every import name comes from the `identifiers.ts` catalogue
// (`FIXED_IMPORT_NAME` / `NODE_FACTORY_NAME` / `SHAPE_HELPER_NAME`), the same
// sets `RESERVED_IDENTIFIERS` is built from — an import this function emits is
// reserved at parse time by construction.
const buildImports = (dag: AuthoredDag, hasLlm: boolean): string => {
  const hasDirectLlm = dag.nodes.some((node) => node.kind === "llm");
  const kinds = [...new Set(dag.nodes.flatMap((node) => [
    node.kind,
    ...(node.kind === "map" ? node.child.nodes.map((child) => child.kind) : []),
  ]))];
  const helpers = [...new Set([
    SHAPE_HELPER_NAME[dag.structure.shape],
    ...dag.nodes.flatMap((node) =>
      node.kind === "map" ? [SHAPE_HELPER_NAME[node.child.structure.shape]] : [],
    ),
  ])];

  // Executable-body factories and Result helpers share one namespace import.
  // Its structural factory calls keep it live after all bodies are implemented.
  const hasGeneratedBody = kinds.some((kind) => BODY_NODE_KINDS.has(kind));

  const names = [
    ...(hasLlm ? [FIXED_IMPORT_NAME.confidence] : []),
    ...kinds.filter((kind) => !BODY_NODE_KINDS.has(kind)).map((kind) => NODE_FACTORY_NAME[kind]),
    ...helpers,
  ].sort();

  return [
    `import { ${FIXED_IMPORT_NAME.zod} } from "zod";`,
    ...(hasGeneratedBody
      ? [`import * as ${FRAMEWORK_NAMESPACE_NAME} from "@fuguejs/framework";`]
      : []),
    `import {`,
    ...names.map((n) => `  ${n},`),
    `} from "@fuguejs/framework";`,
    ...(hasDirectLlm ? [`import type { ${FIXED_IMPORT_NAME.llmNodeDefType} } from "@fuguejs/framework";`] : []),
    `import type { ${FIXED_IMPORT_NAME.dagRegistrationType} } from "@fuguejs/host/contract";`,
  ].join("\n");
};
