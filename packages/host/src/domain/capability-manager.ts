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

import type { Result } from "@fuguejs/framework";
import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type {
  CapabilityHandle,
  Capability,
  CapabilityRegistry,
  LlmClient,
  LlmPricingModel,
} from "@fuguejs/framework";
import type { HostError } from "./host-error.js";
import { logWithoutThrowingTo } from "./diagnostic-logging.js";

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
  // Keyed by `Capability`, not `string`: `CapabilityHandle.name` is already
  // narrowed to the closed capability vocabulary, and widening it here would
  // let a lookup with an arbitrary string typecheck.
  const byName = new Map<Capability, CapabilityHandle>();
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

  // The whole traversal stays in the closed `Capability` vocabulary — handle
  // names and `dependsOn` entries are already `Capability`, so nothing here
  // needs to widen back to `string`.
  const visited = new Set<Capability>();
  const visiting = new Set<Capability>();
  const sorted: CapabilityHandle[] = [];

  const visit = (name: Capability): HostError | null => {
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

/** A single capability that failed to close during lifecycle cleanup. */
interface CloseFailure {
  readonly name: string;
  readonly error: string;
}

/**
 * A connect failure paired with the handles that successfully connected
 * before it — the caller MUST close that prefix to avoid leaking pools and
 * sockets on an aborted boot.
 */
interface ConnectFailure {
  readonly error: HostError;
  /** Handles whose `connect()` completed before the failure, in connect order. */
  readonly connected: readonly CapabilityHandle[];
  /** Cleanup failures already observed on the handle whose connect failed. */
  readonly cleanupFailures: readonly CloseFailure[];
}

type LifecycleLogMethod = (msg: string, data?: Record<string, unknown>) => void;
type LifecycleLogger = {
  readonly info?: LifecycleLogMethod;
  readonly warn?: LifecycleLogMethod;
  readonly error?: LifecycleLogMethod;
};
type ConnectLogger = Required<Pick<LifecycleLogger, "info" | "error">>;
type CloseLogger = Required<Pick<LifecycleLogger, "info" | "warn">>;
type LifecycleDiagnosticFallback = (diagnostic: string) => unknown;

const writeLifecycleFallback: LifecycleDiagnosticFallback = (diagnostic) =>
  process.stderr.write(diagnostic);

/**
 * Lifecycle diagnostics are secondary and must not alter control flow — THE
 * encoding of that rule is `logWithoutThrowing`; this only adapts the optional
 * `data` this module carries to its required parameter.
 */
const logLifecycleWithoutThrowing = (
  logger: LifecycleLogger,
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown> | undefined,
  writeFallback: LifecycleDiagnosticFallback,
): void => logWithoutThrowingTo(logger, level, message, data ?? {}, writeFallback);

/**
 * Connect all capability handles in topological order.
 * Stops on first failure; the Err carries the connected prefix so the
 * caller can close it (a crash-loop boot must not leak connections).
 */
export const connectAll = async (
  handles: readonly CapabilityHandle[],
  logger: ConnectLogger,
  writeFallback: LifecycleDiagnosticFallback = writeLifecycleFallback,
): Promise<Result<void, ConnectFailure>> => {
  const connected: CapabilityHandle[] = [];
  for (const handle of handles) {
    if (handle.connect) {
      logLifecycleWithoutThrowing(
        logger,
        "info",
        `Connecting capability '${handle.name}'...`,
        undefined,
        writeFallback,
      );
      try {
        await handle.connect();
        logLifecycleWithoutThrowing(
          logger,
          "info",
          `Capability '${handle.name}' connected`,
          undefined,
          writeFallback,
        );
      } catch (e) {
        const message = safeErrorMessage(e);
        logLifecycleWithoutThrowing(
          logger,
          "error",
          `Capability '${handle.name}' failed to connect`,
          { error: message },
          writeFallback,
        );
        // The failing handle's adapter may have constructed resources at
        // factory time (e.g. a pg Pool opens sockets before connect() runs).
        // Close it best-effort so an aborted boot doesn't orphan them — the
        // caller only closes the *connected prefix*, which excludes this
        // handle. A close failure remains subordinate to the connect error but
        // is returned as cleanup evidence instead of existing only in logs.
        const cleanupFailures: CloseFailure[] = [];
        if (handle.close) {
          try {
            await handle.close();
          } catch (closeError) {
            const cleanupError = safeErrorMessage(closeError);
            cleanupFailures.push({ name: handle.name, error: cleanupError });
            logLifecycleWithoutThrowing(
              logger,
              "error",
              `Capability '${handle.name}' failed to close after connect failure`,
              { error: cleanupError },
              writeFallback,
            );
          }
        }
        return err({
          error: {
            kind: "internal-invariant-violated",
            message: `Capability '${handle.name}' failed to connect: ${message}`,
            context: { capability: handle.name },
          },
          connected,
          cleanupFailures,
        });
      }
    }
    connected.push(handle);
  }
  return ok(undefined);
};

/**
 * Close all capability handles in reverse order (dependencies close last).
 * Best-effort — continues on failure, logs errors. Returns the failures so
 * the caller can report a non-clean shutdown instead of silently swallowing
 * a pool that refused to drain.
 */
export const closeAll = async (
  handles: readonly CapabilityHandle[],
  logger: CloseLogger,
  writeFallback: LifecycleDiagnosticFallback = writeLifecycleFallback,
): Promise<readonly CloseFailure[]> => {
  const failures: CloseFailure[] = [];
  // Close in reverse order (dependents close before dependencies)
  const reversed = [...handles].reverse();
  for (const handle of reversed) {
    if (!handle.close) continue;

    try {
      await handle.close();
      logLifecycleWithoutThrowing(
        logger,
        "info",
        `Capability '${handle.name}' closed`,
        undefined,
        writeFallback,
      );
    } catch (caught) {
      const error = safeErrorMessage(caught);
      // Record the close outcome before attempting secondary diagnostics.
      failures.push({ name: handle.name, error });
      logLifecycleWithoutThrowing(
        logger,
        "warn",
        `Capability '${handle.name}' failed to close`,
        { error },
        writeFallback,
      );
    }
  }
  return failures;
};

// ---------------------------------------------------------------------------
// Health Check (effectful aggregation)
// ---------------------------------------------------------------------------

/**
 * Run health checks on all capabilities that declare one.
 * Returns aggregated report. Best-effort — never throws.
 *
 * Consumed by the operator-driven `GET /admin/capabilities/health` route.
 */
export const checkHealth = async (
  handles: readonly CapabilityHandle[],
): Promise<CapabilityHealthReport> => {
  const results: CapabilityHealth[] = [];

  for (const handle of handles) {
    try {
      const healthCheck = handle.healthCheck;
      if (healthCheck === undefined) {
        results.push({ status: "no-check", name: handle.name });
        continue;
      }
      const result = await healthCheck();
      if (result.ok) {
        results.push({ status: "healthy", name: handle.name });
      } else {
        results.push({ status: "unhealthy", name: handle.name, reason: result.error });
      }
    } catch (e) {
      results.push({
        status: "unhealthy",
        name: handle.name,
        reason: safeErrorMessage(e),
      });
    }
  }

  return {
    overall: results.some(({ status }) => status === "unhealthy") ? "degraded" : "healthy",
    capabilities: results,
  };
};

// ---------------------------------------------------------------------------
// Utility: extract client map from handles
// ---------------------------------------------------------------------------

/*
 * Extract a capabilities record from a set of handles.
 *
 * This record is the BOOT-SCOPED static client set: it is passed directly to
 * `makeNodeContext({ capabilities })` as the base context for every run (see
 * `adapters/node-context-factory.ts`). When a minting `CapabilityBroker` is
 * wired into `runDag` (the host selects the live Keycloak broker when
 * `REALM_JWT_ISSUER` is set), the framework mints each node's declared
 * `"<provider>:<operation>"` scopes AT DISPATCH and merges the resulting
 * narrowed handles OVER this set; plain capabilities (`http`/`db`/`llm`/…)
 * keep their static client. With no broker wired, this set is used unchanged —
 * byte-identical to the pre-broker behavior (SC-005).
 *
 * TRUST BOUNDARY — this is the single BOOT-TIME point where the per-handle
 * `name ↔ client` correlation (carried by `CapabilityHandle<K>` at
 * construction, erased when widened to `readonly CapabilityHandle[]`) is
 * restored via the cast below. The correlation-cast invariant is exactly two
 * points (ADR-0053, amending ADR-0051's single-point rule): this boot-time
 * cast, plus the structurally identical PER-INVOCATION cast where the Keycloak
 * broker assembles its `ScopedCapabilityHandle` (`handleRecord as
 * ScopedCapabilityHandle` in `adapters/keycloak-broker.ts` `mintFor`). Adapter
 * authors are trusted to wire `CapabilityHandle<K>.name` to a
 * `CapabilityRegistry[K]` client; nothing downstream re-verifies the client's
 * shape (validation checks presence, not structure). Do not introduce a third
 * correlation point.
 *
 * Duplicate names cannot reach this function through the host boot path:
 * `topoSortHandles` rejects them (and null clients) before `connectAll`
 * runs. The duplicate guard below is defence-in-depth: if that invariant is
 * ever violated by a future caller, it fails loudly here rather than silently
 * dropping a handle (last-writer-wins) and surfacing later as a phantom
 * `missing-capability`.
 */
/** Run-scoped transformations applied while extracting boot capability clients. */
export type CapabilityClientDecorators = {
  readonly llm?: (
    name: Capability,
    client: LlmClient,
    pricingModel: LlmPricingModel,
  ) => LlmClient;
};

export const runScopedLlmFacade = (
  metered: LlmClient,
  aliases: Readonly<Record<string, unknown>>,
): LlmClient => {
  const facade: Record<string, unknown> = Object.create(null);
  const bind = (operation: "sendStructured" | "sendWithTools"): unknown =>
    metered[operation].bind(metered);

  facade.sendStructured = bind("sendStructured");
  facade.sendWithTools = bind("sendWithTools");
  for (const [alias, operation] of Object.entries(aliases)) {
    if (alias === "sendStructured" || alias === "sendWithTools") {
      throw new Error(`runScopedOperations cannot replace standard operation '${alias}'`);
    }
    if (operation !== "sendStructured" && operation !== "sendWithTools") {
      throw new Error(
        `runScopedOperations alias '${alias}' names unknown operation '${String(operation)}'`,
      );
    }
    facade[alias] = bind(operation);
  }
  return Object.freeze(facade) as unknown as LlmClient;
};

/**
 * Restore the validated handle-name/client correlation into a capability map.
 * This is the boot-time trust boundary described above; duplicate names fail
 * loudly and LLM handles are transformed into run-scoped metered facades.
 */
export const extractClients = (
  handles: readonly CapabilityHandle[],
  decorators: CapabilityClientDecorators = {},
): Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }> => {
  const clients: Partial<Record<Capability, unknown>> = {};
  for (const handle of handles) {
    if (Object.hasOwn(clients, handle.name)) {
      throw new Error(
        `extractClients: duplicate capability handle name '${handle.name}' — ` +
          `topoSortHandles should have rejected this at boot. This is a wiring bug.`,
      );
    }
    // This remains inside the existing name↔client correlation trust boundary.
    // Standard LLMs receive the narrow metered surface directly. Augmented
    // aliases are declarative data interpreted here; adapter code never gets a
    // run-scoped composition callback in which it could retain the boot client.
    if (handle.clientKind === "llm" && decorators.llm !== undefined) {
      const metered = decorators.llm(
        handle.name,
        handle.client,
        handle.pricingModel,
      );
      clients[handle.name] = handle.runScopedOperations === undefined
        ? metered
        : runScopedLlmFacade(metered, handle.runScopedOperations);
    } else {
      clients[handle.name] = handle.client;
    }
  }
  return clients as Partial<{ [K in Capability]: CapabilityRegistry[K] }>;
};
