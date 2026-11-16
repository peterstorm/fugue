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
import { setUpRedis, buildCheckpointWriter, buildHealth, type RedisSetup } from "../bootstrap.js";
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
  test("setUpRedis resolves `unavailable` — no collaborators, the client kept for shutdown — when Redis is unreachable", async () => {
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:9"; // discard port: connection refused
    try {
      const config = loadConfig();
      const { logger } = recordingLogger();
      const setup = await setUpRedis(config, logger);
      expect(setup.kind).toBe("unavailable");
      expect(setup.redis).not.toBeNull();
      expect(Object.keys(setup).sort()).toEqual(["kind", "redis"]);
      setup.redis?.disconnect();
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = original;
      }
    }
  });

  test("buildHealth's checkRedis is ready exactly when Redis is `connected` and its flag reads healthy", async () => {
    const config = loadConfig();
    const { logger } = recordingLogger();
    const redis = { status: "ready" } as unknown as Redis;
    const fakeLlm = new FakeLlmClient(new Map());
    // The collaborators are never touched by readiness; opaque stand-ins suffice.
    const connected = (healthy: boolean): RedisSetup => ({
      kind: "connected",
      redis,
      isHealthy: () => healthy,
      contextCache: { get: async () => ({ hit: false }), set: async () => ok(undefined) },
      checkpointWriter: { write: async () => {} },
      checkpointer: {} as Checkpointer,
    });

    const ready = buildHealth(config, logger, connected(true), { kind: "configured", llm: fakeLlm }, null);
    expect(await ready.checkRedis?.()).toBe(true);

    const unhealthyFlag = buildHealth(config, logger, connected(false), { kind: "configured", llm: fakeLlm }, null);
    expect(await unhealthyFlag.checkRedis?.()).toBe(false);

    // Unavailable at bootstrap is never ready, whether or not a client exists:
    // nothing was wired to it, so a later reconnect cannot make the pod servable.
    for (const client of [redis, null]) {
      const unavailable = buildHealth(config, logger, { kind: "unavailable", redis: client }, { kind: "configured", llm: fakeLlm }, null);
      expect(await unavailable.checkRedis?.()).toBe(false);
    }

    // LLM readiness gate follows the tagged fallback kind, not a free boolean.
    expect(await ready.checkLlm?.()).toBe(true);
    const fakeFallback = buildHealth(config, logger, connected(true), { kind: "fake-fallback", llm: fakeLlm }, null);
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

  test("buildCheckpointWriter throws an Error naming run, node, kind and the underlying message when saveNode fails", async () => {
    const failure = {
      kind: "checkpoint-write-failed" as const,
      runId: mkRunId("run-9"),
      nodeId: mkNodeId("node-9"),
      message: "output at $.payload is not lossless",
    };
    const cp = {
      saveNode: async () => ({ ok: false as const, error: failure }),
    } as unknown as Checkpointer;
    const writer = buildCheckpointWriter(cp);

    const thrown = await writer.write(mkRunId("run-9"), mkNodeId("node-9"), { a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("run=run-9");
    expect(message).toContain("node=node-9");
    expect(message).toContain("kind=checkpoint-write-failed");
    expect(message).toContain("output at $.payload is not lossless");
    // The structured error rides along for programmatic inspection.
    expect((thrown as Error).cause).toBe(failure);
  });

  test("buildHealth's checkMlflow warns once per up/down transition and never on the first probe or a steady state", async () => {
    const config = loadConfig();
    const { logger, diagnostics } = recordingLogger();
    const originalFetch = globalThis.fetch;
    // Scripted MLflow health: up, up, down, down, up.
    const outcomes: ReadonlyArray<"up" | "down"> = ["up", "up", "down", "down", "up"];
    let call = 0;
    globalThis.fetch = (async () => {
      const outcome = outcomes[call++];
      if (outcome === "down") throw new Error("connect ECONNREFUSED");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const health = buildHealth(
        config,
        logger,
        { kind: "unavailable", redis: null },
        { kind: "configured", llm: new FakeLlmClient(new Map()) },
        null,
      );

      // First probe: no prior state, so no transition to report.
      expect(await health.checkMlflow?.()).toBe(true);
      expect(diagnostics).toEqual([]);

      // Unchanged (up → up): silent.
      expect(await health.checkMlflow?.()).toBe(true);
      expect(diagnostics).toEqual([]);

      // up → down: exactly one failure warning carrying the probe detail.
      expect(await health.checkMlflow?.()).toBe(false);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toStartWith("warn: [health] MLflow failed");
      expect(diagnostics[0]).toContain("ECONNREFUSED");

      // Unchanged (down → down): silent.
      expect(await health.checkMlflow?.()).toBe(false);
      expect(diagnostics).toHaveLength(1);

      // down → up: exactly one recovery warning.
      expect(await health.checkMlflow?.()).toBe(true);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[1]).toStartWith("warn: [health] MLflow recovered");
      expect(call).toBe(outcomes.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
