import { describe, expect, it } from "bun:test";
import { dagId, gitSha } from "@fuguejs/framework";
import type { DagId } from "@fuguejs/framework";
import { initConcurrency } from "../domain/concurrency.js";
import type { CircuitState } from "../domain/circuit-breaker.js";
import { forceReset } from "../domain/circuit-breaker.js";
import { bootComplete, booting, syncStarted } from "../domain/host-state.js";
import type { HostState } from "../domain/host-state.js";
import { freeze } from "../domain/registry.js";
import type { LogPort } from "../ports.js";
import { createSyncCallbacks } from "../sync/sync-callbacks.js";

const SHA = gitSha("abc123");

const makeHarness = (initial: HostState) => {
  let state = initial;
  const errors: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
  const logger: LogPort = {
    info: () => {},
    warn: () => {},
    error: (message, context) => { errors.push({ message, context }); },
  };
  const callbacks = createSyncCallbacks({
    getState: () => state,
    setState: (next) => { state = next; },
    getCircuitBreakers: () => new Map<DagId, CircuitState>(),
    getConcurrency: () => initConcurrency(),
    setConcurrency: () => {},
    logger,
    clock: () => 200,
  });
  return { callbacks, errors, state: () => state };
};

describe("createSyncCallbacks.onNoChange", () => {
  it("surfaces a no-registry state as an invariant violation instead of returning silently", () => {
    const harness = makeHarness(booting(100));

    harness.callbacks.onNoChange(SHA);

    expect(harness.state().phase).toBe("booting");
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.message).toContain("invariant violated");
    expect(harness.errors[0]?.context).toMatchObject({ currentPhase: "booting", sha: SHA });
  });

  it("completes a valid syncing state with its existing registry", () => {
    const registry = freeze([], SHA, 100);
    const ready = bootComplete(booting(0), registry, SHA, 100);
    if (!ready.ok) throw new Error("expected ready fixture");
    const syncing = syncStarted(ready.value, 150);
    if (!syncing.ok) throw new Error("expected syncing fixture");
    const harness = makeHarness(syncing.value);

    harness.callbacks.onNoChange(SHA);

    expect(harness.state().phase).toBe("ready");
    expect(harness.errors).toHaveLength(0);
  });

  it("a failed syncCompleted transition runs NO registry side effects (success-only gate)", () => {
    // A READY state is not 'syncing', so syncCompleted refuses the transition.
    const registry = freeze([], SHA, 100);
    const ready = bootComplete(booting(0), registry, SHA, 100);
    if (!ready.ok) throw new Error("expected ready fixture");

    let state = ready.value;
    const infos: string[] = [];
    const warns: string[] = [];
    const logger: LogPort = {
      info: (message) => { infos.push(message); },
      warn: (message) => { warns.push(message); },
      error: () => {},
    };
    // Seed one breaker entry and a concurrency write counter: the success-only
    // gate means a refused transition must touch NEITHER.
    const breakers = new Map<DagId, CircuitState>([[dagId("some-dag"), forceReset(0)]]);
    const breakersBefore = new Map(breakers);
    let concurrencyWrites = 0;
    const callbacks = createSyncCallbacks({
      getState: () => state,
      setState: (next) => { state = next; },
      getCircuitBreakers: () => breakers,
      getConcurrency: () => initConcurrency(),
      setConcurrency: () => { concurrencyWrites++; },
      logger,
      clock: () => 200,
    });

    callbacks.onComplete(registry, SHA);

    expect(state.phase).toBe("ready"); // no transition
    expect([...breakers.entries()]).toEqual([...breakersBefore.entries()]); // circuit breakers unchanged
    expect(concurrencyWrites).toBe(0); // limiter untouched
    expect(infos.some((m) => m.includes("Registry updated"))).toBe(false); // no side-effect log
    expect(warns.some((m) => m.includes("syncCompleted transition failed"))).toBe(true);
  });
});
