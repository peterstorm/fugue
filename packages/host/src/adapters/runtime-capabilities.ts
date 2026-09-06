/**
 * The capability set and shared infrastructure both host entrypoints wire.
 *
 * `main.ts` (single-tenant) and `worker-main.ts` (per-tenant worker) run
 * different topologies but must present DAGs with the SAME runtime: identical
 * built-in capabilities, identical optional-capability gating, identical
 * git/loader selection. They previously open-coded ~45 near-identical lines
 * apiece, differing only in whether the log lines carry a `tenant` field.
 *
 * That duplication was a correctness hazard, not just noise. Each optional
 * capability is GATED — absent config means the handle is `undefined`, which
 * makes a `requires: [...]` DAG fail the boot-time capability check. If one
 * entrypoint gained a capability the other did not, the same DAG would boot
 * under one topology and be rejected under the other, and the failure would
 * point at the DAG rather than at the wiring that differed.
 */

import type { CapabilityHandle } from "@fuguejs/framework";
import { createHttpCapability, systemClock, noopTracer } from "@fuguejs/framework";
import type { HostConfig } from "../domain/config.js";
import type { LogPort, SharedInfra } from "../ports.js";
import { createInMemorySpendLedger } from "./spend-ledger-memory.js";
import { buildDocumentsCapability, describeDocumentsAdapter } from "./documents-capability.js";
import { buildCdratorCapability } from "./cdrator-capability.js";
import { buildOracleCapability, connectStringHost } from "./oracle-capability.js";
import {
  createHostLlmClient,
  hostLlmPricingModel,
} from "../entrypoint-wiring.js";
import { createLocalGitAdapter, createBunGitAdapter } from "./git-sync.js";
import { createModuleLoader } from "./module-loader.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";

/**
 * Build the capability array for a host.
 *
 * `logContext` is merged into every capability-selection log line — the worker
 * entry passes `{ tenant }` so its lines are attributable; the single-tenant
 * entry passes nothing.
 *
 * Built-ins (`http`, `clock`) ship with the framework and are ALWAYS present:
 * they reach each node's `NodeContext` through this array, so omitting one makes
 * `ctx.http` / `ctx.clock` null and fails any DAG that declares it. The optional
 * adapters are each `undefined` when unconfigured, which is the deliberate
 * zero-regression gate described in the module doc.
 */
export const buildRuntimeCapabilities = async (
  config: HostConfig,
  logger: LogPort,
  logContext: Record<string, unknown> = {},
): Promise<CapabilityHandle[]> => {
  const capabilities: CapabilityHandle[] = [
    createHttpCapability(),
    { name: "clock", client: systemClock },
  ];

  // Each optional adapter is `undefined` when unconfigured (the zero-regression
  // gate). `describe` stays a thunk: the messages below read config fields that
  // are only guaranteed present once the adapter itself resolved.
  const wire = (
    handle: CapabilityHandle | undefined,
    describe: () => string,
  ): void => {
    if (handle === undefined) return;
    capabilities.push(handle);
    logWithoutThrowing(logger, "info", describe(), logContext);
  };

  // ADR-0052: `documents`, selected by environment (fs / ms-graph). The adapter
  // package loads only when configured. `createHost` calls connect() at boot
  // (validating the mount / auth wiring) and close() at shutdown.
  wire(
    await buildDocumentsCapability(config),
    () => `documents capability: ${describeDocumentsAdapter(config)}`,
  );

  // FR-060: `authedHttp` — the generic @fuguejs/http-auth adapter configured for
  // the CDRator/Oister REST API from CDRATOR_* env. Credentials come only from
  // config; none are logged.
  wire(
    buildCdratorCapability(config),
    () => `authedHttp capability: @fuguejs/http-auth targeting ${config.CDRATOR_URL}`,
  );

  // FR-031/FR-033: `oracle` — a read-only oracledb pool wired from ORACLE_* env.
  // Log ONLY the non-secret host:port/service of the connect string, never
  // user/password (FR-041/SC-008).
  wire(
    buildOracleCapability(config, logger),
    () =>
      `oracle capability: @fuguejs/oracle targeting ${connectStringHost(config.ORACLE_CONNECT_STRING!)}`,
  );

  return capabilities;
};

/**
 * Build the shared infrastructure, git adapter and module loader every host
 * needs, with the capability set already wired in.
 *
 * Git selection is by DAGS_LOCAL_PATH: a local path means the DAGs are already
 * on disk (the worker's per-tenant mount, or a dev checkout) and must NOT be
 * cloned; otherwise the remote adapter fetches them.
 */
export const buildRuntimeDeps = async (
  config: HostConfig,
  redis: SharedInfra["redis"],
  logger: LogPort,
  logContext: Record<string, unknown> = {},
): Promise<{
  readonly sharedInfra: SharedInfra;
  readonly git: ReturnType<typeof createBunGitAdapter>;
  readonly loader: ReturnType<typeof createModuleLoader>;
}> => {
  const capabilities = await buildRuntimeCapabilities(config, logger, logContext);
  const sharedInfra: SharedInfra = {
    llm: await createHostLlmClient(config),
    llmPricingModel: hostLlmPricingModel(config),
    redis,
    // STOCK SELECTION IS EXPLICITLY REDIS-FIRST: the memory adapter carries
    // metadata role `redis-fallback`, so `createNodeContextForDag` selects a
    // namespaced Redis ledger whenever its primitives are available and uses
    // this process-only backend only on a loud downgrade.
    spendLedger: createInMemorySpendLedger(),
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger,
    capabilities,
  };
  const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
  const git = isLocalMode ? createLocalGitAdapter() : createBunGitAdapter();
  // The logger is passed so prompt-load errors route through structured logging.
  const loader = createModuleLoader(logger);
  return { sharedInfra, git, loader };
};
