/**
 * Capability Manager — lifecycle of CapabilityHandle instances.
 *
 * Mixed module, split into two clearly-marked sections:
 * - PURE: `topoSortHandles` — orders handles by their `dependsOn` declarations
 *   and rejects malformed handle sets. No I/O; fixture-testable.
 * - EFFECTFUL: `connectAll` / `closeAll` / `checkHealth` — drive the handles'
 *   async lifecycle hooks. These are imperative-shell orchestration; the host's
 *   boot/shutdown calls them. They live here for cohesion with the topo-sort
 *   they consume, not because they are pure.
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
 * - a handle's `client` is null/undefined (a malformed adapter must fail
 *   loudly at boot, not surface later as a phantom `missing-capability`
 *   at run time)
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
    // The type says `client` is non-null, but a malformed JS adapter can
    // still hand us a null — catch it here (the boot choke point) so the
    // diagnostic names the broken handle instead of a run-time
    // `missing-capability` that reads as a wiring gap.
    if (handle.client == null) {
      return err({
        kind: "internal-invariant-violated",
        message: `Capability handle '${handle.name}' has a null client — the adapter must construct its client at factory time`,
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
        const depError = visit(dep);
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
        // The failing handle's adapter may have constructed resources at
        // factory time (e.g. a pg Pool opens sockets before connect() runs).
        // Close it best-effort so an aborted boot doesn't orphan them — the
        // caller only closes the *connected prefix*, which excludes this
        // handle. A close failure is logged, never masks the connect error.
        if (handle.close) {
          try {
            await handle.close();
          } catch (closeError) {
            logger.error(`Capability '${handle.name}' failed to close after connect failure`, {
              error: closeError instanceof Error ? closeError.message : String(closeError),
            });
          }
        }
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
// Health Check (effectful — aggregation only; periodic host polling is a
// follow-up, see capability-handle.ts)
// ---------------------------------------------------------------------------

/**
 * Run health checks on all capabilities that declare one.
 * Returns aggregated report. Best-effort — never throws.
 *
 * Note: nothing in the host runtime calls this yet — it exists for the
 * degraded-state detection follow-up (periodic polling is not wired).
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
 * TRUST BOUNDARY — this is the single point where the per-handle
 * `name ↔ client` correlation (carried by `CapabilityHandle<K>` at
 * construction, erased when widened to `readonly CapabilityHandle[]`) is
 * restored via the cast below. Adapter authors are trusted to wire
 * `CapabilityHandle<K>.name` to a `CapabilityRegistry[K]` client; nothing
 * downstream re-verifies the client's shape (validation checks presence,
 * not structure). Keep every such cast here — do not introduce a second
 * correlation point.
 *
 * Duplicate names cannot reach this function through the host boot path:
 * `topoSortHandles` rejects them (and null clients) before `connectAll`
 * runs, so the unconditional assignment below never silently drops a
 * handle in practice.
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
