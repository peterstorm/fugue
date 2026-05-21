/**
 * HostState — discriminated union modeling the host lifecycle.
 *
 * All transition functions are PURE — no side effects, no mutations.
 * Invalid transitions return a Result.Err with a TransitionError.
 *
 * @satisfies FR-001 — Supports sync cycle states (syncing → ready)
 * @satisfies NFR-012 — Sync failures transition to degraded, not crash; existing DAGs preserved
 */

import type { Result } from "@fugue/framework";
import { ok, err } from "@fugue/framework";
import type { Registry } from "./registry.js";

// ── Transition Error ───────────────────────────────────────────────────────

/**
 * Error returned when an invalid state transition is attempted.
 * Kept local to this module — callers can widen to HostError at boundaries.
 */
export interface TransitionError {
  readonly kind: "invalid-transition";
  readonly from: string;
  readonly to: string;
  readonly message: string;
}

export const invalidTransition = (from: string, to: string): TransitionError => ({
  kind: "invalid-transition",
  from,
  to,
  message: `Invalid state transition: cannot move from "${from}" to "${to}"`,
});

// ── State ADT ──────────────────────────────────────────────────────────────

export type DegradedReason = "redis-disconnected" | "sync-failed" | "no-dags-loaded";

export type HostState =
  | { readonly phase: "booting"; readonly startedAt: number }
  | { readonly phase: "syncing"; readonly registry: Registry; readonly syncStartedAt: number }
  | { readonly phase: "ready"; readonly registry: Registry; readonly lastSyncAt: number; readonly lastSyncSha: string }
  | { readonly phase: "degraded"; readonly registry: Registry; readonly reason: DegradedReason; readonly since: number }
  | { readonly phase: "draining"; readonly registry: Registry; readonly drainStartedAt: number; readonly inflightCount: number }
  | { readonly phase: "stopped" };

// ── Constructors ───────────────────────────────────────────────────────────

export const booting = (now: number): HostState => ({
  phase: "booting",
  startedAt: now,
});

// ── Transitions (pure) ─────────────────────────────────────────────────────

/**
 * Boot complete: host has performed initial sync and loaded DAGs.
 * Valid from: booting
 */
export const bootComplete = (
  state: HostState,
  registry: Registry,
  sha: string,
  now: number,
): Result<HostState, TransitionError> => {
  if (state.phase !== "booting") {
    return err(invalidTransition(state.phase, "ready"));
  }
  return ok({
    phase: "ready" as const,
    registry,
    lastSyncAt: now,
    lastSyncSha: sha,
  });
};

/**
 * Sync started: host is polling git for new commits.
 * Valid from: ready, degraded
 */
export const syncStarted = (
  state: HostState,
  now: number,
): Result<HostState, TransitionError> => {
  switch (state.phase) {
    case "ready":
      return ok({
        phase: "syncing" as const,
        registry: state.registry,
        syncStartedAt: now,
      });
    case "degraded":
      return ok({
        phase: "syncing" as const,
        registry: state.registry,
        syncStartedAt: now,
      });
    default:
      return err(invalidTransition(state.phase, "syncing"));
  }
};

/**
 * Sync completed successfully: new registry loaded from git.
 * Valid from: syncing
 */
export const syncCompleted = (
  state: HostState,
  registry: Registry,
  sha: string,
  now: number,
): Result<HostState, TransitionError> => {
  if (state.phase !== "syncing") {
    return err(invalidTransition(state.phase, "ready"));
  }
  return ok({
    phase: "ready" as const,
    registry,
    lastSyncAt: now,
    lastSyncSha: sha,
  });
};

/**
 * Sync failed: could not pull from git or load DAGs.
 * Valid from: syncing
 * Preserves existing registry — NFR-012.
 */
export const syncFailed = (
  state: HostState,
  now: number,
): Result<HostState, TransitionError> => {
  if (state.phase !== "syncing") {
    return err(invalidTransition(state.phase, "degraded"));
  }
  return ok({
    phase: "degraded" as const,
    registry: state.registry,
    reason: "sync-failed" as const,
    since: now,
  });
};

/**
 * Begin graceful drain: stop accepting new requests, wait for inflight to complete.
 * Valid from: ready, degraded, syncing
 */
export const beginDrain = (
  state: HostState,
  inflightCount: number,
  now: number,
): Result<HostState, TransitionError> => {
  if (state.phase === "booting" || state.phase === "stopped" || state.phase === "draining") {
    return err(invalidTransition(state.phase, "draining"));
  }
  return ok({
    phase: "draining" as const,
    registry: state.registry,
    drainStartedAt: now,
    inflightCount,
  });
};

/**
 * Drain complete: all inflight requests finished, host can stop.
 * Valid from: draining
 */
export const drainComplete = (
  state: HostState,
): Result<HostState, TransitionError> => {
  if (state.phase !== "draining") {
    return err(invalidTransition(state.phase, "stopped"));
  }
  return ok({ phase: "stopped" as const });
};

/**
 * Redis connection lost.
 * Valid from: ready, syncing
 */
export const redisDied = (
  state: HostState,
  now: number,
): Result<HostState, TransitionError> => {
  switch (state.phase) {
    case "ready":
      return ok({
        phase: "degraded" as const,
        registry: state.registry,
        reason: "redis-disconnected" as const,
        since: now,
      });
    case "syncing":
      return ok({
        phase: "degraded" as const,
        registry: state.registry,
        reason: "redis-disconnected" as const,
        since: now,
      });
    default:
      return err(invalidTransition(state.phase, "degraded"));
  }
};

/**
 * Redis connection recovered.
 * Valid from: degraded (with reason redis-disconnected)
 */
export const redisRecovered = (
  state: HostState,
  now: number,
): Result<HostState, TransitionError> => {
  if (state.phase !== "degraded") {
    return err(invalidTransition(state.phase, "ready"));
  }
  if (state.reason !== "redis-disconnected") {
    return err(invalidTransition(`degraded:${state.reason}`, "ready"));
  }
  return ok({
    phase: "ready" as const,
    registry: state.registry,
    lastSyncAt: now,
    lastSyncSha: "",
  });
};

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Extract the registry from any state that has one.
 * Booting and stopped states have no registry.
 */
export const getRegistry = (state: HostState): Registry | undefined => {
  switch (state.phase) {
    case "booting":
    case "stopped":
      return undefined;
    default:
      return state.registry;
  }
};

/**
 * Check if the host is in a state that can serve requests.
 */
export const canServeRequests = (state: HostState): boolean =>
  state.phase === "ready" || state.phase === "degraded" || state.phase === "syncing";
