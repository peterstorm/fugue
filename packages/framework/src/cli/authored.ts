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
// The exported `AuthoredDag` type is BRANDED: `parseAuthoredDag` /
// `parseAuthoredDagJson` are the only producers, so every consumer
// (codegen, gauntlet, scaffold writer) is guaranteed a value that already
// passed every refinement — no structurally-shaped impostors.

import { z } from "zod";
import {
  IDENT,
  JS_RESERVED_WORDS,
  KEBAB,
  RESERVED_IDENTIFIERS,
  SINGLE_LINE,
  camelCase,
  dagLevelIdentifiers,
  generatedIdentifiersFor,
  parseKebab,
  parseKebabIdent,
  type KebabIdent,
} from "./identifiers.js";
import { assertNever } from "./types.js";
import { CONFIDENCE_BUCKET } from "./vocabulary.js";

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

export const FieldTypeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string") }).strict(),
  z.object({ kind: z.literal("number") }).strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
  z
    .object({
      kind: z.literal("enum"),
      // Enum values never reach `//` comments, but they DO reach another
      // single-line context: the prompt body's JSON response shape (jsonShape
      // in authored-codegen renders every value inline). A line terminator
      // there garbles the prompt even though codegen JSON-escapes the z.enum
      // literal. `.readonly()` so the inferred type is ReadonlyArray (and the
      // parsed value is frozen) — enum values are facts, never mutated.
      values: z.array(z.string().min(1).regex(SINGLE_LINE, "must be a single line")).min(2).readonly(),
    })
    .strict(),
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldSpecSchema = z
  .object({
    name: z
      .string()
      .regex(IDENT, "field name must be a JS identifier")
      .refine((n) => !FORBIDDEN_FIELD_NAMES.has(n), {
        message: "field name '__proto__' is not allowed (object-literal prototype setter — it cannot be emitted as a schema key)",
      }),
    type: FieldTypeSchema,
    description: z.string().min(1).regex(SINGLE_LINE, "must be a single line").optional(),
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
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

/**
 * One definition serves both `SchemaSpecSchema` (the shared spec) and the
 * required-`output` slot on nodes — the ONLY difference is the message a
 * MISSING value produces. `missingMessage` is a thunk so the output slot can
 * name the kinds that require an output, derived from the node variants
 * declared further down (the thunk runs at parse time, so ordering is safe).
 */
const schemaSpec = (missingMessage?: () => string) =>
  z
    .object(
      // `.readonly()` — field lists are ReadonlyArray in the inferred types
      // (consumers only map/iterate; extension goes through spread copies).
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

export const SchemaSpecSchema = schemaSpec();
export type SchemaSpec = z.infer<typeof SchemaSpecSchema>;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * A KEBAB_IDENT string field, parsed into the branded `KebabIdent` through
 * the single smart constructor — so every id/name on a parsed AuthoredDag is
 * PROOF the name constructors in `identifiers.ts` can safely emit from it.
 */
const kebabIdentField = (message: string) =>
  z.string().transform((s, ctx) => {
    const parsed = parseKebabIdent(s);
    if (parsed === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
    return parsed;
  });

const nodeId = kebabIdentField("node id must be kebab-case starting with a letter");
/** What this node is for — the authoring intent DescribedDag can't carry. */
const nodePurpose = z.string().min(1).regex(SINGLE_LINE, "must be a single line");

/**
 * The `output` slot for kinds that require one. Zod's default missing-key
 * message ("expected object, received undefined") names the shape but not the
 * RULE — the compose repair loop feeds parse problems to an LLM, so a missing
 * output must state which kinds require one and which kind omits it.
 */
const requiredOutput = schemaSpec(
  () => `output is required for ${OUTPUT_NODE_KINDS.join("/")} nodes — only human-review nodes omit it`,
);

/**
 * A node kind whose output spec is REQUIRED — every kind except human-review.
 * Generic so each variant keeps its literal `kind` (the discriminated-union
 * type stays precise: `Extract<AuthoredNode, { kind: "llm" }>` works).
 */
const outputNode = <K extends string>(kind: K) =>
  z
    .object({
      id: nodeId,
      kind: z.literal(kind),
      purpose: nodePurpose,
      /** Output field spec — required for every kind except human-review. */
      output: requiredOutput,
    })
    .strict();

/**
 * The node union, discriminated on `kind`. A human-review gate is a typed
 * passthrough over the reviewed node's schema, so its variant has NO `output`
 * — every other kind requires one. Same JSON wire shape as ever; the union
 * just makes the kind/output dependency a parse-time fact instead of a
 * superRefine.
 */
const authoredNodeVariants = [
  outputNode("fetch"),
  outputNode("transform"),
  outputNode("llm"),
  z
    .object(
      {
        id: nodeId,
        kind: z.literal("human-review"),
        purpose: nodePurpose,
      },
      {
        // The default strict-object issue is `Unrecognized key: "output"`,
        // which names the key but not the rule — the compose repair loop
        // feeds these messages to an LLM, so state the rule precisely.
        // Sibling stray keys ride along in the SAME issue (`issue.keys`), so
        // they must survive into the message too — swallowing them costs the
        // repair loop a round. When `output` itself is absent, Zod's default
        // unrecognized-keys message already says everything there is to say.
        error: (issue) => {
          if (issue.code !== "unrecognized_keys" || !issue.keys.includes("output")) {
            return undefined;
          }
          const rule =
            "human-review nodes must not declare output (a review gate passes through the reviewed node's schema)";
          const siblings = issue.keys.filter((k) => k !== "output");
          return siblings.length === 0
            ? rule
            : `${rule}; also unrecognized: ${siblings.map((k) => JSON.stringify(k)).join(", ")}`;
        },
      },
    )
    .strict(),
  outputNode("source"),
] as const;

/**
 * Kind vocabularies DERIVED from the variant literals above — the single
 * source; never hand-write a second copy of the kind list.
 */
const NODE_KINDS = authoredNodeVariants.map((v) => v.shape.kind.value);
const OUTPUT_NODE_KINDS = authoredNodeVariants
  .filter((v) => "output" in v.shape)
  .map((v) => v.shape.kind.value);
const KIND_LIST = NODE_KINDS.map((k) => JSON.stringify(k)).join("|");

export const AuthoredNodeSchema = z.discriminatedUnion("kind", authoredNodeVariants, {
  // Zod's default for an unknown or missing discriminator is a bare
  // "Invalid input" — useless to the compose repair loop. Name the full
  // vocabulary; every other issue code falls through to its own message.
  error: (issue) =>
    issue.code === "invalid_union" ? `node kind must be one of ${KIND_LIST}` : undefined,
});
export type AuthoredNode = z.infer<typeof AuthoredNodeSchema>;

// ---------------------------------------------------------------------------
// Structure (one variant per DAG shape; mirrors the define* helpers)
// ---------------------------------------------------------------------------

// Structure references point at node ids, so they share the id's lexical rule
// (KEBAB_IDENT, not plain KEBAB) — a ref like "2fast" can never resolve and
// should be rejected with the precise lexical message rather than only the
// unknown-node refinement.
const nodeRef = kebabIdentField("node reference must be kebab-case starting with a letter");

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
    name: kebabIdentField("name must be kebab-case starting with a letter"),
    // Parsed into the branded `Kebab` through the single smart constructor
    // (mirrors `name`'s treatment) — so a parsed dag's `team` carries the
    // proof the KEBAB rule passed, and consumers like `runCompose`'s --team
    // comparison work brand-to-brand instead of trusting a bare string.
    team: z.string().transform((s, ctx) => {
      const parsed = parseKebab(s);
      if (parsed === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "team must be kebab-case" });
        return z.NEVER;
      }
      return parsed;
    }),
    description: z.string().min(1).regex(SINGLE_LINE, "must be a single line"),
    /** DAG input schema (the request). */
    input: SchemaSpecSchema,
    nodes: z.array(AuthoredNodeSchema).min(1),
    structure: StructureSchema,
  })
  .strict();

/** Node ids referenced by a structure, with the role each plays. */
const structureRefs = (s: AuthoredStructure): ReadonlyArray<readonly [KebabIdent, string]> => {
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

export const AuthoredDagSchema = BaseAuthoredDagSchema.superRefine((dag, ctx) => {
  const byId = new Map(dag.nodes.map((n) => [n.id, n] as const));

  // Identifier safety: every identifier codegen will emit for a node (const,
  // schema const, fan-in const, llm factory) must avoid JS reserved words, the
  // module's imports/fixed consts, the DAG-level names, and every OTHER node's
  // generated identifiers. The gauntlet (codegen → import) would also catch
  // these, but rejecting at parse time gives the author/LLM a precise message
  // naming both sides instead of a duplicate-declaration SyntaxError.
  const moduleReserved = new Set([...RESERVED_IDENTIFIERS, ...dagLevelIdentifiers(dag.name)]);
  const identsByNode = dag.nodes.map((n) => ({ node: n, idents: generatedIdentifiersFor(n) }));
  for (const { node, idents } of identsByNode) {
    const camel = camelCase(node.id);
    if (JS_RESERVED_WORDS.has(camel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `node id '${node.id}' is reserved (camelCases to the JS reserved word '${camel}')`,
      });
    }
    for (const ident of idents) {
      if (moduleReserved.has(ident)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `node id '${node.id}' is reserved (generated identifier '${ident}' collides with a generated or imported identifier)`,
        });
      }
    }
  }
  for (let a = 0; a < identsByNode.length; a++) {
    for (let b = a + 1; b < identsByNode.length; b++) {
      const left = identsByNode[a]!;
      const right = identsByNode[b]!;
      if (left.node.id === right.node.id) continue; // duplicate ids get their own message below
      const shared = left.idents.filter((i) => right.idents.includes(i));
      if (shared.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `node ids '${left.node.id}' and '${right.node.id}' generate colliding identifier(s): ${shared.join(", ")}`,
        });
      }
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
  const kindOf = (id: KebabIdent) => byId.get(id)?.kind;

  if (s.shape === "sources") {
    for (const id of s.sources) {
      if (byId.has(id) && kindOf(id) !== "source") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sources entry '${id}' must be kind "source" (got "${kindOf(id)}")` });
      }
    }
    if (byId.has(s.join) && kindOf(s.join) === "source") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `join '${s.join}' must not be a source node` });
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

  // LLM confidence: codegen injects the CONFIDENCE_BUCKET enum when absent.
  // An EXPLICIT 'confidence' output field must be exactly that shape —
  // anything else would clash with the framework's bucketed-confidence
  // channel (`confidence(o.confidence, "self-reported-bucket")`).
  for (const n of dag.nodes) {
    if (n.kind !== "llm") continue;
    const conf = n.output.fields.find((f) => f.name === "confidence");
    if (conf === undefined) continue;
    const isBucket =
      conf.type.kind === "enum" &&
      conf.type.values.length === CONFIDENCE_BUCKET.length &&
      conf.type.values.every((v, i) => v === CONFIDENCE_BUCKET[i]);
    if (!isBucket) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `llm node '${n.id}' output field 'confidence' must be exactly {"kind":"enum","values":${JSON.stringify(CONFIDENCE_BUCKET)}} (the framework's bucketed confidence) — or omit it and let codegen inject it`,
      });
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
    // A human-review classifier has no output (and is illegal outside linear —
    // reported above), so every predicate correctly reports "not a field".
    const fields =
      classifier === undefined || classifier.kind === "human-review" ? [] : classifier.output.fields;
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
    // Two cases with the same {field, equals} predicate: the second can never
    // fire (cases are checked in order) — an unreachable route is an authoring
    // mistake, not a fallback.
    const predicates = new Set<string>();
    for (const [i, c] of s.cases.entries()) {
      const p = `${c.when.field} ${c.when.equals}`;
      if (predicates.has(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cases[${i}] duplicate predicate {field: '${c.when.field}', equals: '${c.when.equals}'} — the case is unreachable`,
        });
      }
      predicates.add(p);
    }
  }
}).brand<"AuthoredDag">();

/**
 * BRANDED: only `parseAuthoredDag` / `parseAuthoredDagJson` produce this type,
 * so holding an `AuthoredDag` means every refinement above already passed.
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
