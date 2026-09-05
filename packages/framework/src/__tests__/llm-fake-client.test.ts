/**
 * FR-040 total-guard pins for `FakeLlmClient` — "a throw must become a typed
 * node-crash, never a raw rejection". The fake must not green-light raw
 * rejections across the LlmClient port (parity with the real clients, which
 * map every LLM seam inside the Result boundary). Round-2 remediation added
 * these guards; this suite pins every seam with I/O-free hostile probes:
 *
 *   - response provider throw          → typed node-crash
 *   - non-serializable provider result → typed node-crash
 *   - async provider/script result (thenable, synchronous seam) → typed node-crash
 *   - hostile thenable probe (throwing `then` getter / Proxy `get` trap)
 *     → never a raw rejection (round-8 C1; the probe is total)
 *   - withToolsScript throw            → typed node-crash
 *   - hostile script turn (unreadable fields) → typed node-crash (round-8 C1)
 *   - hostile tracer/span              → typed node-crash
 *   - final-turn schema-validation throw (hostile getter) → typed node-crash
 *   - final-turn non-serializable content (cyclic/BigInt)  → typed node-crash
 *   - tool EXECUTION throw             → per-call is_error (never a raw rejection)
 *   - ensureToolNames throw            → typed validation
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { NodeId } from "../types/ids.js";
import { FakeLlmClient } from "../llm/fake-client.js";
import type { FakeTurn, FakeWithToolsScript } from "../llm/fake-client.js";
import type { LlmClient, LlmResponse, ToolDef, LlmRequest, SendWithToolsRequest } from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { stubLlmClient } from "./_llm-mocks.js";
import { testNodeContext } from "./_context-factories.js";

const FinalSchema = z.object({ result: z.number() });
/** Accepts ANY value — needed to isolate the serialization seams from the
 * schema-validation verdict (a `z.unknown()` arm admits cyclic/BigInt
 * payloads that `JSON.stringify` cannot represent). */
const AnySchema = z.unknown();

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext =>
  testNodeContext({ llm: stubLlmClient, ...overrides });

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

  // Synchronous seam: an accidentally-`async` provider type-checks (the
  // return type is `unknown`-wide), and its Promise would stringify to "{}" —
  // silently resolving an empty (wrong) response. The seam rejects thenables
  // loudly instead (pinned for the function form, the Map-value form, and the
  // withToolsScript twin).
  test("an async response provider is a typed node-crash (not a silent empty response)", async () => {
    const client = new FakeLlmClient(async () => ({ result: 1 }));
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/returned a Promise/);
    }
  });

  test("a Promise stored as a Map provider value is a typed node-crash", async () => {
    const client = new FakeLlmClient(new Map([["m1", Promise.resolve({ result: 1 })]]));
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/returned a Promise/);
    }
  });

  // Round-8 C1 (panel-upheld 3/3): the `isThenable` probe's `.then` read is
  // OBSERVABLE — a throwing `then` getter used to make the probe itself throw
  // outside every try/catch, escaping the async method as a raw untyped
  // rejection (violating the module's FR-040 never-raw-rejection discipline
  // and the doc comment's "total on hostile values" claim). The probe is now
  // total: it swallows the trap (not a thenable) and the value fails at the
  // JSON-serialization guard, where the re-read throws into the typed crash.
  test("a provider value with a throwing `then` getter is a typed node-crash (never a raw rejection)", async () => {
    const hostile: Record<string, unknown> = { result: 1 };
    Object.defineProperty(hostile, "then", {
      get: () => {
        throw new Error("then getter exploded");
      },
      enumerable: true,
      configurable: true,
    });
    const client = new FakeLlmClient(new Map([["m1", hostile]]));
    const result = await client.sendStructured(structuredReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/not JSON-serializable/);
    }
  });

  test("a Proxy with a fully-throwing get trap as a provider value never rejects raw across the port", async () => {
    const trap = new Proxy(
      { result: 1 },
      {
        get: () => {
          throw new Error("proxy get trap exploded");
        },
      },
    );
    const client = new FakeLlmClient(new Map([["m1", trap]]));
    // The invariant FR-040 pins is the SETTLED port: the promise must
    // resolve a Result, never reject raw — wherever the hostile value is
    // finally classified.
    const result = await client.sendStructured(structuredReq());
    expect(typeof result).toBe("object");
    expect("ok" in result).toBe(true);
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

  // The TS surface rejects an async script at compile time (`Promise<T>` is
  // not a `FakeTurn`); this cast simulates a JS/`any` caller reaching the
  // runtime seam guard — without it the Promise would fall through as a
  // truthy turn with no `type`/`calls` and misattribute the failure deep in
  // tool dispatch.
  test("an async withToolsScript function is a typed node-crash (not a misattributed dispatch failure)", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: (async () => ({ type: "final", content: { result: 1 } })) as unknown as FakeWithToolsScript,
    });
    const result = await client.sendWithTools(toolsReq(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/withToolsScript returned a Promise/);
    }
  });

  // Round-8 C1 (twin seam): the script's RETURN value is caller data whose
  // field reads (`type`/`thinking`/`tokensIn`/`tokensOut`) used to run
  // outside every try/catch right after the (then) thenable probe — a value
  // whose property reads throw escaped raw there. The loop now snapshots
  // those fields under the same typed-crash discipline as the script call.
  test("a script turn with a throwing `then` getter still plays as an ordinary turn (the probe is total)", async () => {
    const turn: Record<string, unknown> = { type: "final", content: { result: 1 } };
    Object.defineProperty(turn, "then", {
      get: () => {
        throw new Error("then getter exploded");
      },
      enumerable: true,
      configurable: true,
    });
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => turn as unknown as FakeTurn,
    });
    const result = await client.sendWithTools(toolsReq({ schema: FinalSchema }), makeCtx());
    // Not a thenable (probe swallowed the trap) and every field the loop
    // reads is ordinary — the turn plays to completion with no raw rejection.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });

  test("a script turn whose property reads all throw is a typed node-crash (never a raw rejection)", async () => {
    const trap = new Proxy(
      { type: "final", content: { result: 1 } },
      {
        get: () => {
          throw new Error("proxy get trap exploded");
        },
      },
    );
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => trap as unknown as FakeTurn,
    });
    const result = await client.sendWithTools(toolsReq(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ retriability: "retriable" });
      expect((result.error as { message: string }).message).toMatch(/unreadable fields at turn 0/);
    }
  });

  test("a hostile tracer is a typed node-crash (span seam)", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { ok: 1 } }],
    });
    const ctx = makeCtx({
      tracer: {
        withSpan: <T,>(_n: string, _t: string, _fn: () => Promise<T>): Promise<T> => {
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

  // The NON-throwing failure twin: `safeParse` succeeds mechanically and
  // simply reports a shape mismatch — that branch must fail with the typed
  // "Schema validation failed" crash, not a raw rejection or a silent ok.
  test("final turn: a plain schema-validation FAILURE (no throw) is a typed node-crash", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { wrong: "shape" } }],
    });
    const result = await client.sendWithTools(toolsReq({ schema: FinalSchema }), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/Schema validation failed/);
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

  // Round-10 A0 (silent-failure-hunter): the REQUEST itself is caller data —
  // a hostile getter on `req.nodeId` used to throw from the `crash` builder,
  // which is invoked from inside catch blocks, where the second throw
  // replaces the typed rejection with a raw one (the sharpest FR-040 hole in
  // the module). The builder now reads an entry-snapshot taken under the
  // total read; a failing read yields the namespaced placeholder id and the
  // typed error still settles across the port.
  test("a request with a throwing nodeId getter is a typed node-crash with the placeholder id (never a raw rejection)", async () => {
    const hostileReq = new Proxy(structuredReq(), {
      get(target, prop) {
        if (prop === "nodeId") throw new Error("nodeId getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map()); // no "m1" key — forces the crash path
    const result = await client.sendStructured(hostileReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ nodeId: "llm_unknown_node" });
      expect((result.error as { message: string }).message).toMatch(/no response configured/);
    }
  });

  test("a request with a throwing model getter is a typed node-crash (never a raw rejection)", async () => {
    const hostileReq = new Proxy(structuredReq(), {
      get(target, prop) {
        if (prop === "model") throw new Error("model getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map());
    const result = await client.sendStructured(hostileReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The entry snapshot absorbs the throw (total read — the model reads
      // as ""), so the failure surfaces at the configuration check, still a
      // typed crash bound to the request's REAL node id (its read succeeded).
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ nodeId: "test-node" });
      expect((result.error as { message: string }).message).toMatch(/no response configured/);
    }
  });

  test("an unconfigured sendWithTools request with a throwing nodeId getter is a typed node-crash (never a raw rejection)", async () => {
    const hostileReq = new Proxy(toolsReq(), {
      get(target, prop) {
        if (prop === "nodeId") throw new Error("nodeId getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map()); // no withToolsScript — forces the crash path
    const result = await client.sendWithTools(hostileReq, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ nodeId: "llm_unknown_node" });
      expect((result.error as { message: string }).message).toMatch(/no withToolsScript configured/);
    }
  });

  test("a request with a throwing maxIterations getter plays with the default limit (never a raw rejection)", async () => {
    const hostileReq = new Proxy(toolsReq({ schema: FinalSchema }), {
      get(target, prop) {
        if (prop === "maxIterations") throw new Error("maxIterations getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { result: 1 } }],
    });
    const result = await client.sendWithTools(hostileReq, makeCtx());
    // The unreadable limit reads as the default (10); the one-turn script
    // completes inside it — nothing rejected raw.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });

  // The per-turn abort probe re-reads a LIVE signal every turn (a mid-loop
  // abort must still stop the loop), so the totality must hold per read — a
  // throwing `signal` getter on the request or the context cannot reject raw.
  test("a request whose signal getter throws is not a raw rejection (the abort probe is total)", async () => {
    const hostileReq = new Proxy(toolsReq({ schema: FinalSchema }), {
      get(target, prop) {
        if (prop === "signal") throw new Error("signal getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { result: 1 } }],
    });
    const result = await client.sendWithTools(hostileReq, makeCtx());
    // The unreadable signal reads as NOT aborted; the script plays to
    // completion and the port settles.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });

  test("a context whose signal getter throws is not a raw rejection (the abort probe is total)", async () => {
    const hostileCtx = new Proxy(makeCtx(), {
      get(target, prop) {
        if (prop === "signal") throw new Error("ctx signal getter exploded");
        return Reflect.get(target, prop);
      },
    });
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [{ type: "final", content: { result: 1 } }],
    });
    const result = await client.sendWithTools(toolsReq({ schema: FinalSchema }), hostileCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });

  test("a request with a throwing toolChoice getter never rejects raw (the tool_use branch reads it total)", async () => {
    const hostileReq = new Proxy(toolsReq({ schema: FinalSchema }), {
      get(target, prop) {
        if (prop === "toolChoice") throw new Error("toolChoice getter exploded");
        return Reflect.get(target, prop);
      },
    });
    // A tool_use turn is what reads `toolChoice`; an empty call list makes
    // dispatch a no-op and the loop advances to the script's end — proving
    // the read was total (no raw escape) and not equal to "none".
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [({ type: "tool_use", calls: [] }) as unknown as FakeTurn],
    });
    const result = await client.sendWithTools(hostileReq, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      // The failure is the script's exhaustion AFTER the total read — not a
      // raw throw from the read itself.
      expect((result.error as { message: string }).message).toMatch(/script ran out at turn 1/);
    }
  });

  // Round-10 A6 (type-design-analyzer): `sendStructured` used to return
  // `raw as O` with no validation, while the `withTools` final-turn seam
  // runs `req.schema.safeParse` — a fixture violating the declared schema
  // silently passed the cast. The fake now validates the toolless path too.
  test("a sendStructured fixture violating the declared schema is a typed node-crash (never a silent O cast)", async () => {
    const client = new FakeLlmClient(new Map([["m1", { wrong: "shape" }]]));
    const result = await client.sendStructured({
      system: "sys",
      user: "user",
      model: "m1",
      schema: FinalSchema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/Schema validation failed/);
    }
  });

  test("a sendStructured fixture whose schema validation throws is a typed node-crash (the safeParse seam is guarded)", async () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "result", {
      get: () => {
        throw new Error("getter exploded during sendStructured schema validation");
      },
      enumerable: true,
      configurable: true,
    });
    const client = new FakeLlmClient(new Map([["m1", hostile]]));
    const result = await client.sendStructured({
      system: "sys",
      user: "user",
      model: "m1",
      schema: FinalSchema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/schema validation threw/);
    }
  });

  test("sendStructured returns the schema-parsed output, not the raw fixture (zod strip semantics)", async () => {
    // `z.object` strips unknown keys: the port contract is the Parsed shape,
    // so a fixture carrying extra keys must come back without them — the
    // same `parsed.data as O` the withTools final-turn seam returns.
    const client = new FakeLlmClient(new Map([["m1", { result: 1, extra: 2 }]]));
    const result = await client.sendStructured({
      system: "sys",
      user: "user",
      model: "m1",
      schema: FinalSchema,
      nodeId: "test-node" as NodeId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ result: 1 });
  });
});

describe("FakeLlmClient — Map provider lookup order", () => {
  test("a Map provider falls back to the system-prompt key when the model key is absent", async () => {
    // Pins the documented lookup order `responses.has(req.model) ?
    // responses.get(req.model) : responses.get(req.system)`: a Map keyed by
    // the system prompt resolves when the model key is ABSENT from the Map
    // (a model key owned by the Map wins — see the round-9 null pin below).
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

  // Round-9 A1 (silent-failure-hunter-1): OWNERSHIP, not truthiness. The
  // pre-round-9 `responses.get(req.model) ?? responses.get(req.system)`
  // treated a configured `null` under the model key as "absent" and silently
  // substituted the system-key fixture — a silently swapped test oracle with
  // no error anywhere. `null` is a legal response: the function form
  // expresses it (`(req) => null` round-trips to `ok({ output: null, … })`),
  // so the Map form must honor it too.
  test("a null configured under the model key wins over the system-key fallback (has, not ??)", async () => {
    const client = new FakeLlmClient(new Map<string, unknown>([
      ["m1", null],
      ["sys", { result: 7 }],
    ]));
    const result = await client.sendStructured(structuredReq("m1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(null);
      expect(result.value.rawText).toBe("null");
    }
  });

  test("a null configured under the model key is a response, not a fallback miss", async () => {
    const client = new FakeLlmClient(new Map<string, unknown>([
      ["m1", null],
    ]));
    const result = await client.sendStructured(structuredReq("m1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toBe(null);
  });
});

// Every exit branch of the `sendWithTools` loop is typed and pinned: a
// regression flipping any branch's retriability (especially the iteration
// limit — the loop's ONLY non-retriable node-crash) would change retry
// fast-fail behavior with no in-scope test failing.
describe("FakeLlmClient — sendWithTools loop-exit branches", () => {
  test("script exhaustion is a RETRIABLE node-crash naming the turn", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: [],
    });
    const result = await client.sendWithTools(toolsReq(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ retriability: "retriable" });
      expect((result.error as { message: string }).message).toMatch(/script ran out at turn 0/);
    }
  });

  test("the iteration limit is the loop's ONLY non-retriable node-crash", async () => {
    const tool: ToolDef<{}, { ok: number }> = {
      name: "spin",
      description: "never finishes",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.number() }),
      run: async () => ({ ok: 1 }),
    } as unknown as ToolDef<{}, { ok: number }>;
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => ({ type: "tool_use", calls: [{ id: "c1", name: "spin", input: {} }] }),
    });
    const result = await client.sendWithTools(
      toolsReq({ tools: [tool], maxIterations: 2 }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      // The node's retry budget is exhausted by contract — re-running the
      // identical scripted loop cannot clear it.
      expect(result.error).toMatchObject({ retriability: "non-retriable" });
      expect((result.error as { message: string }).message).toMatch(/iteration limit \(2\) reached/);
    }
  });

  test("a tool_use turn under toolChoice='none' is a retriable node-crash", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => ({ type: "tool_use", calls: [{ id: "c1", name: "x", input: {} }] }),
    });
    const result = await client.sendWithTools(
      toolsReq({ toolChoice: "none" }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect(result.error).toMatchObject({ retriability: "retriable" });
      expect((result.error as { message: string }).message).toMatch(/toolChoice='none'/);
    }
  });

  test("an already-aborted signal exits as typed aborted(signal), before any turn", async () => {
    const controller = new AbortController();
    controller.abort();
    let scriptRan = false;
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => {
        scriptRan = true;
        return { type: "final", content: { result: 1 } };
      },
    });
    const result = await client.sendWithTools(
      toolsReq({ signal: controller.signal }),
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: "aborted", reason: "signal" });
    expect(scriptRan).toBe(false); // the abort check precedes any turn script call
  });
});

// Unconfigured-seam footgun diagnostics — the fake's "you forgot to
// configure X" messages are its contract for misconfiguration; pin them so a
// rewording cannot silently break a host grepping its logs for the seam name.
describe("FakeLlmClient — unconfigured-seam diagnostics", () => {
  test("sendWithTools with no script configured is a typed node-crash naming the seam", async () => {
    const client = new FakeLlmClient(new Map());
    const result = await client.sendWithTools(toolsReq(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/no withToolsScript configured/);
    }
  });

  test("an unconfigured provider response is a typed node-crash naming the model key", async () => {
    const client = new FakeLlmClient(new Map());
    const result = await client.sendStructured(structuredReq("nope"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect((result.error as { message: string }).message).toMatch(/no response configured for model="nope"/);
    }
  });
});

describe("FakeLlmClient: scripted prompt-cache figures", () => {
  // These fields exist so DAG-level tests can exercise cache accounting without
  // reaching a provider. That makes the fake a shared test utility: if its
  // accumulation broke, every downstream suite relying on it would quietly
  // assert against wrong numbers, and nothing else would catch it.

  test("accumulates the per-turn cache split across a multi-turn script", async () => {
    // Array form: played back in order, one entry per turn.
    const script: FakeWithToolsScript = [
      {
        type: "tool_use",
        calls: [{ id: "c1", name: "noop", input: {} }],
        tokensIn: 100,
        tokensOut: 10,
        cacheWriteTokens: 60,
        cacheReadTokens: 0,
      },
      {
        type: "final",
        content: { result: 1 },
        tokensIn: 50,
        tokensOut: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 40,
      },
    ];

    const noop: ToolDef<unknown, unknown> = {
      name: "noop" as ToolDef<unknown, unknown>["name"],
      description: "d",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      run: async () => ({}),
    };

    const client = new FakeLlmClient(new Map(), { withToolsScript: script });
    const result = await client.sendWithTools(
      toolsReq({ schema: FinalSchema, tools: [noop] }),
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokensIn).toBe(150);
    expect(result.value.tokensOut).toBe(15);
    expect(result.value.cacheWriteTokens).toBe(60);
    expect(result.value.cacheReadTokens).toBe(40);
  });

  test("defaults both cache figures to zero, so an existing script is unchanged", async () => {
    const client = new FakeLlmClient(new Map(), {
      withToolsScript: () => ({ type: "final", content: { result: 1 } }),
    });
    const result = await client.sendWithTools(toolsReq({ schema: FinalSchema }), makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cacheWriteTokens).toBe(0);
    expect(result.value.cacheReadTokens).toBe(0);
  });
});

// ── LlmClient port variance pin (round-14 C1) ───────────────────────────────
// `LlmClient`'s members are declared as readonly ARROW PROPERTIES, not method
// shorthand. TypeScript checks method-shorthand parameters BIVARIANTLY even
// under `strictFunctionTypes`, so a shorthand declaration would let an
// implementation narrow `ctx` to a type demanding fields a plain `NodeContext`
// does not carry — satisfying the interface structurally, then crashing at
// runtime when the framework invokes it with the context it built itself
// (`nodes/llm-with-tools.ts` passes exactly that). `CapabilityBroker.mintFor`
// documents and defends against this same hazard; this pins the defence for
// the framework's most-implemented port.
//
// This is a COMPILE-TIME assertion with no runtime body: the framework
// typechecks its own tests, so a regression to method shorthand makes
// `NarrowingClient` assignable to `LlmClient` and `tsc` fails right here.

type NarrowerContext = NodeContext & { readonly requiredExtra: string };

/**
 * An implementation that NARROWS `ctx` — must not satisfy `LlmClient`.
 * The generic `<O>` is preserved deliberately: a non-generic stand-in would be
 * unassignable for the wrong reason (signature arity), and the pin would pass
 * even with the hole open.
 */
type NarrowingClient = {
  readonly sendStructured: LlmClient["sendStructured"];
  readonly sendWithTools: <O>(
    req: SendWithToolsRequest<O>,
    ctx: NarrowerContext,
  ) => Promise<Result<LlmResponse<O>, FrameworkError>>;
};

const llmClientVariancePin: NarrowingClient extends LlmClient
  ? "BIVARIANT — the soundness hole has reopened"
  : "contravariant" = "contravariant";
void llmClientVariancePin;
