/**
 * Sync Callbacks — Extracted state-machine transition logic for sync loop events.
 *
 * These callbacks are wired into the sync loop by the imperative shell (host.ts).
 * Extracted here for:
 * - Testability: each callback can be unit tested without booting the full host
 * - Clarity: host.ts wiring is concise, transition logic is colocated
 *
 * All callbacks guard against draining/stopped states — sync events are
 * ignored once shutdown has begun.
 */

import type { DagId, GitSha } from "@fugue/framework";
import type { Registry } from "../domain/registry.js";
import type { HostState } from "../domain/host-state.js";
import { syncStarted, syncCompleted, syncFailed, getRegistry } from "../domain/host-state.js";
import type { CircuitState } from "../domain/circuit-breaker.js";
import { forceReset } from "../domain/circuit-breaker.js";
import { diffDags, diffSummary } from "../domain/dag-diff.js";
import type { HostError } from "../domain/host-error.js";
import type { LogPort } from "../ports.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SyncCallbackDeps {
  readonly getState: () => HostState;
  readonly setState: (s: HostState) => void;
  readonly getCircuitBreakers: () => Map<DagId, CircuitState>;
  readonly logger: LogPort;
  readonly clock: () => number;
}

export interface SyncCallbacks {
  readonly onStarted: () => void;
  readonly onComplete: (registry: Registry, sha: GitSha) => void;
  readonly onNoChange: (sha: GitSha) => void;
  readonly onError: (error: HostError) => void;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create sync loop callbacks wired to the host state machine.
 *
 * Guards:
 * - All callbacks check for draining/stopped and bail early
 * - State transition failures are logged but don't crash
 */
export const createSyncCallbacks = (deps: SyncCallbackDeps): SyncCallbacks => {
  const { getState, setState, getCircuitBreakers, logger, clock } = deps;

  const isShuttingDown = (): boolean => {
    const phase = getState().phase;
    return phase === "draining" || phase === "stopped";
  };

  return {
    onStarted: () => {
      if (isShuttingDown()) {
        logger.info("Ignoring sync start — host is shutting down", { phase: getState().phase });
        return;
      }
      const result = syncStarted(getState(), clock());
      if (result.ok) {
        setState(result.value);
      } else {
        logger.warn("syncStarted transition failed", {
          currentPhase: getState().phase,
          error: result.error.message,
        });
      }
    },

    onComplete: (newRegistry, newSha) => {
      if (isShuttingDown()) {
        logger.info("Ignoring sync completion — host is shutting down", { phase: getState().phase });
        return;
      }

      // Capture previous registry BEFORE state transition for accurate diff
      const prevRegistry = getRegistry(getState());
      const prevDags = prevRegistry
        ? Array.from(prevRegistry.dags.values()).map(d => ({ id: d.id, path: d.route, sha: d.sha }))
        : [];

      const result = syncCompleted(getState(), newRegistry, newSha, clock());
      if (result.ok) {
        setState(result.value);

        // Update circuit breakers for the new registry
        const circuitBreakers = getCircuitBreakers();
        const currentDagIds = new Set(newRegistry.dags.keys());
        for (const dagId of circuitBreakers.keys()) {
          if (!currentDagIds.has(dagId)) {
            circuitBreakers.delete(dagId);
          }
        }
        // Force-reset circuit breakers for current DAGs (FR-092)
        const now = clock();
        for (const dagId of currentDagIds) {
          circuitBreakers.set(dagId, forceReset(now));
        }

        // Compute and log diff between previous and new registry
        const newDags = Array.from(newRegistry.dags.values()).map(d => ({ id: d.id, path: d.route, sha: d.sha }));
        const diff = diffDags(prevDags, newDags);

        logger.info("Registry updated via sync", {
          dagCount: newRegistry.dags.size,
          sha: newSha,
          diff: diffSummary(diff),
        });

        // Warn about DAGs with unresolvable team
        for (const dag of newRegistry.dags.values()) {
          if (dag.team === "unknown") {
            logger.warn(`DAG '${dag.id}' has team 'unknown' — path does not follow dags/{team}/{name}/dag.ts convention`, {
              dagId: dag.id,
              route: dag.route,
            });
          }
        }
      } else {
        logger.warn("syncCompleted transition failed — registry NOT updated, circuit breakers unchanged", {
          currentPhase: getState().phase,
          error: result.error.message,
        });
      }
    },

    onNoChange: (unchangedSha) => {
      if (isShuttingDown()) return;
      const currentRegistry = getRegistry(getState());
      if (!currentRegistry) return; // shouldn't happen from syncing state
      const result = syncCompleted(getState(), currentRegistry, unchangedSha, clock());
      if (result.ok) {
        setState(result.value);
      } else {
        logger.warn("syncCompleted (no-change) transition failed", {
          currentPhase: getState().phase,
          error: result.error.message,
        });
      }
    },

    onError: (error) => {
      if (isShuttingDown()) {
        logger.info("Ignoring sync error — host is shutting down", { phase: getState().phase });
        return;
      }

      const result = syncFailed(getState(), clock());
      if (result.ok) {
        setState(result.value);
      } else {
        logger.warn("syncFailed transition failed — state machine violation", {
          currentPhase: getState().phase,
          error: result.error.message,
        });
      }
      logger.warn("Sync error — existing DAGs remain active", { error });
    },
  };
};
