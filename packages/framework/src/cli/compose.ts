// fugue compose — conversational DAG authoring (deterministic-core
// convergence, Phase B3).
//
// The loop is an explicit machine: interview → draft → validate → present →
// refine/accept. THE LLM'S ONLY OUTPUT CHANNEL IS THE AuthoredDag JSON —
// every turn is `sendStructured` against a closed Zod schema, graph code is
// always generated deterministically (`buildAuthoredScaffold`), and every
// draft is proven through the real gauntlet before the user sees it:
// codegen → `import` through `defineDag` (defineDag's structural checks,
// throws) → `fugue lint` (fan-in keys, passthrough, shape hints). Violations
// feed back to the LLM as structured JSON events, not prose. The LLM never
// hand-writes `defineDag`.
//
// The draft payload crosses the wire as `unknown` and is parsed by
// `parseAuthoredDag` INSIDE the loop — a schema-invalid draft enters the
// repair loop (the superRefine problems reach the model as structured JSON)
// instead of killing the session at the transport boundary. Nothing else ever
// consumes the unknown, so the LLM-only-emits-AuthoredDag guarantee holds.
//
// Seams are injected (LlmClient + ComposeIo) so the whole loop is testable
// with a scripted fake — no network, no TTY.

import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { LlmClient } from "../types/llm.js";
import { formatFrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import { parseAuthoredDag, type AuthoredDag } from "./authored.js";
import { runGauntlet, type GauntletResult } from "./gauntlet.js";
import { writeAuthoredScaffold } from "./new.js";
import { DEFAULT_MODEL } from "./new-templates.js";
import type { NewResult } from "./types.js";

// Re-export the gauntlet from its old home so existing importers keep working.
export { runGauntlet, type GauntletResult } from "./gauntlet.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Terminal seam — injectable so tests script the conversation. */
export interface ComposeIo {
  readonly ask: (question: string) => Promise<string>;
  readonly say: (message: string) => void;
}

export interface ComposeOptions {
  /** The natural-language pipeline description. */
  readonly intent: string;
  /** Owning team (kebab-case) — goes into the AuthoredDag. */
  readonly team: string;
  readonly model?: string;
  /** Root dir that contains `dags/` and resolvable node_modules. */
  readonly root?: string;
  readonly owner?: string;
  readonly force?: boolean;
  /** Max clarifying-question rounds before the model must draft. Default 2. */
  readonly maxQuestionRounds?: number;
  /**
   * Max repair rounds PER DRAFT (schema-validation failures and gauntlet
   * failures both count; the budget resets when a refinement produces a new
   * draft). `rounds.repairs` in the outcome stays cumulative. Default 3.
   */
  readonly maxRepairRounds?: number;
}

export type ComposeOutcome =
  | {
      readonly ok: true;
      readonly result: Extract<NewResult, { ok: true }>;
      readonly rounds: { readonly questions: number; readonly repairs: number; readonly refinements: number };
    }
  | {
      readonly ok: false;
      readonly reason: "aborted" | "llm-error" | "repair-exhausted" | "write-failed";
      readonly problems: readonly string[];
    };

// ---------------------------------------------------------------------------
// The LLM turn contract (closed)
// ---------------------------------------------------------------------------

/**
 * Every model turn is exactly one of: clarifying questions, or a full
 * AuthoredDag draft. The envelope is validated at the API boundary by
 * `sendStructured`; the draft payload is deliberately `unknown` at the wire so
 * `parseAuthoredDag`'s problems can feed the repair loop rather than fail the
 * transport (see the module header). `parseAuthoredDag` is the ONLY consumer.
 */
export const ComposeTurnSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("questions"),
    questions: z.array(z.string().min(1)).min(1).max(5),
  }),
  z.object({
    action: z.literal("draft"),
    dag: z.unknown(),
  }),
]);
export type ComposeTurn = z.infer<typeof ComposeTurnSchema>;

const SYSTEM_PROMPT = `You are the drafting half of \`fugue compose\`. You NEVER write code —
you emit or edit a single AuthoredDag JSON document; deterministic codegen
turns it into a validated Fugue DAG.

Respond with exactly one action:
- {"action":"questions","questions":[...]} — at most 5, only when the intent
  is genuinely ambiguous about data sources, decisions, or human gates.
- {"action":"draft","dag":{...}} — a complete AuthoredDag.

AuthoredDag rules (closed vocabulary — the schema rejects anything else):
- fugueAuthored: 1. name/team/node ids/case labels: kebab-case.
- input + node outputs are field lists; field types are ONLY
  {"kind":"string"|"number"|"boolean"} or {"kind":"enum","values":[...≥2]}.
- Field names must be valid JS identifiers. Node ids must not be JS reserved
  words and must not collide with the identifiers codegen derives from them —
  avoid ids like "dag", "input", "ok", or "llm-node".
- purpose and description fields are single-line (no newlines).
- Node kinds: fetch (external read), transform (pure mapping), llm
  (model call — a confidence bucket is added automatically), human-review
  (approval gate; NO output field; linear shape only, never first), source
  (context-only read; sources shape only).
- The auto-injected llm confidence bucket CANNOT be used as a router
  predicate field — declare it explicitly on the classifier output as
  {"kind":"enum","values":["high","medium","low"]} if you route on it.
- structure is one shape:
  linear   {order:[...≥2]}                    — a chain
  fan-out  {source,branches:[...≥2],join?}    — parallel branches, optional join
  diamond  {source,branches:[...≥2],join}     — parallel branches, required join
  router   {classifier,cases:[{label,when:{field,equals},to}],default}
           — when.field must be an enum field of the classifier output and
             when.equals one of its values; default is REQUIRED
  sources  {sources:[...≥2],join,assemble}    — sources are kind "source"
- Every node appears in the structure exactly once. Node input schemas are
  DERIVED from the topology — never author them.
- Prefer the simplest shape that fits. Human gates only where the user asked
  for approval.`;

// ---------------------------------------------------------------------------
// AuthoredDag → Mermaid (for the present step; pure)
// ---------------------------------------------------------------------------

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_");

export const authoredToMermaid = (dag: AuthoredDag): string => {
  const lines = ["flowchart TD", `    dag_input(["$input (request)"])`];
  for (const n of dag.nodes) {
    lines.push(
      n.kind === "human-review"
        ? `    ${safe(n.id)}{{"${n.id}<br/>${n.kind}"}}`
        : `    ${safe(n.id)}["${n.id}<br/>${n.kind}"]`,
    );
  }
  const s = dag.structure;
  switch (s.shape) {
    case "linear": {
      lines.push(`    dag_input --> ${safe(s.order[0]!)}`);
      for (let i = 1; i < s.order.length; i++) lines.push(`    ${safe(s.order[i - 1]!)} --> ${safe(s.order[i]!)}`);
      break;
    }
    case "fan-out":
    case "diamond": {
      lines.push(`    dag_input --> ${safe(s.source)}`);
      for (const b of s.branches) lines.push(`    ${safe(s.source)} --> ${safe(b)}`);
      if (s.join !== undefined) for (const b of s.branches) lines.push(`    ${safe(b)} --> ${safe(s.join)}`);
      break;
    }
    case "router": {
      lines.push(`    dag_input --> ${safe(s.classifier)}`);
      for (const c of s.cases) lines.push(`    ${safe(s.classifier)} -->|"${c.when.field} = ${c.when.equals}"| ${safe(c.to)}`);
      lines.push(`    ${safe(s.classifier)} -.->|default| ${safe(s.default)}`);
      break;
    }
    case "sources": {
      for (const src of s.sources) lines.push(`    ${safe(src)} --> ${safe(s.join)}`);
      lines.push(`    ${safe(s.join)} --> ${safe(s.assemble)}`);
      lines.push(`    dag_input --> ${safe(s.assemble)}`);
      break;
    }
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const COMPOSE_NODE_ID = nodeId("fugue-compose");

const summarize = (dag: AuthoredDag): string =>
  [
    `${dag.name} (${dag.structure.shape}) — ${dag.description}`,
    ...dag.nodes.map((n) => `  - ${n.id} (${n.kind}): ${n.purpose}`),
  ].join("\n");

export const runCompose = async (
  options: ComposeOptions,
  llm: LlmClient,
  io: ComposeIo,
  // Injectable so the repair loop is testable without manufacturing a real
  // schema-passing-but-invalid draft (the schema is designed to make those
  // nearly unrepresentable; the gauntlet is defense-in-depth behind it).
  gauntlet: (dag: AuthoredDag, root: string) => Promise<GauntletResult> = runGauntlet,
): Promise<ComposeOutcome> => {
  const model = options.model ?? DEFAULT_MODEL;
  const root = options.root !== undefined
    ? (isAbsolute(options.root) ? options.root : resolve(process.cwd(), options.root))
    : process.cwd();
  const maxQuestions = options.maxQuestionRounds ?? 2;
  const maxRepairs = options.maxRepairRounds ?? 3;

  const rounds = { questions: 0, repairs: 0, refinements: 0 };
  // Per-draft repair budget (schema + gauntlet failures both draw on it) —
  // reset whenever a refinement produces a new draft. `rounds.repairs` above
  // stays cumulative for reporting.
  let draftRepairs = 0;

  // The conversation the model sees — grows with answers, violations, refinements.
  const conversation: string[] = [
    `Team: ${options.team}`,
    `Intent: ${options.intent}`,
  ];

  const turn = async (extra?: string): Promise<ComposeTurn | { readonly error: string }> => {
    const user = [...conversation, ...(extra !== undefined ? [extra] : [])].join("\n\n");
    const res = await llm.sendStructured({
      system: SYSTEM_PROMPT,
      user,
      model,
      schema: ComposeTurnSchema,
      nodeId: COMPOSE_NODE_ID,
    });
    if (!res.ok) return { error: formatFrameworkError(res.error) };
    return res.value.output;
  };

  type DraftAttempt =
    | { readonly ok: true; readonly dag: AuthoredDag }
    | { readonly ok: false; readonly outcome: ComposeOutcome };

  // Schema gate: parse the wire-level `unknown` into an AuthoredDag. A schema
  // failure is a repair round exactly like a gauntlet failure — the superRefine
  // problems go back to the model as structured JSON and we re-turn.
  const parseDraftWithRepairs = async (first: Extract<ComposeTurn, { action: "draft" }>): Promise<DraftAttempt> => {
    let current = first;
    for (;;) {
      const parsed = parseAuthoredDag(current.dag);
      if (parsed.ok) return { ok: true, dag: parsed.dag };
      if (draftRepairs >= maxRepairs) {
        return { ok: false, outcome: { ok: false, reason: "repair-exhausted", problems: parsed.problems } };
      }
      draftRepairs++;
      rounds.repairs++;
      const t = await turn(
        `Your draft failed schema validation. Problems:\n${JSON.stringify(parsed.problems, null, 2)}\n` +
          `Current draft:\n${JSON.stringify(current.dag, null, 2)}\n` +
          `Return a corrected {"action":"draft","dag":{...}}.`,
      );
      if ("error" in t) return { ok: false, outcome: { ok: false, reason: "llm-error", problems: [t.error] } };
      if (t.action !== "draft") {
        return { ok: false, outcome: { ok: false, reason: "llm-error", problems: ["expected a corrected draft, got questions"] } };
      }
      current = t;
    }
  };

  // --- interview → first draft ---
  let draft: AuthoredDag | null = null;
  while (draft === null) {
    const mustDraft = rounds.questions >= maxQuestions;
    const t = await turn(mustDraft ? "No more questions — produce the draft now." : undefined);
    if ("error" in t) return { ok: false, reason: "llm-error", problems: [t.error] };
    if (t.action === "questions" && !mustDraft) {
      rounds.questions++;
      for (const q of t.questions) {
        const answer = await io.ask(q);
        conversation.push(`Q: ${q}\nA: ${answer}`);
      }
      continue;
    }
    if (t.action !== "draft") {
      return { ok: false, reason: "llm-error", problems: ["model kept asking questions past the round limit"] };
    }
    const attempt = await parseDraftWithRepairs(t);
    if (!attempt.ok) return attempt.outcome;
    draft = attempt.dag;
  }

  // --- validate → present → refine, until accept/abort ---
  for (;;) {
    // Repair loop: the draft must survive codegen + defineDag + lint.
    let verdict = await gauntlet(draft, root);
    while (!verdict.ok) {
      if (draftRepairs >= maxRepairs) {
        return {
          ok: false,
          reason: "repair-exhausted",
          problems: verdict.errors.map((e) => `${e.kind}: ${e.message}`),
        };
      }
      draftRepairs++;
      rounds.repairs++;
      const t = await turn(
        `Your draft failed validation. Structured violations:\n${JSON.stringify(verdict.errors, null, 2)}\n` +
          `Current draft:\n${JSON.stringify(draft, null, 2)}\n` +
          `Return a corrected {"action":"draft","dag":{...}}.`,
      );
      if ("error" in t) return { ok: false, reason: "llm-error", problems: [t.error] };
      if (t.action !== "draft") return { ok: false, reason: "llm-error", problems: ["expected a corrected draft, got questions"] };
      const attempt = await parseDraftWithRepairs(t);
      if (!attempt.ok) return attempt.outcome;
      draft = attempt.dag;
      verdict = await gauntlet(draft, root);
    }

    io.say(`\n${summarize(draft)}\n\n${authoredToMermaid(draft)}\n`);
    if (verdict.advisories.length > 0) {
      io.say(`Advisories:\n${verdict.advisories.map((a) => `  - ${a.kind}: ${a.message}`).join("\n")}`);
    }

    const answer = (await io.ask('Accept this DAG? ("yes" to write, "abort", or describe a refinement)')).trim();
    if (/^(yes|y|accept)$/i.test(answer)) break;
    if (/^(abort|no|quit|exit)$/i.test(answer)) {
      return { ok: false, reason: "aborted", problems: [] };
    }

    rounds.refinements++;
    draftRepairs = 0; // a refinement is a new draft — fresh repair budget
    conversation.push(`Refinement request: ${answer}`);
    const t = await turn(
      `Current accepted-so-far draft:\n${JSON.stringify(draft, null, 2)}\n` +
        `Apply the refinement above and return {"action":"draft","dag":{...}}.`,
    );
    if ("error" in t) return { ok: false, reason: "llm-error", problems: [t.error] };
    if (t.action !== "draft") return { ok: false, reason: "llm-error", problems: ["expected a refined draft, got questions"] };
    const attempt = await parseDraftWithRepairs(t);
    if (!attempt.ok) return attempt.outcome;
    draft = attempt.dag;
  }

  // --- accept: deterministic write of the final scaffold ---
  // The accepted draft is the user's work product — any write failure carries
  // the full serialized JSON so it can be saved and replayed via `new --from`.
  const withDraftJson = (problems: readonly string[]): readonly string[] => [
    ...problems,
    "accepted draft JSON follows",
    JSON.stringify(draft),
  ];
  let result: NewResult;
  try {
    result = await writeAuthoredScaffold(draft, {
      root,
      force: options.force ?? false,
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "write-failed",
      problems: withDraftJson([e instanceof Error ? e.message : String(e)]),
    };
  }
  if (!result.ok) {
    return { ok: false, reason: "write-failed", problems: withDraftJson(result.problems) };
  }
  return { ok: true, result, rounds };
};
