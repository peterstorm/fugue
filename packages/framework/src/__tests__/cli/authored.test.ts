// AuthoredDag (B1) + deterministic codegen (B2) — the load-bearing assertion
// mirrors new.test.ts: every shape the authoring schema accepts must generate
// a dag.ts that survives the real gauntlet (import through defineDag + lint),
// and `describe` on the generated code must match the authored structure
// (the roundtrip that makes AuthoredDag ⊇ DescribedDag one format family).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { parseAuthoredDag, parseAuthoredDagJson, type AuthoredDag } from "../../cli/authored.js";
import { buildAuthoredScaffold } from "../../cli/authored-codegen.js";
import { runGauntlet } from "../../cli/gauntlet.js";
import { runNewFrom, writeAuthoredScaffold } from "../../cli/new.js";
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
// Fixtures — one authored description per shape
// ---------------------------------------------------------------------------

const str = { kind: "string" as const };
const out = (...names: string[]) => ({ fields: names.map((name) => ({ name, type: str })) });

const FIXTURES: Record<string, AuthoredDag> = {
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

  const reject = (mutate: (dag: AuthoredDag) => unknown, needle: string) => {
    const raw = mutate(structuredClone(FIXTURES.router!) as AuthoredDag);
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
          ...(d.structure as Extract<AuthoredDag["structure"], { shape: "router" }>),
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
          ...(d.structure as Extract<AuthoredDag["structure"], { shape: "router" }>),
          cases: [{ label: "small", when: { field: "bucket", equals: "huge" }, to: "auto-approve" }],
        },
      }),
      "not a value of enum",
    );
  });

  it("rejects source-kind nodes outside the sources shape", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (d.nodes[0] as { kind: string }).kind = "source";
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.join("\n")).toContain("source nodes belong to the sources shape");
    }
  });

  it("rejects human-review outside linear / as first node / with output", () => {
    const first = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDag;
    (first.structure as { order: string[] }).order = ["approve", "draft-reply"];
    expect(parseAuthoredDag(first).ok).toBe(false);

    const withOut = structuredClone(FIXTURES["linear-llm-review"]!) as AuthoredDag;
    (withOut.nodes[1] as { output?: unknown }).output = out("x");
    expect(parseAuthoredDag(withOut).ok).toBe(false);
  });

  it("rejects reserved node ids (they collide with generated identifiers)", () => {
    for (const id of ["dag", "input", "registration"]) {
      const d = structuredClone(FIXTURES.linear!) as AuthoredDag;
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

  it("rejects a newline in purpose / dag description / field description", () => {
    const purpose = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (purpose.nodes[0] as { purpose: string }).purpose = "line one\n// injected";
    const p = parseAuthoredDag(purpose);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.problems.join("\n")).toContain("single line");

    const desc = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (desc as { description: string }).description = "line one\nline two";
    expect(parseAuthoredDag(desc).ok).toBe(false);

    const field = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (field.input.fields[0] as { description?: string }).description = "line one\nline two";
    expect(parseAuthoredDag(field).ok).toBe(false);
  });

  it("rejects a node id that camelCases to a JS reserved word", () => {
    const d = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (d.nodes[1] as { id: string }).id = "default";
    (d.structure as { order: string[] }).order = ["fetch-record", "default"];
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("reserved word 'default'");
  });

  it("rejects an llm node id whose factory collides with a framework import", () => {
    // llm "llm-node" would generate `createLlmNode` — the framework import.
    const d: AuthoredDag = {
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
    const d: AuthoredDag = {
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
    const d: AuthoredDag = {
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
    const inInput = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (inInput.input.fields[0] as { name: string }).name = "__proto__";
    const p1 = parseAuthoredDag(inInput);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain("__proto__");

    const inOutput = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (inOutput.nodes[1]!.output!.fields[0] as { name: string }).name = "__proto__";
    expect(parseAuthoredDag(inOutput).ok).toBe(false);

    // Hostile JSON path too: the same dag arriving as wire text.
    const viaJson = parseAuthoredDagJson(JSON.stringify(inInput));
    expect(viaJson.ok).toBe(false);
  });

  it("rejects leading-digit node ids and dag names (invalid JS identifiers)", () => {
    const nodeD = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (nodeD.nodes[1] as { id: string }).id = "2fast";
    (nodeD.structure as { order: string[] }).order = ["fetch-record", "2fast"];
    const p1 = parseAuthoredDag(nodeD);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.problems.join("\n")).toContain("starting with a letter");

    const nameD = structuredClone(FIXTURES.linear!) as AuthoredDag;
    (nameD as { name: string }).name = "2fast-pipeline";
    expect(parseAuthoredDag(nameD).ok).toBe(false);
  });

  it("rejects node ids that are strict-mode reserved words ('with', 'debugger', 'eval', 'arguments')", () => {
    for (const id of ["with", "debugger", "eval", "arguments"]) {
      const d = structuredClone(FIXTURES.linear!) as AuthoredDag;
      (d.nodes[1] as { id: string }).id = id;
      (d.structure as { order: string[] }).order = ["fetch-record", id];
      const parsed = parseAuthoredDag(d);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toContain(`reserved word '${id}'`);
    }
  });

  it("rejects enum values containing a newline", () => {
    const d = structuredClone(FIXTURES.router!) as AuthoredDag;
    const bucket = d.nodes[0]!.output!.fields[1]! as { type: { kind: string; values: string[] } };
    bucket.type.values = ["small\ninjected", "large"];
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("single line");
  });

  it("rejects duplicate router {field, equals} predicates (unreachable case)", () => {
    reject(
      (d) => {
        const s = d.structure as Extract<AuthoredDag["structure"], { shape: "router" }>;
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
    const d = structuredClone(FIXTURES.router!) as AuthoredDag;
    const bucket = d.nodes[0]!.output!.fields[1]! as { type: { kind: string; values: string[] } };
    bucket.type.values = ["small", "small"];
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("duplicate enum value 'small'");
  });

  it("rejects a sources join of kind source", () => {
    const d = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDag;
    (d.nodes[2] as { kind: string }).kind = "source"; // synthesize, the join
    const parsed = parseAuthoredDag(d);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("join 'synthesize' must not be a source node");
  });

  it("rejects an llm 'confidence' output field that is not the exact bucket enum", () => {
    const wrong = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDag;
    (wrong.nodes[2]!.output!.fields as { name: string; type: unknown }[]).push({
      name: "confidence",
      type: { kind: "string" },
    });
    const parsed = parseAuthoredDag(wrong);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("'confidence' must be exactly");

    // The exact bucket enum, explicitly declared, is accepted.
    const exact = structuredClone(FIXTURES["sources-llm"]!) as AuthoredDag;
    (exact.nodes[2]!.output!.fields as { name: string; type: unknown }[]).push({
      name: "confidence",
      type: { kind: "enum", values: ["high", "medium", "low"] },
    });
    expect(parseAuthoredDag(exact).ok).toBe(true);
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
      const written = await writeAuthoredScaffold(fixture, { root, force: false });
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
      expect(sidecar.dag).toEqual(fixture);

      // LLM nodes ⇒ prompts registry green out of the box.
      if (fixture.nodes.some((n) => n.kind === "llm")) {
        const prompts = await runPromptsCheck(written.dir);
        expect(prompts.ok).toBe(true);
      }
    });
  }

  it("human-review gates surface as humanReview in describe", async () => {
    const root = join(tmpRoot, "review-describe");
    const written = await writeAuthoredScaffold(FIXTURES["linear-llm-review"]!, { root, force: false });
    if (!written.ok) throw new Error(written.problems.join("; "));
    const described = await runDescribe(join(written.dir, "dag.ts"));
    if (!described.ok) throw new Error("describe failed");
    const approve = described.dag.nodes.find((n) => n.id === "approve");
    expect(approve?.humanReview).toBe(true);
  });

  it("LLM outputs get the confidence bucket injected", () => {
    const scaffold = buildAuthoredScaffold(FIXTURES["sources-llm"]!);
    expect(scaffold.dagTs).toContain('confidence: z.enum(["high", "medium", "low"])');
    expect(scaffold.prompts).toHaveLength(1);
    expect(scaffold.prompts[0]!.body).toContain("never use a number");
  });

  it("a two-llm dag emits per-node prompt names and a 2-entry registry", async () => {
    const fixture = FIXTURES["linear-two-llm"]!;
    const scaffold = buildAuthoredScaffold(fixture);
    expect(scaffold.prompts.map((p) => p.name).sort()).toEqual([
      "authored-two-llm-classify",
      "authored-two-llm-draft-reply",
    ]);

    const root = join(tmpRoot, "two-llm-registry");
    const written = await writeAuthoredScaffold(fixture, { root, force: false });
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
    const scaffold = buildAuthoredScaffold(FIXTURES["llm-after-review"]!);
    // The gate passes fetch-doc's schema through — buildInput and the prompt
    // reference its fields, not the (nonexistent) review output.
    expect(scaffold.dagTs).toContain('text: input["text"]');
    const prompt = scaffold.prompts.find((p) => p.name === "authored-llm-after-review")!;
    expect(prompt.body).toContain("text: {{text}}");
  });

  it("fan-in llm buildInput JSON-stringifies the node-keyed objects", () => {
    const scaffold = buildAuthoredScaffold(FIXTURES["sources-llm"]!);
    expect(scaffold.dagTs).toContain('JSON.stringify(input["fetch-weather"])');
    expect(scaffold.dagTs).toContain('JSON.stringify(input["fetch-calendar"])');
    // The prompt tells the model the placeholder carries JSON.
    expect(scaffold.prompts[0]!.body).toContain("fetch_weather (JSON): {{fetch_weather}}");
  });

  it("buildAuthoredScaffold is deterministic (same input → identical output)", () => {
    for (const fixture of Object.values(FIXTURES)) {
      expect(buildAuthoredScaffold(fixture)).toEqual(buildAuthoredScaffold(fixture));
    }
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

  it("runNewFrom fails closed on a gauntlet failure and writes NOTHING", async () => {
    const root = join(tmpRoot, "from-gauntlet-fail");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const alwaysFail = async () => ({
      ok: false as const,
      errors: [{ kind: "import-failed" as const, message: "simulated gauntlet failure" }],
      advisories: [],
    });
    const result = await runNewFrom({ from: fromPath, force: false, root }, alwaysFail);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("import-failed");
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
      nodeId: "summarize",
    };
    const okWithAdvisory = async () => ({ ok: true as const, advisories: [advisory] });
    const result = await runNewFrom({ from: fromPath, force: false, root }, okWithAdvisory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.advisories).toEqual([advisory]);
  });
});

// ---------------------------------------------------------------------------
// Hostile-string properties (mirrors new.test.ts's yamlScalar property) — the
// comment-injection surface: free text either carries a newline (schema must
// reject) or it doesn't (the generated code must still import cleanly, no
// matter what quotes/backticks/template syntax it carries).
// ---------------------------------------------------------------------------

describe("hostile free-text properties", () => {
  const setFreeText = (dag: AuthoredDag, s: string): AuthoredDag => {
    const d = structuredClone(dag) as AuthoredDag;
    (d as { description: string }).description = s;
    for (const n of d.nodes) (n as { purpose: string }).purpose = s;
    (d.input.fields[0] as { description?: string }).description = s;
    return d;
  };

  it("rejects ANY purpose/description containing a newline", () => {
    const withNewline = fc
      .tuple(fc.string({ maxLength: 20 }), fc.constantFrom("\n", "\r", "\r\n"), fc.string({ maxLength: 20 }))
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
      .filter((s) => /^[^\r\n]+$/.test(s));
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
});
