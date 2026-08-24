/**
 * FR-023: the Redis backend deliberately IGNORES composite `SaveNodeOpts` and
 * stores every node under the bare `nodeId`. Composite addressing is a
 * file-backend extension (ADR-0075); Redis's behaviour must stay byte-identical
 * to a canonical save whatever a caller passes.
 *
 * `InMemoryCheckpointer` already had this pinned; Redis did not, even though the
 * shared `_checkpointer-suite` explicitly excludes composite-option cases and
 * defers them to the file backend — so nothing proved Redis's side of the
 * contract. `RedisCheckpointer.saveNode` does not even DECLARE the third
 * parameter, which is exactly the kind of silent conformance a test has to pin:
 * it satisfies the port structurally while observing nothing.
 */

import { describe, test, expect } from "bun:test";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import type { Checkpointer, SaveNodeOpts } from "../checkpoint/checkpointer.js";
import { dagId, nodeId, runId } from "../types/ids.js";

interface EvalCall {
  readonly nodeKey: string;
  readonly payload: string;
}

/** Records the node key each `saveNode` writes into the run's nodes hash. */
const recordingRedis = (calls: EvalCall[]) => ({
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
  expire: async () => 1,
  del: async () => 1,
});

const RUN = runId("run-fr023");
const NODE = nodeId("n1");
const state = {
  nodeId: NODE,
  output: { x: 42 },
  completedAt: new Date("2026-08-12T00:00:01Z"),
};

describe("RedisCheckpointer — composite opts are ignored (FR-023)", () => {
  test("stores under the bare nodeId regardless of the composite options passed", async () => {
    const calls: EvalCall[] = [];
    // Typed as the PORT, so the call is the one a composite-aware caller makes.
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls) as never);

    const withOpts = await cp.saveNode(RUN, state, { namespace: "sub", index: 3, attempt: 1 });
    const canonical = await cp.saveNode(RUN, state);

    // Same verdict...
    expect(withOpts).toEqual(canonical);
    // ...and the SAME stored key: no `sub@n1@3@1` field ever reaches Redis.
    expect(calls.map((c) => c.nodeKey)).toEqual(["n1", "n1"]);
    // ...and byte-identical payloads: the options leak into nothing else either.
    expect(calls[0]!.payload).toBe(calls[1]!.payload);
  });

  test("ignores malformed runtime option values rather than failing the write", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls) as never);
    // Values `compositeNodeKey` would reject outright — the Redis backend never
    // consults them, so the write must still succeed on the canonical key.
    const malformed = Object.freeze({
      namespace: "../ignored",
      index: -1,
      attempt: Number.NaN,
    }) as SaveNodeOpts;

    const result = await cp.saveNode(RUN, state, malformed);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls.map((c) => c.nodeKey)).toEqual(["n1"]);
  });

  test("setMeta/saveNode pairing is unaffected by options", async () => {
    const calls: EvalCall[] = [];
    const cp: Checkpointer = new RedisCheckpointer(recordingRedis(calls) as never);
    const meta = await cp.setMeta(RUN, {
      dagId: dagId("dag-1"),
      startedAt: new Date("2026-08-12T00:00:00Z"),
      nodeCount: 1,
    });
    expect(meta.ok).toBe(true);

    const saved = await cp.saveNode(RUN, state, { namespace: "sub", index: 0, attempt: 0 });
    expect(saved.ok).toBe(true);
    expect(calls.map((c) => c.nodeKey)).toEqual(["n1"]);
  });
});
