/**
 * Capability lifecycle handle — wraps a capability client with runtime
 * lifecycle hooks (connect/close) and optional health checking.
 *
 * Adapter packages produce `CapabilityHandle` instances via factory functions.
 * The runtime manages the lifecycle:
 *   - `connect()` is called once at startup (after config validation).
 *   - `close()` is called at shutdown (graceful drain).
 *   - `healthCheck()` is available for degraded-state detection (host
 *     polling is not yet wired; `checkHealth` aggregation exists in the
 *     host's capability manager).
 *
 * @example
 * ```ts
 * const pgHandle: CapabilityHandle<"db"> = {
 *   name: "db",
 *   client: pgCapabilityImpl,
 *   connect: () => pool.connect(),
 *   close: () => pool.end(),
 *   healthCheck: async () => {
 *     await pool.query("SELECT 1");
 *     return ok(undefined);
 *   },
 * };
 * ```
 */

import type { Result } from "./result.js";
import type { CapabilityRegistry, Capability } from "./node.js";

/**
 * Runtime lifecycle wrapper for a capability client.
 *
 * @typeParam K - The capability name (key of `CapabilityRegistry`).
 */
export interface CapabilityHandle<K extends Capability = Capability> {
  /** Capability name — must match a key in `CapabilityRegistry`. */
  readonly name: K;

  /** The capability client instance injected into `NodeContext`. */
  readonly client: CapabilityRegistry[K];

  /**
   * Called once at runtime startup. Use for connection pool init,
   * authentication handshakes, etc. Throwing aborts the boot sequence.
   */
  readonly connect?: () => Promise<void>;

  /**
   * Called at runtime shutdown. Use for pool drain, socket close, etc.
   * The runtime awaits this before process exit.
   */
  readonly close?: () => Promise<void>;

  /**
   * Optional health check for degraded-state detection. Return `Err(reason)`
   * to signal unhealthy. (The host's `checkHealth` aggregates these; periodic
   * polling is not yet wired into the host runtime.)
   */
  readonly healthCheck?: () => Promise<Result<void, string>>;

  /**
   * Optional dependency ordering. If this capability requires another
   * capability to be connected first, declare it here. The runtime
   * topologically sorts `connect()` calls.
   *
   * Only *handle-backed* capabilities are valid targets — built-ins that are
   * wired directly into `SharedInfra` without a handle (`llm`, `judgeLlm`,
   * `prompts`, `cache`) are never registered with the lifecycle manager, so
   * depending on them always fails the boot-time check. (`http`, by contrast,
   * is handle-backed via `createHttpCapability` and reaches the host through
   * the `capabilities` array — so it *is* a valid target when an HTTP handle
   * is registered.) The type cannot express this narrowing (which capabilities
   * are handle-backed is a runtime property of the deployment), so it is
   * enforced at boot by `topoSortHandles`.
   */
  readonly dependsOn?: readonly Capability[];
}

/**
 * Factory function type for creating capability handles from configuration.
 * Adapter packages export one of these as their public API.
 *
 * @typeParam K - The capability name.
 * @typeParam C - The configuration type (validated by the adapter, typically via Zod).
 *
 * @example
 * ```ts
 * export const createPgAdapter: AdapterFactory<"db", PgAdapterConfig> = (config) => ({
 *   name: "db",
 *   client: new PgCapabilityImpl(config),
 *   connect: () => pool.connect(),
 *   close: () => pool.end(),
 * });
 * ```
 */
export type AdapterFactory<K extends Capability, C> = (
  config: C,
) => CapabilityHandle<K>;
