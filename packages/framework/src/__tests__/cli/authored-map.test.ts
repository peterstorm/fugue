import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { parseAuthoredDag, parseAuthoredDagJson, type AuthoredDag } from "../../cli/authored.js";
import { parseIntent, runCompose, type ComposeTurn } from "../../cli/compose.js";
import { buildAuthoredScaffold } from "../../cli/authored-codegen.js";
import { runGauntlet } from "../../cli/gauntlet.js";
import { describedToMermaid } from "../../cli/visualize.js";
import { z } from "zod";
import { FakeLlmClient } from "../../llm/fake-client.js";
import { tokensOnly } from "../../types/token-usage.js";
import {
  createCollectMapNode,
  createMapNode,
  type CollectedMapOutput,
} from "../../nodes/map.js";
import { makeNodeContext } from "../../shared/make-node-context.js";
import { type Result, ok } from "../../types/result.js";
import { defineDag } from "../../executor/define-dag.js";
import { validateDagShape } from "../../shared/validate-dag.js";
import { buildDescribedDag } from "../../describe/build-described-dag.js";
import { createTransformNode } from "../../nodes/transform.js";
import type { DagDef, DagDefInput } from "../../types/dag.js";
import { DAG_INPUT } from "../../types/ids.js";
import type { FrameworkError } from "../../types/errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../types/llm.js";
import type { NodeDef, TypedNodeContext } from "../../types/node.js";

const assertAuthoredDagReadonly = (dag: AuthoredDag): void => {
  // @ts-expect-error AuthoredDag owns a readonly node array.
  dag.nodes[0] = dag.nodes[0]!;
  const map = dag.nodes.find((node) => node.kind === "map");
  if (map?.kind !== "map") return;
  // @ts-expect-error Validated map bounds cannot be reassigned.
  map.maxWidth = 0;
  // @ts-expect-error Nested child definitions are deeply readonly too.
  map.child.nodes[0]!.purpose = "changed";
};
void assertAuthoredDagReadonly;

const assertCollectOutputTypes = (
  unionOutput: CollectedMapOutput<"left" | "right", number>,
  widenedOutput: CollectedMapOutput<string, number>,
  patternedOutput: CollectedMapOutput<`results_${string}`, number>,
): void => {
  if ("left" in unionOutput) {
    const left: readonly number[] = unionOutput.left;
    void left;
  }
  const possiblyMissing: readonly number[] | undefined = widenedOutput.anyField;
  const patternedPossiblyMissing: readonly number[] | undefined = patternedOutput.results_other;
  void possiblyMissing;
  void patternedPossiblyMissing;
  // @ts-expect-error A union-selected field is not present in every output arm.
  const notAlwaysLeft: readonly number[] = unionOutput.left;
  // @ts-expect-error An infinite template-literal domain cannot promise every matching key.
  const notAlwaysPatterned: readonly number[] = patternedOutput.results_other;
  void notAlwaysLeft;
  void notAlwaysPatterned;
};
void assertCollectOutputTypes;

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

const mustIntent = (raw: string) => {
  const parsed = parseIntent(raw);
  if (parsed === null) throw new Error("expected non-empty intent");
  return parsed;
};

type JsonObject = Record<string, unknown>;
const draft = (): JsonObject => structuredClone(MAP_FIXTURE) as unknown as JsonObject;
const nodesOf = (value: JsonObject): JsonObject[] => value.nodes as JsonObject[];
const mapOf = (value: JsonObject): JsonObject => nodesOf(value)[1]!;
const childOf = (value: JsonObject): JsonObject => mapOf(value).child as JsonObject;
const childNodesOf = (value: JsonObject): JsonObject[] => childOf(value).nodes as JsonObject[];

const deeplyNestedDraft = (levels = 100): JsonObject => {
  const value = draft();
  let type: JsonObject = { kind: "string" };
  for (let index = 0; index < levels; index++) {
    type = {
      kind: "array",
      element: { fields: [{ name: "nested", type }] },
    };
  }
  const input = value.input as JsonObject;
  const inputFields = input.fields as JsonObject[];
  inputFields[0]!.type = type;
  return value;
};

const importGeneratedDag = async (dag: AuthoredDag, name: string): Promise<DagDef> => {
  const dir = join(tmpRoot, `import-${name}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "dag.ts");
  await writeFile(path, buildAuthoredScaffold(dag).dagTs, "utf-8");
  const loaded: unknown = await import(pathToFileURL(path).href);
  const registration = (loaded as { readonly default?: unknown }).default;
  if (typeof registration !== "object" || registration === null || !("dag" in registration)) {
    throw new Error("generated module did not default-export a DAG registration");
  }
  return registration.dag as DagDef;
};

const runGeneratedLlm = async (
  node: DagDef["nodes"][number],
  input: unknown,
  prompt: string,
  output: unknown,
): Promise<string> => {
  if (node.kind !== "llm") throw new Error("expected a generated LLM node");
  let rendered = "";
  const llm = new FakeLlmClient((request) => {
    rendered = request.user;
    return output;
  });
  const runnable = node as NodeDef<unknown, unknown, FrameworkError, readonly ["llm", "prompts"]>;
  const context = makeNodeContext({
    runId: "authored-map-prompt",
    dagId: "authored-map",
    llm,
    prompts: { get: () => prompt },
  }) as TypedNodeContext<readonly ["llm", "prompts"]>;
  const result = await runnable.run(input, context);
  if (!result.ok) throw new Error(`generated LLM failed: ${result.error.kind}`);
  return rendered;
};

describe("AuthoredDag map node (FR-F1-010)", () => {
  it("typechecks the static contracts covered by the registered regression", () => {
    const repoRoot = resolve(__dirname, "../../../../..");
    const compiled = Bun.spawnSync([
      process.execPath,
      "./node_modules/typescript/bin/tsc",
      "--noEmit",
      "-p",
      "packages/framework/tsconfig.json",
    ], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${new TextDecoder().decode(compiled.stdout)}${new TextDecoder().decode(compiled.stderr)}`;
    expect(compiled.exitCode, output).toBe(0);
  }, 30_000);

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
    const parsedReview = parseAuthoredDag(review);
    expect(parsedReview.ok).toBe(false);
    if (!parsedReview.ok) {
      expect(parsedReview.problems.join("\n")).toContain("gather, then review at root level");
    }

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

  it("accepts sampled and boundary positive safe maxWidth values", () => {
    const assertAccepted = (bound: number): void => {
      const value = draft();
      mapOf(value).maxWidth = bound;
      const map = mustParse(value).nodes.find((node) => node.kind === "map");
      if (map?.kind !== "map") throw new Error("expected map node");
      expect(map.maxWidth).toBe(bound);
    };
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), assertAccepted));
    assertAccepted(Number.MAX_SAFE_INTEGER);

    const unsafe = draft();
    mapOf(unsafe).maxWidth = Number.MAX_SAFE_INTEGER + 1;
    expect(parseAuthoredDag(unsafe).ok).toBe(false);
  });

  it("returns structured problems for over-deep authored values", () => {
    const nested = deeplyNestedDraft();
    const parsed = parseAuthoredDag(nested);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems).toEqual([
      "authored DAG exceeds the maximum supported value depth of 64",
    ]);
    expect(parseAuthoredDagJson(JSON.stringify(nested)).ok).toBe(false);
  });

  it("repairs an over-deep refinement without losing the last proven draft", async () => {
    const turns: ComposeTurn[] = [
      { action: "draft", dag: MAP_FIXTURE },
      { action: "draft", dag: deeplyNestedDraft() },
      { action: "questions", questions: ["unexpected repair question"] },
    ];
    const client: LlmClient = {
      async sendStructured<O>(request: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
        const turn = turns.shift();
        if (turn === undefined) throw new Error("scripted LLM ran out of turns");
        const parsed = request.schema.safeParse(turn);
        if (!parsed.success) throw new Error(parsed.error.message);
        return ok({ output: parsed.data, ...tokensOnly(0, 0), rawText: JSON.stringify(turn) });
      },
      async sendWithTools(): Promise<never> {
        throw new Error("compose never uses tools");
      },
    };
    const answers = ["make it deeply nested"];
    const outcome = await runCompose(
      {
        intent: mustIntent("score records"),
        team: mustParse(MAP_FIXTURE).team,
        root: join(tmpRoot, "deep-compose"),
        maxRepairRounds: 1,
      },
      client,
      {
        ask: async () => ({ kind: "answer", text: answers.shift() ?? "abort" }),
        say: () => {},
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "llm-error") throw new Error("expected bounded llm-error");
    expect(outcome.rounds).toEqual({ questions: 0, repairs: 1, refinements: 1 });
    expect(outcome.draft).toEqual(mustParse(MAP_FIXTURE));
  });

  it("rejects unsafe compose round budgets before any effect", async () => {
    let effects = 0;
    const client: LlmClient = {
      async sendStructured(): Promise<never> {
        effects++;
        throw new Error("LLM must not run");
      },
      async sendWithTools(): Promise<never> {
        effects++;
        throw new Error("tools must not run");
      },
    };
    const io = {
      ask: async () => {
        effects++;
        return { kind: "answer" as const, text: "yes" };
      },
      say: () => { effects++; },
    };
    const common = {
      intent: mustIntent("score records"),
      team: mustParse(MAP_FIXTURE).team,
      root: join(tmpRoot, "unsafe-budget"),
    };
    await expect(runCompose({ ...common, maxQuestionRounds: Number.MAX_SAFE_INTEGER + 1 }, client, io))
      .rejects.toThrow("non-negative integer within the safe range");
    await expect(runCompose({ ...common, maxRepairRounds: Number.MAX_SAFE_INTEGER + 1 }, client, io))
      .rejects.toThrow("non-negative integer within the safe range");
    expect(effects).toBe(0);
  });

  it("returns typed validation errors for malformed raw DAG identifiers", () => {
    const work = createTransformNode({
      id: "work",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      transform: (value) => ok(value),
    });
    const base: DagDefInput = {
      id: "valid-dag",
      nodes: { work },
      edges: [{ from: DAG_INPUT, to: "work" }],
      outputNodeId: "work",
    };
    const cases: readonly DagDefInput[] = [
      { ...base, id: "bad id" },
      { ...base, outputNodeId: "bad id" },
      { ...base, edges: [{ from: "bad id", to: "work" }] },
      { ...base, edges: [{ from: DAG_INPUT, to: "bad id" }] },
    ];
    for (const candidate of cases) {
      const parsed = validateDagShape(candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.kind).toBe("validation");
    }
  });

  it("returns an owned deeply immutable proof whose generated bytes stay stable", () => {
    const dag = mustParse(MAP_FIXTURE);
    const before = buildAuthoredScaffold(dag).dagTs;
    const map = dag.nodes.find((node) => node.kind === "map");
    if (map?.kind !== "map") throw new Error("expected map node");

    expect(Object.isFrozen(dag)).toBe(true);
    expect(Object.isFrozen(dag.nodes)).toBe(true);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.child)).toBe(true);
    expect(Object.isFrozen(map.child.nodes[0])).toBe(true);
    expect(Reflect.set(map, "maxWidth", 0)).toBe(false);
    expect(Reflect.set(map.child.nodes[0]!, "purpose", "changed")).toBe(false);
    expect(buildAuthoredScaffold(dag).dagTs).toBe(before);
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

  it("compares mapped-router terminal schemas independent of field and enum order", () => {
    const router = draft();
    childOf(router).nodes = [
      {
        id: "classify",
        kind: "fetch",
        purpose: "Classify",
        output: { fields: [{ name: "route", type: { kind: "enum", values: ["left", "right"] } }] },
      },
      {
        id: "left",
        kind: "transform",
        purpose: "Left",
        output: {
          fields: [
            { name: "value", type: scalar("string") },
            { name: "state", type: { kind: "enum", values: ["open", "closed"] } },
            {
              name: "items",
              type: {
                kind: "array",
                element: fields(["first", scalar("string")], ["second", scalar("number")]),
              },
            },
          ],
        },
      },
      {
        id: "right",
        kind: "transform",
        purpose: "Right",
        output: {
          fields: [
            {
              name: "items",
              type: {
                kind: "array",
                element: fields(["second", scalar("number")], ["first", scalar("string")]),
              },
            },
            { name: "state", type: { kind: "enum", values: ["closed", "open"] } },
            { name: "value", type: scalar("string") },
          ],
        },
      },
    ];
    childOf(router).structure = {
      shape: "router",
      classifier: "classify",
      cases: [{ label: "left", when: { field: "route", equals: "left" }, to: "left" }],
      default: "right",
    };

    expect(parseAuthoredDag(router).ok).toBe(true);
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
    expect(scaffold.dagTs).toContain("const createScoreItemsMap = ($childModel: string)");
    expect(scaffold.dagTs).toContain("$child_createScoreItem($childModel)");
    expect(scaffold.prompts.map((prompt) => prompt.name)).toEqual([
      "authored-map-score-items@score-item",
    ]);
    const result = await runGauntlet(mustParse(value), join(tmpRoot, "child-llm"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result.described.prompts).toEqual(["authored-map-score-items@score-item"]);
    expect(JSON.stringify(result.described.outputSchema)).toContain('"confidence"');
  });

  it("JSON-encodes collected and child-item arrays before real prompt rendering", async () => {
    const downstream = draft();
    nodesOf(downstream).push({
      id: "summarize-results",
      kind: "llm",
      purpose: "Summarize every result",
      output: fields(["summary", scalar("string")]),
    });
    (downstream.structure as JsonObject).order = ["scope-records", "score-items", "summarize-results"];
    const downstreamDag = mustParse(downstream);
    const downstreamScaffold = buildAuthoredScaffold(downstreamDag);
    expect(downstreamScaffold.dagTs).toContain('results: JSON.stringify(input["results"])');
    const downstreamRuntime = await importGeneratedDag(downstreamDag, "map-to-llm");
    const downstreamLlm = downstreamRuntime.nodes.find((node) => node.id === "summarize-results");
    if (downstreamLlm === undefined) throw new Error("missing downstream LLM");
    const results = [{ recordId: "r-1", score: 0.92 }];
    const downstreamPrompt = downstreamScaffold.prompts.find((prompt) => prompt.name === "authored-map");
    if (downstreamPrompt === undefined) throw new Error("missing downstream prompt");
    const renderedResults = await runGeneratedLlm(
      downstreamLlm,
      { results },
      downstreamPrompt.body,
      { summary: "done", confidence: "high" },
    );
    expect(renderedResults).toContain(JSON.stringify(results));
    expect(renderedResults).not.toContain("[object Object]");

    const childArray = draft();
    const itemFields = (((nodesOf(childArray)[0]!.output as JsonObject).fields as JsonObject[])[1]!
      .type as JsonObject).element as JsonObject;
    (itemFields.fields as JsonObject[]).push({
      name: "evidence",
      type: {
        kind: "array",
        element: fields(["code", scalar("string")]),
      },
    });
    childOf(childArray).nodes = [{
      id: "score-item",
      kind: "llm",
      purpose: "Score item evidence",
      output: fields(["score", scalar("number")]),
    }];
    const childDag = mustParse(childArray);
    const childScaffold = buildAuthoredScaffold(childDag);
    expect(childScaffold.dagTs).toContain('evidence: JSON.stringify(input["evidence"])');
    const childRuntime = await importGeneratedDag(childDag, "child-array-to-llm");
    const runtimeMap = childRuntime.nodes.find((node) => node.kind === "map");
    if (runtimeMap?.kind !== "map") throw new Error("missing runtime map");
    const childLlm = runtimeMap.mapping.child.nodes.find((node) => node.id === "score-item");
    if (childLlm === undefined) throw new Error("missing child LLM");
    const childPrompt = childScaffold.prompts.find((prompt) => prompt.name.endsWith("@score-item"));
    if (childPrompt === undefined) throw new Error("missing child prompt");
    const evidence = [{ code: "e-1" }];
    const renderedEvidence = await runGeneratedLlm(
      childLlm,
      { recordId: "r-1", amount: 10, evidence },
      childPrompt.body,
      { score: 1, confidence: "high" },
    );
    expect(renderedEvidence).toContain(JSON.stringify(evidence));
    expect(renderedEvidence).not.toContain("[object Object]");
  });

  it("isolates child bindings from model and outer schema names", async () => {
    const mixed = draft();
    childOf(mixed).nodes = [
      {
        id: "model",
        kind: "transform",
        purpose: "Prepare the model input",
        output: fields(["recordId", scalar("string")]),
      },
      {
        id: "summarize",
        kind: "llm",
        purpose: "Summarize the model input",
        output: fields(["summary", scalar("string")]),
      },
    ];
    childOf(mixed).structure = { shape: "linear", order: ["model", "summarize"] };
    const mixedDag = mustParse(mixed);
    const mixedScaffold = buildAuthoredScaffold(mixedDag);
    expect(mixedScaffold.dagTs).toContain("const $child_model =");
    expect(mixedScaffold.dagTs).toContain("const createScoreItemsMap = ($childModel: string)");
    const mixedResult = await runGauntlet(mixedDag, join(tmpRoot, "child-model-binding"));
    if (!mixedResult.ok) throw new Error(JSON.stringify(mixedResult.errors, null, 2));

    const sameAsMap = draft();
    childNodesOf(sameAsMap)[0]!.id = "score-items";
    (childOf(sameAsMap).structure as JsonObject).order = ["score-items"];
    const sameAsMapDag = mustParse(sameAsMap);
    const sameAsMapScaffold = buildAuthoredScaffold(sameAsMapDag);
    expect(sameAsMapScaffold.dagTs).toContain("const ScoreItemsSchema =");
    expect(sameAsMapScaffold.dagTs).toContain("const $child_ScoreItemsSchema =");
    const sameAsMapRuntime = await importGeneratedDag(sameAsMapDag, "same-as-map-schema");
    const sameAsMapNode = sameAsMapRuntime.nodes.find((node) => node.kind === "map");
    if (sameAsMapNode?.kind !== "map") throw new Error("missing same-name map");
    expect(sameAsMapNode.outputSchema.safeParse({
      results: [{ recordId: "r-1", score: 1 }],
    }).success).toBe(true);
    expect(sameAsMapNode.outputSchema.safeParse({ recordId: "r-1", score: 1 }).success).toBe(false);

    const sameAsOuter = draft();
    childNodesOf(sameAsOuter)[0]!.id = "scope-records";
    childNodesOf(sameAsOuter)[0]!.output = fields(["score", scalar("number")]);
    (childOf(sameAsOuter).structure as JsonObject).order = ["scope-records"];
    const sameAsOuterDag = mustParse(sameAsOuter);
    const sameAsOuterRuntime = await importGeneratedDag(sameAsOuterDag, "same-as-outer-schema");
    const sameAsOuterMap = sameAsOuterRuntime.nodes.find((node) => node.kind === "map");
    if (sameAsOuterMap?.kind !== "map") throw new Error("missing outer-collision map");
    expect(sameAsOuterMap.inputSchema.safeParse({
      requestId: "request-1",
      items: [{ recordId: "r-1", amount: 10 }],
    }).success).toBe(true);
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

  it("emits the honest collect-map constructor with a static child", () => {
    const scaffold = buildAuthoredScaffold(mustParse(MAP_FIXTURE));
    expect(scaffold.dagTs).toContain("createCollectMapNode");
    expect(scaffold.dagTs).toContain('widthFrom: "items"');
    expect(scaffold.dagTs).toContain("maxWidth: 25");
    expect(scaffold.dagTs).toContain('id: "score-item-child"');
    expect(scaffold.dagTs).toContain('gather: { kind: "collect", field: "results" }');
    expect(scaffold.dagTs).not.toContain("reduce:");
    expect(scaffold.dagTs).not.toContain("eval(");
  });

  it("binds collect metadata to its exact reducer and schema identities", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "manual-map-metadata");
    const template = generated.nodes.find((node) => node.kind === "map");
    if (template?.kind !== "map") throw new Error("missing template map");
    const inputSchema = z.object({ items: z.array(z.number()) });
    const childOutputSchema = z.number();
    const collect = createCollectMapNode({
      id: "honest-map",
      inputSchema,
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema,
      gather: { kind: "collect", field: "results" },
    });
    const provenance = collect.mapping.authoredGather;
    if (provenance === undefined) throw new Error("missing collect provenance");

    const singleIdentityMismatches = [
      {
        ...collect,
        outputSchema: z.object({ results: z.array(z.number()) }),
      },
      {
        ...collect,
        mapping: { ...collect.mapping, childOutputSchema: z.number() },
      },
      {
        ...collect,
        mapping: {
          ...collect.mapping,
          reduce: (results: readonly number[]) => collect.mapping.reduce(results),
        },
      },
    ];
    for (const [index, mismatched] of singleIdentityMismatches.entries()) {
      const id = `mismatched-collect-${index}`;
      expect(() => defineDag({
        id,
        nodes: { "honest-map": mismatched },
        edges: [{ from: DAG_INPUT, to: "honest-map" }],
      })).toThrow("requires a valid immutable mapping descriptor");
    }

    const custom = createMapNode({
      id: "manual-map",
      inputSchema,
      outputSchema: z.object({ total: z.number() }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema,
      reduce: (results: readonly number[]) => ok({ total: results.reduce((sum, value) => sum + value, 0) }),
    });
    const transplanted = {
      ...custom,
      mapping: { ...custom.mapping, authoredGather: provenance },
    };

    expect(() => defineDag({
      id: "transplanted-collect",
      nodes: { "manual-map": transplanted },
      edges: [{ from: DAG_INPUT, to: "manual-map" }],
    })).toThrow("requires a valid immutable mapping descriptor");
  });

  it("captures a stateful child schema once and keeps collect output truthful", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "stateful-child-schema");
    const template = generated.nodes.find((node) => node.kind === "map");
    if (template?.kind !== "map") throw new Error("missing template map");
    let reads = 0;
    const firstSchema = z.string();
    const laterSchema = z.number() as unknown as z.ZodType<string>;
    const config = {
      id: "captured-schema-map",
      inputSchema: z.object({ items: z.array(z.string()) }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      get childOutputSchema(): z.ZodType<string> {
        reads++;
        return reads === 1 ? firstSchema : laterSchema;
      },
      gather: { kind: "collect" as const, field: "results" as const },
    };

    const collect = createCollectMapNode(config);
    expect(reads).toBe(1);
    const reduced = collect.mapping.reduce(["captured"]);
    if (!reduced.ok) throw new Error(reduced.error.kind);
    expect(collect.mapping.childOutputSchema).toBe(firstSchema);
    expect(collect.outputSchema.safeParse(reduced.value).success).toBe(true);

    const described = buildDescribedDag({
      dag: defineDag({
        id: "captured-schema-dag",
        nodes: { "captured-schema-map": collect },
        edges: [{ from: DAG_INPUT, to: "captured-schema-map" }],
        outputNodeId: "captured-schema-map",
      }),
      route: "/captured-schema-dag",
      description: "captured schema",
      version: "1.0.0",
    });
    if (!described.ok) throw new Error(described.error.kind);
    const map = described.value.nodes.find((node) => node.kind === "map");
    if (map?.kind !== "map" || map.mapping.gather === null) throw new Error("missing gather");
    expect(map.mapping.gather).toEqual({ kind: "collect", field: "results" });
    expect(map.mapping.gather).not.toBe(collect.mapping.authoredGather);
    expect(Reflect.ownKeys(map.mapping.gather)).toEqual(["kind", "field"]);
  });

  it("collects empty and ordered child results behind a truthful output schema", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "collect-reducer");
    const template = generated.nodes.find((node) => node.kind === "map");
    if (template?.kind !== "map") throw new Error("missing template map");
    const collect = createCollectMapNode({
      id: "collect-values",
      inputSchema: z.object({ items: z.array(z.number()) }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema: z.number(),
      gather: { kind: "collect", field: "results" },
    });

    const empty = collect.mapping.reduce([]);
    const ordered = collect.mapping.reduce([3, 1, 2]);
    expect(empty).toEqual(ok({ results: [] }));
    expect(ordered).toEqual(ok({ results: [3, 1, 2] }));
    if (!ordered.ok) throw new Error("collect reducer failed");
    expect(collect.outputSchema.safeParse(ordered.value).success).toBe(true);
    expect(Object.isFrozen(ordered.value.results)).toBe(true);
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
