/**
 * ADR-0075 composite addressing on the REDIS backend, asserted at the WIRE.
 *
 * F6 shipped the composite codec and the port parameter but implemented the
 * address only in the file backend; FR-023 held Redis and in-memory to the bare
 * `nodeId` so that feature changed no existing layout. This file used to pin
 * that: `RedisCheckpointer.saveNode` did not even DECLARE the third parameter,
 * satisfying the port structurally while observing nothing.
 *
 * F1 PR-A closes it, because runtime-width fan-out needs each index to address
 * a distinct durable entry on the backend PRODUCTION runs, not only on the one
 * the framework tests happen to exercise. The contract cases now live in the
 * shared `_checkpointer-suite` (every backend is held to them); what stays here
 * is the Redis-SPECIFIC evidence the suite cannot give — the exact hash FIELD
 * handed to the Lua script, observed through a recording driver rather than
 * inferred from a `load` round-trip. A backend that encoded the address only on
 * the read side would pass the suite and fail here.
 */

import { describe, test, expect } from "bun:test";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import type { Checkpointer, SaveNodeOpts } from "../checkpoint/checkpointer.js";
import { dagId, nodeId, runId } from "../types/ids.js";
import { redisDriverFake } from "./_redis-driver-fake.js";

interface EvalCall {
  readonly nodeKey: string;
  readonly payload: string;
}

/**
 * Records the node key each `saveNode` writes into the run's nodes hash.
 *
 * The parameter list is checked against `RedisCheckpointerDriver`, so `nodeKey`
 * really is the argument the adapter passes in that position — before the port
 * existed, a cast let this fake claim any order it liked and still pass.
 */
const recordingRedis = (calls: EvalCall[]) =>
  redisDriverFake({
    script: async () => "sha-1",
    evalsha: async (
      _sha: string,
      _numKeys: number,
      _nodesKey: string,
      _metaKey: string,
      nodeKey: string,
      payload: string,
    ) => {
      calls.push({ nodeKey, payload });
      return "OK";
    },
    eval: async () => "OK",
    hgetall: async () => ({}),
    set: async () => "OK",
    get: async () => null,
  });

const RUN = runId("run-composite");
const NODE = nodeId("n1");
const state = {
  nodeId: NODE,
  output: { x: 42 },
  completedAt: new Date("2026-08-12T00:00:01Z"),
};

describe("RedisCheckpointer — composite opts reach the wire (ADR-0075)", () => {
  test("the composite address is the hash FIELD; canonical folding leaves it bare", async () => {
    const calls: EvalCall[] = [];
    // Typed as the PORT, so the call is the one a composite-aware caller makes.
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls));

    await cp.saveNode(RUN, state, { namespace: "sub", index: 3, attempt: 1 });
    await cp.saveNode(RUN, state);

    expect(calls.map((c) => c.nodeKey)).toEqual(["sub@n1@3@1", "n1"]);
  });

  test("the stored PAYLOAD keeps the canonical nodeId even under a composite key", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls));

    await cp.saveNode(RUN, state, { index: 7 });

    expect(calls[0]!.nodeKey).toBe("dag@n1@7@0");
    // ADR-0075: the KEY is the address, `nodeId` is the node's identity. If the
    // payload were rewritten to the composite string, `load`'s
    // `parseNodeStateRecord` would reject it — `@` is outside ID_PATTERN.
    expect(JSON.parse(calls[0]!.payload).nodeId).toBe("n1");
  });

  test("distinct indices write distinct fields — no index overwrites another", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls));

    for (const index of [0, 1, 2]) await cp.saveNode(RUN, state, { index });

    expect(calls.map((c) => c.nodeKey)).toEqual(["dag@n1@0@0", "dag@n1@1@0", "dag@n1@2@0"]);
  });

  test("a malformed address fails typed and issues NO write at all", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls));
    const malformed = Object.freeze({
      namespace: "../bad",
      index: -1,
      attempt: Number.NaN,
    }) as SaveNodeOpts;

    const result = await cp.saveNode(RUN, state, malformed);

    expect(result.ok).toBe(false);
    // `checkpoint-write-failed`, matching the file and in-memory backends — a
    // bad address is caller error, not a Redis fault. Classifying it as
    // `cache-error` here would make one failure wear a different kind
    // depending on which backend a deployment configured.
    if (!result.ok) expect(result.error.kind).toBe("checkpoint-write-failed");
    // Fail closed at the wire: the encoder runs BEFORE the driver call, so a
    // rejected address must not fall back to the canonical key. A silent
    // canonical write is precisely how a fan index would clobber the node's
    // own checkpoint.
    expect(calls).toEqual([]);
  });

  test("the NOSCRIPT/EVAL fallback carries the SAME composite address as the EVALSHA path", async () => {
    // The Lua SHA can be evicted from the server's script cache at any time, so
    // the inline-EVAL retry is a real production path, not a corner. It is a
    // SECOND place the node key is passed, and this PR changed both — a fix
    // applied to only one would silently write fan-out indices to the canonical
    // key whenever the cache happened to be cold.
    const evalCalls: string[] = [];
    const noscriptRedis = redisDriverFake({
      script: async () => "sha-1",
      evalsha: async () => {
        throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      },
      eval: async (
        _script: string,
        _numKeys: number,
        _nodesKey: string,
        _metaKey: string,
        nodeKey: string,
      ) => {
        evalCalls.push(nodeKey);
        return "OK";
      },
    });
    const cp: Checkpointer = new RedisCheckpointer(noscriptRedis);

    const result = await cp.saveNode(RUN, state, { namespace: "sub", index: 5, attempt: 2 });

    expect(result.ok).toBe(true);
    expect(evalCalls).toEqual(["sub@n1@5@2"]);
  });

  test("setMeta/saveNode pairing carries the composite key through", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls));
    const meta = await cp.setMeta(RUN, {
      dagId: dagId("dag-1"),
      startedAt: new Date("2026-08-12T00:00:00Z"),
      nodeCount: 1,
    });
    expect(meta.ok).toBe(true);

    const saved = await cp.saveNode(RUN, state, { namespace: "sub", index: 0, attempt: 0 });
    expect(saved.ok).toBe(true);
    // An explicit zero selects COMPOSITE form, not canonical (ADR-0075).
    expect(calls.map((c) => c.nodeKey)).toEqual(["sub@n1@0@0"]);
  });
});
