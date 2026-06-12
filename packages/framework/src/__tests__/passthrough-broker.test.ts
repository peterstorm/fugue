/**
 * Pass-through CapabilityBroker tests.
 *
 * Proves the zero-regression contract (US3, FR-W2-002/003, SC-005): the
 * pass-through broker hands back the EXACT client references it was constructed
 * with, independent of the invocation `origin` and the `requires` declaration,
 * and never produces an `Err`.
 */

import { describe, it, expect } from "bun:test";
import { createPassthroughBroker } from "../shared/passthrough-broker.js";
import type {
  Invocation,
  ScopedCapabilityHandle,
} from "../types/capability-broker.js";
import type { Capability } from "../types/node.js";
import { runId as makeRunId, dagId as makeDagId, nodeId as makeNodeId } from "../types/ids.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

// Sentinel client objects. We only care about *reference identity*, so any
// distinguishable object suffices. Cast to the broker's client-set shape — the
// broker is structurally agnostic to a client's concrete type (it never
// inspects it), so this faithfully models what the host's `extractClients`
// produces (already-correlated, opaque clients).
const dbClient = { tag: "db-client" };
const httpClient = { tag: "http-client" };

const fullClients = {
  // Built-in capability keys exist on the registry; cast keeps the test
  // independent of any consumer module augmentation.
  http: httpClient,
  db: dbClient,
} as unknown as ScopedCapabilityHandle;

const agentInvocation: Invocation = {
  origin: { kind: "agent", agentClientId: "agent-x" },
  runId: makeRunId("run-1"),
  dagId: makeDagId("dag-1"),
  nodeId: makeNodeId("__run__"),
};

const userInvocation: Invocation = {
  origin: { kind: "user", sub: "user-42", agentClientId: "agent-x" },
  runId: makeRunId("run-1"),
  dagId: makeDagId("dag-1"),
  nodeId: makeNodeId("__run__"),
};

const unwrap = (r: Awaited<ReturnType<ReturnType<typeof createPassthroughBroker>["mintFor"]>>) => {
  if (!r.ok) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`);
  return r.value as Record<string, unknown>;
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createPassthroughBroker", () => {
  it("resolves ok with the EXACT same client references it was constructed with (byte-identical, SC-005)", async () => {
    const broker = createPassthroughBroker(fullClients);

    const result = await broker.mintFor(agentInvocation, []);
    expect(result.ok).toBe(true);
    const resolved = unwrap(result);

    // Per-capability reference equality — not structural equality. This is the
    // load-bearing assertion: the broker must hand back the same object, never
    // a copy, so downstream behavior is byte-identical to direct injection.
    expect(resolved.db).toBe(dbClient);
    expect(resolved.http).toBe(httpClient);
    // And the whole record is the same object reference, too.
    expect(resolved).toBe(fullClients as unknown as Record<string, unknown>);
  });

  it("is independent of Invocation.origin (agent vs user resolve identically)", async () => {
    const broker = createPassthroughBroker(fullClients);

    const fromAgent = unwrap(await broker.mintFor(agentInvocation, []));
    const fromUser = unwrap(await broker.mintFor(userInvocation, []));

    // origin is ignored entirely by the pass-through broker.
    expect(fromAgent).toBe(fromUser);
    expect(fromAgent.db).toBe(fromUser.db);
    expect(fromAgent.http).toBe(fromUser.http);
  });

  it("ignores `requires` ([] vs a non-empty set return the same full client set — today's behavior)", async () => {
    const broker = createPassthroughBroker(fullClients);

    const withEmpty = unwrap(await broker.mintFor(agentInvocation, []));
    const withRequires = unwrap(
      await broker.mintFor(agentInvocation, ["db"] as unknown as readonly Capability[]),
    );

    expect(withEmpty).toBe(withRequires);
    // A requested subset does NOT narrow the returned set for pass-through —
    // the full configured set comes back regardless.
    expect(Object.keys(withRequires).sort()).toEqual(["db", "http"]);
  });

  it("resolves an empty client set to an empty (but ok) set — never an err", async () => {
    const empty: ScopedCapabilityHandle = {};
    const broker = createPassthroughBroker(empty);

    const result = await broker.mintFor(agentInvocation, []);
    expect(result.ok).toBe(true);
    const resolved = unwrap(result);
    expect(resolved).toBe(empty as unknown as Record<string, unknown>);
    expect(Object.keys(resolved)).toEqual([]);
  });

  it("never produces an Err across a range of invocations and requires (SC-008: mints nothing)", async () => {
    const broker = createPassthroughBroker(fullClients);

    const invocations: Invocation[] = [agentInvocation, userInvocation];
    const requireSets: (readonly Capability[])[] = [
      [],
      ["db"] as unknown as readonly Capability[],
      ["db", "http"] as unknown as readonly Capability[],
    ];

    for (const inv of invocations) {
      for (const req of requireSets) {
        const result = await broker.mintFor(inv, req);
        expect(result.ok).toBe(true);
        // And always the same single source-of-truth reference — proving zero
        // token minting / zero per-call allocation of the client set.
        if (result.ok) expect(result.value).toBe(fullClients);
      }
    }
  });
});
