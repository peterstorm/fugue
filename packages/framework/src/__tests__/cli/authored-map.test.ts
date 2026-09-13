import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { parseAuthoredDag, parseAuthoredDagJson, type AuthoredDag } from "../../cli/authored.js";
import { parseIntent, runCompose, type ComposeTurn } from "../../cli/compose.js";
import { buildAuthoredScaffold, structuralProjection } from "../../cli/authored-codegen.js";
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
import { InMemoryCheckpointer } from "../../checkpoint/checkpointer.js";
import { defineDag } from "../../executor/define-dag.js";
import { runDag } from "../../executor/run-dag.js";
import { validateDagShape } from "../../shared/validate-dag.js";
import { buildDescribedDag } from "../../describe/build-described-dag.js";
import { createTransformNode } from "../../nodes/transform.js";
import type { DagDef, DagDefInput } from "../../types/dag.js";
import { DAG_INPUT, ID_MAX_LENGTH } from "../../types/ids.js";
import { resourceName } from "../../types/witness.js";
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
  literalOutput: CollectedMapOutput<"results", number>,
  prototypeNamedOutput: CollectedMapOutput<"toString", number>,
  widenedOutput: CollectedMapOutput<string, number>,
  patternedOutput: CollectedMapOutput<`results_${string}`, number>,
): void => {
  if ("left" in unionOutput) {
    const left: readonly number[] = unionOutput.left;
    void left;
  }
  const possiblyMissing: readonly number[] | undefined = widenedOutput.anyField;
  const widenedPrototypeName: readonly number[] | undefined = widenedOutput.toString;
  const absentLiteralPrototypeName: undefined = literalOutput.toString;
  const gatheredPrototypeName: readonly number[] = prototypeNamedOutput.toString;
  const patternedPossiblyMissing: readonly number[] | undefined = patternedOutput.results_other;
  void [possiblyMissing, widenedPrototypeName, absentLiteralPrototypeName];
  void [gatheredPrototypeName, patternedPossiblyMissing];
  // @ts-expect-error Null-prototype collect outputs never inherit callable Object members.
  widenedOutput.toString();
  // @ts-expect-error A non-prototype gather field leaves toString absent, not callable.
  literalOutput.toString();
  // @ts-expect-error A union-selected field is not present in every output arm.
  const notAlwaysLeft: readonly number[] = unionOutput.left;
  // @ts-expect-error An infinite template-literal domain cannot promise every matching key.
  const notAlwaysPatterned: readonly number[] = patternedOutput.results_other;
  void notAlwaysLeft;
  void notAlwaysPatterned;
};
void assertCollectOutputTypes;

const assertMapTypePolicies = (child: DagDef): void => {
  const inputSchema = z.object({ items: z.array(z.number()), scalar: z.string() });
  const valid = createMapNode({
    id: "typed-map",
    inputSchema,
    outputSchema: z.array(z.number()),
    widthFrom: "items",
    maxWidth: 3,
    child,
    childOutputSchema: z.number(),
    reduce: (values) => ok([...values]),
  });
  createMapNode({
    id: "invalid-typed-map",
    inputSchema,
    outputSchema: z.array(z.number()),
    // @ts-expect-error A known scalar input field cannot determine map width.
    widthFrom: "scalar",
    maxWidth: 3,
    child,
    childOutputSchema: z.number(),
    reduce: (values) => ok([...values]),
  });
  const forgedSource: typeof valid = {
    ...valid,
    // @ts-expect-error A map consumes upstream input and cannot be a source.
    isSource: true,
  };
  const forgedSideEffects: typeof valid = {
    ...valid,
    // @ts-expect-error Mapped fan completion persistence is always a write.
    sideEffects: { kind: "none" },
  };
  const forgedResource: typeof valid = {
    ...valid,
    sideEffects: {
      ...valid.sideEffects,
      // @ts-expect-error Only the constructor-owned fan resource is valid for a map.
      resource: resourceName("checkpoint:other"),
    },
  };
  const forgedConfidence: typeof valid = {
    ...valid,
    // @ts-expect-error Maps do not emit a confidence value.
    confidence: { mode: "value", extract: () => ({ bucket: "high", source: "heuristic" }) },
  };
  void [valid, forgedSource, forgedSideEffects, forgedResource, forgedConfidence];
};
void assertMapTypePolicies;

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

const importGeneratedDag = async (
  dag: AuthoredDag,
  name: string,
  source = buildAuthoredScaffold(dag).dagTs,
): Promise<DagDef> => {
  const dir = join(tmpRoot, `import-${name}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "dag.ts");
  await writeFile(path, source, "utf-8");
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
  it("typechecks and executes a fully body-implemented generated map", async () => {
    const authored = mustParse(MAP_FIXTURE);
    const original = buildAuthoredScaffold(authored).dagTs;
    const bodies = [
      'fetch: async (_input) => $fugue.ok({ requestId: _input.requestId, items: [{ recordId: "b", amount: 2 }, { recordId: "a", amount: 1 }] }),',
      'transform: (_input) => $fugue.ok({ recordId: _input.recordId, score: _input.amount }),',
    ];
    let bodyIndex = 0;
    const implemented = original.replace(
      /^(\s*)\/\/ @fugue-body-start[\s\S]*?^\s*\/\/ @fugue-body-end/gm,
      (_region, indentation: string) => {
        const body = bodies[bodyIndex++];
        if (body === undefined) throw new Error("generated more body regions than expected");
        return `${indentation}// @fugue-body-start\n${indentation}${body}\n${indentation}// @fugue-body-end`;
      },
    );
    expect(bodyIndex).toBe(bodies.length);
    expect(structuralProjection(implemented)).toBe(structuralProjection(original));
    const compileDir = join(tmpRoot, "implemented-compile");
    await mkdir(compileDir, { recursive: true });
    await writeFile(join(compileDir, "dag.ts"), implemented, "utf-8");

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

    const runtime = await importGeneratedDag(authored, "implemented-runtime", implemented);
    const execution = await runDag(runtime, { requestId: "request-1" }, makeNodeContext({
      runId: "implemented-authored-map",
      dagId: runtime.id,
      capabilities: { checkpointer: new InMemoryCheckpointer() },
    }));
    expect(execution.ok).toBe(true);
    if (!execution.ok) throw new Error(execution.error.kind);
    expect(execution.value).toEqual({
      results: [{ recordId: "b", score: 2 }, { recordId: "a", score: 1 }],
    });
    const collected = execution.value as Readonly<Record<string, unknown>>;
    expect(Object.getPrototypeOf(collected)).toBeNull();
    expect(Object.isFrozen(collected)).toBe(true);
    expect(Object.isFrozen(collected.results)).toBe(true);
    expect(collected.toString).toBeUndefined();
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

  it("supports every static map role with direct input and rejects fan-in roles", async () => {
    const mapNode = (): JsonObject => structuredClone(mapOf(draft()));
    const itemInput = (): JsonObject => structuredClone(nodesOf(draft())[0]!.output as JsonObject);
    const transform = (id: string): JsonObject => ({
      id,
      kind: "transform",
      purpose: `Run ${id}`,
      output: fields(["value", scalar("string")]),
    });
    const scope = (): JsonObject => structuredClone(nodesOf(draft())[0]!);

    const validRoles: readonly JsonObject[] = [
      {
        fugueAuthored: 1,
        name: "map-linear-entry",
        team: "demo",
        description: "Map at the linear entry",
        input: itemInput(),
        nodes: [mapNode(), transform("finish")],
        structure: { shape: "linear", order: ["score-items", "finish"] },
      },
      {
        fugueAuthored: 1,
        name: "map-fan-source",
        team: "demo",
        description: "Map as the fan source",
        input: itemInput(),
        nodes: [mapNode(), transform("left"), transform("right")],
        structure: { shape: "fan-out", source: "score-items", branches: ["left", "right"] },
      },
      {
        fugueAuthored: 1,
        name: "map-fan-branch",
        team: "demo",
        description: "Map as a fan branch",
        input: fields(["requestId", scalar("string")]),
        nodes: [scope(), mapNode(), transform("other-branch")],
        structure: { shape: "fan-out", source: "scope-records", branches: ["score-items", "other-branch"] },
      },
      {
        fugueAuthored: 1,
        name: "map-router-handler",
        team: "demo",
        description: "Map as a router handler",
        input: fields(["requestId", scalar("string")]),
        nodes: [
          {
            ...scope(),
            id: "classify",
            output: {
              fields: [
                ...((scope().output as JsonObject).fields as JsonObject[]),
                { name: "route", type: { kind: "enum", values: ["map", "other"] } },
              ],
            },
          },
          mapNode(),
          transform("fallback"),
        ],
        structure: {
          shape: "router",
          classifier: "classify",
          cases: [{ label: "map", when: { field: "route", equals: "map" }, to: "score-items" }],
          default: "fallback",
        },
      },
    ];

    for (const candidate of validRoles) {
      const parsed = mustParse(candidate);
      const verdict = await runGauntlet(parsed, join(tmpRoot, String(candidate.name)));
      if (!verdict.ok) throw new Error(JSON.stringify(verdict.errors, null, 2));
      expect(verdict.described.nodes.some((node) => node.kind === "map")).toBe(true);
    }

    const fanIn = validRoles[2]!;
    const fanJoin = structuredClone(fanIn);
    fanJoin.name = "map-fan-join-refused";
    (fanJoin.nodes as JsonObject[]).push(transform("second-branch"));
    fanJoin.structure = {
      shape: "diamond",
      source: "scope-records",
      branches: ["other-branch", "second-branch"],
      join: "score-items",
    };
    const refusedJoin = parseAuthoredDag(fanJoin);
    expect(refusedJoin.ok).toBe(false);
    if (!refusedJoin.ok) expect(refusedJoin.problems.join("\n")).toContain("fan-in/source role");

    const sourcesJoin: JsonObject = {
      fugueAuthored: 1,
      name: "map-sources-join-refused",
      team: "demo",
      description: "A sources fan-in cannot expose one direct width field",
      input: fields(["requestId", scalar("string")]),
      nodes: [
        { id: "source-a", kind: "source", purpose: "Read A", output: itemInput() },
        { id: "source-b", kind: "source", purpose: "Read B", output: itemInput() },
        mapNode(),
        transform("finish"),
      ],
      structure: {
        shape: "sources",
        sources: ["source-a", "source-b"],
        join: "score-items",
        assemble: "finish",
      },
    };
    const refusedSourcesJoin = parseAuthoredDag(sourcesJoin);
    expect(refusedSourcesJoin.ok).toBe(false);
    if (!refusedSourcesJoin.ok) {
      expect(refusedSourcesJoin.problems.join("\n")).toContain("fan-in/source role");
    }

    const routerClassifier = structuredClone(validRoles[3]!);
    routerClassifier.name = "map-router-classifier-refused";
    routerClassifier.structure = {
      shape: "router",
      classifier: "score-items",
      cases: [{ label: "map", when: { field: "results", equals: "map" }, to: "classify" }],
      default: "fallback",
    };
    const refusedClassifier = parseAuthoredDag(routerClassifier);
    expect(refusedClassifier.ok).toBe(false);
    if (!refusedClassifier.ok) {
      const problems = refusedClassifier.problems.join("\n");
      expect(problems).toContain("must be an enum");
      expect(problems).not.toContain("fan-in/source role");
    }
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
    const itemElement = ((((nodesOf(nested)[0]!.output as JsonObject).fields as JsonObject[])[1]!
      .type as JsonObject).element as JsonObject);
    (itemElement.fields as JsonObject[]).push({
      name: "nestedItems",
      type: {
        kind: "array",
        element: fields(["value", scalar("number")]),
      },
    });
    childNodesOf(nested)[0] = {
      id: "score-item",
      kind: "map",
      purpose: "Map a nested item",
      widthFrom: "nestedItems",
      maxWidth: 2,
      child: {
        id: "nested-item-child",
        nodes: [{
          id: "finish-nested-item",
          kind: "transform",
          purpose: "Finish a nested item",
          output: fields(["value", scalar("number")]),
        }],
        structure: { shape: "linear", order: ["finish-nested-item"] },
      },
      gather: { kind: "collect", field: "nestedResults" },
    };
    const parsedNested = parseAuthoredDag(nested);
    expect(parsedNested.ok).toBe(false);
    if (!parsedNested.ok) {
      expect(parsedNested.problems.join("\n")).toContain("nested maps and human-review are unsupported");
    }

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

  it("accepts gather-then-review as one root human gate", async () => {
    const value = draft();
    nodesOf(value).push({
      id: "review-results",
      kind: "human-review",
      purpose: "Approve the collected results",
    });
    (value.structure as JsonObject).order = ["scope-records", "score-items", "review-results"];

    const authored = mustParse(value);
    const verdict = await runGauntlet(authored, join(tmpRoot, "gather-then-review"));
    if (!verdict.ok) throw new Error(JSON.stringify(verdict.errors, null, 2));
    expect(verdict.described.nodes.find((node) => node.id === "review-results")?.humanReview).toBe(true);

    const runtime = await importGeneratedDag(authored, "gather-then-review");
    const review = runtime.nodes.find((node) => node.id === "review-results");
    if (review === undefined) throw new Error("missing generated review node");
    expect(review.inputSchema.safeParse({
      results: [{ recordId: "r-1", score: 1 }],
    }).success).toBe(true);
    expect(review.inputSchema.safeParse({ recordId: "r-1", score: 1 }).success).toBe(false);
  });

  it("enforces the runtime identifier limit on every authored identifier role", async () => {
    const boundary = draft();
    const name = "a".repeat(ID_MAX_LENGTH);
    const scopeId = "b".repeat(ID_MAX_LENGTH);
    const mapId = "c".repeat(ID_MAX_LENGTH);
    const childId = "d".repeat(ID_MAX_LENGTH);
    const childNodeId = "e".repeat(ID_MAX_LENGTH);
    boundary.name = name;
    nodesOf(boundary)[0]!.id = scopeId;
    mapOf(boundary).id = mapId;
    childOf(boundary).id = childId;
    childNodesOf(boundary)[0]!.id = childNodeId;
    (boundary.structure as JsonObject).order = [scopeId, mapId];
    (childOf(boundary).structure as JsonObject).order = [childNodeId];
    const accepted = mustParse(boundary);
    const verdict = await runGauntlet(accepted, join(tmpRoot, "max-authored-identifiers"));
    if (!verdict.ok) throw new Error(JSON.stringify(verdict.errors, null, 2));

    const cases: readonly [string, (value: JsonObject, id: string) => void][] = [
      ["name", (value, id) => { value.name = id; }],
      ["node and reference", (value, id) => {
        nodesOf(value)[0]!.id = id;
        (value.structure as JsonObject).order = [id, "score-items"];
      }],
      ["child DAG", (value, id) => { childOf(value).id = id; }],
      ["child node and reference", (value, id) => {
        childNodesOf(value)[0]!.id = id;
        (childOf(value).structure as JsonObject).order = [id];
      }],
    ];
    for (const [label, mutate] of cases) {
      const overlong = draft();
      mutate(overlong, "z".repeat(ID_MAX_LENGTH + 1));
      const refused = parseAuthoredDag(overlong);
      expect(refused.ok, label).toBe(false);
      if (!refused.ok) {
        expect(refused.problems.join("\n"), label).toContain("at most 128 characters");
      }
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

  it("rejects cycles without rejecting shared acyclic authored values", () => {
    const cyclic = draft();
    cyclic.self = cyclic;
    const refused = parseAuthoredDag(cyclic);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems).toEqual([
      "authored DAG must be an acyclic JSON value",
    ]);

    const sharedType = { kind: "string" };
    const aliased = draft();
    (aliased.input as JsonObject).fields = [
      { name: "requestId", type: sharedType },
      { name: "traceId", type: sharedType },
    ];
    expect(parseAuthoredDag(aliased).ok).toBe(true);
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

  it("accepts JS-reserved and module-reserved child ids in the prefixed child namespace", async () => {
    for (const id of ["default", "input"] as const) {
      const value = draft();
      childNodesOf(value)[0]!.id = id;
      (childOf(value).structure as JsonObject).order = [id];
      const parsed = mustParse(value);
      const scaffold = buildAuthoredScaffold(parsed);
      expect(scaffold.dagTs).toContain(`const $child_${id} =`);
      const verdict = await runGauntlet(parsed, join(tmpRoot, `child-reserved-${id}`));
      if (!verdict.ok) throw new Error(JSON.stringify(verdict.errors, null, 2));
    }
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

  it("generated fetch, source, and transform bodies fail closed until implemented", async () => {
    const mapped = await importGeneratedDag(mustParse(MAP_FIXTURE), "unimplemented-map-bodies");
    const outerFetch = mapped.nodes.find((node) => node.id === "scope-records");
    const map = mapped.nodes.find((node) => node.kind === "map");
    if (outerFetch === undefined || map?.kind !== "map") throw new Error("missing generated map nodes");
    const childTransform = map.mapping.child.nodes.find((node) => node.id === "score-item");
    if (childTransform === undefined) throw new Error("missing generated child transform");

    const sourceDag = mustParse({
      fugueAuthored: 1,
      name: "unimplemented-sources",
      team: "demo",
      description: "Exercise source placeholders",
      input: fields(["requestId", scalar("string")]),
      nodes: [
        { id: "source-a", kind: "source", purpose: "Read A", output: fields(["a", scalar("string")]) },
        { id: "source-b", kind: "source", purpose: "Read B", output: fields(["b", scalar("string")]) },
        { id: "join", kind: "transform", purpose: "Join", output: fields(["joined", scalar("string")]) },
        { id: "finish", kind: "transform", purpose: "Finish", output: fields(["done", scalar("boolean")]) },
      ],
      structure: { shape: "sources", sources: ["source-a", "source-b"], join: "join", assemble: "finish" },
    });
    const sourced = await importGeneratedDag(sourceDag, "unimplemented-source-body");
    const source = sourced.nodes.find((node) => node.id === "source-a");
    if (source === undefined) throw new Error("missing generated source");

    const context = makeNodeContext({
      runId: "unimplemented-generated",
      dagId: "generated-bodies",
    }) as TypedNodeContext<readonly []>;
    for (const [node, input] of [
      [outerFetch, { requestId: "request-1" }],
      [childTransform, { recordId: "record-1", amount: 10 }],
      [source, undefined],
    ] as const) {
      if (node.kind === "map") throw new Error("expected an ordinary generated node");
      const runnable = node as NodeDef<unknown, unknown, FrameworkError, readonly []>;
      const result = await runnable.run(input, context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          kind: "validation",
          nodeId: node.id,
          path: "body",
          message: `generated body for '${node.id}' is unimplemented`,
        });
      }
    }

    const generated = buildAuthoredScaffold(mustParse(MAP_FIXTURE)).dagTs;
    expect(generated).not.toMatch(/\bok\s*\(\s*\{/);
    expect(generated).not.toContain('"todo"');
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

  it("validates and issues the same captured retry and map-confidence policies", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "stateful-policy-capture");
    const map = generated.nodes.find((node) => node.kind === "map");
    if (map?.kind !== "map") throw new Error("missing generated map");

    const retryNode = createTransformNode({
      id: "retry-work",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      transform: (value) => ok(value),
    });
    let retryReads = 0;
    const statefulRetry = {
      ...retryNode,
      get retry() {
        retryReads++;
        return retryReads === 1
          ? { backoffMs: [100] as [number], jitterRatio: 0 }
          : { backoffMs: [NaN] as [number], jitterRatio: 2 };
      },
    };
    const retryDag = validateDagShape({
      id: "captured-retry",
      nodes: { "retry-work": statefulRetry },
      edges: [{ from: DAG_INPUT, to: "retry-work" }],
    });
    expect(retryDag.ok).toBe(true);
    if (!retryDag.ok) throw new Error(retryDag.error.kind);
    expect(retryReads).toBe(1);
    expect(retryDag.value.nodes[0]?.retry).toEqual({ backoffMs: [100], jitterRatio: 0 });

    let confidenceReads = 0;
    const confidence = {
      get mode() {
        confidenceReads++;
        return confidenceReads === 1 ? "none" : "value";
      },
    };
    const confidenceDag = validateDagShape({
      id: "captured-confidence",
      nodes: { "score-items": { ...map, confidence } },
      edges: [{ from: DAG_INPUT, to: "score-items" }],
    } as unknown as DagDefInput);
    expect(confidenceDag.ok).toBe(true);
    if (!confidenceDag.ok) throw new Error(confidenceDag.error.kind);
    expect(confidenceReads).toBe(1);
    expect(confidenceDag.value.nodes[0]?.confidence).toEqual({ mode: "none" });

    const forged = validateDagShape({
      id: "captured-confidence-extractor",
      nodes: {
        "score-items": {
          ...map,
          confidence: {
            mode: "none",
            extract: () => ({ bucket: "high", source: "heuristic" }),
          },
        },
      },
      edges: [{ from: DAG_INPUT, to: "score-items" }],
    } as unknown as DagDefInput);
    expect(forged.ok).toBe(false);
  });

  it("describes and renders a custom map reducer without claiming collect metadata", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "custom-map-render");
    const template = generated.nodes.find((node) => node.kind === "map");
    if (template?.kind !== "map") throw new Error("missing template map");
    const custom = createMapNode({
      id: "custom-map",
      inputSchema: z.object({ items: z.array(z.number()) }),
      outputSchema: z.object({ total: z.number() }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema: z.number(),
      reduce: (results) => ok({ total: results.reduce((sum, value) => sum + value, 0) }),
    });
    const described = buildDescribedDag({
      dag: defineDag({
        id: "custom-map-dag",
        nodes: { "custom-map": custom },
        edges: [{ from: DAG_INPUT, to: "custom-map" }],
        outputNodeId: "custom-map",
      }),
      route: "/custom-map",
      description: "custom map",
      version: "1.0.0",
    });
    if (!described.ok) throw new Error(described.error.kind);
    const mapped = described.value.nodes.find((node) => node.kind === "map");
    if (mapped?.kind !== "map") throw new Error("missing described map");
    expect(mapped.mapping.gather).toBeNull();
    expect(describedToMermaid(described.value)).toContain("gather: custom reducer");
  });

  it("rejects forged map source, side-effect, and confidence policies", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "forged-map-policy");
    const map = generated.nodes.find((node) => node.kind === "map");
    if (map?.kind !== "map") throw new Error("missing generated map");

    const forgeries = [
      [{ ...map, isSource: true }, "source-has-incoming"],
      [{ ...map, isSource: "source" }, "validation"],
      [{ ...map, sideEffects: { kind: "none" } }, "validation"],
      [{ ...map, sideEffects: { ...map.sideEffects, resource: resourceName("checkpoint:other") } }, "validation"],
      [{ ...map, confidence: { mode: "value", extract: () => ({ bucket: "high", source: "heuristic" }) } }, "validation"],
    ] as const;
    for (const [forged, errorKind] of forgeries) {
      const parsed = validateDagShape({
        id: "forged-map-policy",
        nodes: { "score-items": forged },
        edges: [{ from: DAG_INPUT, to: "score-items" }],
      } as unknown as DagDefInput);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatchObject({
        kind: errorKind,
        nodeId: "score-items",
      });
    }
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

  it("collects into frozen null-prototype dictionaries matching widened lookups", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "collect-reducer");
    const template = generated.nodes.find((node) => node.kind === "map");
    if (template?.kind !== "map") throw new Error("missing template map");
    const field: string = "results";
    const collect = createCollectMapNode({
      id: "collect-values",
      inputSchema: z.object({ items: z.array(z.number()) }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema: z.number(),
      gather: { kind: "collect", field },
    });

    const empty = collect.mapping.reduce([]);
    const ordered = collect.mapping.reduce([3, 1, 2]);
    if (!empty.ok || !ordered.ok) throw new Error("collect reducer failed");
    expect(empty.value.results).toEqual([]);
    expect(ordered.value.results).toEqual([3, 1, 2]);
    expect(Object.getPrototypeOf(ordered.value)).toBeNull();
    expect(ordered.value.toString).toBeUndefined();
    expect(Object.isFrozen(ordered.value.results)).toBe(true);

    const parsed = collect.outputSchema.safeParse({ results: [3, 1, 2] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.results).toEqual([3, 1, 2]);
    expect(Object.getPrototypeOf(parsed.data)).toBeNull();
    expect(Object.isFrozen(parsed.data)).toBe(true);
    expect(Object.isFrozen(parsed.data.results)).toBe(true);
    expect(parsed.data.toString).toBeUndefined();

    const inheritedNameCollect = createCollectMapNode({
      id: "collect-inherited-name",
      inputSchema: z.object({ items: z.array(z.number()) }),
      widthFrom: "items",
      maxWidth: 3,
      child: template.mapping.child,
      childOutputSchema: z.number(),
      gather: { kind: "collect", field: "toString" },
    });
    const inheritedName = inheritedNameCollect.mapping.reduce([4, 5]);
    if (!inheritedName.ok) throw new Error("collect reducer failed");
    expect(inheritedName.value.toString).toEqual([4, 5]);
    expect(Object.hasOwn(inheritedName.value, "toString")).toBe(true);
    const parsedInheritedName = inheritedNameCollect.outputSchema.parse({ toString: [4, 5] });
    expect(parsedInheritedName.toString).toEqual([4, 5]);
    expect(Object.getPrototypeOf(parsedInheritedName)).toBeNull();
    expect(Object.isFrozen(parsedInheritedName)).toBe(true);
  });

  it("contains hostile and malformed describe schemas behind null plus warnings", async () => {
    const generated = await importGeneratedDag(mustParse(MAP_FIXTURE), "hostile-describe-schema");
    const getterFailure = new Error("parse getter exploded");
    const hostile = new Proxy(z.string(), {
      get(target, property, receiver) {
        if (property === "parse") throw getterFailure;
        return Reflect.get(target, property, receiver);
      },
    });
    for (const [schema, expected] of [[hostile, getterFailure], [42, "expected a Zod schema"]] as const) {
      const warnings: unknown[] = [];
      const described = buildDescribedDag({
        dag: generated,
        inputSchema: schema,
        route: "/hostile-schema",
        description: "hostile schema",
        version: "1.0.0",
        warningSink: {
          onSchemaSerializationError: (_where, error) => warnings.push(error),
        },
      });
      expect(described.ok).toBe(true);
      if (!described.ok) throw new Error(described.error.kind);
      expect(described.value.inputSchema).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(expected instanceof Error ? warnings[0] : (warnings[0] as Error).message).toEqual(expected);
    }
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
