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
import type { CapabilityHandle, Capability } from "@fugue/framework";
import type { HostError } from "./host-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A set of capability handles registered with the host.
 * Keyed by capability name — one handle per capability.
 */
export type CapabilitySet = ReadonlyMap<string, CapabilityHandle>;

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
 * Returns Err if a cycle is detected.
 */
export const topoSortHandles = (
  handles: readonly CapabilityHandle[],
): Result<readonly CapabilityHandle[], HostError> => {
  const byName = new Map<string, CapabilityHandle>(handles.map((h) => [h.name, h]));
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
 * Connect all capability handles in topological order.
 * Stops on first failure and returns error with the failing capability name.
 */
export const connectAll = async (
  handles: readonly CapabilityHandle[],
  logger: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
): Promise<Result<void, HostError>> => {
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
          kind: "internal-invariant-violated",
          message: `Capability '${handle.name}' failed to connect: ${message}`,
          context: { capability: handle.name },
        });
      }
    }
  }
  return ok(undefined);
};

/**
 * Close all capability handles in reverse order (dependencies close last).
 * Best-effort — continues on failure, logs errors.
 */
export const closeAll = async (
  handles: readonly CapabilityHandle[],
  logger: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void },
): Promise<void> => {
  // Close in reverse order (dependents close before dependencies)
  const reversed = [...handles].reverse();
  for (const handle of reversed) {
    if (handle.close) {
      try {
        await handle.close();
        logger.info(`Capability '${handle.name}' closed`);
      } catch (e) {
        logger.warn(`Capability '${handle.name}' failed to close`, {
          error: e instanceof Error ? e.message : String(e),
        });
        // Best-effort — continue closing others
      }
    }
  }
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
 */
export const extractClients = (
  handles: readonly CapabilityHandle[],
): Partial<Record<string, unknown>> => {
  const clients: Record<string, unknown> = {};
  for (const handle of handles) {
    clients[handle.name] = handle.client;
  }
  return clients;
};
