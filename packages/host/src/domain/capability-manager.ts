/**
 * Capability Manager — manages lifecycle of CapabilityHandle instances.
 *
 * Pure domain logic for:
 * - Topological sort of handles based on `dependsOn` declarations
 * - Connect/close sequencing
 * - Health check aggregation
 *
 * The host's imperative shell calls these during boot and shutdown.
 *
 * @satisfies ADR-0051 — Extensible capability registry lifecycle management
 */

import type { Result } from "@fugue/framework";
import { ok, err } from "@fugue/framework";
import type { CapabilityHandle, Capability, CapabilityRegistry } from "@fugue/framework";
import type { HostError } from "./host-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Health status of a single capability.
 */
export type CapabilityHealth =
  | { readonly status: "healthy"; readonly name: string }
  | { readonly status: "unhealthy"; readonly name: string; readonly reason: string }
  | { readonly status: "no-check"; readonly name: string };

/**
 * Aggregated health of all capabilities.
 */
export interface CapabilityHealthReport {
  readonly overall: "healthy" | "degraded";
  readonly capabilities: readonly CapabilityHealth[];
}

// ---------------------------------------------------------------------------
// Topological Sort (pure)
// ---------------------------------------------------------------------------

/**
 * Topologically sort capability handles by their `dependsOn` declarations.
 * Returns handles in connect order (dependencies first).
 *
 * Returns Err when the handle set violates an invariant:
 * - two handles claim the same capability name (last-writer-wins would
 *   silently drop one)
 * - a `dependsOn` entry names a capability with no registered handle
 *   (the declared dependency contract would be silently unsatisfied)
 * - a dependency cycle is detected
 */
export const topoSortHandles = (
  handles: readonly CapabilityHandle[],
): Result<readonly CapabilityHandle[], HostError> => {
  const byName = new Map<string, CapabilityHandle>();
  for (const handle of handles) {
    if (byName.has(handle.name)) {
      return err({
        kind: "internal-invariant-violated",
        message: `Duplicate capability handle for '${handle.name}' — one handle per capability`,
        context: { capability: handle.name },
      });
    }
    byName.set(handle.name, handle);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: CapabilityHandle[] = [];

  const visit = (name: string): HostError | null => {
    if (visited.has(name)) return null;
    if (visiting.has(name)) {
      return {
        kind: "internal-invariant-violated",
        message: `Capability dependency cycle detected involving '${name}'`,
        context: { capability: name },
      };
    }

    visiting.add(name);
    const handle = byName.get(name);
    if (handle?.dependsOn) {
      for (const dep of handle.dependsOn) {
        if (!byName.has(dep)) {
          return {
            kind: "internal-invariant-violated",
            message: `Capability '${name}' depends on '${dep}', but no '${dep}' handle is registered`,
            context: { capability: name, missingDependency: dep },
          };
        }
        const depError = visit(dep as string);
        if (depError) return depError;
      }
    }
    visiting.delete(name);
    visited.add(name);
    if (handle) sorted.push(handle);
    return null;
  };

  for (const handle of handles) {
    const error = visit(handle.name);
    if (error) return err(error);
  }

  return ok(sorted);
};

// ---------------------------------------------------------------------------
// Connect / Close (effectful — called by the imperative shell)
// ---------------------------------------------------------------------------

/**
 * A connect failure paired with the handles that successfully connected
 * before it — the caller MUST close that prefix to avoid leaking pools and
 * sockets on an aborted boot.
 */
export interface ConnectFailure {
  readonly error: HostError;
  /** Handles whose `connect()` completed before the failure, in connect order. */
  readonly connected: readonly CapabilityHandle[];
}

/**
 * Connect all capability handles in topological order.
 * Stops on first failure; the Err carries the connected prefix so the
 * caller can close it (a crash-loop boot must not leak connections).
 */
export const connectAll = async (
  handles: readonly CapabilityHandle[],
  logger: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
): Promise<Result<void, ConnectFailure>> => {
  const connected: CapabilityHandle[] = [];
  for (const handle of handles) {
    if (handle.connect) {
      logger.info(`Connecting capability '${handle.name}'...`);
      try {
        await handle.connect();
        logger.info(`Capability '${handle.name}' connected`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error(`Capability '${handle.name}' failed to connect`, { error: message });
        return err({
          error: {
            kind: "internal-invariant-violated",
            message: `Capability '${handle.name}' failed to connect: ${message}`,
            context: { capability: handle.name },
          },
          connected,
        });
      }
    }
    connected.push(handle);
  }
  return ok(undefined);
};

/** A single capability that failed to close during shutdown. */
export interface CloseFailure {
  readonly name: string;
  readonly error: string;
}

/**
 * Close all capability handles in reverse order (dependencies close last).
 * Best-effort — continues on failure, logs errors. Returns the failures so
 * the caller can report a non-clean shutdown instead of silently swallowing
 * a pool that refused to drain.
 */
export const closeAll = async (
  handles: readonly CapabilityHandle[],
  logger: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void },
): Promise<readonly CloseFailure[]> => {
  const failures: CloseFailure[] = [];
  // Close in reverse order (dependents close before dependencies)
  const reversed = [...handles].reverse();
  for (const handle of reversed) {
    if (handle.close) {
      try {
        await handle.close();
        logger.info(`Capability '${handle.name}' closed`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.warn(`Capability '${handle.name}' failed to close`, { error });
        failures.push({ name: handle.name, error });
        // Best-effort — continue closing others
      }
    }
  }
  return failures;
};

// ---------------------------------------------------------------------------
// Health Check (effectful — polled by the host)
// ---------------------------------------------------------------------------

/**
 * Run health checks on all capabilities that declare one.
 * Returns aggregated report. Best-effort — never throws.
 */
export const checkHealth = async (
  handles: readonly CapabilityHandle[],
): Promise<CapabilityHealthReport> => {
  const results: CapabilityHealth[] = [];
  let hasUnhealthy = false;

  for (const handle of handles) {
    if (!handle.healthCheck) {
      results.push({ status: "no-check", name: handle.name });
      continue;
    }
    try {
      const result = await handle.healthCheck();
      if (result.ok) {
        results.push({ status: "healthy", name: handle.name });
      } else {
        results.push({ status: "unhealthy", name: handle.name, reason: result.error });
        hasUnhealthy = true;
      }
    } catch (e) {
      results.push({
        status: "unhealthy",
        name: handle.name,
        reason: e instanceof Error ? e.message : String(e),
      });
      hasUnhealthy = true;
    }
  }

  return {
    overall: hasUnhealthy ? "degraded" : "healthy",
    capabilities: results,
  };
};

// ---------------------------------------------------------------------------
// Utility: extract client map from handles
// ---------------------------------------------------------------------------

/**
 * Extract a capabilities record from a set of handles.
 * Used to pass into `makeNodeContext({ capabilities: ... })`.
 *
 * The returned record is keyed by `Capability` with each value typed to its
 * registry entry, so the wiring site needs no cast. The single cast below is
 * where the per-handle `name ↔ client` correlation (carried by
 * `CapabilityHandle<K>` at construction, widened to the union by the array)
 * is restored.
 */
export const extractClients = (
  handles: readonly CapabilityHandle[],
): Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }> => {
  const clients: Record<string, unknown> = {};
  for (const handle of handles) {
    clients[handle.name] = handle.client;
  }
  return clients as Partial<{ [K in Capability]: CapabilityRegistry[K] }>;
};
