import { describe, expect, it } from "bun:test";
import type { QueueBackend } from "@fuguejs/framework";
import { closeHitlQueueBackend, createHitlQueueBackend } from "../queue-backend.js";

const fakeBackend = (close: () => Promise<void> = async () => {}): QueueBackend =>
  ({ close }) as unknown as QueueBackend;

describe("HITL queue backend wiring", () => {
  it("does not load BullMQ when neither Teams transport is configured", async () => {
    let loads = 0;
    const result = await createHitlQueueBackend(
      { REDIS_URL: "redis://localhost" },
      { info: () => {} },
      async () => {
        loads += 1;
        return () => fakeBackend();
      },
    );
    expect(result).toBeUndefined();
    expect(loads).toBe(0);
  });

  for (const transport of ["TEAMS_WEBHOOK_URL", "BOT_APP_ID"] as const) {
    it(`constructs one backend when ${transport} is configured`, async () => {
      const info: string[] = [];
      const urls: string[] = [];
      const backend = fakeBackend();
      const result = await createHitlQueueBackend(
        { REDIS_URL: "redis://queue", [transport]: "configured" },
        { info: (message) => { info.push(message); } },
        async () => (url) => {
          urls.push(url);
          return backend;
        },
      );
      expect(result).toBe(backend);
      expect(urls).toEqual(["redis://queue"]);
      expect(info).toEqual(["HITL queue backend (BullMQ) constructed"]);
    });
  }

  it("closes a configured backend", async () => {
    let closes = 0;
    await closeHitlQueueBackend(fakeBackend(async () => { closes += 1; }), { error: () => {} });
    expect(closes).toBe(1);
  });

  it("logs and contains close failure", async () => {
    const errors: Array<{ readonly message: string; readonly data?: Record<string, unknown> }> = [];
    await expect(closeHitlQueueBackend(
      fakeBackend(async () => { throw new Error("redis close failed"); }),
      { error: (message, data) => { errors.push({ message, data }); } },
    )).resolves.toBeUndefined();
    expect(errors).toEqual([{
      message: "Failed to close HITL queue backend",
      data: { error: "redis close failed" },
    }]);
  });

  it("contains hostile close failures even when rendering and logging both throw", async () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "message", { get: () => { throw new Error("message trap"); } });
    Object.defineProperty(hostile, "toString", { value: () => { throw new Error("string trap"); } });

    await expect(closeHitlQueueBackend(
      fakeBackend(async () => { throw hostile; }),
      { error: () => { throw new Error("logger trap"); } },
    )).resolves.toBeUndefined();
  });
});
