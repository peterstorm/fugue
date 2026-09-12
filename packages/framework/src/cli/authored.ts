// AuthoredDag — the authoring-direction DAG description (deterministic-core
// convergence, Phase B1).
//
// `DescribedDag` is DERIVED from code (`fugue describe`); `AuthoredDag` is the
// complementary representation an author (human or LLM) writes BEFORE code
// exists. It carries intent `DescribedDag` cannot: per-node `purpose`,
// field-level output specs, and routing cases as data.
// `fugue new --from <authored.json>` turns it into code deterministically;
// `fugue compose` lets an LLM edit ONLY this JSON —
// the LLM never hand-writes `defineDag`.
//
// The schema is deliberately CLOSED: field types are a fixed union, routing
// predicates are `{ field, equals }` on an enum — no expression language.
// Everything here is Zod-parsed (parse, don't validate) and cross-checked
// with `superRefine` so an `AuthoredDag` value that exists is buildable.
// The exported `AuthoredDag` type is BRANDED: `parseAuthoredDag` /
// `parseAuthoredDagJson` are the only producers, so every consumer
// (codegen, gauntlet, scaffold writer) is guaranteed a value that already
// passed every refinement — no structurally-shaped impostors.

import { z } from "zod";
import { safeErrorMessage } from "../types/safe-error.js";
import {
  FUGUE_BODY_MARKER,
  IDENT,
  JS_RESERVED_WORDS,
  RESERVED_IDENTIFIERS,
  SINGLE_LINE,
  TEMPLATE_OPEN,
  camelCase,
  dagLevelIdentifiers,
  generatedIdentifiersFor,
  parseKebab,
  parseKebabIdent,
  type KebabIdent,
} from "./identifiers.js";
import { assertNever } from "./types.js";
import type { Shape } from "./new-templates.js";
import { CONFIDENCE_BUCKET, CONFIDENCE_FIELD } from "./vocabulary.js";

type DeepReadonly<T> =
  T extends string | number | boolean | bigint | symbol | null | undefined ? T
    : T extends (...args: never[]) => unknown ? T
      : T extends readonly unknown[] ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
          : T;

/**
 * Keep recursive Zod parsing and owned freezing below the JavaScript call-stack
 * ceiling. Cycles are programmatic-only (not JSON), so they are refused at the
 * same wire boundary rather than entering recursive schemas.
 */
const MAX_AUTHORED_VALUE_DEPTH = 64;

type AuthoredValueWalk =
  | { readonly kind: "enter"; readonly value: unknown; readonly depth: number }
  | { readonly kind: "leave"; readonly value: object };

const authoredValueProblem = (raw: unknown): string | undefined => {
  const active = new WeakSet<object>();
  const pending: AuthoredValueWalk[] = [{ kind: "enter", value: raw, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "leave") {
      active.delete(current.value);
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (current.depth > MAX_AUTHORED_VALUE_DEPTH) {
      return `authored DAG exceeds the maximum supported value depth of ${MAX_AUTHORED_VALUE_DEPTH}`;
    }
    if (active.has(current.value)) return "authored DAG must be an acyclic JSON value";
    active.add(current.value);
    pending.push({ kind: "leave", value: current.value });
    for (const key of Object.keys(current.value)) {
      pending.push({
        kind: "enter",
        value: (current.value as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Field / schema specs (closed vocabulary)
// ---------------------------------------------------------------------------

// The lexical rules (KEBAB / KEBAB_IDENT / IDENT) are single-sourced in
// `identifiers.ts` — the same copies `compose.ts` / `new.ts` arg parsing and
// `authored-codegen.ts` key emission enforce. KEBAB_IDENT (first segment
// starts with a letter) applies to node ids and the DAG name because they
// feed codegen'd identifiers; team and case labels never become bare
// identifiers, so plain KEBAB stays enough there.
// `__proto__` as an object-literal key is a prototype SETTER, not a property:
// a field named `__proto__` would silently vanish from every generated
// `z.object({...})` / defaults / buildInput literal while passing the whole
// gauntlet. Rejected at parse time — there is no safe emission for it.
const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set(["__proto__"]);
// Free-text fields are interpolated into `//` comments by codegen — ANY JS
// line terminator (\r, \n, U+2028, U+2029) would break out of the comment
// into code position, so the schema rejects them all. SINGLE_LINE is
// single-sourced in `identifiers.ts` alongside the LINE_TERMINATORS scrub
// codegen's `comment()` applies as defense-in-depth — one character class,
// so the two layers can never disagree on the set.
// Free text also reaches generated PROMPT bodies (node purpose, enum values),
// where the runtime's `interpolatePrompt` replaceAll-substitutes any literal
// `{{field}}` matching a buildInput var — a purpose like "… {{text}} …" would
// silently splice runtime input into the prompt while passing the whole
// gauntlet. TEMPLATE_OPEN is single-sourced in `identifiers.ts` alongside the
// TEMPLATE_OPENERS scrub codegen's `promptText()` applies as defense-in-depth
// — one sequence, so the two layers can never disagree on it either.
const NO_TEMPLATE_OPEN = {
  check: (s: string): boolean => !TEMPLATE_OPEN.test(s),
  message:
    "must not contain '{{' (the runtime prompt-placeholder opener — it would splice runtime input into the generated prompt)",
} as const;
// Free text also splices into `//` comments that sit BETWEEN the `@fugue-body`
// integrity markers `structuralProjection` collapses before hashing. A purpose
// or description carrying the literal `@fugue-body` token could inject a fake
// start marker (excluding a node's id/schema/imports from the hash — structural
// tampering undetected, fail-OPEN) or a fake end marker (breaking the hash the
// moment a human implements the real placeholder body, fail-CLOSED). The schema
// rejects the token everywhere. FUGUE_BODY_MARKER is single-sourced in
// `identifiers.ts` alongside the FUGUE_BODY_MARKERS scrub codegen's `comment()`
// / `promptText()` apply as defense-in-depth — one sequence, so the two layers
// can never disagree on it.
const NO_FUGUE_BODY_MARKER = {
  check: (s: string): boolean => !FUGUE_BODY_MARKER.test(s),
  message:
    "must not contain '@fugue-body' (the integrity-projection marker — it would poison the structural hash of the generated module)",
} as const;

export type FieldType =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "array"; readonly element: SchemaSpec };

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  readonly description?: string;
}

export interface SchemaSpec {
  readonly fields: readonly FieldSpec[];
}

const enumValue = z
  .string()
  .min(1)
  .regex(SINGLE_LINE, "must be a single line")
  .refine(NO_TEMPLATE_OPEN.check, NO_TEMPLATE_OPEN.message)
  .refine(NO_FUGUE_BODY_MARKER.check, NO_FUGUE_BODY_MARKER.message);

// Recursive because an authored object field may itself be an array of
// objects. The recursion is data-only and bounded by the JSON document; it
// never admits executable schema source.
const FieldTypeSchema: z.ZodType<FieldType, FieldType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string") }).strict(),
    z.object({ kind: z.literal("number") }).strict(),
    z.object({ kind: z.literal("boolean") }).strict(),
    z.object({ kind: z.literal("enum"), values: z.array(enumValue).min(2).readonly() }).strict(),
    z.object({ kind: z.literal("array"), element: SchemaSpecSchema }).strict(),
  ]),
);

const FieldSpecSchema: z.ZodType<FieldSpec, FieldSpec> = z
  .object({
    name: z
      .string()
      .regex(IDENT, "field name must be a JS identifier")
      .refine((n) => !FORBIDDEN_FIELD_NAMES.has(n), {
        message: "field name '__proto__' is not allowed (object-literal prototype setter — it cannot be emitted as a schema key)",
      }),
    type: FieldTypeSchema,
    description: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "must be a single line")
      .refine(NO_TEMPLATE_OPEN.check, NO_TEMPLATE_OPEN.message)
      .refine(NO_FUGUE_BODY_MARKER.check, NO_FUGUE_BODY_MARKER.message)
      .optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type.kind !== "enum") return;
    const seen = new Set<string>();
    for (const v of f.type.values) {
      if (seen.has(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field '${f.name}': duplicate enum value '${v}'` });
      }
      seen.add(v);
    }
  });

/** One schema parser serves DAG inputs, node outputs, and recursive array elements. */
const schemaSpec = (missingMessage?: () => string): z.ZodType<SchemaSpec, SchemaSpec> =>
  z
    .object(
      { fields: z.array(FieldSpecSchema).min(1).readonly() },
      missingMessage === undefined
        ? undefined
        : { error: (issue) => (issue.input === undefined ? missingMessage() : undefined) },
    )
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

const SchemaSpecSchema: z.ZodType<SchemaSpec, SchemaSpec> = schemaSpec();

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * A string field parsed into a branded value through ONE smart constructor.
 * Both kebab flavours below are this same transform — only the constructor and
 * the message differ — so the "parse, don't validate" step that makes a parsed
 * AuthoredDag PROOF for the name constructors in `identifiers.ts` exists once.
 */
const brandedStringField = <T>(parse: (s: string) => T | null, message: string) =>
  z.string().transform((s, ctx) => {
    const parsed = parse(s);
    if (parsed === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * A KEBAB_IDENT string field, parsed into the branded `KebabIdent` — so every
 * id/name on a parsed AuthoredDag can safely become a bare identifier.
 */
const kebabIdentField = (message: string) => brandedStringField(parseKebabIdent, message);

/**
 * A plain-KEBAB string field, parsed into the branded `Kebab` — used where the
 * value never becomes a bare identifier (team, router case labels).
 */
const kebabField = (message: string) => brandedStringField(parseKebab, message);

const nodeId = kebabIdentField("node id must be kebab-case starting with a letter");
/** What this node is for — the authoring intent DescribedDag can't carry. */
const nodePurpose = z
  .string()
  .min(1)
  .regex(SINGLE_LINE, "must be a single line")
  .refine(NO_TEMPLATE_OPEN.check, NO_TEMPLATE_OPEN.message)
  .refine(NO_FUGUE_BODY_MARKER.check, NO_FUGUE_BODY_MARKER.message);

/**
 * The `output` slot for kinds that require one. Zod's default missing-key
 * message ("expected object, received undefined") names the shape but not the
 * RULE — the compose repair loop feeds parse problems to an LLM, so a missing
 * output must state which kinds require one and which kind omits it.
 */
const requiredOutput = schemaSpec(
  () => `output is required for ${OUTPUT_NODE_KINDS.join("/")} nodes — human-review and map nodes derive/forward output and omit it`,
);

/**
 * An ordinary node kind whose output spec is REQUIRED. Human-review forwards
 * its predecessor and map derives its collect output, so both are separate variants.
 * Generic so each variant keeps its literal `kind` (the discriminated-union
 * type stays precise: `Extract<AuthoredNode, { kind: "llm" }>` works).
 */
const outputNode = <K extends string>(kind: K) =>
  z
    .object({
      id: nodeId,
      kind: z.literal(kind),
      purpose: nodePurpose,
      /** Output field spec — required for each ordinary output-bearing kind. */
      output: requiredOutput,
    })
    .strict();

/**
 * Output-bearing nodes share one variant family. Human-review omits `output`
 * because it forwards its predecessor; map omits it because collect derives
 * the schema. The discriminated union makes those dependencies parse-time facts.
 */
const outputNodeVariants = [
  outputNode("fetch"),
  outputNode("transform"),
  outputNode("llm"),
  outputNode("source"),
] as const;

const HumanReviewNodeSchema = z
  .object(
    {
      id: nodeId,
      kind: z.literal("human-review"),
      purpose: nodePurpose,
    },
    {
      error: (issue) => {
        if (issue.code !== "unrecognized_keys" || !issue.keys.includes("output")) return undefined;
        const rule =
          "human-review nodes must not declare output (a review gate passes through the reviewed node's schema)";
        const siblings = issue.keys.filter((k) => k !== "output");
        return siblings.length === 0
          ? rule
          : `${rule}; also unrecognized: ${siblings.map((k) => JSON.stringify(k)).join(", ")}`;
      },
    },
  )
  .strict();

const OUTPUT_NODE_KINDS = outputNodeVariants.map((variant) => variant.shape.kind.value);
const ChildNodeSchema = z.discriminatedUnion("kind", outputNodeVariants, {
  error: (issue) => issue.code === "invalid_union"
    ? "mapped child node kind must be fetch/transform/llm/source; nested maps and human-review are unsupported — gather, then review at root level (FR-F1-011)"
    : undefined,
});
export type AuthoredChildNode = DeepReadonly<z.infer<typeof ChildNodeSchema>>;

// ---------------------------------------------------------------------------
// Structure (one variant per DAG shape; mirrors the define* helpers)
// ---------------------------------------------------------------------------

// Structure references point at node ids, so they share the id's lexical rule
// (KEBAB_IDENT, not plain KEBAB) — a ref like "2fast" can never resolve and
// should be rejected with the precise lexical message rather than only the
// unknown-node refinement.
const nodeRef = kebabIdentField("node reference must be kebab-case starting with a letter");

const RouterCaseSchema = z
  .object({
    // Parsed into the branded `Kebab` (mirrors `team`'s treatment) — a parsed
    // case label carries the proof the KEBAB rule passed, not a bare string.
    label: kebabField("case label must be kebab-case"),
    /** Closed predicate: classifier output `field` equals `equals`. */
    when: z.object({ field: z.string().regex(IDENT), equals: z.string().min(1) }).strict(),
    to: nodeRef,
  })
  .strict();
export type RouterCase = DeepReadonly<z.infer<typeof RouterCaseSchema>>;

const structureSchema = (minimumLinearNodes: number) => z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("linear"), order: z.array(nodeRef).min(minimumLinearNodes) }).strict(),
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

const StructureSchema = structureSchema(2);
const ChildStructureSchema = structureSchema(1);
type AuthoredStructure = DeepReadonly<z.infer<typeof StructureSchema>>;

// Compile-time proof that `StructureSchema`'s discriminated union covers exactly
// the canonical `Shape` set (derived from the `DAG_SHAPES` tuple in
// `types/dag.ts`). The `assertNever` in `structureRefs` only fires when a
// variant is ADDED to the union — it cannot force the union to COVER every
// `Shape`. These two aliases close both directions, mirroring the
// `_NoExtraShapes` backstop in `types.ts`: a new shape in `DAG_SHAPES` with no
// `StructureSchema` variant makes it silently un-authorable, and a variant
// naming a shape that isn't canonical would drift the authoring surface from
// the schema — each resolves to `never` and fails at its own annotation.
type _StructureCoversShapes = Exclude<Shape, AuthoredStructure["shape"]> extends never ? true : never;
type _StructureNoExtraShapes = Exclude<AuthoredStructure["shape"], Shape> extends never ? true : never;
const _structureCoversShapes: _StructureCoversShapes = true;
const _structureNoExtraShapes: _StructureNoExtraShapes = true;
void _structureCoversShapes;
void _structureNoExtraShapes;

/**
 * Node ids referenced by a structure, with the role each plays — in dependency
 * order (declarations precede use). Exported as the single source of the
 * structural walk: codegen's `structureOrder` derives its iteration order from
 * this same function, so the two can never disagree on a shape's node set.
 */
export const structureRefs = (s: AuthoredStructure): ReadonlyArray<readonly [KebabIdent, string]> => {
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
    default:
      // The return type is inferred, so a missing case would otherwise fall
      // through to `undefined` silently — assertNever makes a new shape a
      // compile error here.
      return assertNever(s);
  }
};

const orderNodesByStructure = <Node extends { readonly id: KebabIdent }>(
  nodes: readonly Node[],
  structure: AuthoredStructure,
): readonly Node[] => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const ordered = structureRefs(structure).flatMap(([id]) => {
    const node = byId.get(id);
    return node === undefined ? [] : [node];
  });
  return ordered.length === nodes.length ? ordered : nodes;
};

// ---------------------------------------------------------------------------
// Inline mapped children and the collect-only authored map node
// ---------------------------------------------------------------------------

function canonicalFields(spec: SchemaSpec): readonly unknown[] {
  return spec.fields
    .map((field) => ({ name: field.name, type: fieldTypeShape(field.type) }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function fieldTypeShape(type: FieldType): unknown {
  if (type.kind === "array") return { kind: "array", element: canonicalFields(type.element) };
  if (type.kind === "enum") return { kind: "enum", values: [...type.values].sort() };
  return type;
}

const schemaShape = (spec: SchemaSpec): string => JSON.stringify(canonicalFields(spec));

const terminalRefs = (structure: AuthoredStructure): readonly KebabIdent[] => {
  switch (structure.shape) {
    case "linear":
      return structure.order.length === 0 ? [] : [structure.order[structure.order.length - 1]!];
    case "fan-out":
      return structure.join === undefined ? [] : [structure.join];
    case "diamond":
      return [structure.join];
    case "router":
      return [...structure.cases.map((entry) => entry.to), structure.default];
    case "sources":
      return [structure.assemble];
    default:
      return assertNever(structure);
  }
};

const addGraphReferenceIssues = (
  nodes: readonly { readonly id: KebabIdent }[],
  structure: AuthoredStructure,
  ctx: z.RefinementCtx,
): void => {
  const byId = new Set(nodes.map((node) => node.id));
  if (byId.size !== nodes.length) {
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate node id '${node.id}'` });
      }
      seen.add(node.id);
    }
  }

  const referenced = new Map<string, number>();
  for (const [id, role] of structureRefs(structure)) {
    if (!byId.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `structure ${role} references unknown node '${id}'` });
    }
    referenced.set(id, (referenced.get(id) ?? 0) + 1);
  }
  for (const [id, count] of referenced) {
    if (count > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `node '${id}' is referenced ${count} times in the structure (each node plays exactly one role)`,
      });
    }
  }
  for (const node of nodes) {
    if (!referenced.has(node.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${node.id}' is not referenced by the structure` });
    }
  }
};

const addSourceRoleIssues = (
  nodes: readonly { readonly id: KebabIdent; readonly kind: string }[],
  structure: AuthoredStructure,
  ctx: z.RefinementCtx,
): void => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  if (structure.shape === "sources") {
    for (const id of structure.sources) {
      const node = byId.get(id);
      if (node !== undefined && node.kind !== "source") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sources entry '${id}' must be kind "source" (got "${node.kind}")` });
      }
    }
    for (const [role, id] of [["join", structure.join], ["assemble", structure.assemble]] as const) {
      if (byId.get(id)?.kind === "source") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${role} '${id}' must not be a source node` });
      }
    }
    return;
  }
  for (const node of nodes) {
    if (node.kind === "source") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `node '${node.id}' is kind "source" but shape is "${structure.shape}" — source nodes belong to the sources shape`,
      });
    }
  }
};

const addRouterIssues = <Node extends { readonly id: KebabIdent }>(
  nodes: readonly Node[],
  structure: AuthoredStructure,
  outputOf: (node: Node | undefined) => SchemaSpec | undefined,
  ctx: z.RefinementCtx,
): void => {
  if (structure.shape !== "router") return;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const classifierFields = outputOf(byId.get(structure.classifier))?.fields ?? [];
  const labels = new Set<string>();
  const predicates = new Set<string>();
  for (const [index, entry] of structure.cases.entries()) {
    const field = classifierFields.find((candidate) => candidate.name === entry.when.field);
    if (field === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${index}] predicate field '${entry.when.field}' is not a field of classifier '${structure.classifier}' output` });
    } else if (field.type.kind !== "enum") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${index}] predicate field '${entry.when.field}' must be an enum (got ${field.type.kind}) — closed routing only` });
    } else if (!field.type.values.includes(entry.when.equals)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${index}] 'equals: ${entry.when.equals}' is not a value of enum '${entry.when.field}' (${field.type.values.join(", ")})` });
    }
    if (labels.has(entry.label)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${index}] duplicate label '${entry.label}'` });
    }
    labels.add(entry.label);
    const predicate = `${entry.when.field}\u0000${entry.when.equals}`;
    if (predicates.has(predicate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cases[${index}] duplicate predicate {field: '${entry.when.field}', equals: '${entry.when.equals}'} — the case is unreachable` });
    }
    predicates.add(predicate);
  }
};

const addIdentifierIssues = (
  nodes: readonly Parameters<typeof generatedIdentifiersFor>[0][],
  ctx: z.RefinementCtx,
  reserved: ReadonlySet<string> = RESERVED_IDENTIFIERS,
): void => {
  const identifiers = nodes.map((node) => ({ node, names: generatedIdentifiersFor(node) }));
  for (const { node, names } of identifiers) {
    const camel = camelCase(node.id);
    if (JS_RESERVED_WORDS.has(camel)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node id '${node.id}' is reserved (camelCases to the JS reserved word '${camel}')` });
    }
    for (const name of names) {
      if (reserved.has(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node id '${node.id}' is reserved (generated identifier '${name}' collides with a generated or imported identifier)` });
      }
    }
  }
  for (let leftIndex = 0; leftIndex < identifiers.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < identifiers.length; rightIndex++) {
      const left = identifiers[leftIndex]!;
      const right = identifiers[rightIndex]!;
      if (left.node.id === right.node.id) continue;
      const shared = left.names.filter((name) => right.names.includes(name));
      if (shared.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node ids '${left.node.id}' and '${right.node.id}' generate colliding identifier(s): ${shared.join(", ")}` });
      }
    }
  }
};

const childNodeOutputSpec = (node: AuthoredChildNode): SchemaSpec =>
  node.kind === "llm" && !node.output.fields.some((field) => field.name === "confidence")
    ? { fields: [...node.output.fields, CONFIDENCE_FIELD] }
    : node.output;

const addLlmConfidenceIssue = (
  node: { readonly id: string; readonly output: SchemaSpec },
  ctx: z.RefinementCtx,
  guidance = "",
): void => {
  const confidence = node.output.fields.find((field) => field.name === "confidence");
  if (confidence === undefined) return;
  const valid = confidence.type.kind === "enum" &&
    confidence.type.values.length === CONFIDENCE_BUCKET.length &&
    confidence.type.values.every((value, index) => value === CONFIDENCE_BUCKET[index]);
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `llm node '${node.id}' output field 'confidence' must be exactly {"kind":"enum","values":${JSON.stringify(CONFIDENCE_BUCKET)}}${guidance}`,
    });
  }
};

const ChildDagSchema = z
  .object({
    id: kebabIdentField("child DAG id must be kebab-case starting with a letter"),
    nodes: z.array(ChildNodeSchema).min(1).readonly(),
    structure: ChildStructureSchema,
  })
  .strict()
  .superRefine((child, ctx) => {
    addGraphReferenceIssues(child.nodes, child.structure, ctx);
    addSourceRoleIssues(child.nodes, child.structure, ctx);
    addRouterIssues(child.nodes, child.structure, (node) => node?.output, ctx);
    addIdentifierIssues(child.nodes, ctx);
    for (const node of child.nodes) {
      if (node.kind === "llm") addLlmConfidenceIssue(node, ctx);
    }
    if (child.structure.shape === "fan-out" && child.structure.join === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mapped child fan-out requires a join so one child output schema is statically knowable" });
    }
    const byId = new Map(child.nodes.map((node) => [node.id, node] as const));
    const terminals = terminalRefs(child.structure).flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    });
    const expected = terminals[0] === undefined ? undefined : childNodeOutputSpec(terminals[0]);
    if (expected !== undefined) {
      for (const terminal of terminals.slice(1)) {
        if (schemaShape(childNodeOutputSpec(terminal)) !== schemaShape(expected)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `mapped child terminal '${terminal.id}' output must match terminal '${terminals[0]!.id}' field names and types`,
          });
        }
      }
    }
  })
  .transform((child) => ({
    ...child,
    nodes: orderNodesByStructure(child.nodes, child.structure),
  }));

export type AuthoredChildDag = DeepReadonly<z.infer<typeof ChildDagSchema>>;

export const childOutputSpec = (child: AuthoredChildDag): SchemaSpec => {
  const terminal = terminalRefs(child.structure)[0];
  const node = terminal === undefined ? undefined : child.nodes.find((candidate) => candidate.id === terminal);
  if (node === undefined) {
    throw new Error(`authored map invariant: child '${child.id}' has no terminal output`);
  }
  return childNodeOutputSpec(node);
};

const GatherSchema = z.object({
  kind: z.literal("collect"),
  field: z
    .string()
    .regex(IDENT, "gather field must be a JS identifier")
    .refine((field) => !FORBIDDEN_FIELD_NAMES.has(field), "gather field '__proto__' is not allowed"),
}).strict();

const MapNodeSchema = z
  .object(
    {
      id: nodeId,
      kind: z.literal("map"),
      purpose: nodePurpose,
      widthFrom: z
        .string()
        .regex(IDENT, "widthFrom must be one field reference (a JS identifier)")
        .refine((field) => !FORBIDDEN_FIELD_NAMES.has(field), "widthFrom '__proto__' is not allowed"),
      maxWidth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      child: ChildDagSchema,
      gather: GatherSchema,
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys" && issue.keys.includes("output")
          ? "map nodes must not declare output; the collect gather derives it from the child output"
          : undefined,
    },
  )
  .strict();

const authoredNodeVariants = [
  outputNodeVariants[0],
  outputNodeVariants[1],
  outputNodeVariants[2],
  HumanReviewNodeSchema,
  outputNodeVariants[3],
  MapNodeSchema,
] as const;
const NODE_KINDS = authoredNodeVariants.map((variant) => variant.shape.kind.value);
const KIND_LIST = NODE_KINDS.map((kind) => JSON.stringify(kind)).join("|");
const AuthoredNodeSchema = z.discriminatedUnion("kind", authoredNodeVariants, {
  error: (issue) => issue.code === "invalid_union" ? `node kind must be one of ${KIND_LIST}` : undefined,
});
export type AuthoredNode = DeepReadonly<z.infer<typeof AuthoredNodeSchema>>;
export type AuthoredMapNode = Extract<AuthoredNode, { readonly kind: "map" }>;

export const mapOutputSpec = (node: AuthoredMapNode): SchemaSpec => ({
  fields: [{
    name: node.gather.field,
    type: { kind: "array", element: childOutputSpec(node.child) },
  }],
});

const outputSpecOf = (node: AuthoredNode | undefined): SchemaSpec | undefined => {
  if (node === undefined || node.kind === "human-review") return undefined;
  return node.kind === "map" ? mapOutputSpec(node) : node.output;
};

const directInputSpec = (
  dag: { readonly input: SchemaSpec; readonly nodes: readonly AuthoredNode[]; readonly structure: AuthoredStructure },
  id: KebabIdent,
): SchemaSpec | undefined => {
  const byId = new Map(dag.nodes.map((node) => [node.id, node] as const));
  const structure = dag.structure;
  switch (structure.shape) {
    case "linear": {
      const index = structure.order.indexOf(id);
      if (index === 0) return dag.input;
      let predecessor = index - 1;
      while (predecessor >= 0) {
        const spec = outputSpecOf(byId.get(structure.order[predecessor]!));
        if (spec !== undefined) return spec;
        predecessor--;
      }
      return dag.input;
    }
    case "fan-out":
    case "diamond":
      if (id === structure.source) return dag.input;
      if (structure.branches.includes(id)) return outputSpecOf(byId.get(structure.source));
      return undefined;
    case "router":
      return id === structure.classifier ? dag.input : outputSpecOf(byId.get(structure.classifier));
    case "sources":
      return undefined;
    default:
      return assertNever(structure);
  }
};

/** Item schema selected by a parsed map's direct array-field reference. */
export const mapItemSpec = (
  dag: { readonly input: SchemaSpec; readonly nodes: readonly AuthoredNode[]; readonly structure: AuthoredStructure },
  node: AuthoredMapNode,
): SchemaSpec => {
  const input = directInputSpec(dag, node.id);
  const field = input?.fields.find((candidate) => candidate.name === node.widthFrom);
  if (field?.type.kind !== "array") {
    throw new Error(`authored map invariant: '${node.id}.${node.widthFrom}' is not an array input`);
  }
  return field.type.element;
};

// ---------------------------------------------------------------------------
// The AuthoredDag
// ---------------------------------------------------------------------------

/** Recursively freeze the parser-owned data graph before issuing its brand. */
const deepFreezeOwned = <T>(value: T): DeepReadonly<T> => {
  if (typeof value !== "object" || value === null) return value as DeepReadonly<T>;
  for (const key of Reflect.ownKeys(value)) {
    deepFreezeOwned((value as Record<PropertyKey, unknown>)[key]);
  }
  return (Object.isFrozen(value) ? value : Object.freeze(value)) as DeepReadonly<T>;
};

const BaseAuthoredDagSchema = z
  .object({
    fugueAuthored: z.literal(1),
    name: kebabIdentField("name must be kebab-case starting with a letter"),
    team: kebabField("team must be kebab-case"),
    description: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "must be a single line")
      .refine(NO_TEMPLATE_OPEN.check, NO_TEMPLATE_OPEN.message)
      .refine(NO_FUGUE_BODY_MARKER.check, NO_FUGUE_BODY_MARKER.message),
    input: SchemaSpecSchema,
    nodes: z.array(AuthoredNodeSchema).min(1),
    structure: StructureSchema,
  })
  .strict();

const AuthoredDagSchema = BaseAuthoredDagSchema.superRefine((dag, ctx) => {
  // Identifier safety: every identifier codegen will emit for a node (const,
  // schema const, fan-in const, llm factory) must avoid JS reserved words, the
  // module's imports/fixed consts, the DAG-level names, and every OTHER node's
  // generated identifiers. The gauntlet (codegen → import) would also catch
  // these, but rejecting at parse time gives the author/LLM a precise message
  // naming both sides instead of a duplicate-declaration SyntaxError.
  const moduleReserved = new Set([...RESERVED_IDENTIFIERS, ...dagLevelIdentifiers(dag.name)]);
  addIdentifierIssues(dag.nodes, ctx, moduleReserved);

  const s = dag.structure;
  addGraphReferenceIssues(dag.nodes, s, ctx);
  addSourceRoleIssues(dag.nodes, s, ctx);

  // LLM confidence: codegen injects the CONFIDENCE_BUCKET enum when absent.
  // An EXPLICIT 'confidence' output field must be exactly that shape —
  // anything else would clash with the framework's bucketed-confidence
  // channel (`confidence(o.confidence, "self-reported-bucket")`).
  for (const node of dag.nodes) {
    if (node.kind === "llm") {
      addLlmConfidenceIssue(
        node,
        ctx,
        " (the framework's bucketed confidence) — or omit it and let codegen inject it",
      );
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

  // Root and child routers share one closed predicate policy. A human-review
  // classifier has no output (and is illegal outside linear), so it reports
  // the same precise missing-field problem through this resolver.
  addRouterIssues(dag.nodes, s, outputSpecOf, ctx);

  for (const [index, node] of dag.nodes.entries()) {
    if (node.kind !== "map") continue;
    const input = directInputSpec(dag, node.id);
    if (input === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "widthFrom"],
        message: `map node '${node.id}' is in a fan-in/source role without a directly addressable input field`,
      });
      continue;
    }
    const field = input.fields.find((candidate) => candidate.name === node.widthFrom);
    if (field === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "widthFrom"],
        message: `'${node.widthFrom}' is not a field of map node '${node.id}' input`,
      });
    } else if (field.type.kind !== "array") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "widthFrom"],
        message: `'${node.widthFrom}' must reference an array field (got ${field.type.kind})`,
      });
    }
  }
})
  // Canonicalize node order to the structure's dependency order (the order
  // `structureRefs` walks — the same walk codegen's `structureOrder` uses),
  // so two authored files differing only in `nodes` array order parse to the
  // SAME value and therefore generate byte-identical scaffolds. Pure and
  // total AFTER the refinements above: every node is referenced exactly once
  // by the structure, so the reordering is a bijection. When refinements
  // failed (unknown refs / duplicate roles) the parse is already a failure —
  // the guards below only keep this transform throw-free on that dead path.
  .transform((dag) => ({
    ...dag,
    nodes: orderNodesByStructure(dag.nodes, dag.structure),
  }))
  .transform(deepFreezeOwned)
  .brand<"AuthoredDag">();

/**
 * BRANDED and deeply readonly: only the parse entry points issue this owned,
 * recursively frozen value after every refinement above has passed.
 */
export type AuthoredDag = z.infer<typeof AuthoredDagSchema>;
/**
 * The unbranded wire shape — what an author (human, LLM, or test fixture)
 * writes BEFORE parsing. The only path from this to `AuthoredDag` is
 * `parseAuthoredDag`.
 */
export type AuthoredDagInput = z.input<typeof AuthoredDagSchema>;

// ---------------------------------------------------------------------------
// Parse entry points
// ---------------------------------------------------------------------------

type AuthoredParseResult =
  | { readonly ok: true; readonly dag: AuthoredDag }
  | { readonly ok: false; readonly problems: readonly string[] };

const issuesToProblems = (issues: readonly z.ZodIssue[]): string[] =>
  issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));

export const parseAuthoredDag = (raw: unknown): AuthoredParseResult => {
  try {
    const valueProblem = authoredValueProblem(raw);
    if (valueProblem !== undefined) return { ok: false, problems: [valueProblem] };
    const parsed = AuthoredDagSchema.safeParse(raw);
    if (parsed.success) return { ok: true, dag: parsed.data };
    return { ok: false, problems: issuesToProblems(parsed.error.issues) };
  } catch (cause) {
    return { ok: false, problems: [`invalid authored DAG: ${safeErrorMessage(cause)}`] };
  }
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
