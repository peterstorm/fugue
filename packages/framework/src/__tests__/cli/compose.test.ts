// fugue compose (B3) — the loop with both seams scripted: a fake LlmClient
// returning canned ComposeTurns, and a scripted ComposeIo. No network, no
// TTY. The load-bearing assertions: the LLM's only channel is the AuthoredDag
// JSON (an accepted draft becomes files via the SAME deterministic writer as
// `new --from`), every draft passes the real gauntlet before the user sees
// it, and a draft the gauntlet rejects is repaired or the run fails closed.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok } from "../../types/result.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../types/llm.js";
import type { Result } from "../../types/result.js";
import type { FrameworkError } from "../../types/errors.js";
import {
  SYSTEM_PROMPT,
  parseComposeArgs,
  parseIntent,
  runCompose,
  type ComposeAnswer,
  type ComposeIo,
  type ComposeTurn,
  type Intent,
} from "../../cli/compose.js";
import { runDescribe } from "../../cli/describe.js";
import { runGauntlet, type GauntletResult } from "../../cli/gauntlet.js";
import { NODE_FACTORY_NAME, SHAPE_HELPER_NAME, parseKebab, type Kebab } from "../../cli/identifiers.js";
import { describedToMermaid } from "../../cli/visualize.js";
import { parseAuthoredDag, type AuthoredDag, type AuthoredDagInput } from "../../cli/authored.js";

const tmpRoot = resolve(__dirname, ".tmp-compose");

beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted seams
// ---------------------------------------------------------------------------

const scriptedLlm = (turns: readonly ComposeTurn[]): { client: LlmClient; requests: string[] } => {
  const queue = [...turns];
  const requests: string[] = [];
  const client: LlmClient = {
    async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
      requests.push(req.user);
      const turn = queue.shift();
      if (turn === undefined) throw new Error("scripted LLM ran out of turns");
      // The real client validates against req.schema; mirror that so a
      // scripted turn that wouldn't survive the API boundary fails the test.
      const parsed = req.schema.safeParse(turn);
      if (!parsed.success) throw new Error(`scripted turn failed schema: ${parsed.error.message}`);
      return ok({ output: parsed.data, tokensIn: 0, tokensOut: 0, rawText: JSON.stringify(turn) });
    },
    async sendWithTools(): Promise<never> {
      throw new Error("compose never uses tools");
    },
  };
  return { client, requests };
};

// Plain strings script typed answers; the CLOSED sentinel scripts the stream
// dying mid-conversation (Ctrl-C / Ctrl-D / piped stdin exhausted).
const CLOSED: ComposeAnswer = { kind: "closed" };

const scriptedIo = (
  answers: readonly (string | ComposeAnswer)[],
): { io: ComposeIo; said: string[]; asked: string[] } => {
  const queue = [...answers];
  const said: string[] = [];
  const asked: string[] = [];
  return {
    io: {
      ask: async (q) => {
        asked.push(q);
        const a = queue.shift();
        if (a === undefined) throw new Error(`scripted IO ran out of answers (asked: ${q})`);
        return typeof a === "string" ? { kind: "answer", text: a } : a;
      },
      say: (m) => {
        said.push(m);
      },
    },
    said,
    asked,
  };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const str = { kind: "string" as const };
const out = (...names: string[]) => ({ fields: names.map((name) => ({ name, type: str })) });

// `AuthoredDag` is branded — fixtures are the unbranded wire shape and are
// parsed (never cast) wherever a real AuthoredDag is needed.
const mustParse = (raw: unknown): AuthoredDag => {
  const parsed = parseAuthoredDag(raw);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.dag;
};

// `ComposeOptions.team` is branded — parse it (never cast), like mustParse.
const mustKebab = (raw: string): Kebab => {
  const parsed = parseKebab(raw);
  if (parsed === null) throw new Error(`not kebab-case: ${raw}`);
  return parsed;
};
const assist = mustKebab("assist");

// `ComposeOptions.intent` is branded too — same parse-don't-cast treatment.
const mustIntent = (raw: string): Intent => {
  const parsed = parseIntent(raw);
  if (parsed === null) throw new Error(`blank intent: ${JSON.stringify(raw)}`);
  return parsed;
};

const validDagInput: AuthoredDagInput = {
  fugueAuthored: 1,
  name: "compose-briefing",
  team: assist,
  description: "Briefing from two sources",
  input: out("region"),
  nodes: [
    { id: "fetch-weather", kind: "source", purpose: "Weather", output: out("forecast") },
    { id: "fetch-calendar", kind: "source", purpose: "Calendar", output: out("events") },
    { id: "join-all", kind: "transform", purpose: "Join sources", output: out("joined") },
    { id: "final", kind: "transform", purpose: "Assemble", output: out("region", "joined") },
  ],
  structure: { shape: "sources", sources: ["fetch-weather", "fetch-calendar"], join: "join-all", assemble: "final" },
};
const validDag = mustParse(validDagInput);

const refinedDag = mustParse({
  ...validDagInput,
  name: "compose-briefing-v2",
  description: "Briefing from two sources, refined",
});

const draft = (dag: unknown): ComposeTurn => ({ action: "draft", dag });

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("runCompose", () => {
  it("draft → accept writes the scaffold through the deterministic writer", async () => {
    const root = join(tmpRoot, "happy");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io, said } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("morning briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(`compose failed: ${outcome.reason} ${outcome.problems.join("; ")}`);

    expect(outcome.rounds).toEqual({ questions: 0, repairs: 0, refinements: 0 });
    expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.ts"));
    expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.authored.json"));
    // The user was shown the summary + the DESCRIBED render before accepting:
    // `describedToMermaid` over the gauntlet's DescribedDag (the same renderer
    // `fugue visualize` uses — title line, output node), so the approval is of
    // the ACTUAL generated DAG, not a re-encoding of the AuthoredDag JSON.
    const shown = said.join("\n");
    expect(shown).toContain("flowchart TD");
    expect(shown).toContain('title: "compose-briefing"');
    expect(shown).toContain('dag_output(["output"])');
  });

  it("clarifying questions round-trips answers into the next turn's context", async () => {
    const root = join(tmpRoot, "questions");
    const { client, requests } = scriptedLlm([
      { action: "questions", questions: ["Which sources?"] },
      draft(validDag),
    ]);
    const { io } = scriptedIo(["weather and calendar", "yes"]);

    const outcome = await runCompose({ intent: mustIntent("a briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.rounds.questions).toBe(1);
    expect(requests[1]).toContain("Q: Which sources?");
    expect(requests[1]).toContain("A: weather and calendar");
  });

  // The authoring schema + codegen make gauntlet failures nearly
  // unrepresentable by design, so the repair loop is exercised through the
  // injectable gauntlet seam: fail once with structured violations, then pass.
  const failingOnce = () => {
    let calls = 0;
    return async (dag: AuthoredDag, root: string): Promise<GauntletResult> => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          errors: [{ kind: "import-failed", message: "simulated duplicate declaration" }],
          advisories: [],
        };
      }
      return runGauntlet(dag, root);
    };
  };

  it("a gauntlet-failing draft is repaired with structured violations fed back", async () => {
    const root = join(tmpRoot, "repair");
    const repairedDag = { ...validDagInput, name: "compose-repair" };
    const { client, requests } = scriptedLlm([draft(repairedDag), draft(repairedDag)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root },
      client,
      io,
      failingOnce(),
    );
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    expect(outcome.rounds.repairs).toBe(1);
    // The repair prompt carried the structured violations, not prose.
    expect(requests[1]).toContain('"kind": "import-failed"');
    expect(requests[1]).toContain("Return a corrected");
  });

  it("fails closed when repairs are exhausted", async () => {
    const root = join(tmpRoot, "exhausted");
    const alwaysFail = async (): Promise<GauntletResult> => ({
      ok: false,
      errors: [{ kind: "import-failed", message: "never valid" }],
      advisories: [],
    });
    const { client } = scriptedLlm([draft(validDag), draft(validDag)]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root, maxRepairRounds: 1 },
      client,
      io,
      alwaysFail,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("repair-exhausted");
      expect(outcome.problems[0]).toContain("import-failed");
      // The failure arm carries the loop telemetry — repair-exhausted is
      // precisely where the repair count is diagnostic.
      expect(outcome.rounds).toEqual({ questions: 0, repairs: 1, refinements: 0 });
    }
  });

  it("a schema-invalid draft enters the repair loop and is fixed by a second draft", async () => {
    const root = join(tmpRoot, "schema-repair");
    // Structure references an unknown node — passes the wire envelope
    // (dag is `unknown` there) but fails parseAuthoredDag inside the loop.
    const invalid = {
      ...validDagInput,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client, requests } = scriptedLlm([
      { action: "draft", dag: invalid },
      draft({ ...validDagInput, name: "compose-schema-repair" }),
    ]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    expect(outcome.rounds.repairs).toBe(1);
    // The repair prompt carried the structured schema problems, not prose.
    expect(requests[1]).toContain("failed schema validation");
    expect(requests[1]).toContain("ghost");
  });

  it("exhausting the question rounds without a draft fails closed as llm-error", async () => {
    const root = join(tmpRoot, "question-exhaustion");
    const q = (text: string): ComposeTurn => ({ action: "questions", questions: [text] });
    const { client } = scriptedLlm([q("one?"), q("two?"), q("three?")]);
    const { io } = scriptedIo(["a1", "a2"]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root, maxQuestionRounds: 2 },
      client,
      io,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems[0]).toContain("past the round limit");
    }
  });

  it("write-failed carries the accepted draft as typed data so the work is never lost", async () => {
    const root = join(tmpRoot, "write-failed");
    const dir = join(root, "dags", "assist", "compose-briefing");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "occupied", "utf-8");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    // Narrow to the write-failed arm — its `draft` is REQUIRED by the type.
    if (outcome.ok || outcome.reason !== "write-failed") {
      throw new Error(`expected write-failed, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.problems.join("\n")).toContain("--force");
    expect(outcome.draft).toEqual(validDag);
    // The write-failed arm carries the loop telemetry too.
    expect(outcome.rounds).toEqual({ questions: 0, repairs: 0, refinements: 0 });
  });

  it("refinement requests produce a new draft that is re-proven before writing", async () => {
    const root = join(tmpRoot, "refine");
    const { client, requests } = scriptedLlm([draft(validDag), draft(refinedDag)]);
    const { io } = scriptedIo(["rename it to v2", "yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.rounds.refinements).toBe(1);
    expect(outcome.result.name as string).toBe("compose-briefing-v2");
    expect(requests[1]).toContain("Refinement request: rename it to v2");
  });

  it("the repair budget is per draft — a refinement resets it", async () => {
    const root = join(tmpRoot, "per-draft-budget");
    // Fail the FIRST gauntlet check of each draft (calls 1 and 3). With a
    // budget of 1 this only passes if the refinement resets the counter;
    // cumulative rounds.repairs still reports both.
    let calls = 0;
    const failFirstCheckPerDraft = async (dag: AuthoredDag, r: string) => {
      calls++;
      if (calls === 1 || calls === 3) {
        return {
          ok: false as const,
          errors: [{ kind: "import-failed" as const, message: "simulated" }],
          advisories: [],
        };
      }
      return runGauntlet(dag, r);
    };
    const refined = { ...validDagInput, name: "compose-per-draft" };
    const { client } = scriptedLlm([draft(validDag), draft(validDag), draft(refined), draft(refined)]);
    const { io } = scriptedIo(["rename it", "yes"]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root, maxRepairRounds: 1 },
      client,
      io,
      failFirstCheckPerDraft,
    );
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    expect(outcome.rounds.repairs).toBe(2);
    expect(outcome.rounds.refinements).toBe(1);
  });

  it("abort leaves nothing behind", async () => {
    const root = join(tmpRoot, "abort");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo(["abort"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("aborted");
      // Telemetry rides along on the failure arms too.
      expect(outcome.rounds).toEqual({ questions: 0, repairs: 0, refinements: 0 });
    }
    expect(await Bun.file(join(root, "dags", "assist", "compose-briefing", "dag.ts")).exists()).toBe(false);
  });

  it("a closed stream during the interview aborts before any further paid calls", async () => {
    const root = join(tmpRoot, "closed-interview");
    const { client, requests } = scriptedLlm([
      { action: "questions", questions: ["Which sources?"] },
      draft(validDag), // must never be consumed
    ]);
    const { io } = scriptedIo([CLOSED]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    // The dead terminal stopped the loop: exactly the one question turn, no
    // draft/gauntlet round against nobody.
    expect(requests).toHaveLength(1);
    expect(existsSync(join(root, "dags"))).toBe(false);
  });

  it("a closed stream MID multi-question round aborts without recording the sentinel or paying further rounds", async () => {
    const root = join(tmpRoot, "closed-mid-questions");
    const { client, requests } = scriptedLlm([
      { action: "questions", questions: ["Which sources?", "Which region?"] },
      draft(validDag), // must never be consumed
    ]);
    // First question answered; the stream dies on the second.
    const { io } = scriptedIo(["weather and calendar", CLOSED]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    // Exactly the one questions turn — the dead terminal must not trigger a
    // draft/gauntlet round against nobody.
    expect(requests).toHaveLength(1);
    expect(existsSync(join(root, "dags"))).toBe(false);
  });

  it("an empty accept-prompt answer re-asks with a hint instead of burning an LLM round", async () => {
    const root = join(tmpRoot, "empty-accept-answer");
    const { client, requests } = scriptedLlm([draft(validDag)]);
    // Bare Enter, whitespace-only, then a real accept.
    const { io, said, asked } = scriptedIo(["", "   ", "yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    // Exactly the one draft turn — blank input never became a
    // "Refinement request: " round.
    expect(requests).toHaveLength(1);
    expect(asked.filter((q) => q.startsWith("Accept this DAG?"))).toHaveLength(3);
    expect(said.join("\n")).toContain('Please answer "yes" to write, "abort" to quit, or describe a refinement.');
    expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.ts"));
  });

  it("a closed stream at the accept prompt aborts and writes nothing", async () => {
    const root = join(tmpRoot, "closed-accept");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo([CLOSED]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    expect(await Bun.file(join(root, "dags", "assist", "compose-briefing", "dag.ts")).exists()).toBe(false);
  });

  // sendStructured returning Err (transport/API failure) — distinct from the
  // scripted fake's throw-on-exhaustion, which would be a test bug.
  const erroringAfter = (turns: readonly ComposeTurn[]): LlmClient => {
    const queue = [...turns];
    return {
      async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
        const turn = queue.shift();
        if (turn === undefined) {
          return err({ kind: "cache-error", operation: "send", message: "socket hang up" });
        }
        const parsed = req.schema.safeParse(turn);
        if (!parsed.success) throw new Error(`scripted turn failed schema: ${parsed.error.message}`);
        return ok({ output: parsed.data, tokensIn: 0, tokensOut: 0, rawText: JSON.stringify(turn) });
      },
      async sendWithTools(): Promise<never> {
        throw new Error("compose never uses tools");
      },
    };
  };

  it("a transport error on the first turn fails closed as llm-error", async () => {
    const root = join(tmpRoot, "llm-error-first");
    const { io } = scriptedIo([]);
    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, erroringAfter([]), io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems[0]).toContain("socket hang up");
    }
  });

  it("a transport error after a proven draft carries that draft as typed data", async () => {
    const root = join(tmpRoot, "llm-error-carries-draft");
    // validDag is proven and presented; the refinement turn then dies on the wire.
    const { io } = scriptedIo(["rename it"]);
    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root },
      erroringAfter([draft(validDag)]),
      io,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "llm-error") {
      throw new Error(`expected llm-error, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.draft).toEqual(validDag);
  });

  it("repair-exhausted after a refinement carries the last proven draft's JSON", async () => {
    const root = join(tmpRoot, "exhausted-carries-draft");
    let calls = 0;
    const failFromSecondCall = async (dag: AuthoredDag, r: string) => {
      calls++;
      if (calls >= 2) {
        return {
          ok: false as const,
          errors: [{ kind: "import-failed" as const, message: "never valid" }],
          advisories: [],
        };
      }
      return runGauntlet(dag, r);
    };
    const { client } = scriptedLlm([draft(validDag), draft(refinedDag), draft(refinedDag)]);
    const { io } = scriptedIo(["make it worse"]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root, maxRepairRounds: 1 },
      client,
      io,
      failFromSecondCall,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "repair-exhausted") {
      throw new Error(`expected repair-exhausted, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.draft).toEqual(validDag);
    // The cumulative telemetry survives the failure: one refinement round
    // happened, and its draft burned the single repair budget.
    expect(outcome.rounds).toEqual({ questions: 0, repairs: 1, refinements: 1 });
  });

  it("a throwing gauntlet is an environment failure: gauntlet-failed WITH the typed draft", async () => {
    const root = join(tmpRoot, "gauntlet-throws");
    const throwing = async (): Promise<never> => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io, throwing);
    expect(outcome.ok).toBe(false);
    // Narrow to the gauntlet-failed arm — its `draft` is REQUIRED by the type.
    if (outcome.ok || outcome.reason !== "gauntlet-failed") {
      throw new Error(`expected gauntlet-failed, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.problems[0]).toContain("ENOSPC");
    // Environment failures keep the STACK, not just the message.
    expect(outcome.problems[0]).toContain("at ");
    expect(outcome.draft).toEqual(validDag);
    // Environment-failure arms carry the loop telemetry too.
    expect(outcome.rounds).toEqual({ questions: 0, repairs: 0, refinements: 0 });
  });

  it("schema-repair exhaustion fails closed with the schema problems", async () => {
    const root = join(tmpRoot, "schema-exhausted");
    const invalid = {
      ...validDagInput,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client } = scriptedLlm([
      { action: "draft", dag: invalid },
      { action: "draft", dag: invalid },
    ]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose(
      { intent: mustIntent("briefing"), team: assist, root, maxRepairRounds: 1 },
      client,
      io,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("repair-exhausted");
      expect(outcome.problems.join("\n")).toContain("ghost");
    }
  });

  it("a gauntlet-repair turn that returns questions fails closed as llm-error", async () => {
    // The GAUNTLET-failure repair loop (distinct from the schema-repair loop
    // below): the model must return a corrected draft, never more questions.
    const root = join(tmpRoot, "gauntlet-repair-got-questions");
    const alwaysFail = async (): Promise<GauntletResult> => ({
      ok: false,
      errors: [{ kind: "import-failed", message: "never valid" }],
      advisories: [],
    });
    const { client } = scriptedLlm([
      draft(validDag),
      { action: "questions", questions: ["are you sure?"] },
    ]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io, alwaysFail);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems.join("\n")).toContain("expected a corrected draft, got questions");
    }
  });

  it("a refinement turn that returns questions fails closed as llm-error, keeping the proven draft", async () => {
    const root = join(tmpRoot, "refine-got-questions");
    const { client } = scriptedLlm([
      draft(validDag),
      { action: "questions", questions: ["what would you like?"] },
    ]);
    const { io } = scriptedIo(["rename it"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "llm-error") {
      throw new Error(`expected llm-error, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.problems.join("\n")).toContain("expected a refined draft, got questions");
    // The proven draft rides along as typed data — the work is never lost.
    expect(outcome.draft).toEqual(validDag);
  });

  it("a schema-repair turn that returns questions fails closed as llm-error", async () => {
    const root = join(tmpRoot, "repair-got-questions");
    const invalid = {
      ...validDagInput,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client } = scriptedLlm([
      { action: "draft", dag: invalid },
      { action: "questions", questions: ["are you sure?"] },
    ]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems.join("\n")).toContain("got questions");
    }
  });

  it("a THROWING scaffold write fails closed as write-failed with the accepted draft", async () => {
    // `dags` is a regular file → isDirNonEmpty rethrows ENOTDIR inside
    // writeAuthoredScaffold; compose must catch it and keep the draft.
    const root = join(tmpRoot, "write-throws");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "dags"), "i am a file, not a directory", "utf-8");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "write-failed") {
      throw new Error(`expected write-failed, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.draft).toEqual(validDag);
  });

  it("gauntlet advisories reach both the user (io.say) and the machine-readable ok outcome", async () => {
    const root = join(tmpRoot, "advisories");
    const advisory = {
      kind: "redundant-passthrough" as const,
      message: "identity-shaped transform",
      nodeId: "join-all",
    };
    // Real gauntlet (so the DescribedDag / Mermaid render is genuine) with the
    // advisory tacked onto the ok verdict — codegen'd drafts are advisory-clean
    // by construction, so the seam is the only way to exercise the channel.
    const okWithAdvisory = async (dag: AuthoredDag, r: string): Promise<GauntletResult> => {
      const verdict = await runGauntlet(dag, r);
      return verdict.ok ? { ...verdict, advisories: [advisory] } : verdict;
    };
    const { client } = scriptedLlm([draft(validDag)]);
    const { io, said } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io, okWithAdvisory);
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    // (a) the ok outcome's NewResult carries the accepted verdict's advisories
    // (the contract runNewFrom honors — compose must not drop them).
    expect(outcome.result.advisories).toEqual([advisory]);
    // (b) the advisory display branch fired at the accept prompt.
    const shown = said.join("\n");
    expect(shown).toContain("Advisories:");
    expect(shown).toContain("redundant-passthrough: identity-shaped transform");
  });

  it("a draft whose team drifts from --team enters the repair loop like a schema failure", async () => {
    const root = join(tmpRoot, "team-drift");
    // "elsewhere" is schema-valid kebab — only the --team flag binds it.
    const drifted = { ...validDagInput, name: "compose-team-drift", team: "elsewhere" };
    const corrected = { ...validDagInput, name: "compose-team-drift" };
    const { client, requests } = scriptedLlm([draft(drifted), draft(corrected)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
    expect(outcome.rounds.repairs).toBe(1);
    expect(outcome.result.team as string).toBe("assist");
    // The repair prompt carried the team rule, structured like schema problems.
    expect(requests[1]).toContain("failed schema validation");
    expect(requests[1]).toContain("team must be 'assist' (from --team)");
    // Nothing ever lands under the drifted team's directory.
    expect(existsSync(join(root, "dags", "elsewhere"))).toBe(false);
  });

  // The accept prompt's closed vocabulary: yes/y/accept write (any case);
  // no/abort/quit/exit abort WITHOUT burning a refinement LLM round.
  const acceptVariants = ["y", "accept", "YES", "Accept"] as const;
  acceptVariants.forEach((answer, i) => {
    it(`accept variant '${answer}' writes the scaffold`, async () => {
      const root = join(tmpRoot, `accept-variant-${i}`);
      const { client } = scriptedLlm([draft(validDag)]);
      const { io } = scriptedIo([answer]);

      const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
      if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.problems.join("; ")}`);
      expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.ts"));
    });
  });

  const abortVariants = ["no", "quit", "exit", "No", "EXIT"] as const;
  abortVariants.forEach((answer, i) => {
    it(`abort variant '${answer}' aborts without burning an LLM round`, async () => {
      const root = join(tmpRoot, `abort-variant-${i}`);
      const { client, requests } = scriptedLlm([draft(validDag)]);
      const { io } = scriptedIo([answer]);

      const outcome = await runCompose({ intent: mustIntent("briefing"), team: assist, root }, client, io);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("aborted");
      // Exactly the one draft turn — the "no"-family never reaches the
      // refinement branch and its paid LLM call.
      expect(requests).toHaveLength(1);
      expect(existsSync(join(root, "dags"))).toBe(false);
    });
  });
});

// The system prompt's kind/shape vocabulary is DERIVED from the identifiers.ts
// catalogues (satisfies-checked Records make a missing entry a compile error);
// this pins the render — every closed-vocabulary token must actually reach
// the prompt text the model drafts against.
describe("SYSTEM_PROMPT vocabulary coverage", () => {
  it("names every node kind from the catalogue", () => {
    for (const kind of Object.keys(NODE_FACTORY_NAME)) {
      expect(SYSTEM_PROMPT).toContain(kind);
    }
  });

  it("names every shape from the catalogue", () => {
    for (const shape of Object.keys(SHAPE_HELPER_NAME)) {
      expect(SYSTEM_PROMPT).toContain(shape);
    }
  });
});

// ---------------------------------------------------------------------------
// Arg parsing — pure, accumulate-all (mirrors parseNewArgs' table style).
// ---------------------------------------------------------------------------

describe("parseComposeArgs", () => {
  it("parses a full invocation", () => {
    const parsed = parseComposeArgs([
      "Process refunds", "--team", "payments", "--model", "claude-x", "--owner", "p.h", "--dir", "root", "--force",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options).toEqual({
        intent: mustIntent("Process refunds"),
        team: mustKebab("payments"),
        model: "claude-x",
        owner: "p.h",
        root: "root",
        force: true,
      });
    }
  });

  it("parses the minimal invocation (intent + --team) with force defaulting off", () => {
    const parsed = parseComposeArgs(["a briefing", "--team", "assist"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options).toEqual({ intent: mustIntent("a briefing"), team: assist, force: false });
  });

  it("accepts flags before the intent", () => {
    const parsed = parseComposeArgs(["--team", "assist", "a briefing"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options).toMatchObject({ intent: mustIntent("a briefing"), team: assist });
  });

  // One rejection per rule — the parser must accumulate rather than die on
  // the first problem, so each needle must surface for its args.
  const rejections: readonly (readonly [string, readonly string[], string])[] = [
    ["a missing intent", ["--team", "assist"], "missing intent string"],
    // Whitespace-only gives the model nothing to draft from — the `Intent`
    // brand's rule, enforced at the arg boundary before any paid LLM round.
    ["a whitespace-only intent", ["   ", "--team", "assist"], "intent must be non-empty"],
    ["a missing --team", ["a briefing"], "missing --team"],
    ["a non-kebab --team", ["a briefing", "--team", "Bad_Team"], "kebab-case"],
    ["an unknown flag", ["a briefing", "--team", "assist", "--turbo"], "unknown flag: --turbo"],
    ["a second positional", ["a briefing", "another intent", "--team", "assist"], "unexpected argument: another intent"],
    ["--team followed by another flag", ["a briefing", "--team", "--force"], "--team requires a value"],
    ["--model followed by another flag", ["a briefing", "--team", "assist", "--model", "--force"], "--model requires a value"],
    ["--owner followed by another flag", ["a briefing", "--team", "assist", "--owner", "--force"], "--owner requires a value"],
    ["--dir at the end of the args", ["a briefing", "--team", "assist", "--dir"], "--dir requires a value"],
  ];
  for (const [label, args, needle] of rejections) {
    it(`rejects ${label}`, () => {
      const parsed = parseComposeArgs(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toContain(needle);
    });
  }

  it("accumulates multiple problems", () => {
    const parsed = parseComposeArgs([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fugue compose (subprocess)", () => {
  const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");

  it("rejects a non-kebab --team at the CLI boundary (before any API-key or LLM work)", async () => {
    const proc = Bun.spawn(["bun", binPath, "compose", "an intent", "--team", "Bad_Team"], {
      stdout: "pipe",
      stderr: "pipe",
      // No key on purpose: the arg parse must fire first — bad args emit the
      // problems JSON on stdout (like `new`), never the missing-key stderr
      // message.
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout) as { ok: boolean; problems?: string[] };
    expect(json.ok).toBe(false);
    expect(json.problems?.join("\n")).toContain("kebab-case");
    expect(stderr).not.toContain("ANTHROPIC_API_KEY");
  });

  it("a missing ANTHROPIC_API_KEY emits the problems JSON envelope on stdout, exit 1", async () => {
    // Valid args, no key: the failure must keep the machine-readable stdout
    // contract (`{ ok: false, problems }`), not bare stderr prose.
    const proc = Bun.spawn(["bun", binPath, "compose", "an intent", "--team", "assist"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout) as { ok: boolean; problems?: string[] };
    expect(json.ok).toBe(false);
    expect(json.problems?.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  it("SIGINT during the interactive wait aborts with the JSON outcome envelope and exit 1", async () => {
    // Non-TTY (piped stdin) exercises the PROCESS-level SIGINT handler: the
    // handler closes readline, the pending ask settles as closed, and the
    // loop returns the aborted outcome — the "only the final outcome line is
    // JSON" contract must hold on the interrupt path. The LLM turn is served
    // by a local mock (the Anthropic SDK honors ANTHROPIC_BASE_URL) that
    // returns a questions turn, parking compose on the interactive ask.
    const questionsTurn = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "structured_output",
          input: { action: "questions", questions: ["Which sources?"] },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(questionsTurn),
    });
    try {
      const proc = Bun.spawn(["bun", binPath, "compose", "a briefing", "--team", "assist"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
      });
      // Wait until compose is parked on the ask (the question prose reaches
      // stdout), then interrupt.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      while (!stdout.includes("Which sources?")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`compose exited before asking; stdout: ${stdout}`);
        stdout += decoder.decode(value, { stream: true });
      }
      proc.kill("SIGINT");
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(exitCode).toBe(1);
      // The handler said so on stderr (silence reads as a hang)…
      expect(stderr).toContain("interrupted");
      // …and the final stdout block is the machine-readable aborted outcome.
      const jsonBlock = stdout.match(/\{[\s\S]*\}\s*$/)?.[0];
      expect(jsonBlock).toBeDefined();
      const json = JSON.parse(jsonBlock!) as { ok: boolean; reason?: string; problems?: string[] };
      expect(json.ok).toBe(false);
      expect(json.reason).toBe("aborted");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  it("a SECOND SIGINT during an in-flight LLM round force-quits with exit 130", async () => {
    // The first interrupt closes readline and waits for the in-flight round;
    // if that round hangs (dead network, stuck API), a second Ctrl-C must not
    // be silently swallowed — it force-quits with the conventional SIGINT
    // exit code and says so on stderr. The mock server answers the first turn
    // with questions (so compose records an answer and starts a second LLM
    // round) and then HANGS the second round forever.
    const questionsTurn = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "structured_output",
          input: { action: "questions", questions: ["Which sources?"] },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    let llmCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        llmCalls++;
        if (llmCalls === 1) return Response.json(questionsTurn);
        return new Promise<Response>(() => {}); // hang the round forever
      },
    });
    try {
      const proc = Bun.spawn(["bun", binPath, "compose", "a briefing", "--team", "assist"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
      });
      // Wait until compose is parked on the ask, answer it, and wait for the
      // (hanging) second LLM round to be in flight.
      const outReader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      while (!stdout.includes("Which sources?")) {
        const { value, done } = await outReader.read();
        if (done) throw new Error(`compose exited before asking; stdout: ${stdout}`);
        stdout += decoder.decode(value, { stream: true });
      }
      proc.stdin.write("weather and calendar\n");
      await proc.stdin.flush();
      while (llmCalls < 2) await Bun.sleep(20);

      // First SIGINT: the notice lands on stderr, the round keeps hanging.
      proc.kill("SIGINT");
      const errReader = proc.stderr.getReader();
      let stderr = "";
      while (!stderr.includes("interrupted")) {
        const { value, done } = await errReader.read();
        if (done) throw new Error(`compose exited after the first SIGINT; stderr: ${stderr}`);
        stderr += decoder.decode(value, { stream: true });
      }

      // Second SIGINT: force-quit, exit 130.
      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      for (;;) {
        const { value, done } = await errReader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
      expect(exitCode).toBe(130);
      expect(stderr).toContain("force-quitting");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe("runGauntlet", () => {
  it("passes a valid draft and cleans up its staging dir AND the empty base", async () => {
    const root = join(tmpRoot, "gauntlet");
    await mkdir(root, { recursive: true });
    const result = await runGauntlet(validDag, root);
    expect(result.ok).toBe(true);
    // `warnings` is non-optional on the ok arm — always an array, empty when
    // every schema serialized cleanly (consumers never branch on presence).
    if (result.ok) expect(result.warnings).toEqual([]);
    // The whole .fugue-compose base is removed once the last draft dir is gone.
    expect(existsSync(join(root, ".fugue-compose"))).toBe(false);
  });

  it("carries describe's schema-serialization warnings on the ok verdict", async () => {
    // The generated code always serializes cleanly, so the warning channel is
    // exercised through the injectable describe seam: the real describe runs
    // (genuine DescribedDag) with a warning tacked on — the verdict must
    // thread it (the warnings-threading contract DescribeResult states: in-
    // process consumers never have to scrape stderr).
    const root = join(tmpRoot, "gauntlet-warnings");
    await mkdir(root, { recursive: true });
    const warning = "inputSchema: simulated serialization failure";
    const warningDescribe = async (path: string) => {
      const real = await runDescribe(path);
      if (!real.ok) throw new Error("expected the staged module to describe");
      return { ...real, warnings: [warning] };
    };
    const result = await runGauntlet(validDag, root, { describe: warningDescribe });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([warning]);
  });

  it("a describe failure AFTER lint passed flips the verdict, keeping lint's advisories", async () => {
    // Generated code makes this branch nearly unrepresentable (describe only
    // fails on a topologically-invalid dag lint would have caught) — exercise
    // it through the injectable describe seam.
    const root = join(tmpRoot, "gauntlet-describe-fails");
    await mkdir(root, { recursive: true });
    const failingDescribe = async (path: string) => ({
      ok: false as const,
      path,
      errors: [
        {
          kind: "describe-failed" as const,
          message: "simulated assemble failure",
          detail: { kind: "cache-error" as const, operation: "get", message: "simulated" },
        },
      ],
    });
    const result = await runGauntlet(validDag, root, { describe: failingDescribe });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.kind).toBe("describe-failed");
      // The real lint ran and passed — its (empty) advisories still ride along.
      expect(result.advisories).toEqual([]);
    }
    // The staging cleanup still ran despite the failure verdict.
    expect(existsSync(join(root, ".fugue-compose"))).toBe(false);
  });

  // The warn sink is an injectable GauntletDeps seam (default: stderr), so
  // the cleanup-failure paths are asserted with a plain captured-array fake —
  // no mocking framework, no process.stderr spying.
  const capturedWarn = (): { warn: (m: string) => void; warnings: string[] } => {
    const warnings: string[] = [];
    return { warn: (m) => void warnings.push(m), warnings };
  };

  it("an unexpected errno from the base rmdir warns and never masks the verdict", async () => {
    const root = join(tmpRoot, "gauntlet-base-warns");
    await mkdir(root, { recursive: true });
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const { warn, warnings } = capturedWarn();
    try {
      const result = await runGauntlet(validDag, root, {
        removeBase: () => Promise.reject(eacces),
        warn,
      });
      // The verdict survives — a base-cleanup failure must not replace it.
      expect(result.ok).toBe(true);
      const written = warnings.join("");
      expect(written).toContain("failed to remove compose staging base");
      expect(written).toContain("EACCES");
    } finally {
      // The injected rmdir never removed the (now empty) base — clear it for real.
      await rm(join(root, ".fugue-compose"), { recursive: true, force: true });
    }
  });

  it("ENOTEMPTY/ENOENT from the base rmdir are expected races — no warning", async () => {
    const root = join(tmpRoot, "gauntlet-base-races");
    await mkdir(root, { recursive: true });
    const { warn, warnings } = capturedWarn();
    try {
      for (const code of ["ENOTEMPTY", "ENOENT"] as const) {
        const raced = Object.assign(new Error(`${code}: simulated race`), { code });
        const result = await runGauntlet(validDag, root, {
          removeBase: () => Promise.reject(raced),
          warn,
        });
        expect(result.ok).toBe(true);
      }
      expect(warnings).toEqual([]);
    } finally {
      await rm(join(root, ".fugue-compose"), { recursive: true, force: true });
    }
  });

  it("a failing cleanup rm warns and never masks the verdict", async () => {
    const root = join(tmpRoot, "gauntlet-cleanup-warns");
    await mkdir(root, { recursive: true });
    const failingCleanup = () => Promise.reject(new Error("EACCES: permission denied"));
    const { warn, warnings } = capturedWarn();
    try {
      const result = await runGauntlet(validDag, root, { cleanup: failingCleanup, warn });
      // The verdict survives — a cleanup failure must not replace a proven draft.
      expect(result.ok).toBe(true);
      const written = warnings.join("");
      expect(written).toContain("failed to clean up compose staging dir");
      expect(written).toContain("EACCES");
    } finally {
      // The injected rm never removed the staging dir — clear it for real.
      await rm(join(root, ".fugue-compose"), { recursive: true, force: true });
    }
  });
});

// The Mermaid preview compose presents is `describedToMermaid` over the
// gauntlet's DescribedDag — the renderer itself (node tokens, injective id
// escaping, edge kinds, human-review styling) is covered by
// `visualize.test.ts`; the gauntlet round-trip below proves the DescribedDag
// carried on the ok verdict matches the authored structure.
describe("runGauntlet described payload", () => {
  it("the ok verdict carries the DescribedDag of the generated code", async () => {
    const root = join(tmpRoot, "gauntlet-described");
    await mkdir(root, { recursive: true });
    const result = await runGauntlet(validDag, root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.described.id).toBe("compose-briefing");
      expect(new Set(result.described.nodes.map((n) => n.id))).toEqual(
        new Set(validDag.nodes.map((n) => n.id)),
      );
      // The render the user approves comes straight from this payload.
      const diagram = describedToMermaid(result.described);
      expect(diagram).toContain("flowchart TD");
      expect(diagram).toContain('title: "compose-briefing"');
    }
  });
});
