import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { parseAuthoredDag, type AuthoredDag } from "../../cli/authored.js";
import { buildAuthoredScaffold } from "../../cli/authored-codegen.js";
import { runGauntlet } from "../../cli/gauntlet.js";
import { describedToMermaid } from "../../cli/visualize.js";

const tmpRoot = resolve(__dirname, ".tmp-authored-map");

beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const scalar = (kind: "string" | "number" | "boolean") => ({ kind });
const fields = (...entries: readonly (readonly [string, ReturnType<typeof scalar>])[]) => ({
  fields: entries.map(([name, type]) => ({ name, type })),
});

const MAP_FIXTURE = {
  fugueAuthored: 1,
  name: "authored-map",
  team: "demo",
  description: "Scope records and score each one",
  input: fields(["requestId", scalar("string")]),
  nodes: [
    {
      id: "scope-records",
      kind: "fetch",
      purpose: "Load records",
      output: {
        fields: [
          { name: "requestId", type: scalar("string") },
          {
            name: "items",
            type: {
              kind: "array",
              element: fields(
                ["recordId", scalar("string")],
                ["amount", scalar("number")],
              ),
            },
          },
        ],
      },
    },
    {
      id: "score-items",
      kind: "map",
      purpose: "Score every record",
      widthFrom: "items",
      maxWidth: 25,
      child: {
        id: "score-item-child",
        nodes: [
          {
            id: "score-item",
            kind: "transform",
            purpose: "Score one record",
            output: fields(
              ["recordId", scalar("string")],
              ["score", scalar("number")],
            ),
          },
        ],
        structure: { shape: "linear", order: ["score-item"] },
      },
      gather: { kind: "collect", field: "results" },
    },
  ],
  structure: { shape: "linear", order: ["scope-records", "score-items"] },
} as const;

const mustParse = (raw: unknown): AuthoredDag => {
  const parsed = parseAuthoredDag(raw);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.dag;
};

type JsonObject = Record<string, unknown>;
const draft = (): JsonObject => structuredClone(MAP_FIXTURE) as unknown as JsonObject;
const nodesOf = (value: JsonObject): JsonObject[] => value.nodes as JsonObject[];
const mapOf = (value: JsonObject): JsonObject => nodesOf(value)[1]!;
const childOf = (value: JsonObject): JsonObject => mapOf(value).child as JsonObject;
const childNodesOf = (value: JsonObject): JsonObject[] => childOf(value).nodes as JsonObject[];

describe("AuthoredDag map node (FR-F1-010)", () => {
  it("parses an inline child and derives the collected output", () => {
    const dag = mustParse(MAP_FIXTURE);
    const map = dag.nodes.find((node) => node.kind === "map");
    expect(map?.kind).toBe("map");
    if (map?.kind !== "map") throw new Error("expected map node");
    expect(map.widthFrom).toBe("items");
    expect(map.maxWidth).toBe(25);
    expect(map.gather).toEqual({ kind: "collect", field: "results" });
    expect(map.child.nodes.map((node) => String(node.id))).toEqual(["score-item"]);
  });

  it("rejects non-field width references, non-array fields, and invalid bounds", () => {
    const cases: readonly [string, (value: JsonObject) => void, string][] = [
      ["path", (value) => { mapOf(value).widthFrom = "payload.items"; }, "field"],
      ["prototype", (value) => { mapOf(value).widthFrom = "__proto__"; }, "field"],
      ["scalar", (value) => { mapOf(value).widthFrom = "requestId"; }, "array"],
      ["missing", (value) => { mapOf(value).widthFrom = "missing"; }, "not a field"],
      ["zero", (value) => { mapOf(value).maxWidth = 0; }, ">0"],
      ["fraction", (value) => { mapOf(value).maxWidth = 1.5; }, "expected int"],
    ];
    for (const [label, mutate, message] of cases) {
      const value = draft();
      mutate(value);
      const parsed = parseAuthoredDag(value);
      expect(parsed.ok, label).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n"), label).toContain(message);
    }
  });

  it("rejects executable/unsupported child and gather forms", () => {
    const nested = draft();
    childNodesOf(nested)[0]!.kind = "map";
    expect(parseAuthoredDag(nested).ok).toBe(false);

    const review = draft();
    childNodesOf(review)[0] = {
      id: "score-item",
      kind: "human-review",
      purpose: "Approve one item",
    };
    expect(parseAuthoredDag(review).ok).toBe(false);

    const reducer = draft();
    mapOf(reducer).gather = { kind: "expression", source: "results => results" };
    expect(parseAuthoredDag(reducer).ok).toBe(false);

    const output = draft();
    mapOf(output).output = fields(["forged", scalar("string")]);
    const parsedOutput = parseAuthoredDag(output);
    expect(parsedOutput.ok).toBe(false);
    if (!parsedOutput.ok) {
      expect(parsedOutput.problems.join("\n")).toContain("collect gather derives it");
    }
  });

  it("accepts every positive safe maxWidth and preserves it", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), (bound) => {
      const value = draft();
      mapOf(value).maxWidth = bound;
      const map = mustParse(value).nodes.find((node) => node.kind === "map");
      if (map?.kind !== "map") throw new Error("expected map node");
      expect(map.maxWidth).toBe(bound);
    }));
  });

  it("canonicalizes child nodes independently of outer node order", () => {
    const value = draft();
    const first = childNodesOf(value)[0]!;
    childOf(value).nodes = [
      {
        id: "finish-score",
        kind: "transform",
        purpose: "Finish the score",
        output: fields(["verdict", scalar("string")]),
      },
      first,
    ];
    (childOf(value).structure as JsonObject).order = ["score-item", "finish-score"];
    const parsed = mustParse(value);
    const map = parsed.nodes.find((node) => node.kind === "map");
    if (map?.kind !== "map") throw new Error("expected map node");
    expect(map.child.nodes.map((node) => String(node.id))).toEqual(["score-item", "finish-score"]);
  });

  it("rejects a child fan-out without a join and router terminals with different schemas", () => {
    const noJoin = draft();
    childOf(noJoin).nodes = [
      { id: "start", kind: "fetch", purpose: "Start", output: fields(["id", scalar("string")]) },
      { id: "left", kind: "transform", purpose: "Left", output: fields(["value", scalar("string")]) },
      { id: "right", kind: "transform", purpose: "Right", output: fields(["value", scalar("string")]) },
    ];
    childOf(noJoin).structure = { shape: "fan-out", source: "start", branches: ["left", "right"] };
    const noJoinParsed = parseAuthoredDag(noJoin);
    expect(noJoinParsed.ok).toBe(false);
    if (!noJoinParsed.ok) expect(noJoinParsed.problems.join("\n")).toContain("requires a join");

    const router = draft();
    childOf(router).nodes = [
      {
        id: "classify",
        kind: "fetch",
        purpose: "Classify",
        output: { fields: [{ name: "route", type: { kind: "enum", values: ["left", "right"] } }] },
      },
      { id: "left", kind: "transform", purpose: "Left", output: fields(["value", scalar("string")]) },
      { id: "right", kind: "transform", purpose: "Right", output: fields(["score", scalar("number")]) },
    ];
    childOf(router).structure = {
      shape: "router",
      classifier: "classify",
      cases: [{ label: "left", when: { field: "route", equals: "left" }, to: "left" }],
      default: "right",
    };
    const routerParsed = parseAuthoredDag(router);
    expect(routerParsed.ok).toBe(false);
    if (!routerParsed.ok) expect(routerParsed.problems.join("\n")).toContain("output must match");
  });
});

describe("authored map codegen and plate rendering", () => {
  const childShapes: Readonly<Record<string, JsonObject>> = {
    linear: childOf(draft()),
    "fan-out": {
      id: "fan-child",
      nodes: [
        { id: "start", kind: "fetch", purpose: "Start", output: fields(["id", scalar("string")]) },
        { id: "left", kind: "transform", purpose: "Left", output: fields(["value", scalar("string")]) },
        { id: "right", kind: "transform", purpose: "Right", output: fields(["value", scalar("string")]) },
        { id: "join", kind: "transform", purpose: "Join", output: fields(["result", scalar("string")]) },
      ],
      structure: { shape: "fan-out", source: "start", branches: ["left", "right"], join: "join" },
    },
    diamond: {
      id: "diamond-child",
      nodes: [
        { id: "start", kind: "fetch", purpose: "Start", output: fields(["id", scalar("string")]) },
        { id: "left", kind: "transform", purpose: "Left", output: fields(["value", scalar("string")]) },
        { id: "right", kind: "transform", purpose: "Right", output: fields(["value", scalar("string")]) },
        { id: "join", kind: "transform", purpose: "Join", output: fields(["result", scalar("string")]) },
      ],
      structure: { shape: "diamond", source: "start", branches: ["left", "right"], join: "join" },
    },
    router: {
      id: "router-child",
      nodes: [
        {
          id: "classify",
          kind: "fetch",
          purpose: "Classify",
          output: { fields: [{ name: "route", type: { kind: "enum", values: ["left", "right"] } }] },
        },
        { id: "left", kind: "transform", purpose: "Left", output: fields(["result", scalar("string")]) },
        { id: "right", kind: "transform", purpose: "Right", output: fields(["result", scalar("string")]) },
      ],
      structure: {
        shape: "router",
        classifier: "classify",
        cases: [{ label: "left", when: { field: "route", equals: "left" }, to: "left" }],
        default: "right",
      },
    },
    sources: {
      id: "sources-child",
      nodes: [
        { id: "source-a", kind: "source", purpose: "Source A", output: fields(["a", scalar("string")]) },
        { id: "source-b", kind: "source", purpose: "Source B", output: fields(["b", scalar("string")]) },
        { id: "join", kind: "transform", purpose: "Join", output: fields(["joined", scalar("string")]) },
        { id: "assemble", kind: "transform", purpose: "Assemble", output: fields(["result", scalar("string")]) },
      ],
      structure: { shape: "sources", sources: ["source-a", "source-b"], join: "join", assemble: "assemble" },
    },
  };

  for (const [shape, child] of Object.entries(childShapes)) {
    it(`generates and proves a ${shape} inline child`, async () => {
      const value = draft();
      mapOf(value).child = structuredClone(child);
      const result = await runGauntlet(mustParse(value), join(tmpRoot, `shape-${shape}`));
      if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
      expect(result.described.nodes.filter((node) => node.kind === "map")).toHaveLength(1);
    });
  }

  it("threads child LLMs through the parent model factory and prompt registry", async () => {
    const value = draft();
    childOf(value).nodes = [{
      id: "score-item",
      kind: "llm",
      purpose: "Score one record",
      output: fields(["score", scalar("number")]),
    }];
    const scaffold = buildAuthoredScaffold(mustParse(value));
    expect(scaffold.dagTs).toContain("export const createAuthoredMapDag");
    expect(scaffold.dagTs).toContain("const createScoreItemsMap = (model: string)");
    expect(scaffold.dagTs).toContain("createScoreItem(model)");
    expect(scaffold.prompts.map((prompt) => prompt.name)).toEqual([
      "authored-map-score-items@score-item",
    ]);
    const result = await runGauntlet(mustParse(value), join(tmpRoot, "child-llm"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result.described.prompts).toEqual(["authored-map-score-items@score-item"]);
    expect(JSON.stringify(result.described.outputSchema)).toContain('"confidence"');
  });

  it("generates chained maps and keeps sibling child prompt names injective", async () => {
    const value = draft();
    const firstMap = mapOf(value);
    const secondMap = structuredClone(firstMap);
    secondMap.id = "summarize-items";
    secondMap.widthFrom = "results";
    secondMap.child = {
      id: "summarize-item-child",
      nodes: [{
        id: "score-item",
        kind: "llm",
        purpose: "Summarize one score",
        output: fields(["summary", scalar("string")]),
      }],
      structure: { shape: "linear", order: ["score-item"] },
    };
    childNodesOf(value)[0]!.kind = "llm";
    nodesOf(value).push(secondMap);
    (value.structure as JsonObject).order = ["scope-records", "score-items", "summarize-items"];

    const parsed = mustParse(value);
    const scaffold = buildAuthoredScaffold(parsed);
    expect(scaffold.prompts.map((prompt) => prompt.name).sort()).toEqual([
      "authored-map-score-items@score-item",
      "authored-map-summarize-items@score-item",
    ]);
    const result = await runGauntlet(parsed, join(tmpRoot, "chained-maps"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result.described.nodes.filter((node) => node.kind === "map")).toHaveLength(2);
  });

  it("emits a real createMapNode with a static child and collect reducer", () => {
    const scaffold = buildAuthoredScaffold(mustParse(MAP_FIXTURE));
    expect(scaffold.dagTs).toContain("createMapNode");
    expect(scaffold.dagTs).toContain('widthFrom: "items"');
    expect(scaffold.dagTs).toContain("maxWidth: 25");
    expect(scaffold.dagTs).toContain('id: "score-item-child"');
    expect(scaffold.dagTs).toContain("reduce: (results) => ok({ results: [...results] })");
    expect(scaffold.dagTs).not.toContain("eval(");
  });

  it("survives generate/import/lint/describe and renders exactly one bounded plate", async () => {
    const result = await runGauntlet(mustParse(MAP_FIXTURE), join(tmpRoot, "gauntlet"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));

    const maps = result.described.nodes.filter((node) => node.kind === "map");
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({
      id: "score-items",
      mapping: {
        widthFrom: "items",
        maxWidth: 25,
        childDagId: "score-item-child",
        gather: { kind: "collect", field: "results" },
      },
    });
    expect(result.described.nodes.some((node) => node.id === "score-item")).toBe(false);

    const mermaid = describedToMermaid(result.described);
    expect(mermaid.match(/n_score_ditems\[\[/g)).toHaveLength(1);
    expect(mermaid).toContain("width: items × n (0 ≤ n ≤ 25)");
    expect(mermaid).toContain("child: score-item-child");
    expect(mermaid).toContain("gather: collect → results");
    expect(mermaid).not.toContain("score-item<br/>");
  });
});
