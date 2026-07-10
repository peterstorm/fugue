// AuthoredDag (B1) + deterministic codegen (B2) — the load-bearing assertion
// mirrors new.test.ts: every shape the authoring schema accepts must generate
// a dag.ts that survives the real gauntlet (import through defineDag + lint),
// and `describe` on the generated code must match the authored structure
// (the roundtrip that makes AuthoredDag ⊇ DescribedDag one format family).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import fc from "fast-check";
import {
  parseAuthoredDag,
  parseAuthoredDagJson,
  type AuthoredDag,
  type AuthoredDagInput,
} from "../../cli/authored.js";
import { buildAuthoredScaffold } from "../../cli/authored-codegen.js";
import {
  RESERVED_IDENTIFIERS,
  dagLevelIdentifiers,
  generatedIdentifiersFor,
  type Kebab,
} from "../../cli/identifiers.js";
import { runGauntlet, type GauntletResult } from "../../cli/gauntlet.js";
import { nodeId } from "../../types/ids.js";
import { CONFIDENCE_FIELD } from "../../cli/vocabulary.js";
import { runNewFrom, writeAuthoredScaffold } from "../../cli/new.js";
import type { DescribedDag } from "../../describe/index.js";
import { runLint } from "../../cli/lint.js";
import { runDescribe } from "../../cli/describe.js";
import { runPromptsCheck } from "../../cli/prompts.js";

const tmpRoot = resolve(__dirname, ".tmp-authored");

beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures — one authored description per shape. Fixtures are the UNBRANDED
// wire shape; `AuthoredDag` is branded, so anything that consumes one goes
// through `mustParse` (parse, don't cast).
// ---------------------------------------------------------------------------

const str = { kind: "string" as const };
const out = (...names: string[]) => ({ fields: names.map((name) => ({ name, type: str })) });

const mustParse = (raw: unknown): AuthoredDag => {
  const parsed = parseAuthoredDag(raw);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.dag;
};

/** Narrow a fixture node to its output-carrying variants (test mutations only). */
const outputOf = (n: AuthoredDagInput["nodes"][number]) => {
  if (!("output" in n)) throw new Error(`node '${n.id}' has no output to mutate`);
  return n.output;
};

const FIXTURES: Record<string, AuthoredDagInput> = {
  linear: {
    fugueAuthored: 1,
    name: "authored-linear",
    team: "demo",
    description: "Fetch then summarize",
    input: out("id"),
    nodes: [
      { id: "fetch-record", kind: "fetch", purpose: "Load the record", output: out("id", "text") },
      { id: "summarize", kind: "transform", purpose: "Summarize the record", output: out("summary") },
    ],
    structure: { shape: "linear", order: ["fetch-record", "summarize"] },
  },
  // Exercises the number/boolean codegen arms (z.number()/z.boolean() +
  // 0/false defaults). Every other fixture uses only string/enum fields, so
  // without this the scalar-type branches emit into generated dag.ts untested.
  "linear-scalar-fields": {
    fugueAuthored: 1,
    name: "authored-scalar",
    team: "demo",
    description: "Fetch metrics then score them",
    input: out("id"),
    nodes: [
      {
        id: "fetch-metrics",
        kind: "fetch",
        purpose: "Load the metrics",
        output: {
          fields: [
            { name: "count", type: { kind: "number" } },
            { name: "active", type: { kind: "boolean" } },
            { name: "label", type: { kind: "string" } },
          ],
        },
      },
      {
        id: "score",
        kind: "transform",
        purpose: "Score the metrics",
        output: { fields: [{ name: "passed", type: { kind: "boolean" } }] },
      },
    ],
    structure: { shape: "linear", order: ["fetch-metrics", "score"] },
  },
  "linear-llm-review": {
    fugueAuthored: 1,
    name: "authored-review",
    team: "demo",
    description: "Draft a reply, gate behind approval",
    input: out("message"),
    nodes: [
      { id: "draft-reply", kind: "llm", purpose: "Draft a reply", output: out("reply") },
      { id: "approve", kind: "human-review", purpose: "Approve the drafted reply" },
    ],
    structure: { shape: "linear", order: ["draft-reply", "approve"] },
  },
  "linear-two-llm": {
    fugueAuthored: 1,
    name: "authored-two-llm",
    team: "demo",
    description: "Classify then draft with two model calls",
    input: out("message"),
    nodes: [
      { id: "classify", kind: "llm", purpose: "Classify the message", output: out("topic") },
      { id: "draft-reply", kind: "llm", purpose: "Draft a reply", output: out("reply") },
    ],
    structure: { shape: "linear", order: ["classify", "draft-reply"] },
  },
  "llm-after-review": {
    fugueAuthored: 1,
    name: "authored-llm-after-review",
    team: "demo",
    description: "Fetch, gate behind approval, then summarize",
    input: out("id"),
    nodes: [
      { id: "fetch-doc", kind: "fetch", purpose: "Load the document", output: out("text") },
      { id: "approve", kind: "human-review", purpose: "Approve the document" },
      { id: "summarize", kind: "llm", purpose: "Summarize the approved document", output: out("summary") },
    ],
    structure: { shape: "linear", order: ["fetch-doc", "approve", "summarize"] },
  },
  "fan-out": {
    fugueAuthored: 1,
    name: "authored-fan-out",
    team: "demo",
    description: "Parallel enrichment with a join",
    input: out("id"),
    nodes: [
      { id: "trigger", kind: "fetch", purpose: "Load the trigger", output: out("id") },
      { id: "enrich-a", kind: "fetch", purpose: "Enrich from A", output: out("a") },
      { id: "enrich-b", kind: "fetch", purpose: "Enrich from B", output: out("b") },
      { id: "merge", kind: "transform", purpose: "Merge the branches", output: out("a", "b") },
    ],
    structure: { shape: "fan-out", source: "trigger", branches: ["enrich-a", "enrich-b"], join: "merge" },
  },
  "fan-out-nojoin": {
    fugueAuthored: 1,
    name: "authored-fan-out-nojoin",
    team: "demo",
    description: "Parallel enrichment without a join",
    input: out("id"),
    nodes: [
      { id: "trigger", kind: "fetch", purpose: "Load the trigger", output: out("id") },
      { id: "enrich-a", kind: "fetch", purpose: "Enrich from A", output: out("a") },
      { id: "enrich-b", kind: "fetch", purpose: "Enrich from B", output: out("b") },
    ],
    structure: { shape: "fan-out", source: "trigger", branches: ["enrich-a", "enrich-b"] },
  },
  diamond: {
    fugueAuthored: 1,
    name: "authored-diamond",
    team: "demo",
    description: "Parallel branches that must reconverge",
    input: out("id"),
    nodes: [
      { id: "trigger", kind: "fetch", purpose: "Load the trigger", output: out("id") },
      { id: "left", kind: "fetch", purpose: "Left branch", output: out("l") },
      { id: "right", kind: "fetch", purpose: "Right branch", output: out("r") },
      { id: "join", kind: "transform", purpose: "Join the branches", output: out("l", "r") },
    ],
    structure: { shape: "diamond", source: "trigger", branches: ["left", "right"], join: "join" },
  },
  router: {
    fugueAuthored: 1,
    name: "authored-router",
    team: "demo",
    description: "Route by amount bucket",
    input: out("requestId"),
    nodes: [
      {
        id: "classify",
        kind: "fetch",
        purpose: "Classify the request",
        output: {
          fields: [
            { name: "requestId", type: str },
            { name: "bucket", type: { kind: "enum", values: ["small", "large"] } },
          ],
        },
      },
      { id: "auto-approve", kind: "transform", purpose: "Approve small", output: out("verdict") },
      { id: "manual-review", kind: "transform", purpose: "Queue large for review", output: out("verdict") },
    ],
    structure: {
      shape: "router",
      classifier: "classify",
      cases: [{ label: "small", when: { field: "bucket", equals: "small" }, to: "auto-approve" }],
      default: "manual-review",
    },
  },
  "router-llm": {
    fugueAuthored: 1,
    name: "authored-router-llm",
    team: "demo",
    description: "LLM classifier routing on its declared confidence bucket",
    input: out("message"),
    nodes: [
      {
        id: "classify",
        kind: "llm",
        purpose: "Classify the message",
        output: {
          fields: [
            { name: "topic", type: str },
            // The bucket enum declared EXPLICITLY — the only way to route on
            // confidence (the auto-injected field is not a predicate target).
            { name: "confidence", type: { kind: "enum", values: ["high", "medium", "low"] } },
          ],
        },
      },
      { id: "auto-handle", kind: "transform", purpose: "Handle a confident classification", output: out("verdict") },
      { id: "escalate", kind: "transform", purpose: "Escalate an uncertain classification", output: out("verdict") },
    ],
    structure: {
      shape: "router",
      classifier: "classify",
      cases: [{ label: "confident", when: { field: "confidence", equals: "high" }, to: "auto-handle" }],
      default: "escalate",
    },
  },
  "diamond-llm-join": {
    fugueAuthored: 1,
    name: "authored-diamond-llm",
    team: "demo",
    description: "Parallel branches joined by an LLM synthesis",
    input: out("id"),
    nodes: [
      { id: "trigger", kind: "fetch", purpose: "Load the trigger", output: out("id") },
      { id: "left", kind: "fetch", purpose: "Left branch", output: out("l") },
      { id: "right", kind: "fetch", purpose: "Right branch", output: out("r") },
      // The join is an LLM node: its derived input is the branch-keyed fan-in,
      // so buildInput must JSON.stringify the branch objects for the prompt.
      { id: "synthesize", kind: "llm", purpose: "Synthesize the branches", output: out("summary") },
    ],
    structure: { shape: "diamond", source: "trigger", branches: ["left", "right"], join: "synthesize" },
  },
  "router-llm-handler": {
    fugueAuthored: 1,
    name: "authored-router-handler",
    team: "demo",
    description: "Route to LLM case and default handlers",
    input: out("message"),
    nodes: [
      {
        id: "classify",
        kind: "fetch",
        purpose: "Classify the message",
        output: {
          fields: [
            { name: "message", type: str },
            { name: "bucket", type: { kind: "enum", values: ["simple", "complex"] } },
          ],
        },
      },
      // Both the case handler and the default are LLM nodes — they consume the
      // classifier's flat output fields (no fan-in), each with its own prompt.
      { id: "quick-reply", kind: "llm", purpose: "Draft a quick reply", output: out("reply") },
      { id: "deep-reply", kind: "llm", purpose: "Draft a thorough reply", output: out("reply") },
    ],
    structure: {
      shape: "router",
      classifier: "classify",
      cases: [{ label: "simple", when: { field: "bucket", equals: "simple" }, to: "quick-reply" }],
      default: "deep-reply",
    },
  },
  "sources-llm": {
    fugueAuthored: 1,
    name: "authored-sources",
    team: "demo",
    description: "Synthesize a briefing from two sources",
    input: out("region"),
    nodes: [
      { id: "fetch-weather", kind: "source", purpose: "Read the weather", output: out("forecast") },
      { id: "fetch-calendar", kind: "source", purpose: "Read the calendar", output: out("events") },
      { id: "synthesize", kind: "llm", purpose: "Write the briefing", output: out("briefing") },
      { id: "final", kind: "transform", purpose: "Attach the region", output: out("region", "briefing") },
    ],
    structure: { shape: "sources", sources: ["fetch-weather", "fetch-calendar"], join: "synthesize", assemble: "final" },
  },
  "sources-llm-assemble": {
    // The ASSEMBLE role as an LLM node: its derived input is the
    // `{ join, $input }` fan-in, so buildInput must JSON.stringify both AND
    // sanitize the `$input` key to the identifier-safe `_input` placeholder.
    fugueAuthored: 1,
    name: "authored-sources-assemble",
    team: "demo",
    description: "Assemble the briefing with an LLM over the join and the request",
    input: out("region"),
    nodes: [
      { id: "fetch-weather", kind: "source", purpose: "Read the weather", output: out("forecast") },
      { id: "fetch-calendar", kind: "source", purpose: "Read the calendar", output: out("events") },
      { id: "join-all", kind: "transform", purpose: "Join the sources", output: out("joined") },
      { id: "write-brief", kind: "llm", purpose: "Write the briefing", output: out("briefing") },
    ],
    structure: { shape: "sources", sources: ["fetch-weather", "fetch-calendar"], join: "join-all", assemble: "write-brief" },
  },
};

// ---------------------------------------------------------------------------
// B1 — schema accepts the fixtures, rejects structural lies
// ---------------------------------------------------------------------------

describe("AuthoredDag schema", () => {
  for (const [label, fixture] of Object.entries(FIXTURES)) {
    it(`accepts the ${label} fixture`, () => {
      const parsed = parseAuthoredDag(fixture);
      if (!parsed.ok) throw new Error(parsed.problems.join("; "));
      expect(parsed.ok).toBe(true);
    });
  }

  const reject = (mutate: (dag: AuthoredDagInput) => unknown, needle: string) => {
    const raw = mutate(structuredClone(FIXTURES.router!) as AuthoredDagInput);
    const parsed = parseAuthoredDag(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain(needle);
  };

  it("rejects unknown node references in the structure", () => {
    reject((d) => ({ ...d, structure: { ...d.structure, default: "ghost" } }), "unknown node 'ghost'");
  });

  it("rejects nodes not referenced by the structure", () => {
    reject(
      (d) => ({ ...d, nodes: [...d.nodes, { id: "orphan", kind: "transform", purpose: "x", output: out("y") }] }),
      "not referenced",
    );
  });

  it("rejects router predicates on non-enum fields", () => {
    reject(
      (d) => ({
        ...d,
        structure: {
          ...(d.structure as Extract<AuthoredDagInput["structure"], { shape: "router" }>),
          cases: [{ label: "small", when: { field: "requestId", equals: "x" }, to: "auto-approve" }],
        },
      }),
      "must be an enum",
    );
  });

  it("rejects router equals outside the enum values", () => {
    reject(
      (d) => ({
        ...d,
        structure: {
          ...(d.structure as Extract<AuthoredDagInput["structure"], { shape: "router" }>),
          cases: [{ label: "small", when: { field: "bucket", equals: "huge" }, to: "auto-approve" }],
        },
      }),
      "not a value of enum",
    );
  });

  it("rejects source-kind nodes outside the sources shape", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (d.nodes[0] as { kind: string }).kind = "source";
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.join("\n")).toContain("source nodes belong to the sources shape");
    }
  });

  it("rejects human-review outside linear (a fan-out branch gate)", () => {
    const d = structuredClone(FIXTURES["fan-out"]!) as AuthoredDagInput;
    // Replace the enrich-b branch with a human-review gate — schema-shaped
    // (no output) but placed in a shape that cannot host one.
    d.nodes[2] = { id: "enrich-b", kind: "human-review", purpose: "Gate branch B" };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain('requires shape "linear"');
  });

  it("rejects human-review as first node / with output", () => {
    const first = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDagInput;
    (first.structure as { order: string[] }).order = ["approve", "draft-reply"];
    const p1 = parseAuthoredDag(first);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain("cannot be the first node");

    // The kind/output dependency is a discriminated union now — the message
    // must still state the RULE (the repair loop feeds it to an LLM), not
    // just Zod's default "unrecognized key".
    const withOut = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDagInput;
    (withOut.nodes[1] as { output?: unknown }).output = out("x");
    const parsed = parseAuthoredDag(withOut);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("must not declare output");
  });

  it("rejects a missing output on every kind that requires one, stating the RULE", () => {
    for (const kind of ["fetch", "transform", "llm", "source"] as const) {
      // sources-llm exercises every role: mutate a source node for "source",
      // the llm join for the rest — only the stripped output should fail.
      const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
      const idx = kind === "source" ? 0 : 2;
      (d.nodes[idx] as { kind: string }).kind = kind;
      delete (d.nodes[idx] as { output?: unknown }).output;
      const parsed = parseAuthoredDag(d);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        // The repair loop feeds this to an LLM: the message must state the
        // kind/output rule, not just Zod's "expected object, received
        // undefined" shape complaint.
        const problem = parsed.problems.find((p) => p.startsWith(`nodes.${idx}.output`));
        expect(problem).toBeDefined();
        expect(problem).toContain(
          "output is required for fetch/transform/llm/source nodes — only human-review nodes omit it",
        );
      }
    }
  });

  it("names the full kind vocabulary on an unknown or missing node kind", () => {
    // The discriminated union's default for a bad discriminator is a bare
    // "Invalid input" — useless to the compose repair loop, so the union
    // error map must name the full kind vocabulary.
    const vocabulary = '"fetch"|"transform"|"llm"|"human-review"|"source"';

    const unknown = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (unknown.nodes[0] as { kind: string }).kind = "fletch";
    const p1 = parseAuthoredDag(unknown);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain(`node kind must be one of ${vocabulary}`);

    const missing = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    delete (missing.nodes[0] as { kind?: string }).kind;
    const p2 = parseAuthoredDag(missing);
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.problems.join("\n")).toContain(`node kind must be one of ${vocabulary}`);
  });

  it("reports stray sibling keys alongside the human-review output rule (one issue, both facts)", () => {
    // `output` and `extra` arrive in the SAME unrecognized_keys issue; the
    // custom message must not swallow "extra" or the repair loop burns a
    // round discovering it.
    const d = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDagInput;
    (d.nodes[1] as Record<string, unknown>).output = out("x");
    (d.nodes[1] as Record<string, unknown>).extra = "stray";
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const problem = parsed.problems.find((p) => p.includes("must not declare output"));
      expect(problem).toBeDefined();
      expect(problem).toContain('also unrecognized: "extra"');
    }
  });

  it("keeps Zod's default unrecognized-keys message when a human-review stray is not output", () => {
    const d = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDagInput;
    (d.nodes[1] as Record<string, unknown>).extra = "stray";
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const all = parsed.problems.join("\n");
      expect(all).toContain('Unrecognized key: "extra"');
      expect(all).not.toContain("must not declare output");
    }
  });

  it("rejects reserved node ids (they collide with generated identifiers)", () => {
    // "opts" is the llm dag-factory parameter binding: a node const named
    // `opts` would be shadowed inside `create<Pascal>Dag = (opts = {}) =>`,
    // handing `{}` to defineDag instead of the node.
    for (const id of ["dag", "input", "registration", "opts"]) {
      const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
      (d.nodes[1] as { id: string }).id = id;
      (d.structure as { order: string[] }).order = ["fetch-record", id];
      const parsed = parseAuthoredDag(d);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("reserved");
    }
  });

  it("rejects invalid JSON text", () => {
    expect(parseAuthoredDagJson("{nope").ok).toBe(false);
  });

  it('rejects a non-kebab team ("Bad_Team")', () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (d as { team: string }).team = "Bad_Team";
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("team must be kebab-case");
  });

  it("parses team into the branded Kebab (proof rides on the parsed dag)", () => {
    const dag = mustParse(FIXTURES.linear!);
    // Compile-time: `team` carries the brand, so brand-demanding consumers
    // (runCompose's --team comparison) type-check without a cast.
    const team: Kebab = dag.team;
    expect(team as string).toBe("demo");
  });

  it("rejects a newline in purpose / dag description / field description", () => {
    const purpose = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (purpose.nodes[0] as { purpose: string }).purpose = "line one\n// injected";
    const p = parseAuthoredDag(purpose);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problems.join("\n")).toContain("single line");

    const desc = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (desc as { description: string }).description = "line one\nline two";
    expect(parseAuthoredDag(desc).ok).toBe(false);

    const field = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (field.input.fields[0] as { description?: string }).description = "line one\nline two";
    expect(parseAuthoredDag(field).ok).toBe(false);
  });

  it("rejects U+2028/U+2029 in purpose / dag description / field description (JS line terminators)", () => {
    // JS honors LINE SEPARATOR and PARAGRAPH SEPARATOR as source line
    // terminators — they end `//` comments exactly like \n, so a purpose
    // carrying one would break out of the generated comment into code
    // position. The schema must reject the FULL LineTerminator set.
    for (const terminator of ["\u2028", "\u2029"]) {
      const purpose = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
      (purpose.nodes[0] as { purpose: string }).purpose = `x${terminator}globalThis.__PWNED=1`;
      const p = parseAuthoredDag(purpose);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.problems.join("\n")).toContain("single line");

      const desc = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
      (desc as { description: string }).description = `line one${terminator}line two`;
      expect(parseAuthoredDag(desc).ok).toBe(false);

      const field = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
      (field.input.fields[0] as { description?: string }).description = `a${terminator}b`;
      expect(parseAuthoredDag(field).ok).toBe(false);

      const enumValue = structuredClone(FIXTURES.router!) as AuthoredDagInput;
      const bucket = outputOf(enumValue.nodes[0]!).fields[1]! as { type: { kind: string; values: readonly string[] } };
      bucket.type = { kind: "enum", values: [`small${terminator}injected`, "large"] };
      expect(parseAuthoredDag(enumValue).ok).toBe(false);
    }
  });

  it("comment() scrubs U+2028/U+2029 at the emission site (defense-in-depth behind the schema)", () => {
    // The schema (above) is the first line of defense, so a BRANDED dag can
    // never carry these — bypass the brand deliberately (the only cast in
    // this suite) to prove the second layer holds on its own: were a
    // terminator ever to reach codegen, the emitted module must not contain
    // it in comment position.
    const hostile = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    for (const n of hostile.nodes) {
      (n as { purpose: string }).purpose = "x\u2028globalThis.__PWNED=1\u2029y";
    }
    const scaffold = buildAuthoredScaffold(hostile as unknown as AuthoredDag);
    expect(scaffold.dagTs).not.toContain("\u2028");
    expect(scaffold.dagTs).not.toContain("\u2029");
    expect(scaffold.dagTs).toContain("x globalThis.__PWNED=1 y");
  });

  it("rejects '{{' in purpose/description/enum values (prompt-placeholder injection)", () => {
    // A hostile purpose "... {{text}} ..." on an llm node whose derived input
    // carries a `text` field would reach the generated prompt body, where the
    // runtime's interpolatePrompt replaceAll-substitutes `{{text}}` with the
    // RUNTIME input -- silent injection that passes the entire gauntlet (which
    // never renders prompts). The schema must reject the opener everywhere.
    const purpose = structuredClone(FIXTURES["llm-after-review"]!) as AuthoredDagInput;
    (purpose.nodes[2] as { purpose: string }).purpose = "Summarize {{text}} nicely";
    const p = parseAuthoredDag(purpose);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problems.join("\n")).toContain("must not contain '{{'");

    const desc = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (desc as { description: string }).description = "a {{id}} b";
    expect(parseAuthoredDag(desc).ok).toBe(false);

    const field = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (field.input.fields[0] as { description?: string }).description = "a {{id}} b";
    expect(parseAuthoredDag(field).ok).toBe(false);

    const enumValue = structuredClone(FIXTURES.router!) as AuthoredDagInput;
    const bucket = outputOf(enumValue.nodes[0]!).fields[1]! as {
      type: { kind: string; values: readonly string[] };
    };
    bucket.type = { kind: "enum", values: ["{{requestId}}", "large"] };
    expect(parseAuthoredDag(enumValue).ok).toBe(false);
  });

  it("promptText() scrubs '{{' at the prompt emission site (defense-in-depth behind the schema)", () => {
    // The schema (above) is the first line of defense, so a BRANDED dag can
    // never carry `{{` -- bypass the brand deliberately (mirroring the
    // comment() scrub test) to prove the second layer holds on its own: were
    // a hostile purpose ever to reach codegen, the emitted prompt must not
    // contain a substitutable `{{text}}` in the Task line.
    const hostile = structuredClone(FIXTURES["llm-after-review"]!) as AuthoredDagInput;
    (hostile.nodes[2] as { purpose: string }).purpose = "Summarize {{text}} nicely";
    const scaffold = buildAuthoredScaffold(hostile as unknown as AuthoredDag);
    const prompt = scaffold.prompts[0]!;
    // The authored `{{` is neutralized in the Task line...
    expect(prompt.body).toContain("Task: Summarize { {text}} nicely");
    expect(prompt.body).not.toContain("Task: Summarize {{text}}");
    // ...while the codegen-emitted (legitimate) placeholder survives untouched.
    expect(prompt.body).toContain("text: {{text}}");
  });

  it("promptText() scrub survives odd/overlapping brace runs — no '{{' re-created", () => {
    // The literal-pair replacement (`{{` → `{ {`) re-created `{{` from odd
    // runs: `"{{{text}}"` → `"{ {{text}}"`, still a live placeholder. The
    // lookahead scrub must leave NO `{{` in the authored text's emission site
    // (the Task line) for exactly that adversarial class.
    for (const purpose of ["Summarize {{{text}} nicely", "Braces {{{{ galore"]) {
      const hostile = structuredClone(FIXTURES["llm-after-review"]!) as AuthoredDagInput;
      (hostile.nodes[2] as { purpose: string }).purpose = purpose;
      const scaffold = buildAuthoredScaffold(hostile as unknown as AuthoredDag);
      const taskLine = scaffold.prompts[0]!.body
        .split("\n")
        .find((line) => line.includes("Task:"));
      expect(taskLine).toBeDefined();
      expect(taskLine!).not.toContain("{{");
    }
  });

  it("rejects a node id that camelCases to a JS reserved word", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (d.nodes[1] as { id: string }).id = "default";
    (d.structure as { order: string[] }).order = ["fetch-record", "default"];
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("reserved word 'default'");
  });

  it("rejects an llm node id whose factory collides with a framework import", () => {
    // llm "llm-node" would generate `createLlmNode` — the framework import.
    const d: AuthoredDagInput = {
      fugueAuthored: 1,
      name: "x-llm",
      team: "demo",
      description: "d",
      input: out("id"),
      nodes: [
        { id: "fetch-record", kind: "fetch", purpose: "Load", output: out("text") },
        { id: "llm-node", kind: "llm", purpose: "Reply", output: out("reply") },
      ],
      structure: { shape: "linear", order: ["fetch-record", "llm-node"] },
    };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("createLlmNode");
  });

  it("rejects node ids whose digit-boundary camelCase forms collide ('a-1b' vs 'a1b')", () => {
    const d: AuthoredDagInput = {
      fugueAuthored: 1,
      name: "x-collide",
      team: "demo",
      description: "d",
      input: out("id"),
      nodes: [
        { id: "a-1b", kind: "fetch", purpose: "One", output: out("x") },
        { id: "a1b", kind: "transform", purpose: "Two", output: out("y") },
      ],
      structure: { shape: "linear", order: ["a-1b", "a1b"] },
    };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const all = parsed.problems.join("\n");
      expect(all).toContain("'a-1b' and 'a1b'");
      expect(all).toContain("a1b, A1bSchema, A1bFanIn");
    }
  });

  it("rejects an llm node id colliding with a non-llm node's const ('foo' vs 'foo-node')", () => {
    const d: AuthoredDagInput = {
      fugueAuthored: 1,
      name: "x-foo",
      team: "demo",
      description: "d",
      input: out("id"),
      nodes: [
        { id: "foo", kind: "llm", purpose: "One", output: out("x") },
        { id: "foo-node", kind: "transform", purpose: "Two", output: out("y") },
      ],
      structure: { shape: "linear", order: ["foo", "foo-node"] },
    };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("fooNode");
  });

  it("rejects '__proto__' as a field name (object-literal prototype setter)", () => {
    // `{ __proto__: z.string() }` in generated code SETS THE PROTOTYPE instead
    // of declaring a field — the field would silently not exist while passing
    // the whole gauntlet. Both the DAG input and node outputs must reject it.
    const inInput = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (inInput.input.fields[0] as { name: string }).name = "__proto__";
    const p1 = parseAuthoredDag(inInput);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain("__proto__");

    const inOutput = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (outputOf(inOutput.nodes[1]!).fields[0] as { name: string }).name = "__proto__";
    expect(parseAuthoredDag(inOutput).ok).toBe(false);

    // Hostile JSON path too: the same dag arriving as wire text.
    const viaJson = parseAuthoredDagJson(JSON.stringify(inInput));
    expect(viaJson.ok).toBe(false);
  });

  it("rejects leading-digit node ids and dag names (invalid JS identifiers)", () => {
    const nodeD = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (nodeD.nodes[1] as { id: string }).id = "2fast";
    (nodeD.structure as { order: string[] }).order = ["fetch-record", "2fast"];
    const p1 = parseAuthoredDag(nodeD);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain("starting with a letter");

    const nameD = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (nameD as { name: string }).name = "2fast-pipeline";
    expect(parseAuthoredDag(nameD).ok).toBe(false);
  });

  it("rejects node ids that are strict-mode reserved words ('with', 'debugger', 'eval', 'arguments')", () => {
    for (const id of ["with", "debugger", "eval", "arguments"]) {
      const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
      (d.nodes[1] as { id: string }).id = id;
      (d.structure as { order: string[] }).order = ["fetch-record", id];
      const parsed = parseAuthoredDag(d);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toContain(`reserved word '${id}'`);
    }
  });

  it("rejects enum values containing a newline", () => {
    const d = structuredClone(FIXTURES.router!) as AuthoredDagInput;
    const bucket = outputOf(d.nodes[0]!).fields[1]! as { type: { kind: string; values: readonly string[] } };
    bucket.type = { kind: "enum", values: ["small\ninjected", "large"] };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("single line");
  });

  it("rejects duplicate router {field, equals} predicates (unreachable case)", () => {
    reject(
      (d) => {
        const s = d.structure as Extract<AuthoredDagInput["structure"], { shape: "router" }>;
        return {
          ...d,
          structure: {
            ...s,
            cases: [
              ...s.cases,
              { label: "small-again", when: { field: "bucket", equals: "small" }, to: "manual-review" },
            ],
          },
        };
      },
      "duplicate predicate",
    );
  });

  it("rejects duplicate enum values", () => {
    const d = structuredClone(FIXTURES.router!) as AuthoredDagInput;
    const bucket = outputOf(d.nodes[0]!).fields[1]! as { type: { kind: string; values: readonly string[] } };
    bucket.type = { kind: "enum", values: ["small", "small"] };
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("duplicate enum value 'small'");
  });

  it("rejects a sources join of kind source", () => {
    const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
    (d.nodes[2] as { kind: string }).kind = "source"; // synthesize, the join
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("join 'synthesize' must not be a source node");
  });

  it("rejects a sources assemble of kind source", () => {
    const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
    (d.nodes[3] as { kind: string }).kind = "source"; // final, the assemble
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("assemble 'final' must not be a source node");
  });

  it("rejects a sources entry that is not of kind source", () => {
    const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
    (d.nodes[0] as { kind: string }).kind = "fetch"; // fetch-weather, a sources[] entry
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.join("\n")).toContain(`sources entry 'fetch-weather' must be kind "source"`);
    }
  });

  it("rejects a node referenced more than once in the structure", () => {
    // Point the router default at the case handler: auto-approve now plays
    // two roles (accumulate-all also flags the orphaned manual-review).
    reject(
      (d) => ({ ...d, structure: { ...d.structure, default: "auto-approve" } }),
      "each node plays exactly one role",
    );
  });

  it("rejects duplicate router case labels", () => {
    reject(
      (d) => {
        const s = d.structure as Extract<AuthoredDagInput["structure"], { shape: "router" }>;
        return {
          ...d,
          structure: {
            ...s,
            cases: [
              ...s.cases,
              // Same label, different predicate — isolates the label rule from
              // the duplicate-predicate rule.
              { label: "small", when: { field: "bucket", equals: "large" }, to: "manual-review" },
            ],
          },
        };
      },
      "duplicate label 'small'",
    );
  });

  it("rejects duplicate node ids", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    d.nodes.push({ id: "summarize", kind: "transform", purpose: "Impostor", output: out("z") });
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("duplicate node id 'summarize'");
  });

  it("rejects duplicate field names in a schema spec", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (d.input.fields as { name: string; type: unknown }[]).push({ name: "id", type: str });
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("duplicate field name 'id'");
  });

  it("rejects a wrong fugueAuthored version literal", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDagInput;
    (d as { fugueAuthored: number }).fugueAuthored = 2;
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("fugueAuthored");
  });

  it("rejects an llm 'confidence' output field that is not the exact bucket enum", () => {
    const wrong = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
    (outputOf(wrong.nodes[2]!).fields as { name: string; type: unknown }[]).push({
      name: "confidence",
      type: { kind: "string" },
    });
    const parsed = parseAuthoredDag(wrong);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("'confidence' must be exactly");

    // The exact bucket enum, explicitly declared, is accepted.
    const exact = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
    (outputOf(exact.nodes[2]!).fields as { name: string; type: unknown }[]).push({
      name: "confidence",
      type: { kind: "enum", values: ["high", "medium", "low"] },
    });
    expect(parseAuthoredDag(exact).ok).toBe(true);
  });
});

// The confidence vocabulary is an exported singleton guarding a declared
// byte-for-byte invariant across authored.ts / authored-codegen.ts /
// compose.ts — a mutation anywhere would silently corrupt all three, so the
// value must be deep-frozen (a loud TypeError instead).
describe("CONFIDENCE_FIELD", () => {
  it("is deep-frozen at every level", () => {
    expect(Object.isFrozen(CONFIDENCE_FIELD)).toBe(true);
    expect(Object.isFrozen(CONFIDENCE_FIELD.type)).toBe(true);
    expect(Object.isFrozen(CONFIDENCE_FIELD.type.values)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B2 — the acceptance matrix: authored → codegen → defineDag + lint, and the
// describe roundtrip
// ---------------------------------------------------------------------------

describe("authored codegen survives the gauntlet", () => {
  for (const [label, fixture] of Object.entries(FIXTURES)) {
    it(`${label} → dag.ts imports, lints clean, describe matches the structure`, async () => {
      const root = join(tmpRoot, label);
      const written = await writeAuthoredScaffold(mustParse(fixture), { root, force: false }, [], []);
      if (!written.ok) throw new Error(written.problems.join("; "));

      const dagPath = join(written.dir, "dag.ts");
      const lint = await runLint(dagPath);
      if (!lint.ok) throw new Error(JSON.stringify(lint.errors, null, 2));
      expect(lint.advisories).toEqual([]);

      // Roundtrip: the derived DescribedDag must contain exactly the authored
      // node ids (plus nothing else) and the authored dag id.
      const described = await runDescribe(dagPath);
      if (!described.ok) throw new Error(JSON.stringify(described.errors, null, 2));
      expect(described.dag.id).toBe(fixture.name);
      expect(new Set(described.dag.nodes.map((n) => n.id))).toEqual(new Set(fixture.nodes.map((n) => n.id)));

      // Sidecar roundtrip: dag.authored.json parses back to the same value.
      const sidecar = parseAuthoredDagJson(await readFile(join(written.dir, "dag.authored.json"), "utf-8"));
      if (!sidecar.ok) throw new Error(sidecar.problems.join("; "));
      expect(sidecar.dag).toEqual(mustParse(fixture));

      // LLM nodes ⇒ prompts registry green out of the box.
      if (fixture.nodes.some((n) => n.kind === "llm")) {
        const prompts = await runPromptsCheck(written.dir);
        expect(prompts.ok).toBe(true);
      }
    });
  }

  it("human-review gates surface as humanReview in describe", async () => {
    const root = join(tmpRoot, "review-describe");
    const written = await writeAuthoredScaffold(mustParse(FIXTURES["linear-llm-review"]!), { root, force: false }, [], []);
    if (!written.ok) throw new Error(written.problems.join("; "));
    const described = await runDescribe(join(written.dir, "dag.ts"));
    if (!described.ok) throw new Error("describe failed");
    const approve = described.dag.nodes.find((n) => n.id === "approve");
    expect(approve?.humanReview).toBe(true);
  });

  it("LLM outputs get the confidence bucket injected", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["sources-llm"]!));
    expect(scaffold.dagTs).toContain('confidence: z.enum(["high", "medium", "low"])');
    expect(scaffold.prompts).toHaveLength(1);
    expect(scaffold.prompts[0]!.body).toContain("never use a number");
  });

  it("imports `ok` only when a node body uses it (all-llm and llm+review DAGs omit it)", () => {
    // `ok(...)` appears only in placeholder fetch/transform/source bodies —
    // an all-llm (or llm + human-review) DAG importing it would carry an
    // unused import in every generated module.
    const okImportLine = /^\s+ok,$/m;
    expect(buildAuthoredScaffold(mustParse(FIXTURES["linear-two-llm"]!)).dagTs).not.toMatch(okImportLine);
    expect(buildAuthoredScaffold(mustParse(FIXTURES["linear-llm-review"]!)).dagTs).not.toMatch(okImportLine);
    // DAGs with an ok-using body keep the import (and the emitted code uses it).
    const withBodies = buildAuthoredScaffold(mustParse(FIXTURES.linear!)).dagTs;
    expect(withBodies).toMatch(okImportLine);
    expect(withBodies).toContain("ok({");
  });

  it("a two-llm dag emits per-node prompt names and a 2-entry registry", async () => {
    const fixture = FIXTURES["linear-two-llm"]!;
    const scaffold = buildAuthoredScaffold(mustParse(fixture));
    expect(scaffold.prompts.map((p) => p.name).sort()).toEqual([
      "authored-two-llm-classify",
      "authored-two-llm-draft-reply",
    ]);

    const root = join(tmpRoot, "two-llm-registry");
    const written = await writeAuthoredScaffold(mustParse(fixture), { root, force: false }, [], []);
    if (!written.ok) throw new Error(written.problems.join("; "));
    const registry = JSON.parse(
      await readFile(join(written.dir, "prompts", "registry.json"), "utf-8"),
    ) as Record<string, { version: string }>;
    expect(Object.keys(registry).sort()).toEqual([
      "authored-two-llm-classify",
      "authored-two-llm-draft-reply",
    ]);
    const prompts = await runPromptsCheck(written.dir);
    expect(prompts.ok).toBe(true);
  });

  it("an llm after a human-review gate consumes the reviewed (upstream) fields", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["llm-after-review"]!));
    // The gate passes fetch-doc's schema through — buildInput and the prompt
    // reference its fields, not the (nonexistent) review output.
    expect(scaffold.dagTs).toContain('text: input["text"]');
    const prompt = scaffold.prompts.find((p) => p.name === "authored-llm-after-review")!;
    expect(prompt.body).toContain("text: {{text}}");
  });

  it("an llm ASSEMBLE consumes the { join, $input } fan-in with '$input' sanitized to '_input'", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["sources-llm-assemble"]!));
    // buildInput reads the raw fan-in keys but emits identifier-safe
    // placeholder names — `$input` → `_input`, `join-all` → `join_all`.
    expect(scaffold.dagTs).toContain('_input: JSON.stringify(input["$input"])');
    expect(scaffold.dagTs).toContain('join_all: JSON.stringify(input["join-all"])');
    // The prompt uses the SAME sanitized placeholder, so template and
    // buildInput can never disagree on the variable name.
    expect(scaffold.prompts[0]!.body).toContain("_input (JSON): {{_input}}");
    expect(scaffold.prompts[0]!.body).toContain("join_all (JSON): {{join_all}}");
  });

  it("fan-in llm buildInput JSON-stringifies the node-keyed objects", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["sources-llm"]!));
    expect(scaffold.dagTs).toContain('JSON.stringify(input["fetch-weather"])');
    expect(scaffold.dagTs).toContain('JSON.stringify(input["fetch-calendar"])');
    // The prompt tells the model the placeholder carries JSON.
    expect(scaffold.prompts[0]!.body).toContain("fetch_weather (JSON): {{fetch_weather}}");
  });

  it("a diamond llm JOIN gets the branch-keyed fan-in wiring (JSON.stringify per branch)", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["diamond-llm-join"]!));
    expect(scaffold.dagTs).toContain('JSON.stringify(input["left"])');
    expect(scaffold.dagTs).toContain('JSON.stringify(input["right"])');
    expect(scaffold.prompts[0]!.body).toContain("left (JSON): {{left}}");
    expect(scaffold.prompts[0]!.body).toContain("right (JSON): {{right}}");
  });

  it("router llm case/default handlers consume the classifier's flat fields (no fan-in)", () => {
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["router-llm-handler"]!));
    // Handlers read the classifier output directly — never JSON.stringify.
    expect(scaffold.dagTs).toContain('message: input["message"]');
    expect(scaffold.dagTs).not.toContain("JSON.stringify(");
    // Two llm nodes ⇒ per-node prompt names.
    expect(scaffold.prompts.map((p) => p.name).sort()).toEqual([
      "authored-router-handler-deep-reply",
      "authored-router-handler-quick-reply",
    ]);
  });

  it("--force overwrites in place WITHOUT clearing user files outside prompts/ (pinned)", async () => {
    // The overwrite guard only gates writing — `--force` re-writes the
    // scaffold files over a non-empty dir but never deletes files it does not
    // itself own (the ONE exception is the tool-owned prompts/ artifacts,
    // reconciled below). Pinned so a future "clean the dir first" change is a
    // deliberate decision, not an accident.
    const root = join(tmpRoot, "force-stale");
    const dag = mustParse(FIXTURES.linear!);
    const first = await writeAuthoredScaffold(dag, { root, force: false }, [], []);
    if (!first.ok) throw new Error(first.problems.join("; "));
    await Bun.write(join(first.dir, "stale.txt"), "left over");
    const second = await writeAuthoredScaffold(dag, { root, force: true }, [], []);
    expect(second.ok).toBe(true);
    expect(await Bun.file(join(first.dir, "stale.txt")).text()).toBe("left over");
    expect(await Bun.file(join(first.dir, "dag.ts")).exists()).toBe(true);
  });

  it("--force reconciles tool-owned prompts/: regen(a) then regen(b, --force) ≡ fresh regen(b)", async () => {
    // Fixed point over the prompt set: the two-llm draft writes two prompt
    // files; force-regenerating a single-llm draft of the SAME dag must drop
    // the stale ones (and rewrite the registry) so `prompts check` is green —
    // exactly the state a fresh regen of the single-llm draft produces.
    const twoLlm = mustParse({ ...FIXTURES["linear-two-llm"]!, name: "force-fixed-point" });
    const oneLlm = mustParse({
      ...FIXTURES["linear-two-llm"]!,
      name: "force-fixed-point",
      nodes: [
        { id: "classify", kind: "transform", purpose: "Classify the message", output: out("topic") },
        { id: "draft-reply", kind: "llm", purpose: "Draft a reply", output: out("reply") },
      ],
    });

    const rootA = join(tmpRoot, "force-fixed-point-regen");
    const first = await writeAuthoredScaffold(twoLlm, { root: rootA, force: false }, [], []);
    if (!first.ok) throw new Error(first.problems.join("; "));
    const second = await writeAuthoredScaffold(oneLlm, { root: rootA, force: true }, [], []);
    if (!second.ok) throw new Error(second.problems.join("; "));

    const rootB = join(tmpRoot, "force-fixed-point-fresh");
    const fresh = await writeAuthoredScaffold(oneLlm, { root: rootB, force: false }, [], []);
    if (!fresh.ok) throw new Error(fresh.problems.join("; "));

    // Same prompts/ dir listing AND same registry bytes as the fresh regen.
    const listing = async (dir: string) => (await readdir(join(dir, "prompts"))).sort();
    expect(await listing(second.dir)).toEqual(await listing(fresh.dir));
    expect(await readFile(join(second.dir, "prompts", "registry.json"), "utf-8")).toBe(
      await readFile(join(fresh.dir, "prompts", "registry.json"), "utf-8"),
    );
    const check = await runPromptsCheck(second.dir);
    expect(check.ok).toBe(true);

    // The llm-free draft as the final regen: prompts/ disappears entirely.
    const noLlm = mustParse({ ...FIXTURES.linear!, name: "force-fixed-point" });
    const third = await writeAuthoredScaffold(noLlm, { root: rootA, force: true }, [], []);
    if (!third.ok) throw new Error(third.problems.join("; "));
    expect(existsSync(join(third.dir, "prompts"))).toBe(false);
  });

  it("buildAuthoredScaffold is deterministic (same input → identical output)", () => {
    for (const fixture of Object.values(FIXTURES)) {
      expect(buildAuthoredScaffold(mustParse(fixture))).toEqual(buildAuthoredScaffold(mustParse(fixture)));
    }
  });

  it("nodes-array permutations parse to the same value and byte-identical scaffolds (canonical node order)", () => {
    // The parse canonicalizes `nodes` to structure order, so two authored
    // files differing only in array order are the SAME document — same
    // sidecar bytes, same generated dag.ts, same prompts.
    for (const [label, fixture] of Object.entries(FIXTURES)) {
      const permuted: AuthoredDagInput = structuredClone(fixture);
      (permuted as { nodes: unknown[] }).nodes = [...permuted.nodes].reverse();
      const a = mustParse(fixture);
      const b = mustParse(permuted);
      expect(JSON.stringify(b, null, 2)).toBe(JSON.stringify(a, null, 2)); // the sidecar bytes
      const sa = buildAuthoredScaffold(a);
      const sb = buildAuthoredScaffold(b);
      if (sb.dagTs !== sa.dagTs) throw new Error(`${label}: permuted nodes produced different dag.ts bytes`);
      expect(sb.prompts).toEqual(sa.prompts);
    }
  });

  it("parse canonicalizes dag.nodes to structure order", () => {
    const permuted: AuthoredDagInput = structuredClone(FIXTURES["sources-llm"]!);
    (permuted as { nodes: unknown[] }).nodes = [...permuted.nodes].reverse();
    const dag = mustParse(permuted);
    // sources shape order: sources…, join, assemble.
    expect(dag.nodes.map((n) => n.id as string)).toEqual([
      "fetch-weather",
      "fetch-calendar",
      "synthesize",
      "final",
    ]);
  });

  it("an EXPLICIT llm confidence field is emitted exactly once (withConfidence skip branch)", () => {
    // router-llm declares the bucket enum explicitly — injection must be
    // skipped, or the schema const would carry a duplicate `confidence` key.
    const scaffold = buildAuthoredScaffold(mustParse(FIXTURES["router-llm"]!));
    const occurrences = scaffold.dagTs.match(/confidence: z\.enum\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // The prompt shape hint carries it exactly once too.
    const prompt = scaffold.prompts[0]!;
    expect(prompt.body.match(/"confidence":/g) ?? []).toHaveLength(1);
  });

  it("router case labels parse into the branded Kebab (proof rides on the parsed dag)", () => {
    const dag = mustParse(FIXTURES.router!);
    if (dag.structure.shape !== "router") throw new Error("expected the router structure");
    // Compile-time: `label` carries the brand (mirrors `team`'s treatment).
    const label: Kebab = dag.structure.cases[0]!.label;
    expect(label as string).toBe("small");
  });

  it("runNewFrom reads the file, refuses to clobber without --force", async () => {
    const root = join(tmpRoot, "from-file");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const first = await runNewFrom({ from: fromPath, force: false, root });
    expect(first.ok).toBe(true);
    // Codegen'd scaffolds are advisory-clean; the field must still be present
    // (always-an-array contract).
    if (first.ok) expect(first.advisories).toEqual([]);
    const second = await runNewFrom({ from: fromPath, force: false, root });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.problems[0]).toContain("--force");
  });

  it("runNewFrom surfaces an unreadable file as problems, not a throw", async () => {
    const result = await runNewFrom({ from: join(tmpRoot, "does-not-exist.authored.json"), force: false, root: tmpRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("cannot read");
  });

  it("runNewFrom surfaces schema problems prefixed with the file path", async () => {
    const root = join(tmpRoot, "from-schema-invalid");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "bad.authored.json");
    await Bun.write(fromPath, JSON.stringify({ ...FIXTURES.linear, name: "2fast" }));
    const result = await runNewFrom({ from: fromPath, force: false, root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain(fromPath);
      expect(result.problems.join("\n")).toContain("starting with a letter");
    }
  });

  it("runNewFrom folds a THROWING gauntlet into the problems envelope (environment failure)", async () => {
    // A gauntlet throw is ENOSPC/EACCES territory — it must land in the same
    // `{ ok: false, problems }` JSON envelope as every other failure (the bin
    // prints stdout JSON), with the stack kept for debugging, not crash past
    // the machine-readable contract.
    const root = join(tmpRoot, "from-gauntlet-throws");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const throwing = async (): Promise<never> => {
      throw new Error("ENOSPC: no space left on device");
    };
    const result = await runNewFrom({ from: fromPath, force: false, root }, throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain("gauntlet failed");
      expect(result.problems[0]).toContain("ENOSPC");
      // Environment failures keep the STACK, not just the message.
      expect(result.problems[0]).toContain("at ");
    }
    expect(existsSync(join(root, "dags"))).toBe(false);
  });

  it("runNewFrom folds a THROWING scaffold write into the problems envelope", async () => {
    // `dags` is a regular file → isDirNonEmpty rethrows ENOTDIR inside
    // writeAuthoredScaffold; runNewFrom must catch it (mirroring runCompose's
    // write-failed arm) instead of breaking the JSON envelope.
    const root = join(tmpRoot, "from-write-throws");
    await mkdir(root, { recursive: true });
    await Bun.write(join(root, "dags"), "i am a file, not a directory");
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const result = await runNewFrom({ from: fromPath, force: false, root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("write failed");
  });

  it("runNewFrom fails closed on a gauntlet failure and writes NOTHING", async () => {
    const root = join(tmpRoot, "from-gauntlet-fail");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const alwaysFail = async () => ({
      ok: false as const,
      errors: [
        {
          kind: "import-failed" as const,
          message: "simulated gauntlet failure",
          stack: "Error: simulated gauntlet failure\n    at import (dag.ts:1:1)",
        },
      ],
      advisories: [],
    });
    const result = await runNewFrom({ from: fromPath, force: false, root }, alwaysFail);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain("import-failed");
      // formatLintError must keep the import-failed arm's stack — the
      // problems envelope is the only surviving record (mutation pin:
      // reverting to `${kind}: ${message}` silently drops it).
      expect(result.problems[0]).toContain("at import (dag.ts:1:1)");
    }
    expect(existsSync(join(root, "dags"))).toBe(false);
  });

  it("runNewFrom surfaces gauntlet advisories on the success result", async () => {
    const root = join(tmpRoot, "from-advisories");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const advisory = {
      kind: "redundant-passthrough" as const,
      message: "identity-shaped transform",
      nodeId: nodeId("summarize"),
    };
    // The ok verdict now carries the DescribedDag of the generated code —
    // runNewFrom only forwards advisories, so a minimal stub suffices here.
    const describedStub: DescribedDag = {
      id: "authored-linear",
      route: "/authored-linear",
      description: "stub",
      version: "1.0.0",
      inputSchema: null,
      outputSchema: null,
      outputNodeId: null,
      nodes: [],
      edges: [],
      waves: [],
      prompts: [],
      capabilities: [],
    };
    const okWithAdvisory = async (): Promise<GauntletResult> => ({
      ok: true,
      described: describedStub,
      advisories: [advisory],
      warnings: [],
    });
    const result = await runNewFrom({ from: fromPath, force: false, root }, okWithAdvisory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.advisories).toEqual([advisory]);
  });

  it("runNewFrom threads non-empty gauntlet warnings onto the machine-readable outcome", async () => {
    // The describe-pass schema-serialization warnings ride the verdict; the
    // NewResult contract says they reach the success result (never dropped).
    const root = join(tmpRoot, "from-warnings");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const describedStub: DescribedDag = {
      id: "authored-linear",
      route: "/authored-linear",
      description: "stub",
      version: "1.0.0",
      inputSchema: null,
      outputSchema: null,
      outputNodeId: null,
      nodes: [],
      edges: [],
      waves: [],
      prompts: [],
      capabilities: [],
    };
    const warning = "outputSchema (node 'summarize'): unrepresentable in JSON Schema";
    const okWithWarning = async (): Promise<GauntletResult> => ({
      ok: true,
      described: describedStub,
      advisories: [],
      warnings: [warning],
    });
    const result = await runNewFrom({ from: fromPath, force: false, root }, okWithWarning);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([warning]);
  });
});

describe("parse problem formatting", () => {
  it("a root-level issue (empty path) surfaces the bare message, no dangling path prefix", () => {
    // `issuesToProblems` prefixes `path.join(".")` only when the path is
    // non-empty — a non-object root exercises the empty-path branch.
    const parsed = parseAuthoredDag(null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems).toHaveLength(1);
      // No path → the problem IS the message: no leading ": " or field path.
      expect(parsed.problems[0]).toMatch(/^Invalid input/);
      expect(parsed.problems[0]!.startsWith(":")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Identifier accounting drift guard — the parse-time collision check
// (`generatedIdentifiersFor` ∪ `dagLevelIdentifiers` ∪ `RESERVED_IDENTIFIERS`)
// must claim EVERY name codegen actually emits: every top-level const /
// interface declaration and every import binding in a generated dag.ts.
// Both are now built from the same `identifiers.ts` name constructors; this
// test proves the derivation covers the emission for every fixture shape, so
// a new emitted name can never silently regress collision detection back to
// gauntlet-time SyntaxErrors.
// ---------------------------------------------------------------------------

describe("identifier accounting covers every emitted name", () => {
  /** Top-level declared identifiers + import bindings of a generated dag.ts. */
  const emittedNames = (dagTs: string): Set<string> => {
    const names = new Set<string>();
    // `const x = …` / `export const x = …` / `export interface X {` at column 0.
    for (const m of dagTs.matchAll(/^(?:export )?(?:const|interface) ([A-Za-z_$][\w$]*)/gm)) {
      names.add(m[1]!);
    }
    // Single-name (possibly type-only) imports: `import { z } from "zod";` etc.
    for (const m of dagTs.matchAll(/^import(?: type)? \{ ([A-Za-z_$][\w$]*) \}/gm)) {
      names.add(m[1]!);
    }
    // The multi-line framework import block.
    const block = dagTs.match(/^import \{\n([\s\S]*?)\n\} from "@fuguejs\/framework";/m);
    for (const line of block?.[1]?.split("\n") ?? []) {
      const name = line.trim().replace(/,$/, "");
      if (name.length > 0) names.add(name);
    }
    return names;
  };

  for (const [label, fixture] of Object.entries(FIXTURES)) {
    it(`${label}: every emitted name is claimed by the accounting`, () => {
      const dag = mustParse(fixture);
      const { dagTs } = buildAuthoredScaffold(dag);
      const claimed = new Set<string>([
        ...RESERVED_IDENTIFIERS,
        ...dagLevelIdentifiers(dag.name),
        ...dag.nodes.flatMap((n) => [...generatedIdentifiersFor(n)]),
      ]);
      const emitted = emittedNames(dagTs);
      // Sanity: the extraction saw the real module, not an empty regex miss.
      expect(emitted.size).toBeGreaterThanOrEqual(dag.nodes.length + 2);
      const unclaimed = [...emitted].filter((name) => !claimed.has(name));
      expect(unclaimed).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Hostile-string properties (mirrors new.test.ts's yamlScalar property) — the
// comment-injection surface: free text either carries a newline (schema must
// reject) or it doesn't (the generated code must still import cleanly, no
// matter what quotes/backticks/template syntax it carries).
// ---------------------------------------------------------------------------

describe("hostile free-text properties", () => {
  const setFreeText = (dag: AuthoredDagInput, s: string): AuthoredDagInput => {
    const d = structuredClone(dag) as AuthoredDagInput;
    (d as { description: string }).description = s;
    for (const n of d.nodes) (n as { purpose: string }).purpose = s;
    (d.input.fields[0] as { description?: string }).description = s;
    return d;
  };

  it("rejects ANY purpose/description containing a JS line terminator", () => {
    // The FULL ECMAScript LineTerminator set — \n, \r, and the U+2028/U+2029
    // separators JS also honors as `//`-comment terminators.
    const withNewline = fc
      .tuple(
        fc.string({ maxLength: 20 }),
        fc.constantFrom("\n", "\r", "\r\n", "\u2028", "\u2029"),
        fc.string({ maxLength: 20 }),
      )
      .map(([a, nl, b]) => `${a}${nl}${b}`);
    fc.assert(
      fc.property(withNewline, (s) => {
        expect(parseAuthoredDag(setFreeText(FIXTURES.linear!, s)).ok).toBe(false);
      }),
    );
  });

  it("single-line quote/backtick-hostile text parses AND survives the real gauntlet", async () => {
    // Real codegen + import + lint per run — keep numRuns small.
    const hostileChar = fc.constantFrom('"', "'", "`", "\\", "$", "{", "}", "/", "*", "a", " ", "—");
    const singleLineHostile = fc
      .string({ unit: hostileChar, minLength: 1, maxLength: 30 })
      // `{{` is schema-rejected (the prompt-placeholder opener — see the
      // dedicated injection tests below), so the survives-the-gauntlet
      // property quantifies over the ACCEPTED language only.
      .filter((s) => /^[^\r\n]+$/.test(s) && !s.includes("{{"));
    const root = join(tmpRoot, "prop-gauntlet");
    await mkdir(root, { recursive: true });
    await fc.assert(
      fc.asyncProperty(singleLineHostile, async (s) => {
        const parsed = parseAuthoredDag(setFreeText(FIXTURES.linear!, s));
        if (!parsed.ok) throw new Error(parsed.problems.join("; "));
        const verdict = await runGauntlet(parsed.dag, root);
        if (!verdict.ok) {
          throw new Error(`gauntlet failed for ${JSON.stringify(s)}: ${JSON.stringify(verdict.errors)}`);
        }
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  // Hostile ENUM values: a `"`, backtick, or `${...}` passes the schema's
  // SINGLE_LINE check (only LINE TERMINATORS are rejected) and then flows,
  // unescaped-if-naive, into FOUR JSON.stringify-guarded sites — zodExpr
  // (authored-codegen ~90), defaultExpr (~98), the LLM prompt's jsonShape hint
  // (~238), and the router `when.equals` comparison (~388). The existing
  // free-text property never mutates enum values, so these four sites went
  // uncovered against hostile input. Note: an LLM node's `confidence` field is
  // pinned to the exact bucket enum, so we cover the LLM-prompt jsonShape via a
  // NON-confidence enum output field (`sources-llm`) and the router when.equals
  // via a fetch classifier's free-form enum (plain `router`).
  const HOSTILE_ENUMS = ['a"b', "a`b", "a${b}", '"; DROP TABLE dags; --'] as const;

  it("hostile ENUM values on a router predicate survive codegen + the real gauntlet (when.equals)", async () => {
    const root = join(tmpRoot, "prop-enum-hostile-router");
    await mkdir(root, { recursive: true });
    for (const hostile of HOSTILE_ENUMS) {
      const d = structuredClone(FIXTURES.router!) as AuthoredDagInput;
      // The fetch classifier's `bucket` enum (zodExpr/defaultExpr) AND the
      // routing case's `equals` (when.equals, codegen line 388) set to the same
      // hostile value so it is a legal predicate target.
      const bucket = outputOf(d.nodes[0]!).fields.find((f) => f.name === "bucket")! as {
        type: { kind: string; values?: readonly string[] };
      };
      bucket.type = { kind: "enum", values: [hostile, "large"] };
      (d.structure as { cases: { when: { equals: string } }[] }).cases[0]!.when.equals = hostile;

      const parsed = parseAuthoredDag(d);
      if (!parsed.ok) throw new Error(`${JSON.stringify(hostile)} rejected: ${parsed.problems.join("; ")}`);

      // Real codegen + import through defineDag + lint — a naive template that
      // interpolated the value bare would emit a dag.ts with a syntax error (or
      // an injected expression) and the gauntlet would fail here.
      const verdict = await runGauntlet(parsed.dag, root);
      if (!verdict.ok) {
        throw new Error(`gauntlet failed for ${JSON.stringify(hostile)}: ${JSON.stringify(verdict.errors)}`);
      }

      // The generated dag.ts routes on the JSON-escaped literal (line 388) and
      // the zod enum lists it escaped — never the raw hostile bytes.
      const dagTs = buildAuthoredScaffold(parsed.dag).dagTs;
      expect(dagTs).toContain(`=== ${JSON.stringify(hostile)}`);
      expect(dagTs).toContain(`z.enum([${JSON.stringify(hostile)}, ${JSON.stringify("large")}])`);
    }
  }, 60_000);

  it("hostile ENUM values on an LLM output field survive codegen + gauntlet, and the prompt shape-hint stays escaped (jsonShape)", async () => {
    const root = join(tmpRoot, "prop-enum-hostile-prompt");
    await mkdir(root, { recursive: true });
    for (const hostile of HOSTILE_ENUMS) {
      const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDagInput;
      // Add a NON-confidence enum output field to the LLM `synthesize` node —
      // this reaches the prompt jsonShape hint (codegen line 238) plus
      // zodExpr/defaultExpr for the generated output schema.
      const synth = d.nodes.find((n) => n.id === "synthesize")!;
      (outputOf(synth).fields as { name: string; type: unknown }[]).push({
        name: "category",
        type: { kind: "enum", values: [hostile, "other"] },
      });

      const parsed = parseAuthoredDag(d);
      if (!parsed.ok) throw new Error(`${JSON.stringify(hostile)} rejected: ${parsed.problems.join("; ")}`);

      const verdict = await runGauntlet(parsed.dag, root);
      if (!verdict.ok) {
        throw new Error(`gauntlet failed for ${JSON.stringify(hostile)}: ${JSON.stringify(verdict.errors)}`);
      }

      // The prompt shape-hint must carry the value JSON-escaped (line 238), not
      // the raw hostile bytes that would break the `{ ... }` hint or open a
      // `${}` template hole in the generated prompt string.
      const scaffold = buildAuthoredScaffold(parsed.dag);
      const prompt = scaffold.prompts.find((p) => p.body.includes('"category"'))!;
      expect(prompt.body).toContain(`"category": ${JSON.stringify(hostile)} | ${JSON.stringify("other")}`);
      expect(prompt.body).not.toContain(`"category": ${hostile}`);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Identifier-collision property (mirrors the hostile-text asyncProperty):
// every set of lexically-valid (KEBAB_IDENT) node ids either fails
// parseAuthoredDag with a precise collision/reserved message, or generates a
// module that survives the real gauntlet — there is no third outcome where
// the schema accepts ids whose generated identifiers then collide into a
// gauntlet-time duplicate-declaration SyntaxError.
// ---------------------------------------------------------------------------

describe("identifier collision property", () => {
  const alnum = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789");
  const letter = fc.constantFrom(..."abcdefghij");
  const segment = fc.string({ unit: alnum, minLength: 1, maxLength: 5 });
  const firstSegment = fc
    .tuple(letter, fc.string({ unit: alnum, maxLength: 4 }))
    .map(([head, tail]) => `${head}${tail}`);
  const kebabIdent = fc
    .tuple(firstSegment, fc.array(segment, { maxLength: 2 }))
    .map(([head, rest]) => [head, ...rest].join("-"));
  // Hazard ids known to stress the accounting: reserved words, framework
  // imports, dag-level names for the fixed dag name "prop-ids", and
  // digit-boundary camelCase collisions.
  const hazardId = fc.constantFrom(
    "dag", "input", "ok", "default", "llm-node", "registration",
    "input-schema", "default-model", "create-prop-ids-dag", "prop-ids-dag-opts",
    "a-1b", "a1b", "foo", "foo-node",
  );
  const nodeIds = fc.array(fc.oneof(kebabIdent, hazardId), { minLength: 2, maxLength: 4 });
  const kinds = fc.array(fc.constantFrom("fetch", "transform", "llm"), { minLength: 4, maxLength: 4 });

  it("arbitrary KEBAB_IDENT id sets either reject at parse or survive the real gauntlet", async () => {
    // Real codegen + import + lint per accepted run — keep numRuns small.
    const root = join(tmpRoot, "prop-identifiers");
    await mkdir(root, { recursive: true });
    await fc.assert(
      fc.asyncProperty(nodeIds, kinds, async (ids, kindPool) => {
        const dagInput: AuthoredDagInput = {
          fugueAuthored: 1,
          name: "prop-ids",
          team: "demo",
          description: "identifier collision property",
          input: out("id"),
          nodes: ids.map((id, i) => ({
            id,
            kind: kindPool[i]! as "fetch" | "transform" | "llm",
            purpose: `Node ${i}`,
            output: out(`f${i}`),
          })),
          structure: { shape: "linear", order: ids },
        };
        const parsed = parseAuthoredDag(dagInput);
        // Rejection is a legitimate outcome — the property is that ACCEPTED
        // id sets never fail the gauntlet on identifier grounds.
        if (!parsed.ok) return;
        const verdict = await runGauntlet(parsed.dag, root);
        if (!verdict.ok) {
          throw new Error(
            `gauntlet failed for ids ${JSON.stringify(ids)}: ${JSON.stringify(verdict.errors)}`,
          );
        }
      }),
      { numRuns: 12 },
    );
  }, 60_000);
});
