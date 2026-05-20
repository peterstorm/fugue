/**
 * Unit tests for queue-bullmq/job.ts — adaptBullMQJob with mocked BullMQ Job.
 * Verifies error wrapping, updateData/updateProgress/appendEvent behavior.
 * No live Redis required.
 */

import { describe, test, expect, mock } from "bun:test";
import { adaptBullMQJob } from "../queue-bullmq/job.js";

// ---------------------------------------------------------------------------
// Mock BullMQ Job
// ---------------------------------------------------------------------------

function createMockJob(data: unknown) {
  return {
    id: "job-123",
    data,
    updateData: mock(async (_data: unknown) => {}),
    updateProgress: mock(async (_pct: number) => {}),
  };
}

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(opts?: { scriptLoadThrows?: boolean; evalshaThrows?: boolean }) {
  const scriptResult = "abc123sha";
  return {
    script: mock(async (..._args: unknown[]) => {
      if (opts?.scriptLoadThrows) throw new Error("ECONNREFUSED");
      return scriptResult;
    }),
    evalsha: mock(async (..._args: unknown[]) => {
      if (opts?.evalshaThrows) throw new Error("NOSCRIPT No matching script");
      return "1715200000000-0";
    }),
    eval: mock(async (..._args: unknown[]) => "1715200000000-0"),
  };
}

describe("adaptBullMQJob — unit tests (mocked BullMQ)", () => {
  test("updateData delegates to bullJob.update with serialized state+context", async () => {
    const mockJob = createMockJob({ state: "initial", context: {} });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await job.updateData({ state: "running", context: { foo: "bar" } });

    expect(mockJob.updateData).toHaveBeenCalledTimes(1);
    const callArg = (mockJob.updateData as any).mock.calls[0][0];
    expect(callArg.state).toBe("running");
    expect(callArg.context.foo).toBe("bar");
  });

  test("updateData wraps BullMQ errors with context", async () => {
    const mockJob = createMockJob({ state: "initial", context: {} });
    mockJob.updateData = mock(async () => { throw new Error("Redis timeout"); });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await expect(job.updateData({ state: "x", context: {} })).rejects.toThrow(
      /updateData failed.*Redis timeout/,
    );
  });

  test("updateProgress delegates to bullJob.updateProgress", async () => {
    const mockJob = createMockJob({ state: "s", context: {} });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await job.updateProgress(75);

    expect(mockJob.updateProgress).toHaveBeenCalledWith(75);
  });

  test("updateProgress wraps errors with context", async () => {
    const mockJob = createMockJob({ state: "s", context: {} });
    mockJob.updateProgress = mock(async () => { throw new Error("ECONNRESET"); });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await expect(job.updateProgress(50)).rejects.toThrow(
      /updateProgress failed.*ECONNRESET/,
    );
  });

  test("appendEvent performs SCRIPT LOAD + EVALSHA on first call", async () => {
    const mockJob = createMockJob({ state: "s", context: {} });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await job.appendEvent({ type: "wave-done" }, "dedup-key-1");

    expect(mockRedis.script).toHaveBeenCalledTimes(1);
    expect(mockRedis.evalsha).toHaveBeenCalledTimes(1);
    // stream key should be events:test-queue:job-123
    const evalshaArgs = (mockRedis.evalsha as any).mock.calls[0];
    expect(evalshaArgs[0]).toBe("abc123sha"); // sha
    expect(evalshaArgs[2]).toContain("events:test-queue:job-123"); // stream key
  });

  test("appendEvent NOSCRIPT fallback uses inline EVAL", async () => {
    const mockJob = createMockJob({ state: "s", context: {} });
    const mockRedis = createMockRedis({ evalshaThrows: true });
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "test-queue");

    await job.appendEvent({ type: "node-failed" });

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  test("appendEvent wraps Redis errors with stream key context", async () => {
    const mockJob = createMockJob({ state: "s", context: {} });
    const mockRedis = createMockRedis();
    mockRedis.evalsha = mock(async () => { throw new Error("OOM"); });
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "q");

    await expect(job.appendEvent({ type: "start" })).rejects.toThrow(
      /appendEvent failed.*stream.*OOM/,
    );
  });

  test("data property returns deserialized state+context from BullMQ job", () => {
    const mockJob = createMockJob({ state: { kind: "pending" }, context: { outputs: {} } });
    const mockRedis = createMockRedis();
    const job = adaptBullMQJob(mockJob as any, mockRedis as any, "q");

    expect(job.data.state).toEqual({ kind: "pending" });
    expect(job.data.context).toEqual({ outputs: {} });
  });
});
