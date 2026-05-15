import { describe, it, expect } from "bun:test";
import { createInMemoryJob } from "../queue/in-memory-job.js";

describe("createInMemoryJob — appendEvent dedup", () => {
  it("appends when no dedupKey is supplied", async () => {
    const job = createInMemoryJob({ state: "x", context: {} });
    await job.appendEvent({ type: "A" });
    await job.appendEvent({ type: "A" });
    expect(job.events).toHaveLength(2);
  });

  it("appends when dedupKeys differ", async () => {
    const job = createInMemoryJob({ state: "x", context: {} });
    await job.appendEvent({ type: "A" }, "k1");
    await job.appendEvent({ type: "B" }, "k2");
    expect(job.events).toHaveLength(2);
  });

  it("dedups two consecutive calls with the same dedupKey to one entry", async () => {
    const job = createInMemoryJob({ state: "x", context: {} });
    await job.appendEvent({ type: "A" }, "k1");
    await job.appendEvent({ type: "A" }, "k1");
    expect(job.events).toHaveLength(1);
  });

  it("dedup tracks all seen keys, not just the most recent", async () => {
    const job = createInMemoryJob({ state: "x", context: {} });
    await job.appendEvent({ type: "A" }, "k1");
    await job.appendEvent({ type: "B" }, "k2");
    await job.appendEvent({ type: "A" }, "k1"); // already seen — deduped
    expect(job.events).toHaveLength(2);
  });

  it("a genuinely new key after multiple appends is still accepted", async () => {
    const job = createInMemoryJob({ state: "x", context: {} });
    await job.appendEvent({ type: "A" }, "k1");
    await job.appendEvent({ type: "B" }, "k2");
    await job.appendEvent({ type: "C" }, "k3"); // new key — accepted
    expect(job.events).toHaveLength(3);
  });
});
