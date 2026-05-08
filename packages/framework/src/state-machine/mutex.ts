// AsyncMutex — FIFO acquire semantics — FR-009

/**
 * A mutual-exclusion lock for async code that resolves waiters in FIFO order.
 *
 * Usage:
 *   const mutex = new AsyncMutex();
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 */
export class AsyncMutex {
  private _locked = false;
  /** Each waiter is the resolve fn of their Promise<() => void> */
  private readonly _queue: Array<(release: () => void) => void> = [];

  /**
   * Acquire the lock. Returns a release function.
   * Callers are queued in submission order (FIFO).
   */
  acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve(() => this._release());
    }

    // Lock is held — enqueue this waiter
    return new Promise<() => void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      // Hand lock directly to the next waiter — stays locked
      next(() => this._release());
    } else {
      this._locked = false;
    }
  }

  /** True if the lock is currently held. */
  get isLocked(): boolean {
    return this._locked;
  }

  /** Number of waiters queued behind the current holder. */
  get queueLength(): number {
    return this._queue.length;
  }
}
