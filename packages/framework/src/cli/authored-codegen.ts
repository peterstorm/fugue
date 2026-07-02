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
// Node input schemas are DERIVED from the topology, not authored:
//   linear    — node i consumes node i-1's output (first consumes the input)
//   fan-out/  — source consumes the input; branches consume the source;
//   diamond     the join consumes a fan-in keyed by branch ids
//   router    — classifier consumes the input; handlers consume its output
//   sources   — sources consume nothing; join consumes a fan-in keyed by
//               source ids; assemble consumes { join, $input }

import { match } from "ts-pattern";
import type {
  AuthoredDag,
  AuthoredNode,
  FieldSpec,
  FieldType,
  SchemaSpec,
} from "./authored.js";
import {
  DEFAULT_MODEL,
  llmConfidenceReturn,
  registration,
  type PromptFile,
  type TemplateCtx,
} from "./new-templates.js";
import { camelCase, pascalCase } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const key = (name: string): string => (IDENT.test(name) ? name : JSON.stringify(name));

/**
 * Every free-text interpolation into a `//` comment goes through here: a
 * newline in the text would otherwise break out of the comment into code
 * position. The authoring schema already rejects multi-line purpose /
 * description fields — this is the defense-in-depth at the emission site.
 */
const comment = (text: string): string => text.replace(/[\r\n]+/g, " ");

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

const CONFIDENCE_FIELD: FieldSpec = {
  name: "confidence",
  type: { kind: "enum", values: ["high", "medium", "low"] },
};

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
  /** Effective output spec (LLM nodes get confidence injected). */
  readonly outSpec: SchemaSpec | null;
  /** Expression for the node's input schema const; null for source nodes. */
  readonly inExpr: string | null;
  /** For LLM nodes: the prompt registry name. */
  readonly promptName?: string;
  /**
   * Var identifier referenced in the structure call. DEAD for llm nodes —
   * `nodeExprRef` calls the factory (`create<Pascal>(model)`) instead of a
   * bound const, so the `<camel>Node` value assigned here never reaches the
   * emitted file (it is still claimed by `generatedIdentifiersFor`; see the
   * rationale there).
   */
  readonly ref: string;
}

const purposeComment = (node: AuthoredNode): string => `// ${node.id} — ${comment(node.purpose)}`;

const fetchNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = createFetchNode({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  // Placeholder — implement the real fetch for: ${comment(p.node.purpose)}
  fetch: async (_input) =>
    ok({
${defaultsObject(p.outSpec!, "      ")}
    }),
});`;

const sourceNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = createSourceNode({
  id: ${JSON.stringify(p.node.id)},
  outputSchema: ${p.outName},
  // Placeholder — implement the real fetch for: ${comment(p.node.purpose)}
  fetch: async () =>
    ok({
${defaultsObject(p.outSpec!, "      ")}
    }),
});`;

const transformNode = (p: NodePlan): string => `${purposeComment(p.node)}
const ${p.ref} = createTransformNode({
  id: ${JSON.stringify(p.node.id)},
  inputSchema: ${p.inExpr},
  outputSchema: ${p.outName},
  // Placeholder — map the real values for: ${comment(p.node.purpose)}
  transform: (_input) =>
    ok({
${defaultsObject(p.outSpec!, "      ")}
    }),
});`;

const humanReviewNode = (p: NodePlan): string => `${purposeComment(p.node)}
// Human-review gate: the run SUSPENDS here and waits for a decision
// (approve / reject / approve-with-edit / reroute) before continuing.
const ${p.ref} = createHumanReviewNode({
  id: ${JSON.stringify(p.node.id)},
  schema: ${p.inExpr},
  prompt: ${JSON.stringify(`Approve: ${p.node.purpose}?`)},
});`;

/** Prompt placeholders must be identifier-ish — sanitize fan-in keys. */
const placeholderName = (fieldKey: string): string => fieldKey.replace(/[^A-Za-z0-9_]/g, "_");

const llmNode = (p: NodePlan, inputFields: readonly string[], fanIn: boolean): string => {
  // Fan-in inputs are OBJECTS keyed by node id — stringify them so the prompt
  // placeholder receives JSON, not "[object Object]".
  const buildInputEntries = inputFields
    .map((f) =>
      fanIn
        ? `${key(placeholderName(f))}: JSON.stringify(input[${JSON.stringify(f)}])`
        : `${key(placeholderName(f))}: input[${JSON.stringify(f)}]`,
    )
    .join(", ");
  const factoryName = `create${pascalCase(p.node.id)}`;
  return `${purposeComment(p.node)}
const ${factoryName} = (
  model: string,
): LlmNodeDef<z.infer<typeof ${p.inExpr}>, z.infer<typeof ${p.outName}>> => {
  const node = createLlmNode({
    id: ${JSON.stringify(p.node.id)},
    inputSchema: ${p.inExpr},
    outputSchema: ${p.outName},
    promptName: ${JSON.stringify(p.promptName)},
    model,
    buildInput: (input) => ({ ${buildInputEntries} }),
  });
${llmConfidenceReturn}
};`;
};

const llmPrompt = (
  dag: AuthoredDag,
  node: AuthoredNode,
  promptName: string,
  inputFields: readonly string[],
  fanIn: boolean,
): PromptFile => {
  const vars = inputFields
    .map((f) => `${placeholderName(f)}${fanIn ? " (JSON)" : ""}: {{${placeholderName(f)}}}`)
    .join("\n");
  const outSpec = withConfidence(node.output!);
  const jsonShape = outSpec.fields
    .map((f) =>
      f.type.kind === "enum"
        ? `"${f.name}": ${f.type.values.map((v) => `"${v}"`).join(" | ")}`
        : `"${f.name}": ${f.type.kind}`,
    )
    .join(", ");
  return {
    name: promptName,
    body: `You are a node in the ${dag.name} pipeline. Task: ${node.purpose}

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

const planNodes = (dag: AuthoredDag): Plans => {
  const llmNodes = dag.nodes.filter((n) => n.kind === "llm");
  const byId = new Map<string, NodePlan>();
  for (const node of dag.nodes) {
    const outSpec = node.output ? (node.kind === "llm" ? withConfidence(node.output) : node.output) : null;
    const promptName =
      node.kind === "llm"
        ? llmNodes.length === 1
          ? dag.name
          : `${dag.name}-${node.id}`
        : undefined;
    byId.set(node.id, {
      node,
      outName: `${pascalCase(node.id)}Schema`,
      outSpec,
      inExpr: null, // filled by wiring
      ...(promptName !== undefined ? { promptName } : {}),
      ref: node.kind === "llm" ? `${camelCase(node.id)}Node` : camelCase(node.id),
    });
  }
  return { byId, hasLlm: llmNodes.length > 0 };
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
 * typed passthroughs).
 */
const effectiveOutName = (p: NodePlan): string =>
  p.node.kind === "human-review" ? (p.inExpr ?? "z.never()") : p.outName;

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
  const schemaDecls: string[] = [schemaConst("InputSchema", dag.input)];
  const extraDecls: string[] = [];

  // Output schema consts (skip human-review — passthrough)
  for (const node of dag.nodes) {
    const p = plan(node.id);
    if (p.outSpec) schemaDecls.push(schemaConst(p.outName, p.outSpec));
  }

  // Wire inputs per shape + build the structure expression
  const structureExpr: string = match(s)
    .with({ shape: "linear" }, (lin) => {
      let prevSchema = "InputSchema";
      for (const id of lin.order) {
        setInput(id, prevSchema);
        prevSchema = effectiveOutName(plan(id));
      }
      return `defineLinearDag({
  id: ${JSON.stringify(dag.name)},
  nodes: [${lin.order.map((id) => nodeExprRef(plan(id))).join(", ")}],
})`;
    })
    .with({ shape: "fan-out" }, { shape: "diamond" }, (fan) => {
      const helper = fan.shape === "diamond" ? "defineDiamond" : "defineFanOut";
      setInput(fan.source, "InputSchema");
      const sourceOut = effectiveOutName(plan(fan.source));
      for (const id of fan.branches) setInput(id, sourceOut);
      let joinPart = "";
      if (fan.join !== undefined) {
        const fanInName = `${pascalCase(fan.join)}FanIn`;
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
      setInput(r.classifier, "InputSchema");
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
      return `defineRouter({
  id: ${JSON.stringify(dag.name)},
  classifier: ${nodeExprRef(plan(r.classifier))},
  cases: {
${cases}
  },
  default: ${nodeExprRef(plan(r.default))}, // REQUIRED
})`;
    })
    .with({ shape: "sources" }, (src) => {
      const joinFanIn = `${pascalCase(src.join)}FanIn`;
      extraDecls.push(
        `// Join: fan-in keyed by the source node ids (\`fugue lint\` checks the key set).`,
        fanInConst(joinFanIn, src.sources.map(plan)),
      );
      setInput(src.join, joinFanIn);
      const assembleFanIn = `${pascalCase(src.assemble)}FanIn`;
      extraDecls.push(
        `// Assemble: fan-in over the join + the request via the "$input" slot.\n// Declaring "$input" is what makes \`defineSources\` add the DAG_INPUT edge.`,
        fanInConst(assembleFanIn, [plan(src.join)], [["$input", "InputSchema"]]),
      );
      setInput(src.assemble, assembleFanIn);
      return `defineSources({
  id: ${JSON.stringify(dag.name)},
  sources: [${src.sources.map((id) => nodeExprRef(plan(id))).join(", ")}],
  join: ${nodeExprRef(plan(src.join))},
  assemble: ${nodeExprRef(plan(src.assemble))},
})`;
    })
    .exhaustive();

  // Node declarations (structure order = declaration order)
  const orderedIds = structureOrder(dag);
  const nodeDecls: string[] = [];
  const prompts: PromptFile[] = [];
  for (const id of orderedIds) {
    const p = plan(id);
    switch (p.node.kind) {
      case "fetch":
        nodeDecls.push(fetchNode(p));
        break;
      case "source":
        nodeDecls.push(sourceNode(p));
        break;
      case "transform":
        nodeDecls.push(transformNode(p));
        break;
      case "human-review":
        nodeDecls.push(humanReviewNode(p));
        break;
      case "llm": {
        const inputFields = llmInputFields(dag, p);
        const fanIn = llmInputIsFanIn(dag, p);
        nodeDecls.push(llmNode(p, inputFields, fanIn));
        prompts.push(llmPrompt(dag, p.node, p.promptName!, inputFields, fanIn));
        break;
      }
    }
  }

  const ctx: TemplateCtx = {
    name: dag.name,
    team: dag.team,
    pascal: pascalCase(dag.name),
    llm: hasLlm,
  };

  const imports = buildImports(dag, hasLlm);
  const header = `// ${dag.name} — ${comment(dag.description)}
//
// Generated deterministically from dag.authored.json (via \`fugue new --from\`
// or \`fugue compose\`). The STRUCTURE is authoritative — edit
// dag.authored.json and regenerate rather than rewiring by hand. Node bodies
// marked "Placeholder" are yours to implement.`;

  const dagBinding = hasLlm
    ? `export interface ${ctx.pascal}DagOpts {
  /** Model seam; defaults to a current id. Tests pass a fake id + FakeLlmClient. */
  readonly model?: string;
}

const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};

export const create${ctx.pascal}Dag = (opts: ${ctx.pascal}DagOpts = {}) =>
  ${structureExpr.replace(/\n/g, "\n  ")};`
    : `const dag = ${structureExpr};`;

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
    registration(ctx, hasLlm ? `create${ctx.pascal}Dag()` : "dag", dag.description),
  ].join("\n");

  return { dagTs, prompts };
};

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

/** Structure roles in dependency order, so declarations always precede use. */
const structureOrder = (dag: AuthoredDag): readonly string[] =>
  match(dag.structure)
    .with({ shape: "linear" }, (s) => s.order)
    .with({ shape: "fan-out" }, { shape: "diamond" }, (s) => [
      s.source,
      ...s.branches,
      ...(s.join !== undefined ? [s.join] : []),
    ])
    .with({ shape: "router" }, (s) => [s.classifier, ...s.cases.map((c) => c.to), s.default])
    .with({ shape: "sources" }, (s) => [...s.sources, s.join, s.assemble])
    .exhaustive();

/**
 * In the LLM factory case the structure references `create<Node>(model)`;
 * everywhere else the plain const.
 */
const nodeExprRef = (p: NodePlan): string =>
  p.node.kind === "llm" ? `create${pascalCase(p.node.id)}(opts.model ?? DEFAULT_MODEL)` : p.ref;

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
  const fieldsOf = (id: string): readonly string[] => byId.get(id)?.output?.fields.map((f) => f.name) ?? [];

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
  }
};

const buildImports = (dag: AuthoredDag, hasLlm: boolean): string => {
  const kinds = new Set(dag.nodes.map((n) => n.kind));
  const helper = match(dag.structure.shape)
    .with("linear", () => "defineLinearDag")
    .with("fan-out", () => "defineFanOut")
    .with("diamond", () => "defineDiamond")
    .with("router", () => "defineRouter")
    .with("sources", () => "defineSources")
    .exhaustive();

  const names = [
    ...(hasLlm ? ["confidence"] : []),
    ...(kinds.has("fetch") ? ["createFetchNode"] : []),
    ...(kinds.has("human-review") ? ["createHumanReviewNode"] : []),
    ...(kinds.has("llm") ? ["createLlmNode"] : []),
    ...(kinds.has("source") ? ["createSourceNode"] : []),
    ...(kinds.has("transform") ? ["createTransformNode"] : []),
    helper,
    "ok",
  ].sort();

  return [
    `import { z } from "zod";`,
    `import {`,
    ...names.map((n) => `  ${n},`),
    `} from "@fuguejs/framework";`,
    ...(hasLlm ? [`import type { LlmNodeDef } from "@fuguejs/framework";`] : []),
    `import type { DagRegistration } from "@fuguejs/host/contract";`,
  ].join("\n");
};
