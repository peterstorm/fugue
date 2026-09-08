import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { z } from "zod";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { defineDag, runDag } from "../executor/index.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createEvalJudgeNode } from "../nodes/eval-judge.js";
import type { EvalJudgeNodeDef, EvalJudgeResult, EvalJudgeRubric } from "../types/eval-judge.js";
import type { LlmClient } from "../types/llm.js";
import { NO_TOKENS } from "../types/token-usage.js";
import { stubSendWithTools } from "./_llm-mocks.js";
import { withHumanReview } from "../nodes/human-review.js";
import { createMapNode } from "../nodes/map.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { validateDagShape } from "../shared/validate-dag.js";
import type { DagDef } from "../types/dag.js";
import { DAG_INPUT, nodeId } from "../types/ids.js";
import { ok } from "../types/result.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import { resourceName, witness, witnessValue } from "../types/witness.js";

const fixture = () => {
  const calls: number[] = [];
  const work = createFetchNode({
    id: "work", inputSchema: z.number(), outputSchema: z.number(),
    fetch: async (n) => { calls.push(n); return ok(n * 2); },
  });
  const child = defineDag({
    id: "child", nodes: { work },
    edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work",
  });
  const fan = createMapNode({
    id: "fan", inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.array(z.number()), widthFrom: "items", maxWidth: 4,
    child, childOutputSchema: z.number(), reduce: (values) => ok([...values]),
  });
  const parse = (candidate: DagDef) => validateDagShape({
    id: "root", nodes: { fan: { ...fan, mapping: { ...fan.mapping, child: candidate } } },
    edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan",
  });
  const execute = async (parsed: ReturnType<typeof parse>) => parsed.ok
    ? runDag(parsed.value, { items: [1, 2] }, makeNodeContext({
        runId: "snapshot-run", dagId: "root",
        capabilities: { checkpointer: new InMemoryCheckpointer() },
      }))
    : undefined;
  return { calls, work, child, fan, parse, execute };
};

const resource = resourceName("snapshot-resource");

const passedJudge: EvalJudgeResult = {
  outcome: "passed", score: 1, criteriaScores: { accuracy: 1 }, failedCriteria: [], reason: "original",
};

const judgeFixture = (rubric: EvalJudgeRubric = { source: "inline", text: "original rubric" }) => {
  const executed: EvalJudgeNodeDef[] = [];
  const config = { id: "quality", criteria: ["accuracy"], threshold: 0.8, model: "original-model", rubric };
  const judge = {
    id: nodeId("quality"), kind: "eval-judge" as const, config,
    async run(this: EvalJudgeNodeDef) { executed.push(this); return passedJudge; },
  };
  return { executed, config, judge };
};

const outerDag = (fan: ReturnType<typeof fixture>["fan"]) => defineDag({
  id: "root", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan",
});

const executeOuter = (dag: DagDef) => runDag(dag, { items: [1] }, makeNodeContext({
  runId: "judge-snapshot-run", dagId: "root", capabilities: { checkpointer: new InMemoryCheckpointer() },
}));

const ownedJudge = (dag: DagDef): EvalJudgeNodeDef => {
  const map = dag.nodes[0];
  if (map.kind !== "map" || !map.mapping.child.evalJudges?.[0]) throw new Error("expected mapped judge");
  return map.mapping.child.evalJudges[0];
};

describe("mapped evaluator definitions are owned execution snapshots", () => {
  for (const boundary of ["createMapNode", "defineDag"] as const) {
    it(`captures executable and nested configuration before alias mutation after ${boundary}`, async () => {
      const f = fixture();
      const { judge, config, executed } = judgeFixture();
      const judges = [judge];
      const originalRun = judge.run;
      const fan = createMapNode({
        id: "fan", inputSchema: f.fan.inputSchema, outputSchema: f.fan.outputSchema,
        ...f.fan.mapping, child: { ...f.child, evalJudges: judges },
      });
      const beforeMutation = boundary === "defineDag" ? outerDag(fan) : undefined;
      judge.run = async () => { throw new Error("replacement judge must not execute"); };
      judge.id = nodeId("replacement");
      config.criteria[0] = "mutated";
      config.criteria.push("extra");
      config.model = "mutated-model";
      config.threshold = 0;
      Reflect.set(config.rubric, "text", "mutated rubric");
      judges.length = 0;
      const dag = beforeMutation ?? outerDag(fan);
      const captured = ownedJudge(dag);
      expect(await executeOuter(dag)).toEqual(ok([2]));
      expect(executed).toEqual([captured]);
      expect(executed[0]).toBe(captured);
      expect(captured.id).toBe(nodeId("quality"));
      expect(captured.run).toBe(originalRun);
      expect(captured.config).toEqual({ id: "quality", criteria: ["accuracy"], threshold: 0.8,
        model: "original-model", rubric: { source: "inline", text: "original rubric" } });
      for (const value of [captured, captured.config, captured.config.criteria, captured.config.rubric]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      expect(Object.isFrozen(originalRun)).toBe(false);
      expect(dag.nodes[0].inputSchema).toBe(f.fan.inputSchema);
      expect(Object.isFrozen(f.fan.inputSchema)).toBe(false);
    });
  }

  it("captures a real factory judge's original run before its mutable entry is replaced", async () => {
    const f = fixture();
    const judge = createEvalJudgeNode({ id: "quality", criteria: ["accuracy"],
      model: "original-model", rubric: { source: "inline", text: "original rubric" } });
    const originalRun = judge.run;
    const requests: { readonly model?: string; readonly user: string }[] = [];
    const judgeLlm: LlmClient = {
      sendStructured: async request => {
        requests.push(request);
        return ok({ ...NO_TOKENS, rawText: "judge response", output: request.schema.parse({
          score: 1, criteria_scores: [{ name: "accuracy", score: 1 }], failed_criteria: [], reason: "original",
        }) });
      },
      sendWithTools: stubSendWithTools,
    };
    const child = defineDag({ id: "child", nodes: { work: f.work },
      edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work", evalJudges: [judge] });
    let replacementCalls = 0;
    Reflect.set(judge, "run", async () => { replacementCalls++; return passedJudge; });
    const parsed = f.parse(child);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(await runDag(parsed.value, { items: [1] }, makeNodeContext({
      runId: "real-judge-snapshot", dagId: "root", judgeLlm,
      capabilities: { checkpointer: new InMemoryCheckpointer() },
    }))).toEqual(ok([2]));
    expect(ownedJudge(parsed.value).run).toBe(originalRun);
    expect(Object.isFrozen(ownedJudge(parsed.value))).toBe(true);
    expect(replacementCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("original-model");
    expect(requests[0].user).toContain("original rubric");
  });

  it("owns both rubric variants and arbitrary criteria values without freezing caller data", () => {
    fc.assert(fc.property(fc.array(fc.string()), fc.string(), fc.boolean(), (criteria, text, template) => {
      const f = fixture();
      const rubric: EvalJudgeRubric = template ? { source: "template", templateId: text } : { source: "inline", text };
      const { judge } = judgeFixture(rubric);
      judge.config.criteria = criteria;
      const parsed = f.parse({ ...f.child, evalJudges: [judge] });
      if (!parsed.ok) throw new Error("valid judge snapshot rejected");
      const captured = ownedJudge(parsed.value);
      expect(captured.config.criteria).toEqual(criteria);
      expect(captured.config.criteria).not.toBe(criteria);
      expect(captured.config.rubric).toEqual(rubric);
      expect(captured.config.rubric).not.toBe(rubric);
      expect(Object.isFrozen(captured.config.rubric)).toBe(true);
      expect(Object.isFrozen(criteria)).toBe(false);
      expect(Object.isFrozen(rubric)).toBe(false);
    }));
  });

  it("reads each evaluator accessor once and executes that exact owned value", async () => {
    const f = fixture();
    const { judge, config, executed } = judgeFixture();
    const reads = { judges: 0, run: 0, config: 0, criteria: 0, rubric: 0, text: 0 };
    const run = judge.run;
    Object.defineProperty(judge, "run", { enumerable: true, get: () => {
      if (++reads.run > 1) throw new Error("run reread");
      return run;
    } });
    Object.defineProperty(judge, "config", { enumerable: true, get: () => {
      if (++reads.config > 1) throw new Error("config reread");
      return config;
    } });
    Object.defineProperty(config, "criteria", { enumerable: true, get: () => {
      if (++reads.criteria > 1) throw new Error("criteria reread");
      return ["accuracy"];
    } });
    Object.defineProperty(config, "rubric", { enumerable: true, get: () => {
      if (++reads.rubric > 1) throw new Error("rubric reread");
      return { source: "inline", get text() { reads.text++; return "original rubric"; } };
    } });
    const parsed = validateDagShape({ id: "child", nodes: { work: f.work },
      edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work",
      get evalJudges() { reads.judges++; return [judge]; },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("accessor snapshot rejected");
    const root = f.parse(parsed.value);
    if (!root.ok) throw new Error("owned child rejected");
    expect(await executeOuter(root.value)).toEqual(ok([2]));
    expect(executed[0]).toBe(ownedJudge(root.value));
    expect(reads).toEqual({ judges: 1, run: 1, config: 1, criteria: 1, rubric: 1, text: 1 });
    expect(Object.isFrozen(executed[0])).toBe(true);
  });

  it.each(["evalJudges", "run", "config", "criteria", "rubric"] as const)(
    "returns typed validation when %s cannot be captured", (field) => {
      const f = fixture();
      const { judge, config } = judgeFixture();
      const input = { id: "child", nodes: { work: f.work }, edges: [{ from: DAG_INPUT, to: "work" }], evalJudges: [judge] };
      const target = field === "evalJudges" ? input : field === "run" || field === "config" ? judge : config;
      Object.defineProperty(target, field, { enumerable: true, get: () => { throw new Error("unreadable evaluator"); } });
      const parsed = validateDagShape(input);
      expect(parsed).toMatchObject({ ok: false, error: { kind: "validation" } });
      if (!parsed.ok && parsed.error.kind === "validation") expect(parsed.error.message).toContain("unreadable evaluator");
    },
  );
});

describe("mapped child eligibility covers the owned execution snapshot", () => {
  it("executes supported accessor-bearing policy without consulting it again", async () => {
    const f = fixture();
    let reads = 0;
    const work = { ...f.work, get sideEffects(): SideEffectProfile {
      reads++;
      return { kind: "reads", resource };
    } };
    const parsed = f.parse({ ...f.child, nodes: [work] });
    expect(parsed.ok).toBe(true);
    const capturedReads = reads;
    expect(await f.execute(parsed)).toEqual(ok([2, 4]));
    expect(reads).toBe(capturedReads);
    expect(f.calls).toEqual([1, 2]);
  });

  it.each(["reads", "writes"] as const)("refuses %s freshness introduced after early eligibility", async (kind) => {
    const f = fixture();
    let reads = 0;
    let extractorCalls = 0;
    const extract = () => { extractorCalls++; return witnessValue("version", "v1"); };
    const unsupported: SideEffectProfile = kind === "reads"
      ? { kind, resource, extractWitness: extract }
      : { kind, resource,
          extractConditionedOn: () => { extractorCalls++; return witness("version", resource, "v1"); },
          extractNewWitness: extract };
    const work = { ...f.work, get sideEffects(): SideEffectProfile {
      return ++reads === 1 ? { kind: "none" } : unsupported;
    } };
    const parsed = f.parse({ ...f.child, nodes: [work] });
    await f.execute(parsed);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "validation" } });
    if (!parsed.ok && parsed.error.kind === "validation") {
      expect(parsed.error.message).toContain("freshness extractors");
    }
    expect(f.calls).toEqual([]);
    expect(extractorCalls).toBe(0);
  });

  it("refuses an extractor first revealed while freezing the execution profile", async () => {
    const f = fixture();
    let reads = 0;
    let extractorCalls = 0;
    const sideEffects: SideEffectProfile = {
      kind: "reads", resource,
      get extractWitness() {
        return ++reads <= 2 ? undefined : () => {
          extractorCalls++;
          return witnessValue("version", "v1");
        };
      },
    };
    const parsed = f.parse({ ...f.child, nodes: [{ ...f.work, sideEffects }] });
    await f.execute(parsed);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(f.calls).toEqual([]);
    expect(extractorCalls).toBe(0);
  });

  it("never brands an owned profile containing an unsupported accessor-supplied extractor", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 6 }), (safeReads) => {
      const f = fixture();
      let reads = 0;
      const extract = () => witnessValue("version", "v1");
      const sideEffects: SideEffectProfile = {
        kind: "reads", resource,
        get extractWitness() { return ++reads > safeReads ? extract : undefined; },
      };
      const parsed = f.parse({ ...f.child, nodes: [{ ...f.work, sideEffects }] });
      if (!parsed.ok) {
        expect(parsed.error.kind).toBe("validation");
        return;
      }
      const map = parsed.value.nodes[0];
      if (map.kind !== "map") throw new Error("expected map descriptor");
      const owned = map.mapping.child.nodes[0].sideEffects;
      if (owned.kind !== "reads") throw new Error("expected the captured read profile");
      expect(Object.isFrozen(owned)).toBe(true);
      expect(owned.extractWitness).toBeUndefined();
    }));
  });

  it("refuses human review introduced between eligibility and node capture", async () => {
    const f = fixture();
    let reads = 0;
    const review = withHumanReview(f.work, { prompt: "Approve?" }).humanReview;
    const work = { ...f.work, get humanReview() { return ++reads === 1 ? undefined : review; } };
    const parsed = f.parse({ ...f.child, nodes: [work] });
    await f.execute(parsed);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "validation" } });
    if (!parsed.ok && parsed.error.kind === "validation") {
      expect(parsed.error.message).toContain("FR-F1-011");
    }
    expect(f.calls).toEqual([]);
  });

  for (const initiallyHidden of [false, true]) {
    it(`refuses a cyclic nested map before recursive parsing (hidden=${initiallyHidden})`, async () => {
      const f = fixture();
      let kindReads = 0;
      let mappingReads = 0;
      const nested = { ...f.fan };
      const cyclic: DagDef = { ...f.child, nodes: [nested] };
      // Deliberately malformed JavaScript discriminant: the graph is derived
      // from real definitions, but changes kind between preflight and capture.
      Object.defineProperty(nested, "kind", { enumerable: true, get: () =>
        initiallyHidden && ++kindReads === 1 ? "fetch" : "map" });
      Object.defineProperty(nested, "mapping", { enumerable: true, get: () => {
        mappingReads++;
        return { ...f.fan.mapping, child: cyclic };
      } });
      const parsed = f.parse(cyclic);
      await f.execute(parsed);
      expect(parsed).toMatchObject({ ok: false, error: { kind: "validation" } });
      if (!parsed.ok && parsed.error.kind === "validation") {
        expect(parsed.error.message).toContain("nested maps are unsupported");
      }
      expect(mappingReads).toBeLessThanOrEqual(1);
      expect(f.calls).toEqual([]);
    });
  }
});
