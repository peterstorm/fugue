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
  authoredToMermaid,
  runCompose,
  type ComposeAnswer,
  type ComposeIo,
  type ComposeTurn,
} from "../../cli/compose.js";
import { runGauntlet } from "../../cli/gauntlet.js";
import type { AuthoredDag } from "../../cli/authored.js";

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

const validDag: AuthoredDag = {
  fugueAuthored: 1,
  name: "compose-briefing",
  team: "assist",
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

const refinedDag: AuthoredDag = {
  ...validDag,
  name: "compose-briefing-v2",
  description: "Briefing from two sources, refined",
};

const draft = (dag: AuthoredDag): ComposeTurn => ({ action: "draft", dag });

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("runCompose", () => {
  it("draft → accept writes the scaffold through the deterministic writer", async () => {
    const root = join(tmpRoot, "happy");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io, said } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: "morning briefing", team: "assist", root }, client, io);
    if (!outcome.ok) throw new Error(`compose failed: ${outcome.reason} ${outcome.problems.join("; ")}`);

    expect(outcome.rounds).toEqual({ questions: 0, repairs: 0, refinements: 0 });
    expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.ts"));
    expect(outcome.result.files).toContain(join("dags", "assist", "compose-briefing", "dag.authored.json"));
    // The user was shown the summary + mermaid before accepting.
    expect(said.join("\n")).toContain("flowchart TD");
  });

  it("clarifying questions round-trips answers into the next turn's context", async () => {
    const root = join(tmpRoot, "questions");
    const { client, requests } = scriptedLlm([
      { action: "questions", questions: ["Which sources?"] },
      draft(validDag),
    ]);
    const { io } = scriptedIo(["weather and calendar", "yes"]);

    const outcome = await runCompose({ intent: "a briefing", team: "assist", root }, client, io);
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
    return async (dag: AuthoredDag, root: string) => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          errors: [{ kind: "import-failed" as const, message: "simulated duplicate declaration" }],
          advisories: [],
        };
      }
      return runGauntlet(dag, root);
    };
  };

  it("a gauntlet-failing draft is repaired with structured violations fed back", async () => {
    const root = join(tmpRoot, "repair");
    const repairedDag: AuthoredDag = { ...validDag, name: "compose-repair" };
    const { client, requests } = scriptedLlm([draft(repairedDag), draft(repairedDag)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose(
      { intent: "briefing", team: "assist", root },
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
    const alwaysFail = async () => ({
      ok: false,
      errors: [{ kind: "import-failed" as const, message: "never valid" }],
      advisories: [],
    });
    const { client } = scriptedLlm([draft(validDag), draft(validDag)]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose(
      { intent: "briefing", team: "assist", root, maxRepairRounds: 1 },
      client,
      io,
      alwaysFail,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("repair-exhausted");
      expect(outcome.problems[0]).toContain("import-failed");
    }
  });

  it("a schema-invalid draft enters the repair loop and is fixed by a second draft", async () => {
    const root = join(tmpRoot, "schema-repair");
    // Structure references an unknown node — passes the wire envelope
    // (dag is `unknown` there) but fails parseAuthoredDag inside the loop.
    const invalid = {
      ...validDag,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client, requests } = scriptedLlm([
      { action: "draft", dag: invalid },
      draft({ ...validDag, name: "compose-schema-repair" }),
    ]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
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
      { intent: "briefing", team: "assist", root, maxQuestionRounds: 2 },
      client,
      io,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems[0]).toContain("past the round limit");
    }
  });

  it("write-failed carries the accepted draft JSON so the work is never lost", async () => {
    const root = join(tmpRoot, "write-failed");
    const dir = join(root, "dags", "assist", "compose-briefing");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "occupied", "utf-8");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo(["yes"]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("write-failed");
      expect(outcome.problems.join("\n")).toContain("--force");
      expect(outcome.problems).toContain("accepted draft JSON follows");
      expect(outcome.problems).toContain(JSON.stringify(validDag));
    }
  });

  it("refinement requests produce a new draft that is re-proven before writing", async () => {
    const root = join(tmpRoot, "refine");
    const { client, requests } = scriptedLlm([draft(validDag), draft(refinedDag)]);
    const { io } = scriptedIo(["rename it to v2", "yes"]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.rounds.refinements).toBe(1);
    expect(outcome.result.name).toBe("compose-briefing-v2");
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
    const refined: AuthoredDag = { ...validDag, name: "compose-per-draft" };
    const { client } = scriptedLlm([draft(validDag), draft(validDag), draft(refined), draft(refined)]);
    const { io } = scriptedIo(["rename it", "yes"]);

    const outcome = await runCompose(
      { intent: "briefing", team: "assist", root, maxRepairRounds: 1 },
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

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    expect(await Bun.file(join(root, "dags", "assist", "compose-briefing", "dag.ts")).exists()).toBe(false);
  });

  it("a closed stream during the interview aborts before any further paid calls", async () => {
    const root = join(tmpRoot, "closed-interview");
    const { client, requests } = scriptedLlm([
      { action: "questions", questions: ["Which sources?"] },
      draft(validDag), // must never be consumed
    ]);
    const { io } = scriptedIo([CLOSED]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    // The dead terminal stopped the loop: exactly the one question turn, no
    // draft/gauntlet round against nobody.
    expect(requests).toHaveLength(1);
    expect(existsSync(join(root, "dags"))).toBe(false);
  });

  it("a closed stream at the accept prompt aborts and writes nothing", async () => {
    const root = join(tmpRoot, "closed-accept");
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo([CLOSED]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
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
    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, erroringAfter([]), io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems[0]).toContain("socket hang up");
    }
  });

  it("a transport error after a proven draft carries that draft's JSON", async () => {
    const root = join(tmpRoot, "llm-error-carries-draft");
    // validDag is proven and presented; the refinement turn then dies on the wire.
    const { io } = scriptedIo(["rename it"]);
    const outcome = await runCompose(
      { intent: "briefing", team: "assist", root },
      erroringAfter([draft(validDag)]),
      io,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("llm-error");
      expect(outcome.problems).toContain("last proven draft JSON follows");
      expect(outcome.problems).toContain(JSON.stringify(validDag));
    }
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
      { intent: "briefing", team: "assist", root, maxRepairRounds: 1 },
      client,
      io,
      failFromSecondCall,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("repair-exhausted");
      expect(outcome.problems).toContain("last proven draft JSON follows");
      expect(outcome.problems).toContain(JSON.stringify(validDag));
    }
  });

  it("a throwing gauntlet is an environment failure: gauntlet-failed WITH the draft JSON", async () => {
    const root = join(tmpRoot, "gauntlet-throws");
    const throwing = async (): Promise<never> => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { client } = scriptedLlm([draft(validDag)]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io, throwing);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("gauntlet-failed");
      expect(outcome.problems[0]).toContain("ENOSPC");
      expect(outcome.problems).toContain("draft JSON follows");
      expect(outcome.problems).toContain(JSON.stringify(validDag));
    }
  });

  it("schema-repair exhaustion fails closed with the schema problems", async () => {
    const root = join(tmpRoot, "schema-exhausted");
    const invalid = {
      ...validDag,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client } = scriptedLlm([
      { action: "draft", dag: invalid },
      { action: "draft", dag: invalid },
    ]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose(
      { intent: "briefing", team: "assist", root, maxRepairRounds: 1 },
      client,
      io,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("repair-exhausted");
      expect(outcome.problems.join("\n")).toContain("ghost");
    }
  });

  it("a schema-repair turn that returns questions fails closed as llm-error", async () => {
    const root = join(tmpRoot, "repair-got-questions");
    const invalid = {
      ...validDag,
      structure: { shape: "sources", sources: ["fetch-weather", "ghost"], join: "join-all", assemble: "final" },
    };
    const { client } = scriptedLlm([
      { action: "draft", dag: invalid },
      { action: "questions", questions: ["are you sure?"] },
    ]);
    const { io } = scriptedIo([]);

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
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

    const outcome = await runCompose({ intent: "briefing", team: "assist", root }, client, io);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("write-failed");
      expect(outcome.problems).toContain("accepted draft JSON follows");
      expect(outcome.problems).toContain(JSON.stringify(validDag));
    }
  });
});

describe("fugue compose (subprocess)", () => {
  it("rejects a non-kebab --team at the CLI boundary (before any API-key or LLM work)", async () => {
    const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");
    const proc = Bun.spawn(["bun", binPath, "compose", "an intent", "--team", "Bad_Team"], {
      stdout: "pipe",
      stderr: "pipe",
      // No key on purpose: the team check must fire first, so this exits 2
      // (usage) rather than 1 (missing ANTHROPIC_API_KEY).
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("kebab-case");
  });
});

describe("runGauntlet", () => {
  it("passes a valid draft and cleans up its staging dir AND the empty base", async () => {
    const root = join(tmpRoot, "gauntlet");
    await mkdir(root, { recursive: true });
    const result = await runGauntlet(validDag, root);
    expect(result.ok).toBe(true);
    // The whole .fugue-compose base is removed once the last draft dir is gone.
    expect(existsSync(join(root, ".fugue-compose"))).toBe(false);
  });
});

describe("authoredToMermaid", () => {
  it("renders every node (n_-prefixed) and the $input edge", () => {
    const diagram = authoredToMermaid(validDag);
    for (const n of validDag.nodes) {
      expect(diagram).toContain(`n_${n.id.replace(/[^A-Za-z0-9_]/g, "_")}`);
    }
    expect(diagram).toContain("dag_input");
    expect(diagram.startsWith("flowchart TD")).toBe(true);
  });

  it("a node literally named 'dag-input' does not merge with the virtual input token", () => {
    const d: AuthoredDag = {
      fugueAuthored: 1,
      name: "merge-check",
      team: "assist",
      description: "d",
      input: { fields: [{ name: "id", type: str }] },
      nodes: [
        { id: "fetch-x", kind: "fetch", purpose: "x", output: out("x") },
        { id: "dag-input", kind: "transform", purpose: "y", output: out("y") },
      ],
      structure: { shape: "linear", order: ["fetch-x", "dag-input"] },
    };
    const diagram = authoredToMermaid(d);
    // The real node's token is n_dag_input; the virtual request node keeps dag_input.
    expect(diagram).toContain('n_dag_input["dag-input<br/>transform"]');
    expect(diagram).toContain("dag_input --> n_fetch_x");
    expect(diagram).toContain("n_fetch_x --> n_dag_input");
  });

  it("escapes quotes in router edge labels (when.equals is free text)", () => {
    const d: AuthoredDag = {
      fugueAuthored: 1,
      name: "router-escape",
      team: "assist",
      description: "d",
      input: { fields: [{ name: "id", type: str }] },
      nodes: [
        {
          id: "classify",
          kind: "fetch",
          purpose: "c",
          output: { fields: [{ name: "bucket", type: { kind: "enum", values: ['sm"all', "large"] } }] },
        },
        { id: "handle-small", kind: "transform", purpose: "s", output: out("v") },
        { id: "fallback", kind: "transform", purpose: "f", output: out("v") },
      ],
      structure: {
        shape: "router",
        classifier: "classify",
        cases: [{ label: "small", when: { field: "bucket", equals: 'sm"all' }, to: "handle-small" }],
        default: "fallback",
      },
    };
    const diagram = authoredToMermaid(d);
    expect(diagram).toContain("bucket = sm&quot;all");
    expect(diagram).not.toContain('sm"all');
  });
});
