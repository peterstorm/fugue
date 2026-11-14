import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  createGuardrailNode,
  defineDag,
  DAG_INPUT,
  runDag,
  makeNodeContext,
  FakeLlmClient,
  ok,
  runId as mkRunId,
  nodeId as mkNodeId,
  asMapIndex,
  freshnessExecutionEpoch,
} from "@fuguejs/framework";
import type { Checkpointer, GuardrailResult } from "@fuguejs/framework";
import type { SynthesisOutput } from "../schemas/summary.js";
import type { Redis } from "ioredis";
import { createGroundingGuardrailNode } from "../dag/nodes/grounding-guardrail.js";
import { createAssembleResponseNode } from "../dag/nodes/assemble-response.js";
import {
  GuardrailSkippedSchema,
  GuardrailValidatedSchema,
  GuardrailFailedSchema,
} from "../schemas/guardrail.js";
import { setUpRedis, buildCheckpointWriter, buildHealth } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import type { AppLogger } from "../logger.js";

const makeCtx = () => makeNodeContext({ runId: "test", dagId: "test" });

const makeSynthesis = (): SynthesisOutput => ({
  overallSentiment: "positive",
  sentimentScore: 0.5,
  keyTopics: ["billing"],
  summary: "Customer had a billing inquiry.",
  actionItems: [],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
});

const recordingLogger = () => {
  const diagnostics: string[] = [];
  const render = (prefix: string, msg: string, args: readonly unknown[]): string =>
    `${prefix}: ${[msg, ...args].map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}`;
  const logger: AppLogger = {
    debug: () => {},
    info: () => {},
    warn: (msg, ...args) => { diagnostics.push(render("warn", msg, args)); },
    error: (msg, ...args) => { diagnostics.push(render("error", msg, args)); },
  };
  return { logger, diagnostics };
};

describe("pr53 repair — guardrail failed-arm contract", () => {
  test("a guardrail node whose validate() throws degrades to kind 'failed' through its own OutputSchema", async () => {
    // The REAL OutputSchema composed by the grounding guardrail node — the
    // contract under repair is that it admits every arm its wrapper emits,
    // including {kind:"failed"} when validate() throws.
    const node = createGroundingGuardrailNode();
    const throwingNode = createGuardrailNode<unknown, SynthesisOutput>({
      id: "grounding-guardrail",
      inputSchema: z.unknown() as z.ZodType<unknown>,
      outputSchema: node.outputSchema,
      validate: () => {
        throw new Error("grounding validator exploded");
      },
    });

    const dag = defineDag({
      id: "guardrail-failed-arm-regression",
      nodes: { "grounding-guardrail": throwingNode },
      edges: [{ from: DAG_INPUT, to: "grounding-guardrail" }],
    });

    // Through the framework's node runner: output validation against the
    // node's own OutputSchema happens in the runner, not in node.run.
    const result = await runDag<Record<string, unknown>, GuardrailResult<SynthesisOutput>>(
      dag,
      { request: true },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("failed");
      if (result.value.kind === "failed") {
        expect(result.value.error).toContain("grounding validator exploded");
      }
    }
  });

  test("the assembler's degrade path maps kind 'failed' to a degraded response carrying the guardrail error", async () => {
    const node = createAssembleResponseNode();
    const result = await node.run(
      {
        $input: { customerId: "cust-001" },
        "extract-features": {
          branch: "ok" as const,
          customer: { id: "cust-001", name: "Test", accountType: "personal" },
          recentUtterances: [],
          scoredConversations: [],
        },
        "grounding-guardrail": {
          kind: "failed" as const,
          passed: false as const,
          error: "grounding validator exploded",
          warnings: [],
          checks: [],
        },
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("degraded");
      if (result.value.status === "degraded") {
        expect(result.value.message).toContain("grounding validator exploded");
      }
    }
  });
});

describe("pr53 repair — bootstrap seams", () => {
  test("setUpRedis resolves with every collaborator null and isHealthy() false when Redis is unreachable", async () => {
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:9"; // discard port: connection refused
    try {
      const config = loadConfig();
      const { logger } = recordingLogger();
      const setup = await setUpRedis(config, logger);
      expect(setup.contextCache).toBeNull();
      expect(setup.checkpointWriter).toBeNull();
      expect(setup.checkpointer).toBeNull();
      expect(setup.isHealthy()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = original;
      }
    }
  });

  test("buildHealth's checkRedis is ready exactly when isHealthy() and a redis client are both present", async () => {
    const config = loadConfig();
    const { logger } = recordingLogger();
    const redis = { status: "ready" } as unknown as Redis;
    const fakeLlm = new FakeLlmClient(new Map());
    const setup = (healthy: boolean, withRedis: boolean) => ({
      redis: withRedis ? redis : null,
      isHealthy: () => healthy,
      contextCache: null,
      checkpointWriter: null,
      checkpointer: null,
    });

    const ready = buildHealth(config, logger, setup(true, true), { kind: "configured", llm: fakeLlm }, null);
    expect(await ready.checkRedis?.()).toBe(true);

    const unhealthyFlag = buildHealth(config, logger, setup(false, true), { kind: "configured", llm: fakeLlm }, null);
    expect(await unhealthyFlag.checkRedis?.()).toBe(false);

    const noClient = buildHealth(config, logger, setup(true, false), { kind: "configured", llm: fakeLlm }, null);
    expect(await noClient.checkRedis?.()).toBe(false);

    // LLM readiness gate follows the tagged fallback kind, not a free boolean.
    expect(await ready.checkLlm?.()).toBe(true);
    const fakeFallback = buildHealth(config, logger, setup(true, true), { kind: "fake-fallback", llm: fakeLlm }, null);
    expect(await fakeFallback.checkLlm?.()).toBe(false);
  });

  test("buildCheckpointWriter forwards the mapped-child scope into saveNode opts (index/attempt)", async () => {
    const calls: Array<{ readonly opts: unknown }> = [];
    const cp = {
      saveNode: async (_runId: unknown, _state: unknown, opts: unknown) => {
        calls.push({ opts });
        return ok(undefined);
      },
    } as unknown as Checkpointer;
    const writer = buildCheckpointWriter(cp);

    await writer.write(
      mkRunId("run-1"),
      mkNodeId("child-1"),
      { a: 1 },
      {
        mapNodeId: mkNodeId("map-node"),
        index: asMapIndex(2)!,
        executionEpoch: freshnessExecutionEpoch(7),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ index: 2, attempt: 7 });

    // No scope → canonical root address: no composite opts at all.
    await writer.write(mkRunId("run-1"), mkNodeId("root-1"), { a: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].opts).toBeUndefined();
  });
});

describe("pr53 repair — guardrail wire schemas", () => {
  test("GuardrailSkippedSchema rejects passed=false", () => {
    const result = GuardrailSkippedSchema.safeParse({
      kind: "skipped",
      value: undefined,
      passed: false,
      warnings: [],
      checks: [],
    });
    expect(result.success).toBe(false);
  });

  test("GuardrailSkippedSchema rejects a skipped arm carrying a value", () => {
    const result = GuardrailSkippedSchema.safeParse({
      kind: "skipped",
      value: { summary: "smuggled" },
      passed: true,
      warnings: [],
      checks: [],
    });
    expect(result.success).toBe(false);
  });

  test("GuardrailFailedSchema requires error", () => {
    const withError = GuardrailFailedSchema.safeParse({
      kind: "failed",
      passed: false,
      error: "boom",
      warnings: [],
      checks: [],
    });
    expect(withError.success).toBe(true);

    const withoutError = GuardrailFailedSchema.safeParse({
      kind: "failed",
      passed: false,
      warnings: [],
      checks: [],
    });
    expect(withoutError.success).toBe(false);
  });

  test("GuardrailValidatedSchema rejects missing checks", () => {
    const result = GuardrailValidatedSchema.safeParse({
      kind: "validated",
      value: makeSynthesis(),
      passed: true,
      warnings: [],
    });
    expect(result.success).toBe(false);
  });
});
