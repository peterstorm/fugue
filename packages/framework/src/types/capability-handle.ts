/**
 * Capability lifecycle handle — wraps a capability client with runtime
 * lifecycle hooks (connect/close) and optional health checking.
 *
 * AXIS NOTE: `CapabilityHandle` is the BOOT-scoped *lifecycle* wrapper — it
 * owns `connect`/`close`/`healthCheck` and the connection pool, opened once at
 * boot and shared across every run. It is DISTINCT from `CapabilityBroker`
 * (`./capability-broker.ts`), which resolves per-invocation *authority* over the
 * same client set. Pools stay boot-scoped; only authority is invocation-scoped.
 * The two axes do not overlap: a broker never touches connect/close, and a
 * handle never varies authority per call.
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
   * set directly as built-in `NodeContext` fields by `makeNodeContext`
   * (`llm`, `judgeLlm`, `prompts`, `cache`), never registered as a
   * `CapabilityHandle`, are never seen by the lifecycle manager, so
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
