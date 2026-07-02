// AuthoredDag — the authoring-direction DAG description (deterministic-core
// convergence, Phase B1).
//
// `DescribedDag` is DERIVED from code (`fugue describe`); `AuthoredDag` is the
// superset an author (human or LLM) writes BEFORE code exists. It carries the
// intent `DescribedDag` cannot: per-node `purpose`, field-level output specs,
// and routing cases as data. `fugue new --from <authored.json>` turns it into
// code deterministically; `fugue compose` lets an LLM edit ONLY this JSON —
// the LLM never hand-writes `defineDag`.
//
// The schema is deliberately CLOSED: field types are a fixed union, routing
// predicates are `{ field, equals }` on an enum — no expression language.
// Everything here is Zod-parsed (parse, don't validate) and cross-checked
// with `superRefine` so an `AuthoredDag` value that exists is buildable.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Field / schema specs (closed vocabulary)
// ---------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A field name must be a valid JS identifier so codegen can emit dotted access.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const FieldTypeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string") }).strict(),
  z.object({ kind: z.literal("number") }).strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
  z
    .object({ kind: z.literal("enum"), values: z.array(z.string().min(1)).min(2) })
    .strict(),
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldSpecSchema = z
  .object({
    name: z.string().regex(IDENT, "field name must be a JS identifier"),
    type: FieldTypeSchema,
    description: z.string().min(1).optional(),
  })
  .strict();
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const SchemaSpecSchema = z
  .object({ fields: z.array(FieldSpecSchema).min(1) })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const f of spec.fields) {
      if (seen.has(f.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field name '${f.name}'` });
      }
      seen.add(f.name);
    }
  });
export type SchemaSpec = z.infer<typeof SchemaSpecSchema>;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export const NODE_KINDS = ["fetch", "transform", "llm", "human-review", "source"] as const;

export const AuthoredNodeSchema = z
  .object({
    id: z.string().regex(KEBAB, "node id must be kebab-case"),
    kind: z.enum(NODE_KINDS),
    /** What this node is for — the authoring intent DescribedDag can't carry. */
    purpose: z.string().min(1),
    /**
     * Output field spec. Omitted ONLY for human-review nodes (a review gate is
     * a typed passthrough over the reviewed node's schema).
     */
    output: SchemaSpecSchema.optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if (node.kind === "human-review" && node.output !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `human-review node '${node.id}' must not declare output (it passes through the reviewed schema)`,
      });
    }
    if (node.kind !== "human-review" && node.output === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `node '${node.id}' (${node.kind}) requires an output spec`,
      });
    }
  });
export type AuthoredNode = z.infer<typeof AuthoredNodeSchema>;

// ---------------------------------------------------------------------------
// Structure (one variant per DAG shape; mirrors the define* helpers)
// ---------------------------------------------------------------------------

const nodeRef = z.string().regex(KEBAB);

export const RouterCaseSchema = z
  .object({
    label: z.string().regex(KEBAB, "case label must be kebab-case"),
    /** Closed predicate: classifier output `field` equals `equals`. */
    when: z.object({ field: z.string().regex(IDENT), equals: z.string().min(1) }).strict(),
    to: nodeRef,
  })
  .strict();
export type RouterCase = z.infer<typeof RouterCaseSchema>;

export const StructureSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("linear"), order: z.array(nodeRef).min(2) }).strict(),
  z
    .object({
      shape: z.literal("fan-out"),
      source: nodeRef,
      branches: z.array(nodeRef).min(2),
      join: nodeRef.optional(),
    })
    .strict(),
  z
    .object({
      shape: z.literal("diamond"),
      source: nodeRef,
      branches: z.array(nodeRef).min(2),
      join: nodeRef,
    })
    .strict(),
  z
    .object({
      shape: z.literal("router"),
      classifier: nodeRef,
      cases: z.array(RouterCaseSchema).min(1),
      default: nodeRef,
    })
    .strict(),
  z
    .object({
      shape: z.literal("sources"),
      sources: z.array(nodeRef).min(2),
      join: nodeRef,
      assemble: nodeRef,
    })
    .strict(),
]);
export type AuthoredStructure = z.infer<typeof StructureSchema>;

// ---------------------------------------------------------------------------
// The AuthoredDag
// ---------------------------------------------------------------------------

const BaseAuthoredDagSchema = z
  .object({
    /** Format discriminator + version for forward evolution. */
    fugueAuthored: z.literal(1),
    name: z.string().regex(KEBAB, "name must be kebab-case"),
    team: z.string().regex(KEBAB, "team must be kebab-case"),
    description: z.string().min(1),
    /** DAG input schema (the request). */
    input: SchemaSpecSchema,
    nodes: z.array(AuthoredNodeSchema).min(1),
    structure: StructureSchema,
  })
  .strict();

/** Node ids referenced by a structure, with the role each plays. */
const structureRefs = (s: AuthoredStructure): ReadonlyArray<readonly [string, string]> => {
  switch (s.shape) {
    case "linear":
      return s.order.map((id, i) => [id, `order[${i}]`] as const);
    case "fan-out":
    case "diamond":
      return [
        [s.source, "source"] as const,
        ...s.branches.map((id, i) => [id, `branches[${i}]`] as const),
        ...(s.join !== undefined ? [[s.join, "join"] as const] : []),
      ];
    case "router":
      return [
        [s.classifier, "classifier"] as const,
        ...s.cases.map((c, i) => [c.to, `cases[${i}].to`] as const),
        [s.default, "default"] as const,
      ];
    case "sources":
      return [
        ...s.sources.map((id, i) => [id, `sources[${i}]`] as const),
        [s.join, "join"] as const,
        [s.assemble, "assemble"] as const,
      ];
  }
};

const camelOf = (kebab: string): string => {
  const pascal = kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

/**
 * Identifiers the generated `dag.ts` imports or declares. A node id whose
 * camelCase form lands here would produce a duplicate declaration. The
 * validation gauntlet (codegen → import) would also catch these, but
 * rejecting at parse time gives the author/LLM a precise message instead of
 * a duplicate-declaration SyntaxError.
 */
const RESERVED_IDENTIFIERS = new Set([
  "dag", "input", "registration", "z", "ok", "confidence",
  "createFetchNode", "createTransformNode", "createLlmNode",
  "createHumanReviewNode", "createSourceNode",
  "defineLinearDag", "defineFanOut", "defineDiamond", "defineRouter", "defineSources",
]);

export const AuthoredDagSchema = BaseAuthoredDagSchema.superRefine((dag, ctx) => {
  const byId = new Map(dag.nodes.map((n) => [n.id, n] as const));

  for (const n of dag.nodes) {
    if (RESERVED_IDENTIFIERS.has(camelOf(n.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node id '${n.id}' is reserved (collides with generated identifiers)` });
    }
  }

  // Node ids unique
  if (byId.size !== dag.nodes.length) {
    const seen = new Set<string>();
    for (const n of dag.nodes) {
      if (seen.has(n.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate node id '${n.id}'` });
      }
      seen.add(n.id);
    }
  }

  // Every structure reference resolves; every node is referenced exactly once.
  const refs = structureRefs(dag.structure);
  const referenced = new Map<string, number>();
  for (const [id, role] of refs) {
    if (!byId.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `structure ${role} references unknown node '${id}'` });
    }
    referenced.set(id, (referenced.get(id) ?? 0) + 1);
  }
  for (const [id, count] of referenced) {
    if (count > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${id}' is referenced ${count} times in the structure (each node plays exactly one role)` });
    }
  }
  for (const n of dag.nodes) {
    if (!referenced.has(n.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${n.id}' is not referenced by the structure` });
    }
  }

  // Kind constraints per shape role
  const s = dag.structure;
  const kindOf = (id: string) => byId.get(id)?.kind;

  if (s.shape === "sources") {
    for (const id of s.sources) {
      if (byId.has(id) && kindOf(id) !== "source") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sources entry '${id}' must be kind "source" (got "${kindOf(id)}")` });
      }
    }
    if (byId.has(s.assemble) && kindOf(s.assemble) === "source") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `assemble '${s.assemble}' must not be a source node` });
    }
  } else {
    // Source nodes are only valid roots of the sources shape.
    for (const n of dag.nodes) {
      if (n.kind === "source") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${n.id}' is kind "source" but shape is "${s.shape}" — source nodes belong to the sources shape` });
      }
    }
  }

  // Human-review gates: linear only (matches `fugue new --review`), never first.
  for (const n of dag.nodes) {
    if (n.kind !== "human-review") continue;
    if (s.shape !== "linear") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `human-review node '${n.id}' requires shape "linear" (gate other shapes by hand with withHumanReview)` });
    } else if (s.order[0] === n.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `human-review node '${n.id}' cannot be the first node (it reviews a predecessor's output)` });
    }
  }

  // Router: classifier's output must carry the predicate field as an enum, and
  // every `equals` must be one of its values; the default handler catches the rest.
  if (s.shape === "router") {
    const classifier = byId.get(s.classifier);
    const fields = classifier?.output?.fields ?? [];
    for (const [i, c] of s.cases.entries()) {
      const field = fields.find((f) => f.name === c.when.field);
      if (!field) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${i}] predicate field '${c.when.field}' is not a field of classifier '${s.classifier}' output` });
        continue;
      }
      if (field.type.kind !== "enum") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${i}] predicate field '${c.when.field}' must be an enum (got ${field.type.kind}) — closed routing only` });
        continue;
      }
      if (!field.type.values.includes(c.when.equals)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${i}] 'equals: ${c.when.equals}' is not a value of enum '${c.when.field}' (${field.type.values.join(", ")})` });
      }
    }
    const labels = new Set<string>();
    for (const [i, c] of s.cases.entries()) {
      if (labels.has(c.label)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${i}] duplicate label '${c.label}'` });
      }
      labels.add(c.label);
    }
  }
});
export type AuthoredDag = z.infer<typeof BaseAuthoredDagSchema>;

// ---------------------------------------------------------------------------
// Parse entry points
// ---------------------------------------------------------------------------

export type AuthoredParseResult =
  | { readonly ok: true; readonly dag: AuthoredDag }
  | { readonly ok: false; readonly problems: readonly string[] };

const issuesToProblems = (issues: readonly z.ZodIssue[]): string[] =>
  issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));

export const parseAuthoredDag = (raw: unknown): AuthoredParseResult => {
  const parsed = AuthoredDagSchema.safeParse(raw);
  if (parsed.success) return { ok: true, dag: parsed.data };
  return { ok: false, problems: issuesToProblems(parsed.error.issues) };
};

export const parseAuthoredDagJson = (json: string): AuthoredParseResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, problems: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return parseAuthoredDag(raw);
};
