/**
 * Immutable Registry — holds the current set of loaded DAGs.
 *
 * Key invariant: Once frozen, a Registry is never mutated.
 * New sync → new Registry instance. Builders are pure functions
 * that return fresh objects every time.
 *
 * @satisfies FR-004 — Only validated DAGs appear in the registry
 * @satisfies FR-007 — Each DAG version identified by git commit SHA
 * @satisfies NFR-010 — Failing DAG import cannot corrupt existing registry
 */

import type { DagId, DagDef, GitSha } from "@fuguejs/framework";
import type { z } from "zod";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-DAG configuration — fully resolved at registration time.
 *
 * `timeout`, `maxConcurrency`, `cacheTtlMs`, and `checkpointTtlMs` are always
 * populated (per-DAG override merged with the host default in dag-factory).
 *
 * `circuitBreaker` is a PARTIAL override, present only when the DAG declares one;
 * run-dag merges each declared field over the host-level CIRCUIT_BREAKER_* config.
 */
export interface ResolvedDagConfig {
  readonly timeout: number;
  readonly maxConcurrency: number;
  readonly cacheTtlMs: number;
  readonly checkpointTtlMs: number;
  readonly circuitBreaker?: {
    readonly failureThreshold?: number;
    readonly resetTimeoutMs?: number;
  };
}

/**
 * DAG health status — discriminated union prevents impossible states
 * (e.g., healthy with a disabledReason).
 */
export type DagStatus =
  | { readonly kind: "healthy" }
  | { readonly kind: "disabled"; readonly reason: string };

/**
 * A DAG that has been validated, loaded, and registered in the host.
 */
export interface RegisteredDag {
  readonly id: DagId;
  readonly team: string;
  readonly route: string;
  readonly dag: DagDef;
  readonly inputSchema: z.ZodType;
  readonly config: ResolvedDagConfig;
  readonly meta: { readonly description: string; readonly version: string; readonly owner?: string };
  readonly loadedAt: number;
  readonly sha: GitSha;
  readonly status: DagStatus;
  /** Absolute filesystem path of the dag.ts module that was imported. */
  readonly modulePath: string;
  /** Pre-loaded prompt templates keyed by name (loaded from sibling prompts/ dir). */
  readonly prompts: ReadonlyMap<string, string>;
}

/**
 * Immutable snapshot of all loaded DAGs at a point in time.
 *
 * `sha` is `null` only for the pre-boot empty registry ("never synced"); every
 * registry produced by `freeze`/sync carries a real GitSha.
 */
export interface Registry {
  readonly dags: ReadonlyMap<DagId, RegisteredDag>;
  readonly loadedAt: number;
  readonly sha: GitSha | null;
}

// ── Builders (pure) ────────────────────────────────────────────────────────

/**
 * Create an empty registry with no loaded DAGs.
 */
export const emptyRegistry = (): Registry => Object.freeze({
  dags: new Map() as ReadonlyMap<DagId, RegisteredDag>,
  loadedAt: 0,
  sha: null,
});

/**
 * Return a new frozen registry with the given DAG added (or replaced if same id).
 * Non-destructive — original registry is unchanged.
 */
export const withDag = (r: Registry, dag: RegisteredDag): Registry => {
  const newDags = new Map(r.dags);
  newDags.set(dag.id, dag);
  return Object.freeze({
    dags: newDags as ReadonlyMap<DagId, RegisteredDag>,
    loadedAt: r.loadedAt,
    sha: r.sha,
  });
};

/**
 * Return a new frozen registry with the given DAG removed.
 * Non-destructive — original registry is unchanged.
 * If id doesn't exist, returns a structurally identical copy.
 */
export const withoutDag = (r: Registry, id: DagId): Registry => {
  const newDags = new Map(r.dags);
  newDags.delete(id);
  return Object.freeze({
    dags: newDags as ReadonlyMap<DagId, RegisteredDag>,
    loadedAt: r.loadedAt,
    sha: r.sha,
  });
};

/**
 * Freeze a set of validated DAGs into an immutable registry snapshot.
 * Object.freeze on the outer object prevents reassigning `dags`, `loadedAt`, `sha`
 * fields at runtime. The Map is cast to ReadonlyMap for compile-time safety but
 * is NOT deeply frozen — runtime immutability depends on the convention that
 * consumers never cast away ReadonlyMap.
 *
 * @param dags - Array of validated, loaded DAGs
 * @param sha - Git commit SHA this registry represents
 * @param now - Timestamp when loading completed
 */
export const freeze = (dags: readonly RegisteredDag[], sha: GitSha, now: number): Registry => {
  const dagMap = new Map<DagId, RegisteredDag>();
  for (const dag of dags) {
    dagMap.set(dag.id, dag);
  }
  return Object.freeze({
    dags: dagMap as ReadonlyMap<DagId, RegisteredDag>,
    loadedAt: now,
    sha,
  });
};

// ── Queries ────────────────────────────────────────────────────────────────

export const lookupDag = (r: Registry, id: DagId): RegisteredDag | undefined =>
  r.dags.get(id);

/**
 * Get count of healthy DAGs in the registry.
 */
export const healthyCount = (r: Registry): number => {
  let count = 0;
  for (const dag of r.dags.values()) {
    if (dag.status.kind === "healthy") count++;
  }
  return count;
};

export const isEmpty = (r: Registry): boolean => r.dags.size === 0;
