/** REDIS_URL enables genuine SIGKILL/replacement tests, not an HTTP/BullMQ deployment. */
import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { z } from "zod";
import { compositeNodeKey, dagId, freshnessExecutionEpoch, fromJson, mapIndex, nodeId, runId } from "@fuguejs/framework";
import { buildCheckpointKey, buildCheckpointMetaKey, buildCheckpointNodesKey } from "../../domain/cache-keys.js";
import { mappedTestTenant, CHECKPOINT_TTL_SEC, RUN_RETENTION_SEC } from "../fixtures/mapped-host.js";

const redisUrl = process.env.REDIS_URL;
const Message = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prefix"), epoch: z.number() }),
  z.object({ kind: z.literal("epoch-committed"), epoch: z.number() }),
  z.object({ kind: z.literal("outcome"), outcome: z.unknown() }),
]);
const Envelope = z.object({
  state: z.object({ kind: z.string() }).passthrough(),
  context: z.object({ freshnessExecutionEpoch: z.number() }).passthrough(),
});
const spawnWorker = (tenant: string, id: string, scenario: string, mode: "interrupt" | "finish") => {
  const received = Promise.withResolvers<z.infer<typeof Message>>();
  const worker = Bun.spawn([process.execPath, new URL("../fixtures/mapped-resume-worker.ts", import.meta.url).pathname, tenant, id, scenario, mode], {
    env: process.env, stdout: "ignore", stderr: "pipe",
    ipc: (raw) => {
      const message = Message.safeParse(raw);
      if (message.success) received.resolve(message.data);
      else received.reject(new Error("Worker sent malformed barrier/outcome"));
    },
  });
  const stderr = new Response(worker.stderr).text();
  const message = Promise.race([
    received.promise,
    worker.exited.then(async (code) => { throw new Error(`Worker exited before barrier/outcome (${code}): ${await stderr}`); }),
  ]);
  return { worker, message, stderr };
};

const disposeWorkers = async (workers: readonly ReturnType<typeof spawnWorker>[], redis: Redis, tenant: string): Promise<void> => {
  for (const { worker } of workers) { worker.kill("SIGKILL"); await worker.exited; }
  // Unique test tenant only; no FLUSHDB and no global service/policy edits.
  const keys = await redis.keys(`fugue:${tenant}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
};

describe.skipIf(!redisUrl)("mapped host process-kill/resume — real Redis + createRunExecutor", () => {
  for (const scenario of ["resume", "changed", "same", "fan"] as const) {
    it(`${scenario}: only the current durable generation's completed prefix survives SIGKILL`, async () => {
      const redis = new Redis(redisUrl!);
      const tenant = mappedTestTenant(`map-kill-${crypto.randomUUID()}`);
      const id = runId(`run-${crypto.randomUUID()}`);
      const root = dagId("mapped-root");
      const prefix = `fugue:${tenant}:acceptance:${id}`;
      const nodesKey = buildCheckpointNodesKey(tenant, root, id);
      const metaKey = buildCheckpointMetaKey(tenant, root, id);
      const checkpointKey = `fugue:${tenant}:hitl:ckpt:${id}`;
      const epoch = scenario === "resume" ? 0 : 1;
      const completion = (index: number, attempt = epoch) => compositeNodeKey(nodeId("fan"), { index: mapIndex(index), attempt });
      const workers: ReturnType<typeof spawnWorker>[] = [];
      try {
        const interrupted = spawnWorker(tenant, id, scenario, "interrupt");
        workers.push(interrupted);
        expect(await interrupted.message).toEqual({ kind: "prefix", epoch });
        // Separate connection observes ACKNOWLEDGED fan saves before we kill.
        const before = await redis.hgetall(nodesKey);
        expect(Object.keys(before).sort()).toEqual([
          ...(epoch === 1 ? [0, 1, 2, 3].map((i) => completion(i, 0)) : []), completion(0), completion(1),
        ].sort());
        const metaBefore = await redis.get(metaKey);
        expect(metaBefore).not.toBeNull();
        const checkpointBefore = await redis.get(checkpointKey);
        expect(checkpointBefore).not.toBeNull();
        const saved = Envelope.parse(fromJson(checkpointBefore!));
        expect(saved.state).toMatchObject({ kind: "running", wave: 1 });
        expect(saved.context.freshnessExecutionEpoch).toBe(epoch);
        const callsBefore = await redis.hgetall(`${prefix}:calls`);
        const values = scenario === "changed" ? [9, 10, 11, 12] : [1, 2, 3, 4];
        const currentValues = epoch === 0 ? [1, 2, 3, 4] : values;
        expect(callsBefore[`${epoch}:${currentValues[0]}`]).toBe("1");
        expect(callsBefore[`${epoch}:${currentValues[1]}`]).toBe("1");
        expect(callsBefore[`${epoch}:${currentValues[2]}`]).toBe("1");
        expect(callsBefore[`${epoch}:${currentValues[3]}`]).toBeUndefined();
        interrupted.worker.kill("SIGKILL");
        await interrupted.worker.exited;
        expect(interrupted.worker.signalCode).toBe("SIGKILL");

        const replacement = spawnWorker(tenant, id, scenario, "finish");
        workers.push(replacement);
        expect(await replacement.message).toEqual({
          kind: "outcome", outcome: { ok: true, value: { kind: "completed", output: currentValues.map((n) => n * 2) } },
        });
        expect(await replacement.worker.exited).toBe(0);
        expect(await replacement.stderr).toBe("");
        const after = await redis.hgetall(nodesKey);
        expect(Object.keys(after).sort()).toEqual([
          ...(epoch === 1 ? [0, 1, 2, 3].map((i) => completion(i, 0)) : []), ...[0, 1, 2, 3].map((i) => completion(i)),
        ].sort());
        expect(after[completion(0)]).toBe(before[completion(0)]);
        expect(after[completion(1)]).toBe(before[completion(1)]);
        expect(await redis.get(metaKey)).toBe(metaBefore);
        const callsAfter = await redis.hgetall(`${prefix}:calls`);
        expect(callsAfter[`${epoch}:${currentValues[0]}`]).toBe("1");
        expect(callsAfter[`${epoch}:${currentValues[1]}`]).toBe("1");
        // Incomplete external work may repeat; completed fan saves do not.
        expect(callsAfter[`${epoch}:${currentValues[2]}`]).toBe("2");
        expect(callsAfter[`${epoch}:${currentValues[3]}`]).toBe("1");
        if (epoch === 1) {
          for (const value of [1, 2, 3, 4]) expect(callsAfter[`0:${value}`]).toBe("1");
          expect(await redis.hget(`${prefix}:reviews`, "output:1")).toBe("[2,4,6,8]");
          expect(await redis.hget(`${prefix}:reviews`, "output:2")).toBe(JSON.stringify(currentValues.map((n) => n * 2)));
        }
        expect(await redis.hget(`${prefix}:scope`, "visits")).toBe(scenario === "changed" || scenario === "same" ? "2" : "1");
        const parentKey = buildCheckpointKey(tenant, root, id, nodeId("fan"));
        expect(parentKey).toBe(`fugue:${tenant}:mapped-root:${id}:fan`);
        expect(fromJson((await redis.get(parentKey))!)).toEqual(currentValues.map((n) => n * 2));
        expect(await redis.get(buildCheckpointKey(tenant, root, id, nodeId("step")))).toBeNull();
        const outputKeys = await redis.keys(`fugue:${tenant}:mapped-root:${id}:fan@step@*`);
        expect(outputKeys.length).toBe(epoch === 1 ? 8 : 4);
        for (const generation of epoch === 1 ? [0, 1] : [0]) {
          const outputs = generation === 0 ? [2, 4, 6, 8] : currentValues.map((n) => n * 2);
          for (const [index, output] of outputs.entries()) {
            const key = buildCheckpointKey(tenant, root, id, nodeId("step"), {
              mapNodeId: nodeId("fan"), index: mapIndex(index), executionEpoch: freshnessExecutionEpoch(generation),
            });
            expect(outputKeys).toContain(key);
            expect(fromJson((await redis.get(key))!)).toBe(output);
          }
        }
        for (const key of [nodesKey, metaKey, parentKey, ...outputKeys]) {
          expect(key.startsWith(`fugue:${tenant}:mapped-root:${id}:`)).toBe(true);
          expect(await redis.ttl(key)).toBeGreaterThan(0);
          expect(await redis.ttl(key)).toBeLessThanOrEqual(CHECKPOINT_TTL_SEC);
        }
        expect(await redis.ttl(checkpointKey)).toBeGreaterThan(CHECKPOINT_TTL_SEC);
        expect(await redis.ttl(checkpointKey)).toBeLessThanOrEqual(RUN_RETENTION_SEC);
      } finally {
        await disposeWorkers(workers, redis, tenant);
      }
    }, 30_000);
  }

  it("SIGKILL after the reroute checkpoint commits but before replacement work restores epoch 1", async () => {
    const redis = new Redis(redisUrl!);
    const tenant = mappedTestTenant(`map-epoch-${crypto.randomUUID()}`);
    const id = runId(crypto.randomUUID());
    const root = dagId("mapped-root");
    const nodesKey = buildCheckpointNodesKey(tenant, root, id);
    const workers: ReturnType<typeof spawnWorker>[] = [];
    try {
      const interrupted = spawnWorker(tenant, id, "committed", "interrupt");
      workers.push(interrupted);
      expect(await interrupted.message).toEqual({ kind: "epoch-committed", epoch: 1 });
      const checkpoint = await redis.get(`fugue:${tenant}:hitl:ckpt:${id}`);
      expect(checkpoint).not.toBeNull();
      const envelope = Envelope.parse(fromJson(checkpoint!));
      expect(envelope.state).toMatchObject({ kind: "running", wave: 0 });
      expect(envelope.context.freshnessExecutionEpoch).toBe(1);
      const oldCompletions = await redis.hgetall(nodesKey);
      expect(Object.keys(oldCompletions).sort()).toEqual([0, 1, 2, 3].map((index) => compositeNodeKey(nodeId("fan"), { index, attempt: 0 })).sort());
      const metaBefore = await redis.get(buildCheckpointMetaKey(tenant, root, id));
      interrupted.worker.kill("SIGKILL");
      await interrupted.worker.exited;
      expect(interrupted.worker.signalCode).toBe("SIGKILL");
      const replacement = spawnWorker(tenant, id, "committed", "finish");
      workers.push(replacement);
      expect(await replacement.message).toEqual({ kind: "outcome", outcome: { ok: true, value: { kind: "completed", output: [18, 20, 22, 24] } } });
      expect(await replacement.worker.exited).toBe(0);
      const completions = await redis.hgetall(nodesKey);
      expect(Object.keys(completions)).toHaveLength(8);
      for (const [key, value] of Object.entries(oldCompletions)) expect(completions[key]).toBe(value);
      expect(await redis.get(buildCheckpointMetaKey(tenant, root, id))).toBe(metaBefore);
      const calls = await redis.hgetall(`fugue:${tenant}:acceptance:${id}:calls`);
      expect(calls).toEqual({ "0:1": "1", "0:2": "1", "0:3": "1", "0:4": "1", "1:9": "1", "1:10": "1", "1:11": "1", "1:12": "1" });
    } finally {
      await disposeWorkers(workers, redis, tenant);
    }
  }, 30_000);
});
