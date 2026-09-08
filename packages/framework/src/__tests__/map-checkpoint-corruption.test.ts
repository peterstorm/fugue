import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import { z } from "zod";
import type { Checkpointer, CorruptCheckpointAddress, RunState } from "../checkpoint/checkpointer.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { defineDag, runDag } from "../executor/index.js";
import { createFileCheckpointer } from "../file/checkpointer.js";
import { keyDigest } from "../file/layout.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createMapNode } from "../nodes/map.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { frameworkError } from "../types/error-factories.js";
import { PersistedFrameworkErrorSchema, type FrameworkError } from "../types/errors.js";
import { DAG_INPUT, dagId, nodeId, runId } from "../types/ids.js";
import { err, ok } from "../types/result.js";
import type { Result } from "../types/result.js";

const RUN = runId("map-checkpoint-refusal");
const FAN = nodeId("fan");
const PREFIX = "dag@fan@0@0";
const meta = { dagId: dagId("outer"), startedAt: new Date("2026-01-01T00:00:00.000Z"), nodeCount: 3 };

const fixture = (childOutputSchema = z.number()) => {
  const children: number[] = [];
  const reductions: (readonly number[])[] = [];
  const child = defineDag({ id: "child", nodes: {
    work: createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(),
      fetch: async n => { children.push(n); return ok(n * 2); } }),
  }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
  const fan = createMapNode({ id: "fan", inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.array(z.number()), widthFrom: "items", maxWidth: 3, child, childOutputSchema,
    reduce: xs => { reductions.push(xs); return ok([...xs]); } });
  const dag = defineDag({ id: "outer", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
  const run = (cp: Checkpointer, items: readonly number[]) => runDag(dag, { items },
    makeNodeContext({ runId: RUN, dagId: "outer", capabilities: { checkpointer: cp } }));
  return { run, children, reductions };
};

/** Record the public port, delegating real adapter behavior without replacing its decoder. */
const recording = (delegate: Checkpointer) => {
  const calls: string[] = [];
  const loads: Result<RunState | null, FrameworkError>[] = [];
  const cp: Checkpointer = {
    load: async (id, opts) => {
      calls.push("load");
      const result = await delegate.load(id, opts);
      loads.push(result);
      return result;
    },
    setMeta: (id, value) => { calls.push("setMeta"); return delegate.setMeta(id, value); },
    saveNode: (id, value, opts) => { calls.push("saveNode"); return delegate.saveNode(id, value, opts); },
  };
  return { cp, calls, loads };
};

const expectCorrupt = (result: Result<unknown, FrameworkError>, address: CorruptCheckpointAddress) => {
  expect(result).toMatchObject({ ok: false, error: { kind: "retry-exhausted", rootErrorKind: "checkpoint-corrupt", nodeId: FAN, attempts: 1 } });
  if (result.ok || result.error.kind !== "retry-exhausted") throw new Error("expected attributable corruption refusal");
  // The existing retry taxonomy retains the complete original error as JSON.
  const cause = PersistedFrameworkErrorSchema.parse(JSON.parse(result.error.lastError));
  expect(cause).toMatchObject({ kind: "checkpoint-corrupt", runId: RUN, nodeId: FAN });
  if (cause.kind !== "checkpoint-corrupt") throw new Error("expected original checkpoint-corrupt cause");
  expect(cause.message).toContain(address.kind);
  expect(cause.message).toContain(address.kind === "node-key" ? address.nodeKey : address.fileName);
};

describe("mapped fan checkpoint failure gates", () => {
  const addresses: readonly CorruptCheckpointAddress[] = [
    { kind: "node-key", nodeKey: PREFIX },
    { kind: "digest-filename", fileName: `${"a".repeat(64)}.json` },
    { kind: "node-key", nodeKey: "dag@unrelated@9@7" },
  ];
  for (const address of addresses) {
    for (const items of [[], [1, 2]]) it(`refuses ${JSON.stringify(address)} even at width ${items.length}`, async () => {
      const f = fixture();
      const recorded = recording({
        load: async () => ok({ meta, nodes: {}, corruptNodeAddresses: [address] }),
        setMeta: async () => ok(undefined), saveNode: async () => ok(undefined),
      });
      expectCorrupt(await f.run(recorded.cp, items), address);
      expect(recorded.calls).toEqual(["load"]);
      expect(f.children).toEqual([]);
      expect(f.reductions).toEqual([]);
    });
  }

  it("preserves the failed initial setMeta error after a null load, before any child/save/reducer", async () => {
    const failure = frameworkError.cacheError("checkpoint:setMeta", "metadata store unavailable", "permanent");
    const recorded = recording({ load: async () => ok(null), setMeta: async () => err(failure), saveNode: async () => ok(undefined) });
    const f = fixture();
    expect(await f.run(recorded.cp, [1, 2])).toEqual(err(failure));
    expect(recorded.loads).toEqual([ok(null)]);
    expect(recorded.calls).toEqual(["load", "setMeta"]);
    expect(f.children).toEqual([]);
    expect(f.reductions).toEqual([]);
  });

  it("successful initial metadata seeding makes fresh completions readable and reusable", async () => {
    const storage = new InMemoryCheckpointer();
    const recorded = recording(storage);
    const f = fixture();
    expect(await f.run(recorded.cp, [1, 2])).toEqual(ok([2, 4]));
    expect(recorded.loads).toEqual([ok(null)]);
    expect(recorded.calls).toEqual(["load", "setMeta", "saveNode", "saveNode"]);
    expect(await f.run(recorded.cp, [1, 2])).toEqual(ok([2, 4]));
    expect(recorded.calls).toEqual(["load", "setMeta", "saveNode", "saveNode", "load"]);
    expect(f.children).toEqual([1, 2]);
    expect(f.reductions).toEqual([[2, 4], [2, 4]]);
  });

  it("rejects a fresh child that passes its DAG schema but fails the map schema before save/gather/next index", async () => {
    const storage = new InMemoryCheckpointer();
    const recorded = recording(storage);
    const f = fixture(z.number().max(3));
    const result = await f.run(recorded.cp, [2, 3]);
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", nodeId: FAN } });
    if (result.ok || result.error.kind !== "validation") throw new Error("expected map schema refusal");
    expect(result.error.message).toContain("fan index 0 produced an output the child schema rejects");
    expect(f.children).toEqual([2]);
    expect(f.reductions).toEqual([]);
    expect(recorded.calls).toEqual(["load", "setMeta"]);
    expect(await storage.load(RUN)).toMatchObject({ ok: true, value: { nodes: {}, corruptNodeAddresses: [] } });
    // The same map contract accepts valid fresh outputs, which become durable.
    expect(await f.run(recorded.cp, [1, 1])).toEqual(ok([2, 2]));
    expect(f.children).toEqual([2, 1, 1]);
    expect(f.reductions).toEqual([[2, 2]]);
    expect(recorded.calls).toEqual(["load", "setMeta", "load", "saveNode", "saveNode"]);
  });
});

const warnings: string[] = [];
beforeEach(() => {
  warnings.length = 0;
  setFrameworkLogger({ debug: () => {}, info: () => {}, error: () => {}, warn: message => { warnings.push(message); } });
});
afterEach(__resetFrameworkLogger);

type DurableFixture = {
  readonly cp: Checkpointer;
  readonly readPrefix: () => Promise<string | null>;
  readonly corruptPrefix: (kind: CorruptCheckpointAddress["kind"]) => Promise<CorruptCheckpointAddress>;
  readonly close: () => Promise<void>;
};

const fileFixture = async (): Promise<DurableFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "mapped-corruption-"));
  const fileName = `${keyDigest(PREFIX)}.json`;
  const path = join(directory, RUN, "nodes", fileName);
  return {
    cp: createFileCheckpointer(directory),
    readPrefix: () => readFile(path, "utf8"),
    corruptPrefix: async kind => {
      const bytes = await readFile(path, "utf8");
      await writeFile(path, kind === "digest-filename" ? "{truncated" :
        bytes.replace(/"completedAt":"[^"]+"/, '"completedAt":"not-a-date"'));
      return kind === "digest-filename" ? { kind, fileName } : { kind, nodeKey: PREFIX };
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const redisFixture = async (): Promise<DurableFixture> => {
  const redis = new Redis(process.env.REDIS_URL!);
  const nodesKey = `chkpt:${RUN}`;
  const metaKey = `${nodesKey}:meta`;
  await redis.del(nodesKey, metaKey);
  return {
    cp: new RedisCheckpointer(redis),
    readPrefix: () => redis.hget(nodesKey, PREFIX),
    corruptPrefix: async () => {
      await redis.hset(nodesKey, PREFIX, "{truncated");
      return { kind: "node-key", nodeKey: PREFIX };
    },
    close: async () => { await redis.del(nodesKey, metaKey); redis.disconnect(); },
  };
};

for (const backend of [
  { name: "file", create: fileFixture, kinds: ["node-key", "digest-filename"] as const, enabled: true },
  { name: "Redis", create: redisFixture, kinds: ["node-key"] as const, enabled: Boolean(process.env.REDIS_URL) },
]) describe.skipIf(!backend.enabled)(`mapped fan with real ${backend.name} checkpoint loads`, () => {
  for (const kind of backend.kinds) it(`a dropped completed prefix (${kind}) never repeats its child effect or overwrites durable bytes`, async () => {
    const durable = await backend.create();
    try {
      const f = fixture();
      expect(await f.run(durable.cp, [1, 2])).toEqual(ok([2, 4]));
      expect(f.children).toEqual([1, 2]);
      const healthy = await durable.readPrefix();
      const address = await durable.corruptPrefix(kind);
      const corrupted = await durable.readPrefix();
      expect(corrupted).not.toBe(healthy);
      const loaded = await durable.cp.load(RUN);
      expect(loaded).toMatchObject({ ok: true, value: { corruptNodeAddresses: [address] } });
      if (!loaded.ok || loaded.value === null) throw new Error("expected adapter warning-and-drop load");
      expect(Object.keys(loaded.value.nodes)).toEqual(["dag@fan@1@0"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Dropping corrupt checkpoint entry");
      const recorded = recording(durable.cp);
      expectCorrupt(await f.run(recorded.cp, [1, 2, 3]), address);
      expect(recorded.loads).toEqual([loaded]);
      expect(recorded.calls).toEqual(["load"]);
      expect(f.children).toEqual([1, 2]);
      expect(f.reductions).toEqual([[2, 4]]);
      expect(await durable.readPrefix()).toBe(corrupted);
      expect(warnings).toHaveLength(2);
    } finally { await durable.close(); }
  });

  for (const prefix of ["healthy", "missing"] as const) it(`${prefix} prefix executes only genuinely missing children`, async () => {
    const durable = await backend.create();
    try {
      const f = fixture();
      if (prefix === "healthy") expect(await f.run(durable.cp, [1])).toEqual(ok([2]));
      else expect(await durable.cp.setMeta(RUN, meta)).toEqual(ok(undefined));
      const recorded = recording(durable.cp);
      expect(await f.run(recorded.cp, [1, 2])).toEqual(ok([2, 4]));
      expect(f.children).toEqual([1, 2]);
      expect(recorded.calls).toEqual(prefix === "healthy" ? ["load", "saveNode"] : ["load", "saveNode", "saveNode"]);
      const loaded = await durable.cp.load(RUN);
      expect(loaded).toMatchObject({ ok: true, value: { corruptNodeAddresses: [] } });
      if (!loaded.ok || loaded.value === null) throw new Error("expected completed fan");
      expect(Object.keys(loaded.value.nodes).sort()).toEqual([PREFIX, "dag@fan@1@0"]);
      expect(warnings).toEqual([]);
    } finally { await durable.close(); }
  });
});
