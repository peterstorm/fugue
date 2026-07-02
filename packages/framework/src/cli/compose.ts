// fugue compose — conversational DAG authoring (deterministic-core
// convergence, Phase B3).
//
// The loop is an explicit machine: interview → draft → validate → present →
// refine/accept. THE LLM'S ONLY OUTPUT CHANNEL IS THE AuthoredDag JSON —
// every turn is `sendStructured` against a closed Zod schema, graph code is
// always generated deterministically (`buildAuthoredScaffold`), and every
// draft is proven through the real gauntlet before the user sees it:
// codegen → `import` through `defineDag` (defineDag's structural checks,
// throws) → `fugue lint` (fan-in keys, passthrough, shape hints) → `fugue
// describe` (the DescribedDag whose Mermaid render — `describedToMermaid`,
// the same renderer `fugue visualize` uses — is what the user approves).
// Violations feed back to the LLM as structured JSON events, not prose. The
// LLM never hand-writes `defineDag`.
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
import { match } from "ts-pattern";
import { z } from "zod";
import type { LlmClient } from "../types/llm.js";
import { formatFrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import { parseAuthoredDag, type AuthoredDag } from "./authored.js";
import { runGauntlet, type GauntletResult } from "./gauntlet.js";
import { KEBAB } from "./identifiers.js";
import { describedToMermaid } from "./visualize.js";
import { writeAuthoredScaffold } from "./new.js";
import { DEFAULT_MODEL } from "./new-templates.js";
import { CONFIDENCE_BUCKET } from "./vocabulary.js";
import type { NewResult } from "./types.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * What a single terminal prompt produced. `closed` means the input stream is
 * GONE (Ctrl-C / Ctrl-D / piped stdin exhausted) — there is no user anymore,
 * so every ask site must abort the loop instead of treating the sentinel as
 * an answer and burning further LLM/gauntlet rounds against a dead terminal.
 */
export type ComposeAnswer =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "closed" };

/** Terminal seam — injectable so tests script the conversation. */
export interface ComposeIo {
  readonly ask: (question: string) => Promise<ComposeAnswer>;
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
      /** `gauntlet-failed` = the proving machinery itself threw (an environment failure, not a draft problem). */
      readonly reason: "aborted" | "llm-error" | "repair-exhausted" | "write-failed" | "gauntlet-failed";
      readonly problems: readonly string[];
      /**
       * The user's work product, carried as DATA so hitting a wall never
       * discards it: the most recent draft that survived the full gauntlet
       * (or, for gauntlet-/write-failures, the draft in flight). Absent only
       * when no draft existed yet, or on a deliberate abort. Replayable via
       * `fugue new --from`.
       */
      readonly draft?: AuthoredDag;
    };

// ---------------------------------------------------------------------------
// CLI argument parsing (pure — mirrors parseNewArgs' accumulate-all shape)
// ---------------------------------------------------------------------------

// KEBAB (single-sourced in `identifiers.ts`) — the same convention the
// AuthoredDag schema enforces on `team` and `fugue new` enforces on its path.

export interface ParsedComposeArgs {
  readonly ok: true;
  readonly options: ComposeOptions;
}
export interface ParseComposeError {
  readonly ok: false;
  readonly problems: readonly string[];
}

/**
 * Parse `fugue compose`'s arguments (everything after the `compose` token)
 * into validated `ComposeOptions`. Pure — no I/O, no `process.*`; the bin
 * keeps only readline/SIGINT/env-key wiring. Accumulates ALL problems rather
 * than failing on the first, so the author sees every fix at once (mirrors
 * `parseNewArgs`).
 */
export const parseComposeArgs = (args: readonly string[]): ParsedComposeArgs | ParseComposeError => {
  const problems: string[] = [];
  let intent: string | undefined;
  let team: string | undefined;
  let model: string | undefined;
  let owner: string | undefined;
  let root: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const takeValue = (flag: string): string | undefined => {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        problems.push(`${flag} requires a value`);
        return undefined;
      }
      i++;
      return value;
    };
    match(arg)
      .with("--team", () => {
        team = takeValue("--team");
      })
      .with("--model", () => {
        model = takeValue("--model");
      })
      .with("--owner", () => {
        owner = takeValue("--owner");
      })
      .with("--dir", () => {
        root = takeValue("--dir");
      })
      .with("--force", () => {
        force = true;
      })
      .otherwise((other) => {
        if (other.startsWith("--")) {
          problems.push(`unknown flag: ${other}`);
        } else if (intent === undefined) {
          intent = other;
        } else {
          problems.push(`unexpected argument: ${other}`);
        }
      });
  }

  if (intent === undefined) {
    problems.push('missing intent string (e.g. `fugue compose "Process refunds…" --team payments`)');
  }
  if (team === undefined) {
    problems.push("missing --team <team>");
  } else if (!KEBAB.test(team)) {
    // The team lands in the AuthoredDag (kebab-case there) and in the
    // dags/<team>/ directory name — reject junk at the boundary instead of
    // letting the first LLM draft fail schema validation on our own flag.
    problems.push(`--team '${team}' must be kebab-case (lowercase, digits, single dashes)`);
  }

  if (intent === undefined || team === undefined || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    options: {
      intent,
      team,
      force,
      ...(model !== undefined ? { model } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(root !== undefined ? { root } : {}),
    },
  };
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
- fugueAuthored: 1. name/team/node ids/case labels: kebab-case (name and
  node ids must start with a letter).
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
  {"kind":"enum","values":${JSON.stringify(CONFIDENCE_BUCKET)}} if you route on it.
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

  // The most recent draft that survived the full gauntlet. Budget/transport
  // failures attach it (the typed `draft` field) so hitting a wall never
  // discards work the user already saw proven.
  let lastProven: AuthoredDag | null = null;
  const failClosed = (
    reason: "llm-error" | "repair-exhausted",
    problems: readonly string[],
  ): Extract<ComposeOutcome, { ok: false }> => ({
    ok: false,
    reason,
    problems,
    ...(lastProven !== null ? { draft: lastProven } : {}),
  });

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
  // problems go back to the model as structured JSON and we re-turn. The
  // validated `--team` flag is enforced HERE too: it only reaches the model as
  // prose, so a drifting draft would otherwise pass every gate and write to
  // `dags/<the model's team>/` — a flag the user set must bind, not suggest.
  const parseDraftWithRepairs = async (first: Extract<ComposeTurn, { action: "draft" }>): Promise<DraftAttempt> => {
    let current = first;
    for (;;) {
      const parsed = parseAuthoredDag(current.dag);
      if (parsed.ok && parsed.dag.team === options.team) return { ok: true, dag: parsed.dag };
      const problems = parsed.ok
        ? [`team must be '${options.team}' (from --team), got '${parsed.dag.team}'`]
        : parsed.problems;
      if (draftRepairs >= maxRepairs) {
        return { ok: false, outcome: failClosed("repair-exhausted", problems) };
      }
      draftRepairs++;
      rounds.repairs++;
      const t = await turn(
        `Your draft failed schema validation. Problems:\n${JSON.stringify(problems, null, 2)}\n` +
          `Current draft:\n${JSON.stringify(current.dag, null, 2)}\n` +
          `Return a corrected {"action":"draft","dag":{...}}.`,
      );
      if ("error" in t) return { ok: false, outcome: failClosed("llm-error", [t.error]) };
      if (t.action !== "draft") {
        return { ok: false, outcome: failClosed("llm-error", ["expected a corrected draft, got questions"]) };
      }
      current = t;
    }
  };

  // --- interview → first draft ---
  let draft: AuthoredDag | null = null;
  while (draft === null) {
    const mustDraft = rounds.questions >= maxQuestions;
    const t = await turn(mustDraft ? "No more questions — produce the draft now." : undefined);
    if ("error" in t) return failClosed("llm-error", [t.error]);
    if (t.action === "questions" && !mustDraft) {
      rounds.questions++;
      for (const q of t.questions) {
        const answer = await io.ask(q);
        // A closed stream means there is no user — abort instead of recording
        // the sentinel as an answer and paying for further LLM rounds.
        if (answer.kind === "closed") return { ok: false, reason: "aborted", problems: [] };
        conversation.push(`Q: ${q}\nA: ${answer.text}`);
      }
      continue;
    }
    if (t.action !== "draft") {
      return failClosed("llm-error", ["model kept asking questions past the round limit"]);
    }
    const attempt = await parseDraftWithRepairs(t);
    if (!attempt.ok) return attempt.outcome;
    draft = attempt.dag;
  }

  // The gauntlet stages real files (mkdir → write → import → rm) — a throw
  // there is an ENVIRONMENT failure (ENOSPC, EACCES, …), not a draft problem.
  // Fail closed WITH the current draft's JSON so the work survives.
  type Proven =
    | { readonly ok: true; readonly verdict: GauntletResult }
    | { readonly ok: false; readonly outcome: ComposeOutcome };
  const prove = async (d: AuthoredDag): Promise<Proven> => {
    try {
      return { ok: true, verdict: await gauntlet(d, root) };
    } catch (e) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "gauntlet-failed",
          // Environment failures are debugged from this outcome alone — keep
          // the stack, not just the message.
          problems: [e instanceof Error ? (e.stack ?? e.message) : String(e)],
          draft: d,
        },
      };
    }
  };

  // --- validate → present → refine, until accept/abort ---
  for (;;) {
    // Repair loop: the draft must survive codegen + defineDag + lint.
    let proven = await prove(draft);
    if (!proven.ok) return proven.outcome;
    let verdict = proven.verdict;
    while (!verdict.ok) {
      if (draftRepairs >= maxRepairs) {
        return failClosed(
          "repair-exhausted",
          verdict.errors.map((e) => `${e.kind}: ${e.message}`),
        );
      }
      draftRepairs++;
      rounds.repairs++;
      const t = await turn(
        `Your draft failed validation. Structured violations:\n${JSON.stringify(verdict.errors, null, 2)}\n` +
          `Current draft:\n${JSON.stringify(draft, null, 2)}\n` +
          `Return a corrected {"action":"draft","dag":{...}}.`,
      );
      if ("error" in t) return failClosed("llm-error", [t.error]);
      if (t.action !== "draft") return failClosed("llm-error", ["expected a corrected draft, got questions"]);
      const attempt = await parseDraftWithRepairs(t);
      if (!attempt.ok) return attempt.outcome;
      draft = attempt.dag;
      proven = await prove(draft);
      if (!proven.ok) return proven.outcome;
      verdict = proven.verdict;
    }
    lastProven = draft;

    // The Mermaid preview is rendered from the gauntlet's DescribedDag — the
    // structure DERIVED from the actually-generated code (same renderer as
    // `fugue visualize`), not a re-encoding of the AuthoredDag. The user
    // approves the real thing.
    io.say(`\n${summarize(draft)}\n\n${describedToMermaid(verdict.described)}\n`);
    if (verdict.advisories.length > 0) {
      io.say(`Advisories:\n${verdict.advisories.map((a) => `  - ${a.kind}: ${a.message}`).join("\n")}`);
    }

    const res = await io.ask('Accept this DAG? ("yes" to write, "abort", or describe a refinement)');
    // Closed stream ⇒ nobody can accept — abort from here exactly like an
    // explicit "abort" answer (the draft was only ever staged, never written).
    if (res.kind === "closed") return { ok: false, reason: "aborted", problems: [] };
    const answer = res.text.trim();
    if (/^(yes|y|accept)$/i.test(answer)) {
      // --- accept: deterministic write of the final scaffold ---
      // Writing HERE (inside the loop) keeps the accepted verdict in scope, so
      // its advisories reach the machine-readable outcome — the NewResult
      // contract `runNewFrom` honors too. The accepted draft is the user's
      // work product: any write failure carries it as the typed `draft` field
      // so it can be saved and replayed via `fugue new --from`.
      let result: NewResult;
      try {
        result = await writeAuthoredScaffold(
          draft,
          {
            root,
            force: options.force ?? false,
            ...(options.owner !== undefined ? { owner: options.owner } : {}),
          },
          verdict.advisories,
        );
      } catch (e) {
        return {
          ok: false,
          reason: "write-failed",
          problems: [e instanceof Error ? (e.stack ?? e.message) : String(e)],
          draft,
        };
      }
      if (!result.ok) {
        return { ok: false, reason: "write-failed", problems: result.problems, draft };
      }
      return { ok: true, result, rounds };
    }
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
    if ("error" in t) return failClosed("llm-error", [t.error]);
    if (t.action !== "draft") return failClosed("llm-error", ["expected a refined draft, got questions"]);
    const attempt = await parseDraftWithRepairs(t);
    if (!attempt.ok) return attempt.outcome;
    draft = attempt.dag;
  }
};
