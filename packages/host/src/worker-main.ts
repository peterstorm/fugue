/**
 * @fuguejs/host — WORKER entry point (T6, AD-1).
 *
 * A worker is `createHost` bound to EXACTLY ONE tenant (FR-007), serving on that
 * tenant's per-tenant Unix-domain socket (`/run/fugue/<tenant>.sock`, 0600). The
 * supervisor (T7) spawns it with `TENANT_ID` + `FUGUE_SECRETS_REF` in the env and
 * reverse-proxies inbound HTTP to its socket. This is NOT a public listener
 * (FR-001): the single public listener is the supervisor's.
 *
 * Bootstrap sequence (fail-CLOSED at every step — a half-wired worker must never
 * boot, since it would hold the wrong/absent tenant's authority):
 *   1. parse env → bound tenant (`tenantId(TENANT_ID)`) + secrets ref
 *      (`markSecretsRef(FUGUE_SECRETS_REF)`).
 *   2. resolve the tenant's secrets INSIDE this process via the env-file
 *      `SecretsSource` (the SOLE site that carries dereference authority — the
 *      supervisor structurally lacks it, FR-005/FR-006, SC-002).
 *   3. merge resolved secrets OVER the worker's base env, then `parseHostConfig`.
 *   4. `createHost` bound to this tenant, binding the per-tenant UDS (chmod 0600).
 *   5. any failure → log the STEP + reason (never a secret VALUE) and exit 1.
 *
 * This file has side effects (secret read, Redis connect, git clone, UDS bind,
 * process.exit). It is NOT re-exported from the library surface — only the pure
 * `buildWorkerBootstrap` planner below is, so the wiring is unit-testable without
 * binding a real socket.
 *
 * @satisfies FR-007 — one worker, one tenant; one tenant's config/secrets/state.
 * @satisfies FR-031 — the tenant's secrets are resolved only inside this worker.
 * @satisfies FR-035 — reuses `createHost`; does not replace the single-tenant path.
 */

import { parseHostConfig } from "./domain/config.js";
import { workerSocketPath } from "./domain/config.js";
import type { HostConfig } from "./domain/config.js";
import { tenantId, markSecretsRef } from "./domain/tenant.js";
import type { TenantId, SecretsRef } from "./domain/tenant.js";
import { formatHostError } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createEnvFileSecretsSource } from "./supervisor/secrets/env-file-secrets-source.js";
import type { SecretsSource, ResolvedSecrets } from "./supervisor/secrets/secrets-source.js";
import {
  WORKER_REDIS_ACL_USERNAME_ENV,
  WORKER_REDIS_ACL_PASSWORD_ENV,
  parseAclCredential,
} from "./supervisor/secrets/redis-acl.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import { createRedisConnectivity } from "./adapters/redis-connectivity.js";
import { buildCdratorCapability } from "./adapters/cdrator-capability.js";
import { buildDocumentsCapability, describeDocumentsAdapter } from "./adapters/documents-capability.js";
import { buildOracleCapability, connectStringHost } from "./adapters/oracle-capability.js";
import { closeHitlQueueBackend, createHitlQueueBackend } from "./hitl/queue-backend.js";
import type { SharedInfra } from "./ports.js";
import { ok, err, noopTracer, createHttpCapability, systemClock } from "@fuguejs/framework";
import type { Result, CapabilityHandle } from "@fuguejs/framework";
import { createHostLlmClient, createJsonConsoleLogger } from "./entrypoint-wiring.js";

// ── Pure bootstrap planner (functional core — unit-testable, no I/O) ──────────

/**
 * The fully-resolved plan a worker boots from: the bound tenant principal id,
 * the validated host config, and the UDS path to bind. Returned by
 * `buildWorkerBootstrap` so the env→tenant→secrets→config→socket pipeline is
 * testable end-to-end WITHOUT touching Redis, git, or a real socket.
 *
 * NOTE: `config` carries the resolved secrets merged in — it is SENSITIVE; the
 * caller MUST NOT log it.
 */
interface WorkerBootstrap {
  readonly tenant: TenantId;
  readonly secretsRef: SecretsRef;
  readonly config: HostConfig;
  readonly socketPath: string;
}

/**
 * PURE: turn the worker's raw env + a (already-constructed) `SecretsSource` into
 * a validated `WorkerBootstrap`, or a fail-closed `HostError`.
 *
 * Steps, each fail-closed:
 *   1. `TENANT_ID` present + shape-valid → branded `TenantId` (no `:`/glob).
 *   2. `FUGUE_SECRETS_REF` present → branded `SecretsRef`.
 *   3. resolve the ref via the injected source (any read/parse error → Left).
 *   4. merge resolved secrets OVER the base env (so a tenant's secret can
 *      satisfy e.g. `ANTHROPIC_API_KEY`), then `parseHostConfig`.
 *   5. compute the per-tenant UDS path from `WORKER_UDS_DIR`.
 *
 * The merge layers resolved secrets ON TOP of the worker's own env: secrets win
 * over a baseline env value for the same key (the secrets file is the tenant's
 * authoritative source). Secret VALUES never appear in any returned error.
 *
 * The injected `SecretsSource` is the DEPENDENCY SEAM: production passes the
 * env-file adapter; tests pass an in-memory stub — so this whole pipeline is
 * exercised with plain data, no filesystem.
 */
export const buildWorkerBootstrap = (
  env: Record<string, string | undefined>,
  secrets: SecretsSource,
): Result<WorkerBootstrap, HostError> => {
  const rawTenant = env.TENANT_ID;
  if (rawTenant === undefined || rawTenant === "") {
    return err({ kind: "config-invalid", message: "worker bootstrap: TENANT_ID is required (worker mode binds exactly one tenant)" });
  }
  const tenantResult = tenantId(rawTenant);
  if (!tenantResult.ok) return tenantResult;
  const tenant = tenantResult.value;

  const rawRef = env.FUGUE_SECRETS_REF;
  if (rawRef === undefined || rawRef === "") {
    return err({ kind: "config-invalid", message: "worker bootstrap: FUGUE_SECRETS_REF is required (where to resolve this tenant's secrets)" });
  }
  const secretsRef = markSecretsRef(rawRef);

  const resolved = secrets(secretsRef);
  if (!resolved.ok) return resolved;

  // Defense-in-depth (mirrors the TENANT_ID rebind guard below): a secrets source
  // MUST NOT override env vars the SUPERVISOR force-injects into the spawn env.
  // The merge below layers resolved secrets OVER the base env, so an own-key in
  // the secrets file would win over a supervisor-injected value. We forbid:
  //   - WORKER_UDS_DIR: overriding it moves the worker's bound socket off the
  //     supervisor's proxy/probe target — `waitForUds` times out, the worker is
  //     SIGKILLed, and the tenant goes 503 (self-DoS).
  //   - FUGUE_REDIS_ACL_USERNAME / FUGUE_REDIS_ACL_PASSWORD: the supervisor mints
  //     and injects the per-tenant ACL credential (ADR-0067); a secrets file that
  //     rebound it could connect the worker to Redis as a different (or unscoped)
  //     user, tampering with the isolation handoff channel. Reject outright so the
  //     credential channel is tamper-evident, parallel to WORKER_UDS_DIR.
  // Reject such a file rather than silently honour a forbidden override.
  const FORBIDDEN_SECRET_OVERRIDES = [
    "WORKER_UDS_DIR",
    WORKER_REDIS_ACL_USERNAME_ENV,
    WORKER_REDIS_ACL_PASSWORD_ENV,
  ] as const;
  for (const forbidden of FORBIDDEN_SECRET_OVERRIDES) {
    if (Object.prototype.hasOwnProperty.call(resolved.value, forbidden)) {
      return err({
        kind: "config-invalid",
        message: `worker bootstrap: a secrets source must not set ${forbidden} (it is a supervisor-injected spawn-env binding and must not be overridden by a tenant's secrets)`,
      });
    }
  }

  // Merge resolved secrets OVER the base env. `parseHostConfig` then validates
  // the union. Secret-VALUE non-leakage is upheld upstream by `parseHostConfig`
  // (its errors name the offending KEY, never the value), not by this merge line.
  const merged: Record<string, string | undefined> = { ...env, ...(resolved.value as ResolvedSecrets) };
  const configResult = parseHostConfig(merged);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  // Re-assert the tenant matches the config-parsed TENANT_ID (defense-in-depth:
  // a secrets file MUST NOT be able to rebind the worker to a different tenant).
  if (config.TENANT_ID !== rawTenant) {
    return err({
      kind: "config-invalid",
      message: `worker bootstrap: resolved config TENANT_ID does not match the env-bound tenant (a secrets source must not rebind the worker)`,
    });
  }

  return ok({
    tenant,
    secretsRef,
    config,
    socketPath: workerSocketPath(config.WORKER_UDS_DIR, tenant),
  });
};

// ── Redis Connectivity ─────────────────────────────────────────────────────
// The ioredis adapter is SHARED with `main.ts` (see `adapters/redis-connectivity.ts`);
// the worker only supplies the optional per-tenant ACL credential (ADR-0067).

// ── Main (imperative shell) ────────────────────────────────────────────────────

const main = async () => {
  const logger = createJsonConsoleLogger();

  // Step 1-4 (pure planning): env → tenant → secrets → config → socket path.
  // The env-file SecretsSource is constructed HERE — the sole site that carries
  // filesystem-read authority (FR-005, SC-002).
  logger.info("Worker bootstrap: resolving tenant + secrets...");
  const secretsSource = createEnvFileSecretsSource();
  const bootstrapResult = buildWorkerBootstrap(process.env as Record<string, string | undefined>, secretsSource);
  if (!bootstrapResult.ok) {
    // formatHostError names the step/reason; the env-file adapter never puts a
    // secret VALUE into its error, so this is safe to log.
    logger.error(`Worker bootstrap failed: ${formatHostError(bootstrapResult.error)}`);
    process.exit(1);
  }
  const { tenant, config, socketPath } = bootstrapResult.value;
  logger.info("Worker bootstrap resolved", { tenant, socketPath });

  // Step 5: Redis connectivity (fail-closed). ADR-0067: if the supervisor injected
  // a per-tenant ACL credential, connect as that scoped user (NOPERM-enforced
  // isolation). The all-or-nothing pairing invariant lives in `parseAclCredential`
  // (a half-injected credential fails CLOSED rather than connecting unscoped).
  const aclResult = parseAclCredential(config.FUGUE_REDIS_ACL_USERNAME, config.FUGUE_REDIS_ACL_PASSWORD);
  if (!aclResult.ok) {
    logger.error(`Worker bootstrap failed: ${formatHostError(aclResult.error)}`, {
      tenant,
      hasAclUser: config.FUGUE_REDIS_ACL_USERNAME !== undefined,
      hasAclPass: config.FUGUE_REDIS_ACL_PASSWORD !== undefined,
    });
    process.exit(1);
  }
  const aclCredential = aclResult.value;
  if (aclCredential !== undefined) {
    logger.info("Worker connecting to Redis as per-tenant ACL user", { tenant, aclUser: aclCredential.username });
  }
  const redisResult = await createRedisConnectivity(config.REDIS_URL, aclCredential);
  if (!redisResult.ok) {
    // Carry { tenant } so this fail-closed exit is attributable in a multi-tenant
    // log stream, consistent with the ACL-failure log above.
    logger.error(`Redis connectivity failed: ${formatHostError(redisResult.error)}`, { tenant });
    process.exit(1);
  }
  const { port: redisPort, redis, disconnect: disconnectRedis } = redisResult.value;

  try {
    const capabilities: CapabilityHandle[] = [
      createHttpCapability(),
      { name: "clock", client: systemClock },
    ];

    // ADR-0052: optional `documents` capability, selected by environment
    // (fs / ms-graph) — the SAME shared builder as the single-tenant entry
    // (main.ts), so the adapter selection can never drift between topologies.
    // Undefined when unconfigured → a `requires: ["documents"]` DAG fails the
    // boot-time capability check (zero-regression baseline, same gating as the
    // oracle / authedHttp capabilities).
    const documents = await buildDocumentsCapability(config);
    if (documents !== undefined) {
      capabilities.push(documents);
      logger.info(`documents capability: ${describeDocumentsAdapter(config)}`, { tenant });
    }

    // Optional `authedHttp` capability (FR-060): the generic @fuguejs/http-auth
    // adapter configured for the CDRator/Oister REST API from CDRATOR_* env.
    // Same gating as the documents adapter — undefined when CDRATOR_URL is unset.
    const cdrator = buildCdratorCapability(config);
    if (cdrator !== undefined) {
      capabilities.push(cdrator);
      logger.info(`authedHttp capability: @fuguejs/http-auth targeting ${config.CDRATOR_URL}`, { tenant });
    }

    // Optional `oracle` capability (FR-031/FR-033): @fuguejs/oracle wired from
    // ORACLE_* env. Same gating as the documents adapter — undefined when
    // ORACLE_CONNECT_STRING is unset. We log ONLY the non-secret host:port/service
    // of the connect string, never user/password (FR-041/SC-008).
    const oracle = buildOracleCapability(config, logger);
    if (oracle !== undefined) {
      capabilities.push(oracle);
      logger.info(`oracle capability: @fuguejs/oracle targeting ${connectStringHost(config.ORACLE_CONNECT_STRING!)}`, { tenant });
    }

    const sharedInfra: SharedInfra = {
      llm: await createHostLlmClient(config),
      redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
      logger,
      capabilities,
    };

    const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
    const git = isLocalMode ? createLocalGitAdapter() : createBunGitAdapter();
    const loader = createModuleLoader(logger);

    const queueBackend = await createHitlQueueBackend(config, logger);

    // Step 6: createHost bound to THIS tenant, serving on the per-tenant UDS.
    const hostResult = await createHost({
      config,
      git,
      loader,
      redis: redisPort,
      sharedInfra,
      logger,
      queueBackend,
      tenant,
      bind: { unix: socketPath },
      onShutdown: async () => {
        await closeHitlQueueBackend(queueBackend, logger);
        await disconnectRedis();
      },
    });

    if (!hostResult.ok) {
      logger.error(`Worker failed to start: ${formatHostError(hostResult.error)}`);
      await disconnectRedis();
      process.exit(1);
    }

    logger.info("Fugue worker is running", { tenant, socketPath });
  } catch (e) {
    await disconnectRedis().catch((disconnectErr: unknown) => {
      console.error(JSON.stringify({
        level: "error",
        msg: "Failed to disconnect Redis during error cleanup",
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        ts: new Date().toISOString(),
      }));
    });
    throw e;
  }
};

// Execute main only when this file is the process entrypoint — never when a
// test imports the pure `buildWorkerBootstrap` planner (which would otherwise
// dial Redis and bind a socket). `process.argv[1]` is the invoked script path;
// matching it against this module's basename keeps the guard NodeNext-CJS-safe
// (no `import.meta.main`, which does not typecheck under CJS output).
const invokedScript = process.argv[1] ?? "";
if (invokedScript.endsWith("worker-main.ts") || invokedScript.endsWith("worker-main.js")) {
  main().catch((e) => {
    console.error("Fatal error during worker startup:", e);
    process.exit(1);
  });
}
