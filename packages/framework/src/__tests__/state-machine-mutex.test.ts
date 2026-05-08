import { describe, it, expect } from "bun:test";
import { AsyncMutex } from "../state-machine/mutex.js";

describe("AsyncMutex", () => {
  it("starts unlocked", () => {
    const m = new AsyncMutex();
    expect(m.isLocked).toBe(false);
  });

  it("locks while held and unlocks on release", async () => {
    const m = new AsyncMutex();
    const release = await m.acquire();
    expect(m.isLocked).toBe(true);
    release();
    // After release the lock should be free again (allow microtask)
    await Promise.resolve();
    expect(m.isLocked).toBe(false);
  });

  it("only one holder at a time", async () => {
    const m = new AsyncMutex();
    const release1 = await m.acquire();
    expect(m.isLocked).toBe(true);

    let holder2Started = false;
    const p2 = m.acquire().then((release2) => {
      holder2Started = true;
      return release2;
    });

    // release1 has not been called yet — holder2 must not have started
    expect(holder2Started).toBe(false);

    release1();
    const release2 = await p2;
    expect(holder2Started).toBe(true);
    expect(m.isLocked).toBe(true);
    release2();
    await Promise.resolve();
    expect(m.isLocked).toBe(false);
  });

  it("resolves waiters in FIFO order (FR-009)", async () => {
    const m = new AsyncMutex();
    const order: number[] = [];

    // Acquire the lock first so the other acquires queue up
    const releaseFirst = await m.acquire();

    const promises = [1, 2, 3].map((id) =>
      m.acquire().then(async (release) => {
        order.push(id);
        release();
      }),
    );

    // Queue lengths should grow
    expect(m.queueLength).toBe(3);

    // Release the initial lock; FIFO means 1 -> 2 -> 3
    releaseFirst();
    await Promise.all(promises);

    expect(order).toEqual([1, 2, 3]);
  });

  it("handles concurrent acquire/release cycles", async () => {
    const m = new AsyncMutex();
    const results: number[] = [];

    const task = async (id: number) => {
      const release = await m.acquire();
      results.push(id);
      await Promise.resolve(); // yield inside critical section
      release();
    };

    await Promise.all([0, 1, 2, 3, 4].map(task));
    // All tasks completed
    expect(results.length).toBe(5);
    // Each id appears exactly once
    expect(new Set(results).size).toBe(5);
  });
});
