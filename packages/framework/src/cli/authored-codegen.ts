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
// teaching comments; THIS module is the machine generator — placeholder
// ("todo") bodies, prompts derived from `purpose`, and the
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
import { match } from "ts-pattern";
import { childOutputSpec, mapItemSpec, mapOutputSpec, structureRefs } from "./authored.js";
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
  DAG_CONST_NAME,
  DEFAULT_MODEL_NAME,
  FIXED_IMPORT_NAME,
  FUGUE_BODY_MARKERS,
  FUGUE_BODY_TOKEN,
  IDENT,
  INPUT_SCHEMA_NAME,
  LINE_TERMINATORS,
  TEMPLATE_OPENERS,
  NODE_FACTORY_NAME,
  SHAPE_HELPER_NAME,
  dagFactoryName,
  fanInConstName,
  llmFactoryName,
  mapFactoryName,
  nodeRefName,
  schemaConstName,
  type KebabIdent,
} from "./identifiers.js";
import { CONFIDENCE_FIELD } from "./vocabulary.js";
import { assertNever } from "./types.js";

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

const defaultExpr = (type: FieldType): string =>
  match(type)
    .with({ kind: "string" }, () => '"todo"')
    .with({ kind: "number" }, () => "0")
    .with({ kind: "boolean" }, () => "false")
    .with({ kind: "enum" }, (entry) => JSON.stringify(entry.values[0]))
    .with({ kind: "array" }, () => "[]")
    .exhaustive();

/** LLM node outputs always carry bucketed confidence (the framework idiom). */
const withConfidence = (spec: SchemaSpec): SchemaSpec =>
  spec.fields.some((f) => f.name === "confidence")
    ? spec
    : { fields: [...spec.fields, CONFIDENCE_FIELD] };

const schemaConst = (name: string, spec: SchemaSpec): string =>
  `const ${name} = ${schemaExpr(spec)};`;

const defaultsObject = (spec: SchemaSpec, indent = "    "): string =>
  spec.fields.map((f) => `${indent}${key(f.name)}: ${defaultExpr(f.type)},`).join("\n");

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
}

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
 * Stamp generated TypeScript with a tamper-evident integrity banner. The
 * `@fugue-integrity sha256:<hex>` hash covers the machine-owned STRUCTURE — the
 * body with each `@fugue-body` region collapsed by `structuralProjection` — so
 * rewiring the DAG by hand (imports, schemas, ids, structure, registration)
 * trips the hash, but implementing the placeholder node bodies the scaffold
 * tells you to fill in does NOT. This resolves the former contradiction where a
 * whole-body hash forbade the very edits `nextSteps` and the generated README
 * instruct.
 *
 * Pure (body in, stamped body out) and co-located with `structuralProjection`
 * and the region markers it depends on — the entire integrity contract lives in
 * this one module; the shell (`new.ts`) only writes the returned string.
 *
 * CROSS-REPO COUPLING SURFACE — loom's `fugue-generated-integrity` engine rule
 * (loom/engine `src/linter/programmatic/fugue-generated-integrity.ts`)
 * recomputes this hash and blocks on a mismatch at the wave gate. It is a
 * consumer of, and depends byte-for-byte on, all four of (nothing imported):
 *   1. the banner line format `// @fugue-integrity sha256:<64-hex>` (lowercase
 *      hex, on its own line) this function emits;
 *   2. the COMMENT-ONLY PRELUDE: every line above the integrity line is a `//`
 *      comment (the banner sits at the top of the file; the rule fails closed
 *      on real code above the integrity line — it would escape the hash);
 *   3. the two `@fugue-body-start` / `@fugue-body-end` marker strings above;
 *   4. the collapse rule: sha256 over `structuralProjection` of everything
 *      AFTER the integrity line, utf-8, hex digest.
 *
 * The projected STRUCTURE is the sole input to the hash, so regenerating from
 * the same AuthoredDag reproduces the identical structure and hence the
 * identical hash. Regeneration is NOT a byte-for-byte fixed point of an
 * implemented file, though: it re-emits placeholder bodies, DESTROYING any
 * implemented `@fugue-body` region contents — which is why overwriting a
 * non-empty dir requires `--force`.
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

// The placeholder-body emitters take the output spec explicitly: the caller
// has already narrowed `p.node` by kind, so `p.node.output` is a plain field
// access — no non-null assertion anywhere. The body property (comment + the
// async callback) is wrapped in @fugue-body markers so implementing it does not
// trip the integrity hash; id/schemas stay outside the markers and hashed.

const fetchNode = (p: NodePlan, outSpec: SchemaSpec): string => `${purposeComment(p.node)}
const ${p.ref} = ${NODE_FACTORY_NAME.fetch}({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Placeholder — implement the real fetch for: ${comment(p.node.purpose)}
  fetch: async (_input) =>
    ok({
${defaultsObject(outSpec, "      ")}
    }),
  ${FUGUE_BODY_END}
});`;

const sourceNode = (p: NodePlan, outSpec: SchemaSpec): string => `${purposeComment(p.node)}
const ${p.ref} = ${NODE_FACTORY_NAME.source}({
  id: ${JSON.stringify(p.node.id)},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Placeholder — implement the real fetch for: ${comment(p.node.purpose)}
  fetch: async () =>
    ok({
${defaultsObject(outSpec, "      ")}
    }),
  ${FUGUE_BODY_END}
});`;

const transformNode = (p: NodePlan, outSpec: SchemaSpec): string => `${purposeComment(p.node)}
const ${p.ref} = ${NODE_FACTORY_NAME.transform}({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  ${FUGUE_BODY_START}
  // Placeholder — map the real values for: ${comment(p.node.purpose)}
  transform: (_input) =>
    ok({
${defaultsObject(outSpec, "      ")}
    }),
  ${FUGUE_BODY_END}
});`;

const humanReviewNode = (p: NodePlan): string => `${purposeComment(p.node)}
// Human-review gate: the run SUSPENDS here and waits for a decision
// (approve / reject / approve-with-edit / reroute) before continuing.
const ${p.ref} = ${NODE_FACTORY_NAME["human-review"]}({
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

const llmNode = (
  p: NodePlan,
  promptName: string,
  inputs: readonly LlmPromptInput[],
  explicitReturnType = true,
): string => {
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
  const node = ${NODE_FACTORY_NAME.llm}({
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
  readonly hasLlm: boolean;
}

const childHasLlm = (node: AuthoredMapNode): boolean =>
  node.child.nodes.some((child) => child.kind === "llm");

const allLlmCount = (dag: AuthoredDag): number =>
  dag.nodes.reduce(
    (count, node) => count + (node.kind === "llm" ? 1 : 0) +
      (node.kind === "map" ? node.child.nodes.filter((child) => child.kind === "llm").length : 0),
    0,
  );

/**
 * Prompt registry name for an llm node: the dag name when it is the only llm
 * node, `<dag>-<node>` otherwise.
 */
const promptNameFor = (dag: AuthoredDag, id: string): string =>
  allLlmCount(dag) === 1 ? dag.name : `${dag.name}-${id}`;

const childPromptNameFor = (dag: AuthoredDag, map: AuthoredMapNode, id: string): string =>
  `${dag.name}-${map.id}@${id}`;

const planNodes = (dag: AuthoredDag): Plans => {
  const byId = new Map<string, NodePlan>();
  for (const node of dag.nodes) {
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
    });
  }
  return {
    byId,
    hasLlm: dag.nodes.some((node) =>
      node.kind === "llm" || (node.kind === "map" && childHasLlm(node)),
    ),
  };
};

const CHILD_LOCAL_PREFIX = "$child_";
const CHILD_MODEL_NAME = "$childModel";
const childLocalName = (name: string): string => `${CHILD_LOCAL_PREFIX}${name}`;

const planChildNodes = (nodes: readonly AuthoredChildNode[]): Map<string, NodePlan> =>
  new Map(nodes.map((node) => [node.id, {
    node,
    outName: childLocalName(schemaConstName(node.id)),
    outSpec: node.kind === "llm" ? withConfidence(node.output) : node.output,
    inExpr: null,
    ref: childLocalName(nodeRefName(node.id, node.kind)),
    llmFactory: node.kind === "llm" ? childLocalName(llmFactoryName(node.id)) : null,
  }] as const));

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

interface ChildEmission {
  readonly declaration: string;
  readonly prompts: readonly PromptFile[];
}

const indent = (value: string, spaces: number): string => {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => line.length === 0 ? line : `${prefix}${line}`).join("\n");
};

const emitChildStructure = (
  child: AuthoredChildDag,
  plans: Map<string, NodePlan>,
  itemSchema: SchemaSpec,
): { readonly expression: string; readonly extras: readonly string[] } => {
  const plan = (id: string): NodePlan => {
    const found = plans.get(id);
    if (found === undefined) throw new Error(`authored map invariant: unknown child node '${id}'`);
    return found;
  };
  const setInput = (id: string, expression: string): void => {
    plans.set(id, { ...plan(id), inExpr: expression });
  };
  const itemExpr = schemaExpr(itemSchema, "  ");
  const extras: string[] = [];
  const ref = (id: string): string => {
    const node = plan(id);
    if (node.node.kind !== "llm") return node.ref;
    if (node.llmFactory === null) {
      throw new Error(`authored map invariant: child LLM '${node.node.id}' has no factory binding`);
    }
    return `${node.llmFactory}(${CHILD_MODEL_NAME})`;
  };

  const expression = match(child.structure)
    .with({ shape: "linear" }, (linear) => {
      let previous = itemExpr;
      for (const id of linear.order) {
        setInput(id, previous);
        previous = effectiveOutName(plan(id));
      }
      return `${SHAPE_HELPER_NAME.linear}({\n  id: ${JSON.stringify(child.id)},\n  nodes: [${linear.order.map(ref).join(", ")}],\n})`;
    })
    .with({ shape: "fan-out" }, { shape: "diamond" }, (fan) => {
      setInput(fan.source, itemExpr);
      const sourceOutput = effectiveOutName(plan(fan.source));
      for (const id of fan.branches) setInput(id, sourceOutput);
      if (fan.join === undefined) {
        throw new Error(`authored map invariant: child '${child.id}' fan-out has no join`);
      }
      const fanInName = childLocalName(fanInConstName(fan.join));
      extras.push(fanInConst(fanInName, fan.branches.map(plan)));
      setInput(fan.join, fanInName);
      return `${SHAPE_HELPER_NAME[fan.shape]}({\n  id: ${JSON.stringify(child.id)},\n  source: ${ref(fan.source)},\n  branches: [${fan.branches.map(ref).join(", ")}],\n  join: ${ref(fan.join)},\n})`;
    })
    .with({ shape: "router" }, (router) => {
      setInput(router.classifier, itemExpr);
      const classifierOutput = effectiveOutName(plan(router.classifier));
      for (const entry of router.cases) setInput(entry.to, classifierOutput);
      setInput(router.default, classifierOutput);
      const cases = router.cases.map((entry) => `    ${key(entry.label)}: {\n      when: (out) => (out as z.infer<typeof ${classifierOutput}>).${entry.when.field} === ${JSON.stringify(entry.when.equals)},\n      to: ${ref(entry.to)},\n    },`).join("\n");
      return `${SHAPE_HELPER_NAME.router}({\n  id: ${JSON.stringify(child.id)},\n  classifier: ${ref(router.classifier)},\n  cases: {\n${cases}\n  },\n  default: ${ref(router.default)},\n})`;
    })
    .with({ shape: "sources" }, (sources) => {
      const joinFanIn = childLocalName(fanInConstName(sources.join));
      extras.push(fanInConst(joinFanIn, sources.sources.map(plan)));
      setInput(sources.join, joinFanIn);
      const assembleFanIn = childLocalName(fanInConstName(sources.assemble));
      extras.push(fanInConst(assembleFanIn, [plan(sources.join)], [["$input", itemExpr]]));
      setInput(sources.assemble, assembleFanIn);
      return `${SHAPE_HELPER_NAME.sources}({\n  id: ${JSON.stringify(child.id)},\n  sources: [${sources.sources.map(ref).join(", ")}],\n  join: ${ref(sources.join)},\n  assemble: ${ref(sources.assemble)},\n})`;
    })
    .exhaustive();

  return { expression, extras };
};

const emitMapNode = (
  dag: AuthoredDag,
  plan: NodePlan,
  node: AuthoredMapNode,
): ChildEmission => {
  if (plan.inExpr === null) {
    throw new Error(`authored map invariant: map node '${node.id}' reached codegen before input wiring`);
  }
  const itemSpec = mapItemSpec(dag, node);
  const childIds = structureRefs(node.child.structure).map(([childId]) => childId);
  const plans = planChildNodes(node.child.nodes);
  const child = emitChildStructure(node.child, plans, itemSpec);
  const declarations: string[] = [];
  for (const id of childIds) {
    const childPlan = plans.get(id);
    if (childPlan?.outSpec !== null && childPlan?.outSpec !== undefined) {
      declarations.push(schemaConst(childPlan.outName, childPlan.outSpec));
    }
  }
  declarations.push(...child.extras);

  const prompts: PromptFile[] = [];
  for (const id of childIds) {
    const childPlan = plans.get(id);
    if (childPlan === undefined) throw new Error(`authored map invariant: unknown child node '${id}'`);
    switch (childPlan.node.kind) {
      case "fetch":
        declarations.push(fetchNode(childPlan, childPlan.node.output));
        break;
      case "source":
        declarations.push(sourceNode(childPlan, childPlan.node.output));
        break;
      case "transform":
        declarations.push(transformNode(childPlan, childPlan.node.output));
        break;
      case "llm": {
        const promptName = childPromptNameFor(dag, node, childPlan.node.id);
        const inputs = llmPromptInputs(
          { input: itemSpec, nodes: node.child.nodes, structure: node.child.structure },
          childPlan,
        );
        declarations.push(llmNode(childPlan, promptName, inputs, false));
        prompts.push(llmPrompt(dag, childPlan.node, promptName, inputs));
        break;
      }
    }
  }

  const parameter = childHasLlm(node) ? `${CHILD_MODEL_NAME}: string` : "";
  const body = declarations.length === 0 ? "" : `${indent(declarations.join("\n\n"), 2)}\n\n`;
  const declaration = `${purposeComment(node)}\nconst ${mapFactoryName(node.id)} = (${parameter}) => {\n${body}  return ${NODE_FACTORY_NAME.map}({\n    id: ${JSON.stringify(node.id)},\n    inputSchema: ${plan.inExpr},\n    widthFrom: ${JSON.stringify(node.widthFrom)},\n    maxWidth: ${node.maxWidth},\n    child: ${child.expression.replace(/\n/g, "\n    ")},\n    childOutputSchema: ${schemaExpr(childOutputSpec(node.child), "    ")},\n    gather: { kind: "collect", field: ${JSON.stringify(node.gather.field)} },\n  });\n};`;
  return { declaration, prompts };
};

/**
 * Build the full `dag.ts` + prompt files from a validated AuthoredDag.
 * Deterministic and pure.
 */
export const buildAuthoredScaffold = (dag: AuthoredDag): AuthoredScaffold => {
  const { byId, hasLlm } = planNodes(dag);
  const plan = (id: string): NodePlan => {
    const p = byId.get(id);
    if (!p) throw new Error(`authored-codegen invariant: unknown node '${id}' (schema validation should have rejected this)`);
    return p;
  };
  const setInput = (id: string, expr: string): void => {
    byId.set(id, { ...plan(id), inExpr: expr });
  };

  const s = dag.structure;
  // One canonical iteration order for EVERY emitted section — parse already
  // canonicalizes `dag.nodes` to this order, but deriving it here keeps the
  // emitted bytes independent of the nodes array even for a value that
  // bypassed the brand (tests) — schema consts, node decls, and prompts can
  // never disagree.
  const orderedIds = structureOrder(dag);
  const schemaDecls: string[] = [schemaConst(INPUT_SCHEMA_NAME, dag.input)];
  const extraDecls: string[] = [];

  // Output schema consts (skip human-review — passthrough)
  for (const id of orderedIds) {
    const p = plan(id);
    if (p.outSpec) schemaDecls.push(schemaConst(p.outName, p.outSpec));
  }

  // Wire inputs per shape + build the structure expression
  const structureExpr: string = match(s)
    .with({ shape: "linear" }, (lin) => {
      let prevSchema: string = INPUT_SCHEMA_NAME;
      for (const id of lin.order) {
        setInput(id, prevSchema);
        prevSchema = effectiveOutName(plan(id));
      }
      return `${SHAPE_HELPER_NAME.linear}({
  id: ${JSON.stringify(dag.name)},
  nodes: [${lin.order.map((id) => nodeExprRef(plan(id))).join(", ")}],
})`;
    })
    .with({ shape: "fan-out" }, { shape: "diamond" }, (fan) => {
      const helper = SHAPE_HELPER_NAME[fan.shape];
      setInput(fan.source, INPUT_SCHEMA_NAME);
      const sourceOut = effectiveOutName(plan(fan.source));
      for (const id of fan.branches) setInput(id, sourceOut);
      let joinPart = "";
      if (fan.join !== undefined) {
        const fanInName = fanInConstName(fan.join);
        extraDecls.push(
          `// The join sees every branch keyed by its node id — keys MUST equal the\n// incoming set (\`fugue lint\` enforces this).`,
          fanInConst(fanInName, fan.branches.map(plan)),
        );
        setInput(fan.join, fanInName);
        joinPart = `\n  join: ${nodeExprRef(plan(fan.join))},`;
      }
      return `${helper}({
  id: ${JSON.stringify(dag.name)},
  source: ${nodeExprRef(plan(fan.source))},
  branches: [${fan.branches.map((id) => nodeExprRef(plan(id))).join(", ")}],${joinPart}
})`;
    })
    .with({ shape: "router" }, (r) => {
      setInput(r.classifier, INPUT_SCHEMA_NAME);
      const classifierOut = effectiveOutName(plan(r.classifier));
      for (const c of r.cases) setInput(c.to, classifierOut);
      setInput(r.default, classifierOut);
      const cases = r.cases
        .map(
          (c) => `    ${key(c.label)}: {
      when: (out) => (out as z.infer<typeof ${classifierOut}>).${c.when.field} === ${JSON.stringify(c.when.equals)},
      to: ${nodeExprRef(plan(c.to))},
    },`,
        )
        .join("\n");
      return `${SHAPE_HELPER_NAME.router}({
  id: ${JSON.stringify(dag.name)},
  classifier: ${nodeExprRef(plan(r.classifier))},
  cases: {
${cases}
  },
  default: ${nodeExprRef(plan(r.default))}, // REQUIRED
})`;
    })
    .with({ shape: "sources" }, (src) => {
      const joinFanIn = fanInConstName(src.join);
      extraDecls.push(
        `// Join: fan-in keyed by the source node ids (\`fugue lint\` checks the key set).`,
        fanInConst(joinFanIn, src.sources.map(plan)),
      );
      setInput(src.join, joinFanIn);
      const assembleFanIn = fanInConstName(src.assemble);
      extraDecls.push(
        `// Assemble: fan-in over the join + the request via the "$input" slot.\n// Declaring "$input" is what makes \`defineSources\` add the DAG_INPUT edge.`,
        fanInConst(assembleFanIn, [plan(src.join)], [["$input", INPUT_SCHEMA_NAME]]),
      );
      setInput(src.assemble, assembleFanIn);
      return `${SHAPE_HELPER_NAME.sources}({
  id: ${JSON.stringify(dag.name)},
  sources: [${src.sources.map((id) => nodeExprRef(plan(id))).join(", ")}],
  join: ${nodeExprRef(plan(src.join))},
  assemble: ${nodeExprRef(plan(src.assemble))},
})`;
    })
    .exhaustive();

  // Node declarations (structure order = declaration order)
  const nodeDecls: string[] = [];
  const prompts: PromptFile[] = [];
  for (const id of orderedIds) {
    const p = plan(id);
    switch (p.node.kind) {
      case "fetch":
        nodeDecls.push(fetchNode(p, p.node.output));
        break;
      case "source":
        nodeDecls.push(sourceNode(p, p.node.output));
        break;
      case "transform":
        nodeDecls.push(transformNode(p, p.node.output));
        break;
      case "human-review":
        nodeDecls.push(humanReviewNode(p));
        break;
      case "llm": {
        const promptName = promptNameFor(dag, p.node.id);
        const inputs = llmPromptInputs(dag, p);
        nodeDecls.push(llmNode(p, promptName, inputs));
        prompts.push(llmPrompt(dag, p.node, promptName, inputs));
        break;
      }
      case "map": {
        const emitted = emitMapNode(dag, p, p.node);
        nodeDecls.push(emitted.declaration);
        prompts.push(...emitted.prompts);
        break;
      }
    }
  }

  const ctx: TemplateCtx = {
    name: dag.name,
    team: dag.team,
    llm: hasLlm,
  };

  const imports = buildImports(dag, hasLlm);
  const header = `// ${dag.name} — ${comment(dag.description)}
//
// Generated deterministically from dag.authored.json (via \`fugue new --from\`
// or \`fugue compose\`). The STRUCTURE is authoritative and integrity-hashed —
// edit dag.authored.json and regenerate rather than rewiring by hand. Node
// bodies between the "@fugue-body" markers are yours to implement: they are
// EXCLUDED from the integrity hash, so filling them in is expected and safe.`;

  const dagBinding = hasLlm
    ? `${llmFactoryPreamble(dag.name)}

${llmDagFactoryOpen(dag.name)}
  ${structureExpr.replace(/\n/g, "\n  ")};`
    : `const ${DAG_CONST_NAME} = ${structureExpr};`;

  const dagTs = [
    header,
    "",
    imports,
    "",
    schemaDecls.join("\n\n"),
    ...(extraDecls.length > 0 ? ["", extraDecls.join("\n")] : []),
    "",
    nodeDecls.join("\n\n"),
    "",
    dagBinding,
    "",
    registration(ctx, hasLlm ? `${dagFactoryName(dag.name)}()` : DAG_CONST_NAME, dag.description),
  ].join("\n");

  return { dagTs, prompts };
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
 * In the LLM factory case the structure references `create<Node>(model)`;
 * everywhere else the plain const.
 */
const nodeExprRef = (plan: NodePlan): string => {
  if (plan.node.kind === "llm") {
    if (plan.llmFactory === null) {
      throw new Error(`authored-codegen invariant: LLM node '${plan.node.id}' has no factory binding`);
    }
    return `${plan.llmFactory}(opts.model ?? ${DEFAULT_MODEL_NAME})`;
  }
  if (plan.node.kind === "map") {
    return childHasLlm(plan.node)
      ? `${mapFactoryName(plan.node.id)}(opts.model ?? ${DEFAULT_MODEL_NAME})`
      : `${mapFactoryName(plan.node.id)}()`;
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
  const s = graph.structure;
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

  switch (s.shape) {
    case "linear": {
      const i = s.order.indexOf(p.node.id);
      // Human-review gates are typed passthroughs — walk back to the nearest
      // predecessor that actually produces fields (mirrors effectiveOutName).
      let j = i - 1;
      while (j >= 0 && byId.get(s.order[j]!)?.kind === "human-review") j--;
      return j < 0 ? direct(graph.input) : fieldsOf(s.order[j]!);
    }
    case "fan-out":
    case "diamond":
      if (p.node.id === s.source) return direct(graph.input);
      if (p.node.id === s.join) return fanIn(s.branches);
      return fieldsOf(s.source);
    case "router":
      return p.node.id === s.classifier ? direct(graph.input) : fieldsOf(s.classifier);
    case "sources":
      if (p.node.id === s.join) return fanIn(s.sources);
      if (p.node.id === s.assemble) return fanIn([s.join, "$input"]);
      return []; // a source node consumes nothing
    default:
      // Keep this switch exhaustive: a newly-added Shape must fail compilation
      // here until its input-field semantics are explicitly implemented.
      return assertNever(s);
  }
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

  // `ok(...)` appears only in generated fetch/transform/source placeholder
  // bodies. The collect-map constructor owns its fixed reducer, while llm and
  // human-review nodes emit no `ok`, so an all-llm map must not import it.
  const needsOk = kinds.some(
    (kind) => kind === "fetch" || kind === "transform" || kind === "source",
  );

  const names = [
    ...(hasLlm ? [FIXED_IMPORT_NAME.confidence] : []),
    ...kinds.map((k) => NODE_FACTORY_NAME[k]),
    ...helpers,
    ...(needsOk ? [FIXED_IMPORT_NAME.ok] : []),
  ].sort();

  return [
    `import { ${FIXED_IMPORT_NAME.zod} } from "zod";`,
    `import {`,
    ...names.map((n) => `  ${n},`),
    `} from "@fuguejs/framework";`,
    ...(hasDirectLlm ? [`import type { ${FIXED_IMPORT_NAME.llmNodeDefType} } from "@fuguejs/framework";`] : []),
    `import type { ${FIXED_IMPORT_NAME.dagRegistrationType} } from "@fuguejs/host/contract";`,
  ].join("\n");
};
