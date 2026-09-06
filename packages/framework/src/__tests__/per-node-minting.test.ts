/**
 * Per-node capability minting (review C1).
 *
 * Proves the framework, when a `MintingAuthority` (broker + origin) is wired
 * into `runDag`, resolves EACH node's declared `requires` through
 * `broker.mintFor` AT DISPATCH (with the node's REAL id), merges the minted
 * handles OVER the boot-scoped base context (static clients survive; minted
 * scope handles are added), treats `broker.provides()` capabilities as
 * satisfied at run-start validation, and fails a node fail-closed when its
 * mint is refused.
 *
 * This is the regression guard for the bug where the broker was only ever called
 * once with empty `requires` (minting machinery unreachable) and, on the realm
 * path, REPLACED the static client set with an empty mint (every static client
 * vanished).
 *
 * Also pins the settled-refusal retry contract (ADR-0059): a `policy-refusal`
 * is terminal — the retry machinery must neither re-invoke `mintFor` nor
 * rewrap the error as `retry-exhausted` (the host's HTTP classifier needs the
 * bare kind to map it to 403 and exempt it from the circuit breaker).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { Capability, NodeContext } from "../types/node.js";
import type { LlmClient } from "../types/llm.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import type {
  CapabilityBroker,
  Invocation,
  InvocationOrigin,
  MintingAuthority,
  ScopedCapabilityHandle,
} from "../types/capability-broker.js";
import { runDag } from "../executor/run-dag.js";
import { createFetchNode } from "../nodes/fetch.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { N } from "./_id-helpers.js";
import { DAG_INPUT } from "../types/ids.js";
import { RecordingObserver } from "../observer/observer.js";

// A scope-shaped capability the broker mints, and a plain static one it doesn't.
interface BrokerLlmWithAlias extends LlmClient {
  readonly critique: LlmClient["sendStructured"];
}

declare module "../types/node.js" {
  interface CapabilityRegistry {
    brokerLlm: LlmClient;
    brokerLlmWithAlias: BrokerLlmWithAlias;
  }
}

const SCOPE = "svc:opA" as Capability;
const cap = (s: string) => s as Capability;

/** A recording broker: mints a sentinel handle for scope-shaped names, passes
 * plain names through (returns nothing for them — the base context supplies them). */
const recordingBroker = (opts?: { refuse?: boolean }) => {
  const calls: { nodeId: string; requires: readonly Capability[] }[] = [];
  const broker: CapabilityBroker = {
    mintFor: async (inv: Invocation, requires: readonly Capability[]): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
      calls.push({ nodeId: inv.nodeId as string, requires });
      if (opts?.refuse && requires.some((r) => (r as string).includes(":"))) {
        return err({ kind: "policy-refusal", scope: requires.find((r) => (r as string).includes(":")) as string, agentClientId: inv.origin.agentClientId });
      }
      const out: Record<string, unknown> = {};
      for (const r of requires) {
        if ((r as string).includes(":")) {
          out[r] = {
            clientKind: "non-llm",
            client: { tag: `minted:${r}:${inv.nodeId as string}` },
          };
        }
      }
      return ok(out as ScopedCapabilityHandle);
    },
    provides: (c: Capability) => (c as string).includes(":"),
  };
  return { broker, calls };
};

const staticHttp = { tag: "static-http-client" };

const baseCtx = (): NodeContext =>
  makeNodeContext({
    runId: "run-1",
    dagId: "dag-1",
    // The boot-scoped static client set — the minted scope handles are layered
    // OVER this, and these must survive (the C1 regression dropped them).
    http: staticHttp as unknown as NodeContext["http"],
  });

const agentOrigin: InvocationOrigin = { kind: "agent", agentClientId: "agent-x" };

/** Non-LLM broker tests still carry the mandatory metering authority. */
const testMinting = (broker: CapabilityBroker): MintingAuthority => ({
  broker,
  origin: agentOrigin,
  meterLlm: (_capability, _binding, nodeId) => err({
    kind: "validation",
    nodeId,
    message: "test broker unexpectedly delivered an LLM binding",
  }),
});

describe("per-node capability minting (C1)", () => {
  it("mints each node's declared scope at dispatch, merged over the static base; mintFor sees the REAL node id", async () => {
    const { broker, calls } = recordingBroker();

    // nodeA requires a broker-minted scope; nodeB requires a plain static client.
    const seen: Record<string, unknown> = {};
    const nodeA = createFetchNode({
      id: N("nodeA"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async (_in, ctx) => {
        seen.A_scope = (ctx as unknown as Record<string, unknown>)[SCOPE as string];
        seen.A_http = (ctx as unknown as Record<string, unknown>).http;
        return ok({ ok: true });
      },
    });
    const nodeB = createFetchNode({
      id: N("nodeB"),
      inputSchema: z.object({ ok: z.boolean() }),
      outputSchema: z.object({ done: z.boolean() }),
      requires: [cap("http")] as unknown as readonly Capability[],
      fetch: async (_in, ctx) => {
        seen.B_http = (ctx as unknown as Record<string, unknown>).http;
        seen.B_scope = (ctx as unknown as Record<string, unknown>)[SCOPE as string];
        return ok({ done: true });
      },
    });

    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [nodeA, nodeB],
      edges: [{ from: DAG_INPUT, to: "nodeA" }, { from: "nodeA", to: "nodeB" }],
    });

    const result = await runDag(dag, {}, baseCtx(), { minting: testMinting(broker) });
    expect(result.ok).toBe(true);

    // mintFor was called PER NODE with that node's requires and its REAL id.
    const byNode = Object.fromEntries(calls.map((c) => [c.nodeId, c.requires]));
    expect(byNode["nodeA"]).toEqual([SCOPE]);
    expect(byNode["nodeB"]).toEqual([cap("http")]);
    expect(calls.every((c) => c.nodeId !== "__run__")).toBe(true);

    // nodeA saw its MINTED scope handle (proves merge) AND the static http (proves
    // the static base survived the merge).
    expect(seen.A_scope).toEqual({ tag: `minted:${SCOPE}:nodeA` });
    expect(seen.A_http).toBe(staticHttp);

    // nodeB saw the static http (broker mints nothing for a plain name) and did
    // NOT receive nodeA's minted scope handle (per-node narrowing).
    expect(seen.B_http).toBe(staticHttp);
    expect(seen.B_scope).toBeUndefined();
  });

  it("routes a broker-minted custom LLM through the run-owned meter before merge", async () => {
    let providerCalls = 0;
    let meteredCalls = 0;
    const inner: LlmClient = {
      sendStructured: async <O>() => {
        providerCalls += 1;
        return ok({
          output: { answer: "ok" } as O,
          rawText: "",
          tokensIn: 1,
          tokensOut: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        });
      },
      sendWithTools: async () => {
        throw new Error("unused");
      },
    };
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        brokerLlm: {
          clientKind: "llm",
          client: inner,
          pricingModel: { kind: "request" },
          runScopedOperations: {},
        },
      }),
      provides: (capability) => capability === "brokerLlm",
    };
    const node = createFetchNode({
      id: N("broker-llm-node"),
      inputSchema: z.object({}),
      outputSchema: z.object({ answer: z.string() }),
      requires: ["brokerLlm"] as const,
      fetch: async (_input, ctx) => {
        const result = await ctx.brokerLlm.sendStructured({
          system: "s",
          user: "u",
          model: "gpt-4o",
          schema: z.object({ answer: z.string() }),
          nodeId: N("broker-llm-node"),
        });
        return result.ok ? ok(result.value.output) : result;
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "broker-llm-node" }],
    });

    const result = await runDag(dag, {}, baseCtx(), {
      minting: {
        broker,
        origin: agentOrigin,
        meterLlm: (_capability, binding) => ok({
          sendStructured: (request) => {
            meteredCalls += 1;
            return binding.client.sendStructured(request);
          },
          sendWithTools: (request, ctx) => {
            meteredCalls += 1;
            return binding.client.sendWithTools(request, ctx);
          },
        }),
      },
    });

    expect(result).toEqual(ok({ answer: "ok" }));
    expect(meteredCalls).toBe(1);
    expect(providerCalls).toBe(1);
  });

  it("executes a non-empty broker LLM alias through the run-owned meter", async () => {
    let providerCalls = 0;
    let meteredCalls = 0;
    let observedAliasMap: Readonly<Record<string, unknown>> | undefined;
    const inner: BrokerLlmWithAlias = {
      sendStructured: async <O>() => {
        providerCalls += 1;
        return ok({
          output: { answer: "aliased" } as O,
          rawText: "",
          tokensIn: 1,
          tokensOut: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        });
      },
      sendWithTools: async () => { throw new Error("unused"); },
      critique: async () => { throw new Error("boot-scoped alias must never run"); },
    };
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        brokerLlmWithAlias: {
          clientKind: "llm",
          client: inner,
          pricingModel: { kind: "request" },
          runScopedOperations: { critique: "sendStructured" },
        },
      }),
      provides: (capability) => capability === "brokerLlmWithAlias",
    };
    const node = createFetchNode({
      id: N("broker-alias-node"),
      inputSchema: z.object({}),
      outputSchema: z.object({ answer: z.string() }),
      requires: ["brokerLlmWithAlias"] as const,
      fetch: async (_input, ctx) => {
        const result = await ctx.brokerLlmWithAlias.critique({
          system: "s",
          user: "u",
          model: "gpt-4o",
          schema: z.object({ answer: z.string() }),
          nodeId: N("broker-alias-node"),
        });
        return result.ok ? ok(result.value.output) : result;
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "broker-alias-node" }],
    });

    const result = await runDag(dag, {}, baseCtx(), {
      minting: {
        broker,
        origin: agentOrigin,
        meterLlm: (_capability, binding) => {
          observedAliasMap = binding.runScopedOperations;
          const sendStructured: LlmClient["sendStructured"] = (request) => {
            meteredCalls += 1;
            return binding.client.sendStructured(request);
          };
          return ok({
            sendStructured,
            sendWithTools: binding.client.sendWithTools.bind(binding.client),
            critique: sendStructured,
          } as BrokerLlmWithAlias);
        },
      },
    });

    expect(result).toEqual(ok({ answer: "aliased" }));
    expect(observedAliasMap).toEqual({ critique: "sendStructured" });
    expect(meteredCalls).toBe(1);
    expect(providerCalls).toBe(1);
  });

  it("rejects a runtime-forged minting authority with no run meter before dispatch", async () => {
    let mintCalls = 0;
    const broker: CapabilityBroker = {
      mintFor: async () => {
        mintCalls += 1;
        return ok({
          brokerLlm: {
            clientKind: "llm",
            client: {} as LlmClient,
            pricingModel: { kind: "request" },
            runScopedOperations: {},
          },
        });
      },
      provides: (capability) => capability === "brokerLlm",
    };
    const node = createFetchNode({
      id: N("unmetered-broker-llm"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: ["brokerLlm"] as const,
      fetch: async () => ok({ ok: true }),
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "unmetered-broker-llm" }],
    });

    const forged = { broker, origin: agentOrigin } as unknown as MintingAuthority;
    const result = await runDag(dag, {}, baseCtx(), { minting: forged });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "validation") {
      expect(result.error.message).toContain("meterLlm must be a function");
    }
    expect(mintCalls).toBe(0);
  });

  // ── snapshotOrigin: the origin half of the run-authority parse fence ───────
  //
  // `own-data.ts`'s primitives are property-tested on their own, but nothing
  // exercised THIS composition: the two variants' expected key sets, and the
  // per-field string checks, are written out by hand here. Swapping the two key
  // lists, or dropping a `typeof … === "string"` guard, keeps every own-data
  // property test green while letting a malformed origin — the value the whole
  // fence exists to reject before run-start — through into the audit record.
  describe("snapshotOrigin rejects every malformed InvocationOrigin shape", () => {
    // The label is derived from `expected`, never from `origin`: one of these
    // origins is a revoked Proxy, and stringifying it to build a message would
    // throw inside the assertion rather than inside the code under test.
    const rejects = async (origin: unknown, expected: string): Promise<void> => {
      let mintCalls = 0;
      const broker: CapabilityBroker = {
        mintFor: async () => {
          mintCalls += 1;
          return ok({} as unknown as ScopedCapabilityHandle);
        },
        provides: () => false,
      };
      const node = createFetchNode({
        id: N("origin-fence"),
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        requires: [] as const,
        fetch: async () => ok({ ok: true }),
      });
      const dag = defineDagFromArray({
        id: "dag-origin",
        nodes: [node],
        edges: [{ from: DAG_INPUT, to: "origin-fence" }],
      });

      const result = await runDag(dag, {}, baseCtx(), {
        minting: {
          broker,
          origin: origin as InvocationOrigin,
          meterLlm: () => ok({} as LlmClient),
        },
      });

      expect(result.ok, `expected refusal mentioning "${expected}"`).toBe(false);
      if (!result.ok) {
        // Narrow before reading `message`: `FrameworkError` is a union and not
        // every member carries one. The kind assertion is load-bearing anyway —
        // the fence must fail as a `validation`, not as a node crash.
        expect(result.error.kind).toBe("validation");
        if (result.error.kind === "validation") {
          expect(result.error.message).toContain("minting authority origin invalid");
          expect(result.error.message).toContain(expected);
        }
      }
      // Fail CLOSED: a bad origin must stop the run before any egress, not
      // after the broker has already minted against an unattributable caller.
      expect(mintCalls).toBe(0);
    };

    it("refuses a non-object origin", async () => {
      await rejects(42, "must be an object");
      await rejects(null, "must be an object");
    });

    it("refuses an unknown or non-string kind", async () => {
      await rejects({ kind: "service" }, 'kind must be exactly "agent" or "user"');
      await rejects({ kind: 7 }, 'kind must be exactly "agent" or "user"');
      await rejects({}, "kind must be an own data property");
    });

    it("refuses an agent origin carrying the wrong key set", async () => {
      // Extra key...
      await rejects(
        { kind: "agent", agentClientId: "a", sub: "s" },
        "agent variant must contain exactly kind and agentClientId",
      );
      // ...and missing key. Both directions matter: `hasExactOwnKeys` is an
      // equality check, and a subset check would pass the second.
      await rejects(
        { kind: "agent" },
        "agent variant must contain exactly kind and agentClientId",
      );
    });

    it("refuses a user origin carrying the wrong key set", async () => {
      await rejects(
        { kind: "user", sub: "s" },
        "user variant must contain exactly kind, sub, and agentClientId",
      );
      await rejects(
        { kind: "user", sub: "s", agentClientId: "a", extra: 1 },
        "user variant must contain exactly kind, sub, and agentClientId",
      );
      // The agent variant's key set must NOT satisfy the user variant, which is
      // exactly what a swap of the two expected lists would produce.
      await rejects(
        { kind: "user", agentClientId: "a" },
        "user variant must contain exactly kind, sub, and agentClientId",
      );
    });

    it("refuses non-string identity fields on either variant", async () => {
      await rejects({ kind: "agent", agentClientId: 7 }, "agentClientId must be a string");
      await rejects(
        { kind: "user", sub: 7, agentClientId: "a" },
        "sub and agentClientId must be strings",
      );
      await rejects(
        { kind: "user", sub: "s", agentClientId: 7 },
        "sub and agentClientId must be strings",
      );
    });

    it("refuses an accessor-backed field — a getter could answer differently later", async () => {
      const hostile = Object.defineProperty({ kind: "agent" }, "agentClientId", {
        get: () => "attacker",
        enumerable: true,
        configurable: true,
      });
      await rejects(hostile, "agentClientId must be an own data property");
    });

    it("refuses a revoked Proxy without letting the throw escape the Result", async () => {
      const revocable = Proxy.revocable({ kind: "agent", agentClientId: "a" }, {});
      revocable.revoke();
      await rejects(revocable.proxy, "could not be inspected safely");
    });
  });

  it("rejects an untagged broker LLM instead of passing it through unmetered", async () => {
    let nodeRuns = 0;
    let meterCalls = 0;
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        brokerLlm: {} as LlmClient,
      } as unknown as ScopedCapabilityHandle),
      provides: (capability) => capability === "brokerLlm",
    };
    const node = createFetchNode({
      id: N("untagged-broker-llm"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: ["brokerLlm"] as const,
      fetch: async () => {
        nodeRuns += 1;
        return ok({ ok: true });
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "untagged-broker-llm" }],
    });

    const result = await runDag(dag, {}, baseCtx(), {
      minting: {
        broker,
        origin: agentOrigin,
        meterLlm: () => {
          meterCalls += 1;
          return ok({} as LlmClient);
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toContain("clientKind");
    }
    expect(nodeRuns).toBe(0);
    expect(meterCalls).toBe(0);
  });

  it("run-start validation passes a scope the broker provides() even though it is absent from the base context", async () => {
    const { broker } = recordingBroker();
    const node = createFetchNode({
      id: N("only"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }),
    });
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [{ from: DAG_INPUT, to: "only" }] });
    // Base context has NO `svc:opA` — only the broker can supply it at dispatch.
    const result = await runDag(dag, {}, baseCtx(), { minting: testMinting(broker) });
    expect(result.ok).toBe(true);
  });

  it("rejects a broker key that the node neither declared nor claimed", async () => {
    let ran = false;
    const broker: CapabilityBroker = {
      mintFor: async () => ok({
        http: { clientKind: "non-llm", client: { tag: "broker-http" } },
      } as unknown as ScopedCapabilityHandle),
    };
    const node = createFetchNode({
      id: N("reserved-output"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [],
      fetch: async () => {
        ran = true;
        return ok({ ok: true });
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "reserved-output" }],
    });

    const result = await runDag(dag, {}, baseCtx(), { minting: testMinting(broker) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("returned undeclared or unclaimed capabilities: http");
      }
    }
    expect(ran).toBe(false);
    expect(baseCtx().http as unknown).toBe(staticHttp);
  });

  it("fails the node fail-closed when its mint is refused — the broker's error propagates UNWRAPPED", async () => {
    const { broker } = recordingBroker({ refuse: true });
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached
    });
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [{ from: DAG_INPUT, to: "gated" }] });
    const result = await runDag(dag, {}, baseCtx(), { minting: testMinting(broker) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A settled refusal is terminal (ADR-0059): it fast-fails the DAG with the
      // ORIGINAL error kind preserved — never rewrapped as `retry-exhausted`,
      // even at retry limit 0. The host classifier branches on the bare kind.
      expect(result.error.kind).toBe("policy-refusal");
    }
  });

  it("never retries a settled refusal: with retry budget, mintFor fires exactly once and the bare kind survives", async () => {
    const { broker, calls } = recordingBroker({ refuse: true });
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      // Retry budget present — a retriable error here would mint 3 times. A
      // settled policy-refusal must fast-fail on the FIRST attempt: retrying
      // re-fires the mint against a policy that already said no and emits a
      // duplicate refusal audit per attempt (SC-009).
      defaultRetryLimit: 2,
    });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
      suppressRoutingWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("policy-refusal");
    expect(calls.length).toBe(1);
  });

  it("never retries a settled downstream-denied: with retry budget, mintFor fires exactly once and the bare kind survives", async () => {
    // Mirrors the policy-refusal fast-fail test for the OTHER settled mint-path
    // kind (ADR-0059): a downstream "no" (FIC mismatch / WIF rejection / resource
    // denial) is an ANSWER, not an outage — retrying would re-fire the exchange
    // against a provider that already refused and emit duplicate refusal audits.
    const calls: { nodeId: string }[] = [];
    const broker: CapabilityBroker = {
      mintFor: async (inv: Invocation): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
        calls.push({ nodeId: inv.nodeId as string });
        return err({ kind: "downstream-denied", resource: "https://graph.microsoft.com", reason: "FIC subject mismatch" });
      },
      provides: (c: Capability) => (c as string).includes(":"),
    };
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      defaultRetryLimit: 2, // budget present — a retriable error would mint 3 times
    });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
      suppressRoutingWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Bare kind survives — never rewrapped as retry-exhausted.
      expect(result.error.kind).toBe("downstream-denied");
      if (result.error.kind === "downstream-denied") {
        expect(result.error.resource).toBe("https://graph.microsoft.com");
        expect(result.error.reason).toBe("FIC subject mismatch");
      }
    }
    expect(calls.length).toBe(1); // exactly one mint attempt — no retry
  });

  it("never retries llm-budget-exceeded: the node fails once (one mint, one run) and the bare kind survives", async () => {
    // The budget error is deterministic WITHIN a run — the cumulative counter
    // only grows, so a retry can never succeed (retry-policy.ts fast-fail set).
    // Retrying would also re-fire mintFor per attempt.
    const { broker, calls } = recordingBroker();
    let fetchRuns = 0;
    const node = createFetchNode({
      id: N("budgeted"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async (_in, ctx) => {
        fetchRuns += 1;
        return err({
          kind: "llm-budget-exceeded",
          runId: ctx.runId,
          nodeId: N("budgeted"),
          cause: {
            kind: "reached",
            ceiling: { kind: "tokens", limit: 1000 },
            basis: "settled",
            observed: 1200,
          },
        });
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "budgeted" }],
      defaultRetryLimit: 2, // budget present — a retriable error would run 3 times
    });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
      suppressRoutingWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("llm-budget-exceeded");
      if (result.error.kind === "llm-budget-exceeded") {
        expect(result.error.cause.ceiling).toEqual({ kind: "tokens", limit: 1000 });
        expect(result.error.cause.basis).toBe("settled");
      }
    }
    expect(fetchRuns).toBe(1); // the node ran exactly once — fast-fail, no retry
    expect(calls.length).toBe(1); // and minted exactly once
  });

  it("a checkpoint-skipped node mints NOTHING — mintFor is never called for a replayed node (review gap 4/10)", async () => {
    // run-node.ts orders the checkpoint-skip check BEFORE the minting seam: a
    // replayed node returns its cached output without dispatching, so no
    // authority is minted (and no mint audit emitted) for work that never runs.
    const { broker, calls } = recordingBroker();

    const nodeA = createFetchNode({
      id: N("nodeA"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached — checkpointed
    });
    const nodeB = createFetchNode({
      id: N("nodeB"),
      inputSchema: z.object({ ok: z.boolean() }),
      outputSchema: z.object({ done: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ done: true }),
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [nodeA, nodeB],
      edges: [{ from: DAG_INPUT, to: "nodeA" }, { from: "nodeA", to: "nodeB" }],
    });

    // Resume with nodeA's output already checkpointed → nodeA is skipped/replayed.
    const checkpoint = new Map<string, unknown>([["nodeA", { ok: true }]]);
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
      resume: { runId: "run-1", checkpoint },
    });

    expect(result.ok).toBe(true);
    // ZERO mintFor calls for the skipped node; exactly one for the node that ran.
    expect(calls.filter((c) => c.nodeId === "nodeA").length).toBe(0);
    expect(calls.filter((c) => c.nodeId === "nodeB").length).toBe(1);
    expect(calls.length).toBe(1);
  });

  it("without a broker, the base context is used unchanged (byte-identical, no minting)", async () => {
    const calls: number[] = [];
    const node = createFetchNode({
      id: N("plain"),
      inputSchema: z.object({}),
      outputSchema: z.object({ http: z.boolean() }),
      requires: [cap("http")] as unknown as readonly Capability[],
      fetch: async (_in, ctx) => {
        calls.push(1);
        return ok({ http: (ctx as unknown as Record<string, unknown>).http === staticHttp });
      },
    });
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [{ from: DAG_INPUT, to: "plain" }] });
    const result = await runDag<unknown, { http: boolean }>(dag, {}, baseCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.http).toBe(true);
  });
});

// ── Port-contract enforcement at the dispatch seam (pass-4) ─────────────────

describe("per-node minting — broker port-contract enforcement", () => {
  it("fences hostile mintFor accessors and proxies as validation with balanced run telemetry", async () => {
    let accessorReads = 0;
    const accessorBroker = Object.defineProperty({
      provides: (c: Capability) => (c as string).includes(":"),
    }, "mintFor", {
      get: () => {
        accessorReads += 1;
        throw new Error("hostile mintFor getter");
      },
    }) as CapabilityBroker;
    const revoked = Proxy.revocable({
      mintFor: async () => ok({} as ScopedCapabilityHandle),
      provides: (c: Capability) => (c as string).includes(":"),
    }, {});
    revoked.revoke();

    for (const broker of [accessorBroker, revoked.proxy]) {
      const observer = new RecordingObserver();
      const node = createFetchNode({
        id: N("gated"),
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        requires: [SCOPE] as unknown as readonly Capability[],
        fetch: async () => ok({ ok: true }),
      });
      const dag = defineDagFromArray({
        id: "dag-1",
        nodes: [node],
        edges: [{ from: DAG_INPUT, to: "gated" }],
      });
      const ctx = makeNodeContext({
        runId: "run-1",
        dagId: "dag-1",
        observer,
        http: staticHttp as unknown as NodeContext["http"],
      });

      const result = await runDag(dag, {}, ctx, {
        minting: testMinting(broker),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
      expect(observer.events.map((event) => event.type)).toEqual(["run-start", "run-end"]);
      const runEnd = observer.events[1];
      expect(runEnd?.type).toBe("run-end");
      if (runEnd?.type === "run-end") expect(runEnd.status).toBe("error");
    }
    expect(accessorReads).toBe(1);
  });

  it("cannot mutate a node's requirements to authorize an overdelivered capability", async () => {
    let mutationBlocked = false;
    let nodeRuns = 0;
    const broker: CapabilityBroker = {
      mintFor: async (_inv, requires) => {
        try {
          (requires as Capability[]).push(cap("http"));
        } catch {
          mutationBlocked = true;
        }
        return ok({
          http: { clientKind: "non-llm", client: { tag: "injected" } },
        } as unknown as ScopedCapabilityHandle);
      },
      provides: (capability) => capability === SCOPE || capability === cap("http"),
    };
    const node = createFetchNode({
      id: N("immutable-requires"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => {
        nodeRuns += 1;
        return ok({ ok: true });
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "immutable-requires" }],
    });

    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
    });

    expect(mutationBlocked).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.message).toContain("returned undeclared or unclaimed capabilities: http");
    }
    expect(nodeRuns).toBe(0);
    expect(dag.nodes[0]?.requires).toEqual([SCOPE]);
  });

  it("a broker mintFor contract throw is non-retriable and invoked once with retry budget", async () => {
    let mintCalls = 0;
    const throwingBroker: CapabilityBroker = {
      mintFor: async () => {
        mintCalls++;
        throw new Error("broker exploded across the port");
      },
      provides: (c: Capability) => (c as string).includes(":"),
    };
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      defaultRetryLimit: 2,
    });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(throwingBroker),
      suppressRoutingWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("broker.mintFor violated the port contract");
      }
    }
    expect(mintCalls).toBe(1);
  });

  // Run-start snapshots every node's `requires` and every `provides()` answer
  // once, and reuses that frozen facade for validation and every dispatch. Both
  // halves must be fenced: a throw from either has to come back on the Result
  // channel with the broker never reached, not escape runDag as an exception
  // and not re-fire broker egress on a retry.
  it("a throwing requires iterable refuses on the Result channel, before any egress", async () => {
    let mintCalls = 0;
    const broker: CapabilityBroker = {
      mintFor: async () => {
        mintCalls++;
        return ok({} as ScopedCapabilityHandle);
      },
      provides: (c: Capability) => (c as string).includes(":"),
    };
    let nodeRuns = 0;
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => { nodeRuns++; return ok({ ok: true }); },
    });
    const built = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      defaultRetryLimit: 2,
    });
    // `defineDagFromArray` snapshots `requires` into a frozen array, so the
    // hostile iterable is only reachable on a hand-assembled DagDef — which is
    // exactly the input `runDag` must not crash on.
    const hostileDag = {
      ...built,
      nodes: [{
        ...built.nodes[0]!,
        requires: {
          [Symbol.iterator]: () => { throw new Error("hostile requires iterator"); },
        } as unknown as readonly Capability[],
      }],
    } as unknown as typeof built;

    const result = await runDag(hostileDag, {}, baseCtx(), {
      minting: testMinting(broker),
      suppressRoutingWarnings: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "validation") {
      expect(result.error.message).toContain("node.requires threw while snapshotting run authority");
      expect(result.error.message).toContain("hostile requires iterator");
    } else {
      throw new Error("expected a validation refusal on the Result channel");
    }
    // Refused before the broker was ever consulted, and the node never ran.
    expect(mintCalls).toBe(0);
    expect(nodeRuns).toBe(0);
  });

  it("a throwing broker provides() refuses on the Result channel, before any egress", async () => {
    let mintCalls = 0;
    const broker: CapabilityBroker = {
      mintFor: async () => {
        mintCalls++;
        return ok({} as ScopedCapabilityHandle);
      },
      provides: () => { throw new Error("hostile provides"); },
    };
    let nodeRuns = 0;
    const node = createFetchNode({
      id: N("gated"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => { nodeRuns++; return ok({ ok: true }); },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      defaultRetryLimit: 2,
    });

    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(broker),
      suppressRoutingWarnings: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "validation") {
      expect(result.error.nodeId).toBe(N("gated"));
      expect(result.error.message).toContain('broker.provides("svc:opA") threw');
      expect(result.error.message).toContain("hostile provides");
    } else {
      throw new Error("expected a validation refusal on the Result channel");
    }
    expect(mintCalls).toBe(0);
    expect(nodeRuns).toBe(0);
  });

  it("treats hostile ok() capability bags as one-shot non-retriable contract failures", async () => {
    const revoked = Proxy.revocable({ [SCOPE]: { tag: "revoked" } }, {});
    revoked.revoke();
    const hostileOwnKeys = new Proxy({ [SCOPE]: { tag: "trapped" } }, {
      ownKeys: () => { throw new Error("hostile ownKeys trap"); },
    });
    const accessorBacked = Object.defineProperty({}, SCOPE, {
      enumerable: true,
      get: () => { throw new Error("capability getter must not run"); },
    });

    for (const [label, capabilityBag] of [
      ["null", null],
      ["primitive", 7],
      ["array", []],
      ["revoked proxy", revoked.proxy],
      ["throwing property trap", hostileOwnKeys],
      ["accessor-backed property", accessorBacked],
    ] as const) {
      let mintCalls = 0;
      let nodeRuns = 0;
      const observer = new RecordingObserver();
      const broker: CapabilityBroker = {
        mintFor: async () => {
          mintCalls += 1;
          return ok(capabilityBag as ScopedCapabilityHandle);
        },
        provides: (capability: Capability) => capability === SCOPE,
      };
      const node = createFetchNode({
        id: N("hostile-success"),
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        requires: [SCOPE] as unknown as readonly Capability[],
        fetch: async () => {
          nodeRuns += 1;
          return ok({ ok: true });
        },
      });
      const dag = defineDagFromArray({
        id: "dag-1",
        nodes: [node],
        edges: [{ from: DAG_INPUT, to: "hostile-success" }],
        defaultRetryLimit: 2,
      });
      const ctx = makeNodeContext({
        runId: "run-1",
        dagId: "dag-1",
        observer,
        http: staticHttp as unknown as NodeContext["http"],
      });

      const result = await runDag(dag, {}, ctx, {
        minting: testMinting(broker),
        suppressRoutingWarnings: true,
      });

      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.error.kind, label).toBe("node-crash");
        if (result.error.kind === "node-crash") {
          expect(result.error.retriability, label).toBe("non-retriable");
          expect(result.error.message, label).toContain("broker.mintFor violated the port contract");
        }
      }
      expect(mintCalls, label).toBe(1);
      expect(nodeRuns, label).toBe(0);
      const nodeErrors = observer.events.filter((event) => event.type === "node-error");
      expect(nodeErrors, label).toHaveLength(1);
      expect(nodeErrors[0]?.frameworkError.kind, label).toBe("node-crash");
    }
  });

  it("snapshots or rejects hostile Result envelopes before retry classification", async () => {
    const revoked = Proxy.revocable({ ok: true, value: { [SCOPE]: { tag: "revoked" } } }, {});
    revoked.revoke();
    let discriminantReads = 0;
    const statefulDiscriminant = Object.defineProperties({}, {
      ok: {
        enumerable: true,
        get: () => {
          discriminantReads += 1;
          return discriminantReads > 1;
        },
      },
      value: { enumerable: true, value: { [SCOPE]: { tag: "bypass" } } },
      error: { enumerable: true, value: { kind: "policy-refusal", scope: SCOPE } },
    });
    const throwingError = Object.defineProperties({}, {
      ok: { enumerable: true, value: false },
      error: {
        enumerable: true,
        get: () => { throw new Error("hostile error getter"); },
      },
    });

    for (const [label, envelope] of [
      ["null envelope", null],
      ["primitive envelope", 7],
      ["array envelope", []],
      ["revoked envelope", revoked.proxy],
      ["stateful discriminant", statefulDiscriminant],
      ["throwing error accessor", throwingError],
      ["truthy discriminant", { ok: "yes", value: { [SCOPE]: {} } }],
      ["missing Err payload", { ok: false }],
      ["extra Result field", { ok: true, value: { [SCOPE]: {} }, extra: true }],
    ] as const) {
      let mintCalls = 0;
      let nodeRuns = 0;
      const broker: CapabilityBroker = {
        mintFor: async () => {
          mintCalls += 1;
          return envelope as unknown as Result<ScopedCapabilityHandle, FrameworkError>;
        },
        provides: (capability: Capability) => capability === SCOPE,
      };
      const node = createFetchNode({
        id: N("hostile-envelope"),
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        requires: [SCOPE] as unknown as readonly Capability[],
        fetch: async () => {
          nodeRuns += 1;
          return ok({ ok: true });
        },
      });
      const dag = defineDagFromArray({
        id: "dag-1",
        nodes: [node],
        edges: [{ from: DAG_INPUT, to: "hostile-envelope" }],
        defaultRetryLimit: 2,
      });

      const result = await runDag(dag, {}, baseCtx(), {
        minting: testMinting(broker),
        suppressRoutingWarnings: true,
      });

      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.error.kind, label).toBe("node-crash");
        if (result.error.kind === "node-crash") {
          expect(result.error.retriability, label).toBe("non-retriable");
          expect(result.error.message, label).toContain("broker.mintFor violated the port contract");
        }
      }
      expect(mintCalls, label).toBe(1);
      expect(nodeRuns, label).toBe(0);
    }
    expect(discriminantReads).toBe(0);
  });

  it("a broker claiming provides(cap) but omitting it from ok() fails the node with missing-capability — run never sees an undefined handle", async () => {
    // The seam contract: run-start validation exempted the scope on the strength
    // of provides(); a broker that then fails to deliver would put `undefined`
    // behind the validated-context cast and crash inside `run`. The minted-record
    // delivery proof fails closed before the static base enters the merge.
    let runReached = false;
    const lyingBroker: CapabilityBroker = {
      mintFor: async () => ok({} as ScopedCapabilityHandle), // claims below, delivers nothing
      provides: (c: Capability) => (c as string).includes(":"),
    };
    const node = createFetchNode({
      id: N("undelivered"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => {
        runReached = true;
        return ok({ ok: true });
      },
    });
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [{ from: DAG_INPUT, to: "undelivered" }] });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: testMinting(lyingBroker),
    });
    expect(result.ok).toBe(false);
    expect(runReached).toBe(false);
    if (!result.ok) {
      const root =
        result.error.kind === "retry-exhausted" ? result.error.rootErrorKind : result.error.kind;
      expect(root).toBe("missing-capability");
      const bare = result.error.kind === "missing-capability" ? result.error : undefined;
      if (bare) {
        expect(bare.missing[0]).toEqual({ nodeId: N("undelivered"), capability: SCOPE });
      }
    }
  });

  it("snapshots each distinct capability claim once so a drifting broker cannot expose static authority", async () => {
    const staticScope = { tag: "static-authority-must-not-run" };
    let providesCalls = 0;
    let runReached = false;
    const broker: CapabilityBroker = {
      mintFor: async () => ok({} as ScopedCapabilityHandle),
      // The first answer waives static validation. Every later answer would
      // revoke that claim and let the old dispatch path fall back to the static
      // client. Run preparation must observe this predicate exactly once.
      provides: () => {
        providesCalls += 1;
        return providesCalls === 1;
      },
    };
    const first = createFetchNode({
      id: N("first"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => {
        runReached = true;
        return ok({ ok: true });
      },
    });
    const second = createFetchNode({
      id: N("second"),
      inputSchema: z.object({ ok: z.boolean() }),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }),
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [first, second],
      edges: [{ from: DAG_INPUT, to: "first" }, { from: "first", to: "second" }],
    });
    const ctx = makeNodeContext({
      runId: "run-1",
      dagId: "dag-1",
      capabilities: { [SCOPE]: staticScope } as never,
    });

    const result = await runDag(dag, {}, ctx, {
      minting: testMinting(broker),
    });

    expect(result.ok).toBe(false);
    expect(providesCalls).toBe(1);
    expect(runReached).toBe(false);
    if (!result.ok) {
      const root = result.error.kind === "retry-exhausted"
        ? result.error.rootErrorKind
        : result.error.kind;
      expect(root).toBe("missing-capability");
    }
  });

  it("a static base capability cannot mask a claimed handle omitted by the broker", async () => {
    const staticScope = { tag: "static-authority-must-not-run" };
    let runReached = false;
    const broker: CapabilityBroker = {
      mintFor: async () => ok({} as ScopedCapabilityHandle),
      provides: (capability: Capability) => capability === SCOPE,
    };
    const node = createFetchNode({
      id: N("masked-omission"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => {
        runReached = true;
        return ok({ ok: true });
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "masked-omission" }],
    });
    const ctx = makeNodeContext({
      runId: "run-1",
      dagId: "dag-1",
      capabilities: { [SCOPE]: staticScope } as never,
    });

    const result = await runDag(dag, {}, ctx, {
      minting: testMinting(broker),
    });

    expect(result.ok).toBe(false);
    expect(runReached).toBe(false);
    expect((ctx as unknown as Record<string, unknown>)[SCOPE]).toBe(staticScope);
    if (!result.ok) {
      const root = result.error.kind === "retry-exhausted"
        ? result.error.rootErrorKind
        : result.error.kind;
      expect(root).toBe("missing-capability");
    }
  });

  // ── Fixed-pricing LLM bindings (round-13 A8) ───────────────────────────────
  // `parseScopedBinding` accepts two pricing models. Every prior test used
  // `{ kind: "request" }`, so the `"fixed"` branch — its model parse, its
  // malformed-binding refusals, and the alias-collision refusal that guards
  // every LLM binding — was never executed.

  /** Build a broker minting one LLM capability with the given raw binding. */
  const brokerMinting = (capability: string, binding: unknown): CapabilityBroker => ({
    mintFor: async () => ok({ [capability]: binding } as never),
    provides: (c) => c === capability,
  });

  const llmBindingClient = (onCall: () => void): LlmClient => ({
    sendStructured: async <O>() => {
      onCall();
      return ok({
        output: { answer: "fixed" } as O,
        rawText: "",
        tokensIn: 1,
        tokensOut: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      });
    },
    sendWithTools: async () => { throw new Error("unused"); },
  });

  /** Run a one-node DAG whose node requires `brokerLlm` from `broker`. */
  const runWithBrokerLlm = async (
    broker: CapabilityBroker,
    meterLlm: MintingAuthority["meterLlm"],
  ): Promise<Result<unknown, FrameworkError>> => {
    const node = createFetchNode({
      id: N("fixed-pricing-node"),
      inputSchema: z.object({}),
      outputSchema: z.object({ answer: z.string() }),
      requires: ["brokerLlm"] as const,
      fetch: async (_input, ctx) => {
        const result = await ctx.brokerLlm.sendStructured({
          system: "s",
          user: "u",
          model: "gpt-4o",
          schema: z.object({ answer: z.string() }),
          nodeId: N("fixed-pricing-node"),
        });
        return result.ok ? ok(result.value.output) : result;
      },
    });
    const dag = defineDagFromArray({
      id: "dag-1",
      nodes: [node],
      edges: [{ from: DAG_INPUT, to: "fixed-pricing-node" }],
    });
    return runDag(dag, {}, baseCtx(), {
      minting: { broker, origin: agentOrigin, meterLlm },
    });
  };

  const rootKindOf = (result: Result<unknown, FrameworkError>): string | undefined => {
    if (result.ok) return undefined;
    return result.error.kind === "retry-exhausted"
      ? result.error.rootErrorKind
      : result.error.kind;
  };

  it("carries a fixed pricing model's parsed id through to the meter", async () => {
    let providerCalls = 0;
    let observedPricing: unknown;
    const broker = brokerMinting("brokerLlm", {
      clientKind: "llm",
      client: llmBindingClient(() => { providerCalls += 1; }),
      pricingModel: { kind: "fixed", model: "gpt-4o" },
      runScopedOperations: {},
    });

    const result = await runWithBrokerLlm(broker, (_capability, binding) => {
      observedPricing = binding.pricingModel;
      return ok({
        sendStructured: (request) => binding.client.sendStructured(request),
        sendWithTools: (request, ctx) => binding.client.sendWithTools(request, ctx),
      });
    });

    expect(result).toEqual(ok({ answer: "fixed" }));
    expect(providerCalls).toBe(1);
    // The declared model reaches the meter, which is what lets a fixed-priced
    // binding be costed without trusting the per-request model field.
    expect(observedPricing).toEqual({ kind: "fixed", model: "gpt-4o" });
  });

  it("refuses a fixed pricing model with no model, an empty model, or a non-string one", async () => {
    for (const pricingModel of [
      { kind: "fixed" },
      { kind: "fixed", model: "" },
      { kind: "fixed", model: "   " },
      { kind: "fixed", model: 42 },
      { kind: "fixed", model: null },
    ]) {
      const broker = brokerMinting("brokerLlm", {
        clientKind: "llm",
        client: llmBindingClient(() => { throw new Error("must not run"); }),
        pricingModel,
        runScopedOperations: {},
      });

      const result = await runWithBrokerLlm(broker, (_c, binding) => ok({
        sendStructured: (request) => binding.client.sendStructured(request),
        sendWithTools: (request, ctx) => binding.client.sendWithTools(request, ctx),
      }));

      expect(result.ok).toBe(false);
    }
  });

  it("refuses an unrecognised pricing model kind rather than defaulting one", async () => {
    // Defaulting to `request` would silently re-price a binding the broker
    // meant to fix — fail closed instead.
    const broker = brokerMinting("brokerLlm", {
      clientKind: "llm",
      client: llmBindingClient(() => { throw new Error("must not run"); }),
      pricingModel: { kind: "per-token" },
      runScopedOperations: {},
    });

    const result = await runWithBrokerLlm(broker, (_c, binding) => ok({
      sendStructured: (request) => binding.client.sendStructured(request),
      sendWithTools: (request, ctx) => binding.client.sendWithTools(request, ctx),
    }));

    expect(result.ok).toBe(false);
  });

  it("refuses an alias that would shadow a standard operation on a fixed binding", async () => {
    // An alias named `sendStructured` would let a broker replace the metered
    // standard operation with an unmetered one of its own. The refusal must be
    // fail-closed: the node never runs, so the provider is never reached.
    for (const alias of ["sendStructured", "sendWithTools"]) {
      let providerCalls = 0;
      const broker = brokerMinting("brokerLlm", {
        clientKind: "llm",
        client: llmBindingClient(() => { providerCalls += 1; }),
        pricingModel: { kind: "fixed", model: "gpt-4o" },
        runScopedOperations: { [alias]: "sendStructured" },
      });

      const result = await runWithBrokerLlm(broker, (_c, binding) => ok({
        sendStructured: (request) => binding.client.sendStructured(request),
        sendWithTools: (request, ctx) => binding.client.sendWithTools(request, ctx),
      }));

      expect(result.ok).toBe(false);
      expect(providerCalls).toBe(0);
      // A malformed binding is a broker-contract violation, not a caller error.
      expect(rootKindOf(result)).toBe("node-crash");
    }
  });

  it("refuses an alias naming an operation that does not exist", async () => {
    const broker = brokerMinting("brokerLlm", {
      clientKind: "llm",
      client: llmBindingClient(() => { throw new Error("must not run"); }),
      pricingModel: { kind: "fixed", model: "gpt-4o" },
      runScopedOperations: { critique: "sendAnything" },
    });

    const result = await runWithBrokerLlm(broker, (_c, binding) => ok({
      sendStructured: (request) => binding.client.sendStructured(request),
      sendWithTools: (request, ctx) => binding.client.sendWithTools(request, ctx),
    }));

    expect(result.ok).toBe(false);
  });
});
