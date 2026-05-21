/**
 * Property tests for host-state state machine.
 *
 * Invariants:
 * 1. Registry is never lost during valid transitions (NFR-012)
 * 2. canServeRequests agrees with phase membership
 * 3. Invalid transitions always return err with correct from/to
 * 4. getRegistry returns undefined only for booting/stopped
 */

import { describe, it } from "bun:test";
import * as fc from "fast-check";
import { dagId } from "@fugue/framework";
import type { DagDef } from "@fugue/framework";
import { z } from "zod";
import type { HostState } from "../domain/host-state.js";
import {
  booting,
  bootComplete,
  syncStarted,
  syncCompleted,
  syncFailed,
  beginDrain,
  drainComplete,
  redisDied,
  redisRecovered,
  getRegistry,
  canServeRequests,
} from "../domain/host-state.js";
import type { Registry, RegisteredDag } from "../domain/registry.js";
import { freeze, emptyRegistry } from "../domain/registry.js";

// ── Arbitraries ────────────────────────────────────────────────────────────

const arbTimestamp = fc.nat({ max: 2_000_000_000_000 });
const arbSha = fc.stringMatching(/^[0-9a-f]{7,40}$/);

const testRegistry: Registry = freeze([], "abc1234", Date.now());

// ── Tests ──────────────────────────────────────────────────────────────────

describe("host-state property tests", () => {
  it("booting → bootComplete → ready always succeeds", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, arbTimestamp, (bootTime, sha, readyTime) => {
        const state = booting(bootTime);
        const result = bootComplete(state, testRegistry, sha, readyTime);
        return result.ok === true && result.value.phase === "ready";
      }),
    );
  });

  it("ready → syncStarted → syncCompleted → ready preserves registry capability", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, arbTimestamp, arbSha, arbTimestamp, (t1, sha1, t2, sha2, t3) => {
        const state = booting(0);
        const readyResult = bootComplete(state, testRegistry, sha1, t1);
        if (!readyResult.ok) return false;

        const syncResult = syncStarted(readyResult.value, t2);
        if (!syncResult.ok) return false;

        const completeResult = syncCompleted(syncResult.value, testRegistry, sha2, t3);
        if (!completeResult.ok) return false;

        return completeResult.value.phase === "ready" && canServeRequests(completeResult.value);
      }),
    );
  });

  it("ready → syncStarted → syncFailed → degraded preserves registry (NFR-012)", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, arbTimestamp, arbTimestamp, (t1, sha, t2, t3) => {
        const state = booting(0);
        const readyResult = bootComplete(state, testRegistry, sha, t1);
        if (!readyResult.ok) return false;

        const syncResult = syncStarted(readyResult.value, t2);
        if (!syncResult.ok) return false;

        const failResult = syncFailed(syncResult.value, t3);
        if (!failResult.ok) return false;

        const registry = getRegistry(failResult.value);
        // Registry must still be present after sync failure
        return registry !== undefined && failResult.value.phase === "degraded";
      }),
    );
  });

  it("canServeRequests is true exactly for ready, degraded, syncing", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, (t, sha) => {
        const bootState = booting(t);
        const readyResult = bootComplete(bootState, testRegistry, sha, t + 1);
        if (!readyResult.ok) return false;
        const readyState = readyResult.value;

        const syncResult = syncStarted(readyState, t + 2);
        if (!syncResult.ok) return false;
        const syncingState = syncResult.value;

        const failResult = syncFailed(syncingState, t + 3);
        if (!failResult.ok) return false;
        const degradedState = failResult.value;

        return (
          canServeRequests(bootState) === false &&
          canServeRequests(readyState) === true &&
          canServeRequests(syncingState) === true &&
          canServeRequests(degradedState) === true
        );
      }),
    );
  });

  it("getRegistry returns undefined only for booting and stopped", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, (t, sha) => {
        const bootState = booting(t);
        const readyResult = bootComplete(bootState, testRegistry, sha, t + 1);
        if (!readyResult.ok) return false;

        const drainResult = beginDrain(readyResult.value, 0, t + 2);
        if (!drainResult.ok) return false;

        const stoppedResult = drainComplete(drainResult.value);
        if (!stoppedResult.ok) return false;

        return (
          getRegistry(bootState) === undefined &&
          getRegistry(readyResult.value) !== undefined &&
          getRegistry(drainResult.value) !== undefined &&
          getRegistry(stoppedResult.value) === undefined
        );
      }),
    );
  });

  it("syncFailed preserves lastSuccessfulSyncAt from ready state", () => {
    fc.assert(
      fc.property(arbTimestamp, arbSha, arbTimestamp, arbTimestamp, (readyAt, sha, syncAt, failAt) => {
        const state = booting(0);
        const readyResult = bootComplete(state, testRegistry, sha, readyAt);
        if (!readyResult.ok) return false;

        const syncResult = syncStarted(readyResult.value, syncAt);
        if (!syncResult.ok) return false;

        const failResult = syncFailed(syncResult.value, failAt);
        if (!failResult.ok) return false;

        // degraded.lastSyncAt should be the last SUCCESSFUL sync time, not the failed sync start
        if (failResult.value.phase !== "degraded") return false;
        return failResult.value.lastSyncAt === readyAt;
      }),
    );
  });

  it("invalid transitions always produce err with from/to info", () => {
    fc.assert(
      fc.property(arbTimestamp, (t) => {
        const bootState = booting(t);
        // Can't sync from booting
        const result = syncStarted(bootState, t + 1);
        return !result.ok && result.error.from === "booting" && result.error.to === "syncing";
      }),
    );
  });
});
