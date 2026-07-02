// AuthoredDag (B1) + deterministic codegen (B2) — the load-bearing assertion
// mirrors new.test.ts: every shape the authoring schema accepts must generate
// a dag.ts that survives the real gauntlet (import through defineDag + lint),
// and `describe` on the generated code must match the authored structure
// (the roundtrip that makes AuthoredDag ⊇ DescribedDag one format family).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseAuthoredDag, parseAuthoredDagJson, type AuthoredDag } from "../../cli/authored.js";
import { buildAuthoredScaffold } from "../../cli/authored-codegen.js";
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

  it("runNewFrom reads the file, refuses to clobber without --force", async () => {
    const root = join(tmpRoot, "from-file");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "x.authored.json");
    await Bun.write(fromPath, JSON.stringify(FIXTURES.linear));
    const first = await runNewFrom({ from: fromPath, force: false, root });
    expect(first.ok).toBe(true);
    const second = await runNewFrom({ from: fromPath, force: false, root });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.problems[0]).toContain("--force");
  });
});
