/**
 * HostState — discriminated union modeling the host lifecycle.
 *
 * All transition functions are PURE — no side effects, no mutations.
 * Invalid transitions return a Result.Err with a TransitionError.
 *
 * @satisfies FR-001 — Supports sync cycle states (syncing → ready)
 * @satisfies NFR-012 — Sync failures transition to degraded, not crash; existing DAGs preserved
 */

import { match, P } from "ts-pattern";
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
  | { readonly phase: "syncing"; readonly registry: Registry; readonly syncStartedAt: number; readonly lastSyncSha: string }
  | { readonly phase: "ready"; readonly registry: Registry; readonly lastSyncAt: number; readonly lastSyncSha: string }
  | { readonly phase: "degraded"; readonly registry: Registry; readonly reason: DegradedReason; readonly since: number; readonly lastSyncSha: string; readonly lastSyncAt: number }
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
): Result<HostState, TransitionError> =>
  match(state)
    .with({ phase: "ready" }, (s) =>
      ok({
        phase: "syncing" as const,
        registry: s.registry,
        syncStartedAt: now,
        lastSyncSha: s.lastSyncSha,
      }),
    )
    .with({ phase: "degraded" }, (s) =>
      ok({
        phase: "syncing" as const,
        registry: s.registry,
        syncStartedAt: now,
        lastSyncSha: s.lastSyncSha,
      }),
    )
    .otherwise((s) => err(invalidTransition(s.phase, "syncing")));

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
    lastSyncSha: state.lastSyncSha,
    lastSyncAt: state.syncStartedAt,
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
): Result<HostState, TransitionError> =>
  match(state)
    .with({ phase: "ready" }, (s) =>
      ok({
        phase: "degraded" as const,
        registry: s.registry,
        reason: "redis-disconnected" as const,
        since: now,
        lastSyncSha: s.lastSyncSha,
        lastSyncAt: s.lastSyncAt,
      }),
    )
    .with({ phase: "syncing" }, (s) =>
      ok({
        phase: "degraded" as const,
        registry: s.registry,
        reason: "redis-disconnected" as const,
        since: now,
        lastSyncSha: s.lastSyncSha,
        lastSyncAt: s.syncStartedAt,
      }),
    )
    .otherwise((s) => err(invalidTransition(s.phase, "degraded")));

/**
 * Redis connection recovered.
 * Valid from: degraded (with reason redis-disconnected)
 * Restores lastSyncSha/lastSyncAt from the degraded state — avoids forcing unnecessary resync.
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
    lastSyncAt: state.lastSyncAt,
    lastSyncSha: state.lastSyncSha,
  });
};

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Extract the registry from any state that has one.
 * Booting and stopped states have no registry.
 */
export const getRegistry = (state: HostState): Registry | undefined =>
  match(state)
    .with({ phase: "booting" }, () => undefined)
    .with({ phase: "stopped" }, () => undefined)
    .with({ phase: "ready" }, (s) => s.registry)
    .with({ phase: "syncing" }, (s) => s.registry)
    .with({ phase: "degraded" }, (s) => s.registry)
    .with({ phase: "draining" }, (s) => s.registry)
    .exhaustive();

/**
 * Check if the host is in a state that can serve requests.
 */
export const canServeRequests = (state: HostState): boolean =>
  match(state)
    .with({ phase: "ready" }, () => true)
    .with({ phase: "degraded" }, () => true)
    .with({ phase: "syncing" }, () => true)
    .with({ phase: "booting" }, () => false)
    .with({ phase: "draining" }, () => false)
    .with({ phase: "stopped" }, () => false)
    .exhaustive();
