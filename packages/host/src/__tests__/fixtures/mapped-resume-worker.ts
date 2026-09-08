/** Real host executor + Redis run store. Queue acquisition is test-owned, not BullMQ. */
import Redis from "ioredis";
import { z } from "zod";
import { DAG_INPUT, createFetchNode, createMapNode, createTransformNode, defineDag, nodeId, ok, runId, withHumanReview } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { createRedisConnectivity, requireHitlRedisPort } from "../../adapters/redis-connectivity.js";
import { tenantId } from "../../domain/tenant.js";
import { createRunExecutor } from "../../hitl/adapters/run-executor.js";
import { createRedisRunStore } from "../../hitl/adapters/run-store.js";
import { createRunLeaseAuthority } from "../../hitl/ports.js";
import { makeRunStoreJobLike } from "../../hitl/run-store-job.js";
import { tryRunTimestampMs } from "../../hitl/types.js";
import { mappedHostInfra, registeredMapDag, RUN_RETENTION_SEC } from "./mapped-host.js";

const args = z.tuple([z.string(), z.string(), z.enum(["resume", "changed", "same", "fan", "committed"]), z.enum(["interrupt", "finish"])]).parse(process.argv.slice(2));
const [tenantName, rawRun, scenario, mode] = args;
const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const url = z.string().min(1).parse(process.env.REDIS_URL);
const tenant = unwrap(tenantId(tenantName));
const id = runId(rawRun);
const connected = unwrap(await createRedisConnectivity(url));
const observer = new Redis(url);
const markerPrefix = `fugue:${tenant}:acceptance:${id}`;
const externalCallsKey = `${markerPrefix}:calls`;
const scopeKey = `${markerPrefix}:scope`;
const reviewKey = `${markerPrefix}:reviews`;
const reroutedKey = `${markerPrefix}:rerouted`;
const increment = async (key: string, field: string) => {
  const count = await observer.hincrby(key, field, 1);
  await observer.expire(key, RUN_RETENTION_SEC);
  return count;
};
const barrier = async (kind: "prefix" | "epoch-committed", epoch: number): Promise<void> => {
  process.send?.({ kind, epoch });
  await new Promise<void>(() => {});
};
const child = defineDag({
  id: "mapped-child",
  nodes: { step: createFetchNode({
    id: "step", inputSchema: z.number(), outputSchema: z.number(),
    fetch: async (n) => {
      const epoch = await observer.exists(reroutedKey);
      await increment(externalCallsKey, `${epoch}:${n}`);
      const targetEpoch = scenario === "resume" ? 0 : 1;
      const blockedValue = scenario === "changed" && epoch === 1 ? 11 : 3;
      // Sequential fan has acknowledged saves 0 and 1 before entering index 2.
      if (mode === "interrupt" && epoch === targetEpoch && n === blockedValue) await barrier("prefix", epoch);
      return ok(n * 2);
    },
  }) }, edges: [{ from: DAG_INPUT, to: "step" }], outputNodeId: "step",
});
const scope = createFetchNode({
  id: "scope", inputSchema: z.object({}), outputSchema: z.object({ items: z.array(z.number()) }),
  fetch: async () => {
    const visit = await increment(scopeKey, "visits");
    return ok({ items: (scenario === "changed" || scenario === "committed") && visit > 1 ? [9, 10, 11, 12] : [1, 2, 3, 4] });
  },
});
const fan = createMapNode({
  id: "fan", inputSchema: z.object({ items: z.array(z.number()) }), outputSchema: z.array(z.number()),
  widthFrom: "items", maxWidth: 4, child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]),
});
const review = withHumanReview(createTransformNode({
  id: "review", inputSchema: z.array(z.number()), outputSchema: z.array(z.number()), transform: (xs) => ok(xs),
}), { prompt: "Gather then review" });
const dag = defineDag({
  id: "mapped-root", nodes: { scope, fan, review },
  edges: [{ from: DAG_INPUT, to: "scope" }, { from: "scope", to: "fan" }, { from: "fan", to: "review" }], outputNodeId: "review",
});
const registered = registeredMapDag(dag, tenantName);
const authority = createRunLeaseAuthority();
const store = createRedisRunStore(requireHitlRedisPort(connected.redis), tenant, { ttlSec: RUN_RETENTION_SEC }, authority.verifier);
const executor = createRunExecutor({
  sharedInfra: mappedHostInfra(connected.redis), getRegisteredDag: (requested) => requested === dag.id ? registered : undefined,
  tenant, runRetentionTtlSec: RUN_RETENTION_SEC,
});
try {
  let record = unwrap(await store.get(id));
  if (record === null) {
    const now = unwrap(tryRunTimestampMs(Date.now()));
    unwrap(await store.create({
      runId: id, dagId: registered.id, ownerTeam: registered.team, input: {}, identity: { kind: "admin" },
      status: { kind: "queued" }, checkpoint: unwrap(await executor.seedCheckpoint(registered.id, {})), createdAtMs: now, updatedAtMs: now,
    }));
    record = unwrap(await store.get(id));
  }
  if (record === null) throw new Error("Run publication missing");
  // The harness controls acquisition/replacement; production store still checks
  // its issued lease and the actual Redis owner token + execution fence.
  const owner = crypto.randomUUID();
  const signal = new AbortController().signal;
  await observer.set(`fugue:${tenant}:hitl:lock:${id}`, owner, "EX", RUN_RETENTION_SEC);
  const lease = authority.issuer.issue(id, owner, signal);
  const job = unwrap(makeRunStoreJobLike(store, lease, record.checkpoint));
  const outcome = await executor.run({
    runId: id, dagId: registered.id, input: {}, identity: { kind: "admin" }, signal, job,
    onHumanReview: async ({ output }) => {
      const visit = await increment(reviewKey, "visits");
      await observer.hset(reviewKey, `output:${visit}`, JSON.stringify(output));
      if (scenario !== "resume" && visit === 1) return { kind: "reroute", targetNodeId: nodeId(scenario === "fan" ? "fan" : "scope") };
      return { kind: "approve" };
    },
    onDecisionConsumed: async () => {
      await observer.set(reroutedKey, "1", "EX", RUN_RETENTION_SEC);
      if (scenario === "committed" && mode === "interrupt") await barrier("epoch-committed", 1);
    },
  });
  process.send?.({ kind: "outcome", outcome });
} finally {
  await connected.disconnect();
  await observer.quit();
}
