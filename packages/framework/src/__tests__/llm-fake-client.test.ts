/**
 * FR-040 total-guard pins for `FakeLlmClient` — "a throw must become a typed
 * node-crash, never a raw rejection". The fake must not green-light raw
 * rejections across the LlmClient port (parity with the real clients, which
 * map every LLM seam inside the Result boundary). Round-2 remediation added
 * these guards; this suite pins every seam with I/O-free hostile probes:
 *
 *   - response provider throw          → typed node-crash
 *   - non-serializable provider result → typed node-crash
 *   - withToolsScript throw            → typed node-crash
 *   - hostile tracer/span              → typed node-crash
 *   - final-turn schema-validation throw (hostile getter) → typed node-crash
 *   - final-turn non-serializable content (cyclic/BigInt)  → typed node-crash
 *   - tool EXECUTION throw             → per-call is_error (never a raw rejection)
 *   - ensureToolNames throw            → typed validation
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { NoopObserver } from "../observer/observer.js";
import type { RunId, DagId, NodeId } from "../types/ids.js";
import { FakeLlmClient } from "../llm/fake-client.js";
import type { ToolDef, LlmRequest, SendWithToolsRequest } from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import { stubLlmClient } from "./_llm-mocks.js";

const FinalSchema = z.object({ result: z.number() });
/** Accepts ANY value — needed to isolate the serialization seams from the
 * schema-validation verdict (a `z.unknown()` arm admits cyclic/BigInt
 * payloads that `JSON.stringify` cannot represent). */
const AnySchema = z.unknown();

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: stubLlmClient, http: null, clock: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});

const structuredReq = (model = "m1"): LlmRequest<unknown> => ({
  system: "sys",
  user: "user",
  model,
  schema: AnySchema,
  nodeId: "test-node" as NodeId,
});

const toolsReq = (
  overrides: Partial<SendWithToolsRequest<unknown>> = {},
): SendWithToolsRequest<unknown> => ({
  system: "sys",
  user: "user",
  model: "m1",
  tools: [],
  schema: AnySchema,
  nodeId: "test-node" as NodeId,
  ...overrides,
});

const cyclic = (): Record<string, unknown> => {
  const value: Record<string, unknown> = { kind: "cyclic" };
  value.self = value;
  return value;
};

describe("FakeLlmClient — FR-040 total guards (never a raw rejection)", () => {
  test("a throwing response provider is a typed node-crash", async () => {
    const client = new FakeLlmClient(() => {
      throw new Error("provider exploded");
    });
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ retriability: "retriable" });
      expect((result.error as { message: string }).message).toMatch(/response provider threw/);
    }
  });

  test("a cyclic provider result is a typed node-crash (not a raw TypeError)", async () => {
    const client = new FakeLlmClient(new Map([["m1", cyclic()]]));
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/not JSON-serializable/);
    }
  });

  test("a BigInt provider result is a typed node-crash (not a raw TypeError)", async () => {
    const client = new FakeLlmClient(new Map([["m1", { big: 10n }]]));
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/not JSON-serializable/);
    }
  });

  test("a throwing withToolsScript function is a typed node-crash", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => {
        throw new Error("script exploded");
      },
    });
    const result = await client.sendWithTools(toolsReq(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/withToolsScript threw/);
    }
  });

  test("a hostile tracer is a typed node-crash (span seam)", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { ok: 1 } }],
    });
    const ctx = makeCtx({
      tracer: {
        withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>): Promise<T> => {
          throw new Error("tracer exploded");
        },
      },
    });
    const result = await client.sendWithTools(toolsReq(), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/span\/tracer threw/);
    }
  });

  test("duplicate tool names are a typed validation error", async () => {
    const raw = (name: string): ToolDef<unknown, unknown> =>
      ({
        name,
        description: "d",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        run: async () => ({}),
      }) as unknown as ToolDef<unknown, unknown>;
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: {} }],
    });
    const result = await client.sendWithTools(toolsReq({ tools: [raw("dup"), raw("dup")] }), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect((result.error as { message: string }).message).toMatch(/Duplicate tool name/);
    }
  });

  test("final turn: a schema-validation THROW (hostile getter) is a typed node-crash", async () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "result", {
      get: () => {
        throw new Error("getter exploded during schema validation");
      },
      enumerable: true,
      configurable: true,
    });
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: hostile }],
    });
    const result = await client.sendWithTools(toolsReq({ schema: FinalSchema }), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/schema validation threw at final turn/);
    }
  });

  test("final turn: cyclic content accepted by an unknown-typed schema is a typed node-crash", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: cyclic() }],
    });
    const result = await client.sendWithTools(toolsReq({ schema: AnySchema }), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/final content is not JSON-serializable/);
    }
  });

  test("final turn: BigInt content accepted by an unknown-typed schema is a typed node-crash", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { big: 10n } }],
    });
    const result = await client.sendWithTools(toolsReq({ schema: AnySchema }), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/final content is not JSON-serializable/);
    }
  });

  test("a throwing tool EXECUTION is a per-call is_error, never a raw rejection", async () => {
    const tool: ToolDef<{}, { ok: number }> = {
      name: "boom",
      description: "always fails",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.number() }),
      run: async () => {
        throw new Error("tool exploded");
      },
    } as unknown as ToolDef<{}, { ok: number }>;
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (_req, ctx) => {
        if (ctx.turn === 0) {
          return { type: "tool_use", calls: [{ id: "c1", name: "boom", input: {} }] };
        }
        return { type: "final", content: { result: 1 } };
      },
    });
    const result = await client.sendWithTools(
      toolsReq({ tools: [tool], schema: FinalSchema }),
      makeCtx(),
    );
    // The dispatch seam absorbed the tool throw into a per-call error result
    // and the loop continued to the final turn — nothing rejected raw.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });
});

describe("FakeLlmClient — Map provider lookup order", () => {
  test("a Map provider falls back to the system-prompt key when the model key is absent", async () => {
    // Pins the documented lookup order `responses.get(req.model) ??
    // responses.get(req.system)`: a Map keyed by the system prompt resolves
    // when the model key is absent (a Map keyed by model wins when present).
    const client = new FakeLlmClient(new Map<string, unknown>([
      ["sys", { result: 7 }],
    ]));
    const hit = await client.sendStructured(structuredReq("model-not-in-map"));
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value.output).toEqual({ result: 7 });
      expect(hit.value.rawText).toBe('{"result":7}');
    }

    const miss = await client.sendStructured(structuredReq("other-model"));
    // "sys" is the request's system prompt, so even an unknown model resolves
    // through the fallback key.
    expect(miss.ok).toBe(true);

    const none = await client.sendStructured({ ...structuredReq("other-model"), system: "absent" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.kind).toBe("node-crash");
  });
});
