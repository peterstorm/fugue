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
import { makeNodeContext } from "../shared/make-node-context.js";
import type {
  CapabilityBroker,
  Invocation,
  InvocationOrigin,
  ScopedCapabilityHandle,
} from "../types/capability-broker.js";
import { runDag } from "../executor/run-dag.js";
import { createFetchNode } from "../nodes/fetch.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { N } from "./_id-helpers.js";

// A scope-shaped capability the broker mints, and a plain static one it doesn't.
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
        if ((r as string).includes(":")) out[r] = { tag: `minted:${r}:${inv.nodeId as string}` };
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
      edges: [{ from: "nodeA", to: "nodeB" }],
    });

    const result = await runDag(dag, {}, baseCtx(), { minting: { broker, origin: agentOrigin } });
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

  it("run-start validation passes a scope the broker provides() even though it is absent from the base context", async () => {
    const { broker } = recordingBroker();
    const node = createFetchNode({
      id: N("only"),
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }),
    });
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [] });
    // Base context has NO `svc:opA` — only the broker can supply it at dispatch.
    const result = await runDag(dag, {}, baseCtx(), { minting: { broker, origin: agentOrigin } });
    expect(result.ok).toBe(true);
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
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [] });
    const result = await runDag(dag, {}, baseCtx(), { minting: { broker, origin: agentOrigin } });
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
      edges: [],
      // Retry budget present — a retriable error here would mint 3 times. A
      // settled policy-refusal must fast-fail on the FIRST attempt: retrying
      // re-fires the mint against a policy that already said no and emits a
      // duplicate refusal audit per attempt (SC-009).
      defaultRetryLimit: 2,
    });
    const result = await runDag(dag, {}, baseCtx(), {
      minting: { broker, origin: agentOrigin },
      suppressRoutingWarnings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("policy-refusal");
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
    const dag = defineDagFromArray({ id: "dag-1", nodes: [node], edges: [] });
    const result = await runDag<unknown, { http: boolean }>(dag, {}, baseCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.http).toBe(true);
  });
});
