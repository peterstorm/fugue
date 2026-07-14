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
import { structureRefs } from "./authored.js";
import type {
  AuthoredDag,
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

const zodExpr = (t: FieldType): string =>
  match(t)
    .with({ kind: "string" }, () => "z.string()")
    .with({ kind: "number" }, () => "z.number()")
    .with({ kind: "boolean" }, () => "z.boolean()")
    .with({ kind: "enum" }, (e) => `z.enum([${e.values.map((v) => JSON.stringify(v)).join(", ")}])`)
    .exhaustive();

const defaultExpr = (t: FieldType): string =>
  match(t)
    .with({ kind: "string" }, () => '"todo"')
    .with({ kind: "number" }, () => "0")
    .with({ kind: "boolean" }, () => "false")
    .with({ kind: "enum" }, (e) => JSON.stringify(e.values[0]))
    .exhaustive();

/** LLM node outputs always carry bucketed confidence (the framework idiom). */
const withConfidence = (spec: SchemaSpec): SchemaSpec =>
  spec.fields.some((f) => f.name === "confidence")
    ? spec
    : { fields: [...spec.fields, CONFIDENCE_FIELD] };

const schemaConst = (name: string, spec: SchemaSpec): string => {
  const fields = spec.fields
    .map((f) => `  ${key(f.name)}: ${zodExpr(f.type)},${f.description ? ` // ${comment(f.description)}` : ""}`)
    .join("\n");
  return `const ${name} = z.object({\n${fields}\n});`;
};

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
  /**
   * Var identifier referenced in the structure call (`nodeRefName`). DEAD for
   * llm nodes — `nodeExprRef` calls the factory (`llmFactoryName(id)(model)`)
   * instead of a bound const, so the `llmNodeRefName` value assigned here
   * never reaches the emitted file (it is still claimed by
   * `generatedIdentifiersFor`; see the rationale on `llmNodeRefName`).
   */
  readonly ref: string;
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

const llmNode = (p: NodePlan, promptName: string, inputFields: readonly string[], fanIn: boolean): string => {
  // Fan-in inputs are OBJECTS keyed by node id — stringify them so the prompt
  // placeholder receives JSON, not "[object Object]".
  const buildInputEntries = inputFields
    .map((f) =>
      fanIn
        ? `${key(placeholderName(f))}: JSON.stringify(input[${JSON.stringify(f)}])`
        : `${key(placeholderName(f))}: input[${JSON.stringify(f)}]`,
    )
    .join(", ");
  return `${purposeComment(p.node)}
const ${llmFactoryName(p.node.id)} = (
  model: string,
): LlmNodeDef<z.infer<typeof ${p.inExpr}>, z.infer<typeof ${p.outName}>> => {
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
  inputFields: readonly string[],
  fanIn: boolean,
): PromptFile => {
  const vars = inputFields
    .map((f) => `${placeholderName(f)}${fanIn ? " (JSON)" : ""}: {{${placeholderName(f)}}}`)
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

export interface AuthoredScaffold {
  readonly dagTs: string;
  readonly prompts: readonly PromptFile[];
}

interface Plans {
  readonly byId: Map<string, NodePlan>;
  readonly hasLlm: boolean;
}

/**
 * Prompt registry name for an llm node: the dag name when it is the only llm
 * node, `<dag>-<node>` otherwise.
 */
const promptNameFor = (dag: AuthoredDag, id: string): string =>
  dag.nodes.filter((n) => n.kind === "llm").length === 1 ? dag.name : `${dag.name}-${id}`;

const planNodes = (dag: AuthoredDag): Plans => {
  const byId = new Map<string, NodePlan>();
  for (const node of dag.nodes) {
    const outSpec = match(node)
      .with({ kind: "human-review" }, () => null)
      .with({ kind: "llm" }, (n) => withConfidence(n.output))
      .otherwise((n) => n.output);
    byId.set(node.id, {
      node,
      outName: schemaConstName(node.id),
      outSpec,
      inExpr: null, // filled by wiring
      ref: nodeRefName(node.id, node.kind),
    });
  }
  return { byId, hasLlm: dag.nodes.some((n) => n.kind === "llm") };
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
        const inputFields = llmInputFields(dag, p);
        const fanIn = llmInputIsFanIn(dag, p);
        nodeDecls.push(llmNode(p, promptName, inputFields, fanIn));
        prompts.push(llmPrompt(dag, p.node, promptName, inputFields, fanIn));
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
const nodeExprRef = (p: NodePlan): string =>
  p.node.kind === "llm" ? `${llmFactoryName(p.node.id)}(opts.model ?? ${DEFAULT_MODEL_NAME})` : p.ref;

/**
 * Whether an LLM node's derived input is a fan-in object (keys = node ids /
 * `$input`) rather than a predecessor's flat fields. Fan-in values are
 * objects, so `buildInput` must JSON.stringify them for the prompt.
 */
const llmInputIsFanIn = (dag: AuthoredDag, p: NodePlan): boolean =>
  match(dag.structure)
    .with({ shape: "fan-out" }, { shape: "diamond" }, (s) => s.join === p.node.id)
    .with({ shape: "sources" }, (s) => s.join === p.node.id || s.assemble === p.node.id)
    .with({ shape: "linear" }, { shape: "router" }, () => false)
    .exhaustive();

/** Top-level input keys an LLM node's buildInput/prompt can reference. */
const llmInputFields = (dag: AuthoredDag, p: NodePlan): readonly string[] => {
  const s = dag.structure;
  const byId = new Map(dag.nodes.map((n) => [n.id, n] as const));
  // Human-review gates have no output variant — they contribute no fields here
  // (the linear walk below skips past them to the real producer anyway).
  const fieldsOf = (id: KebabIdent): readonly string[] => {
    const n = byId.get(id);
    return n === undefined || n.kind === "human-review" ? [] : n.output.fields.map((f) => f.name);
  };

  switch (s.shape) {
    case "linear": {
      const i = s.order.indexOf(p.node.id);
      // Human-review gates are typed passthroughs — walk back to the nearest
      // predecessor that actually produces fields (mirrors effectiveOutName).
      let j = i - 1;
      while (j >= 0 && byId.get(s.order[j]!)?.kind === "human-review") j--;
      return j < 0 ? dag.input.fields.map((f) => f.name) : fieldsOf(s.order[j]!);
    }
    case "fan-out":
    case "diamond":
      if (p.node.id === s.source) return dag.input.fields.map((f) => f.name);
      if (p.node.id === s.join) return s.branches; // fan-in keys
      return fieldsOf(s.source);
    case "router":
      return p.node.id === s.classifier
        ? dag.input.fields.map((f) => f.name)
        : fieldsOf(s.classifier);
    case "sources":
      if (p.node.id === s.join) return s.sources; // fan-in keys
      if (p.node.id === s.assemble) return [s.join, "$input"];
      return []; // a source node consumes nothing
    default:
      // `noImplicitReturns` is off, so without this a newly-added Shape would
      // silently fall through to `undefined` and crash downstream on `.map`.
      // Match every sibling walker in this file: fail exhaustively at compile time.
      return assertNever(s);
  }
};

// Every import name comes from the `identifiers.ts` catalogue
// (`FIXED_IMPORT_NAME` / `NODE_FACTORY_NAME` / `SHAPE_HELPER_NAME`), the same
// sets `RESERVED_IDENTIFIERS` is built from — an import this function emits is
// reserved at parse time by construction.
const buildImports = (dag: AuthoredDag, hasLlm: boolean): string => {
  const kinds = [...new Set(dag.nodes.map((n) => n.kind))];
  const helper = SHAPE_HELPER_NAME[dag.structure.shape];

  // `ok(...)` appears only in the placeholder fetch/transform/source bodies —
  // llm factories return through the confidence spread and human-review gates
  // have no body — so an all-llm/review DAG must not import it (mirrors the
  // `confidence`/hasLlm gating; an unused import is lint noise in every
  // generated module).
  const needsOk = dag.nodes.some(
    (n) => n.kind === "fetch" || n.kind === "transform" || n.kind === "source",
  );

  const names = [
    ...(hasLlm ? [FIXED_IMPORT_NAME.confidence] : []),
    ...kinds.map((k) => NODE_FACTORY_NAME[k]),
    helper,
    ...(needsOk ? [FIXED_IMPORT_NAME.ok] : []),
  ].sort();

  return [
    `import { ${FIXED_IMPORT_NAME.zod} } from "zod";`,
    `import {`,
    ...names.map((n) => `  ${n},`),
    `} from "@fuguejs/framework";`,
    ...(hasLlm ? [`import type { ${FIXED_IMPORT_NAME.llmNodeDefType} } from "@fuguejs/framework";`] : []),
    `import type { ${FIXED_IMPORT_NAME.dagRegistrationType} } from "@fuguejs/host/contract";`,
  ].join("\n");
};
