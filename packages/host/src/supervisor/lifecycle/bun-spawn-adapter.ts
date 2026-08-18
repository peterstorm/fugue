/**
 * Bun.spawn worker adapter — the IMPERATIVE SHELL implementing `SpawnPort` +
 * `ProcManagePort` (AD-9). The decision-shaped part (argv + env construction,
 * incl. the per-worker heap cap) is factored into the PURE `buildWorkerSpawn`
 * function so it is unit-testable WITHOUT spawning a real process; the adapter
 * itself only does the actual `Bun.spawn` / `process.kill` I/O and fail-closes
 * thrown errors into `HostError`.
 *
 * HEAP CAP MECHANISM (AD-9, WORKER_HEAP_CAP_MB):
 *   Bun has no dedicated per-process heap CLI flag, but it honours the
 *   Node-compatible `--max-old-space-size=<MB>` flag (the V8 old-space ceiling)
 *   forwarded through `NODE_OPTIONS`, which Bun reads at startup. We therefore set
 *   `NODE_OPTIONS=--max-old-space-size=<heapCapMb>` in the CHILD's env (merged
 *   with any inherited NODE_OPTIONS). This bounds a single tenant's old-space
 *   heap so a runaway tenant OOMs its OWN worker (contained crash → restart)
 *   rather than the shared host. Unset `heapCapMb` → no cap added.
 *
 * `--smol` (Bun's low-memory mode) is intentionally NOT used: it trades
 * throughput globally and is not a hard ceiling. A hard old-space cap that
 * triggers a contained OOM crash is the AD-9 requirement.
 */

import { dirname } from "node:path";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { internalInvariantViolated } from "../../domain/host-error.js";
import type { LogPort } from "../../ports.js";
import type { SpawnPort, ProcManagePort, WorkerSpawnSpec, WorkerHandle } from "./spawn-port.js";

// ── Pure: argv + env construction (testable without spawning) ──────────────────

/**
 * The fully-resolved spawn plan: the argv vector and the child's env. PURE output
 * of `buildWorkerSpawn` — the adapter feeds it straight into `Bun.spawn`. Kept as
 * a value so tests can assert the heap-cap flag and the forwarded env WITHOUT a
 * real process.
 */
interface WorkerSpawnPlan {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * PURE: build the argv + env for a worker spawn from a `WorkerSpawnSpec` and the
 * supervisor's own (inherited) env. Deterministic, no I/O.
 *
 *   - argv: `["bun", "run", <workerEntry>]`.
 *   - env: the inherited env MERGED with the per-worker overrides:
 *       TENANT_ID, FUGUE_SECRETS_REF (the REFERENCE only — FR-005/FR-006),
 *       WORKER_UDS_DIR = `dirname(spec.udsPath)` so the worker binds EXACTLY the
 *       socket the supervisor targets (C7), any `spec.extraEnv`, and — when
 *       `heapCapMb` is set — `NODE_OPTIONS` with
 *       `--max-old-space-size=<heapCapMb>` appended to any inherited NODE_OPTIONS
 *       (AD-9 heap cap). The secrets ref is forwarded; it is NEVER dereferenced
 *       supervisor-side.
 *
 * Precedence: per-worker overrides WIN over inherited env (so a stale inherited
 * TENANT_ID from the supervisor process can never leak the wrong tenant into a
 * worker). `extraEnv` is applied before the mandatory tenant/secrets overrides so
 * it can never override the tenant binding.
 */
export const buildWorkerSpawn = (
  spec: WorkerSpawnSpec,
  inheritedEnv: Readonly<Record<string, string | undefined>>,
): WorkerSpawnPlan => {
  // INHERITED ENV IS REQUIRED, NOT A LEAK (A1): the worker is `createHost` bound
  // to one tenant (worker-main.ts), so it `parseHostConfig`s the SAME schema as
  // the supervisor and genuinely CONSUMES platform-wide config from this env:
  //   - REDIS_URL          — the worker's Redis connection TARGET (host:port). The
  //                          per-tenant ACL credential (FUGUE_REDIS_ACL_*) only
  //                          OVERRIDES the embedded username/password; the URL
  //                          itself is still needed (worker-main.ts createRedisConnectivity).
  //   - ADMIN_TOKEN        — required by the schema AND used: createHost wires it
  //                          into the worker's auth middleware (host.ts) to validate
  //                          admin-authenticated runs the supervisor proxies over UDS.
  //   - REALM_JWT_ISSUER, … — broker / JWT verification config the worker needs.
  // Scrubbing these would break the worker (config-parse failure + rejected admin
  // runs), so the whole-env inheritance is deliberate. The supervisor and its
  // workers share a uid/trust domain (AD-2/AD-9); per-tenant ISOLATION rests on the
  // Redis ACL key-scope + signed tenant header, not on withholding platform config.
  // Start from inherited env (drop undefined values for a clean string record).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inheritedEnv)) {
    if (v !== undefined) env[k] = v;
  }

  // extraEnv first — must not be able to override the tenant binding below.
  if (spec.extraEnv) {
    for (const [k, v] of Object.entries(spec.extraEnv)) env[k] = v;
  }

  // Mandatory per-worker bindings (override anything inherited/extra).
  env.TENANT_ID = spec.tenant;
  env.FUGUE_SECRETS_REF = spec.secretsRef; // REFERENCE only — never resolved here.
  // WORKER_UDS_DIR (C7): the worker binds `workerSocketPath(WORKER_UDS_DIR,
  // tenant)`, so the dir MUST be the parent of the supervisor-chosen `spec.udsPath`
  // — otherwise the worker binds one socket while the supervisor's
  // registry/proxy/probe target another (silent mismatch when WORKER_UDS_DIR is
  // not the default /run/fugue). Deriving it from `dirname(spec.udsPath)`
  // structurally guarantees `workerSocketPath(env.WORKER_UDS_DIR, tenant) ===
  // spec.udsPath`.
  env.WORKER_UDS_DIR = dirname(spec.udsPath);

  // Heap cap (AD-9): append --max-old-space-size to NODE_OPTIONS, preserving any
  // inherited flags. Append (not replace) so platform-wide NODE_OPTIONS survive.
  if (spec.heapCapMb !== undefined) {
    const flag = `--max-old-space-size=${spec.heapCapMb}`;
    const existing = env.NODE_OPTIONS;
    env.NODE_OPTIONS = existing && existing.length > 0 ? `${existing} ${flag}` : flag;
  }

  return {
    cmd: ["bun", "run", spec.workerEntry],
    env,
  };
};

// ── Adapter (impure: Bun.spawn / process.kill) ─────────────────────────────────

/**
 * Create the Bun.spawn-backed `SpawnPort` + `ProcManagePort`. `inheritedEnv`
 * defaults to `process.env` but is injectable so the spawn-plan can be exercised
 * deterministically in tests (combined with `buildWorkerSpawn` directly).
 */
export const createBunSpawnAdapter = (
  inheritedEnv: Readonly<Record<string, string | undefined>> = process.env,
  logger?: LogPort,
): SpawnPort & ProcManagePort => ({
  spawn: async (spec: WorkerSpawnSpec): Promise<Result<WorkerHandle, HostError>> => {
    try {
      const plan = buildWorkerSpawn(spec, inheritedEnv);
      const proc = Bun.spawn([...plan.cmd], {
        env: plan.env,
        stdout: "inherit",
        stderr: "inherit",
        // Workers are reparented to thin-init (PID 1) so a supervisor restart
        // does NOT take them down (AD-2); see thin-init.ts. We do not set a
        // custom process group here — reparenting is handled by the init topology.
      });
      if (typeof proc.pid !== "number") {
        return err(internalInvariantViolated("Bun.spawn returned no pid for worker", { tenant: spec.tenant }));
      }
      return ok({
        pid: proc.pid,
        exited: proc.exited,
      });
    } catch (e) {
      // Fail-closed: a spawn failure for ONE tenant is contained — surfaced as
      // that tenant's worker-unavailable upstream (AD-8). Here we return a
      // generic invariant error carrying the cause; the lifecycle manager maps it
      // to worker-unavailable(tenant).
      return err(internalInvariantViolated("worker spawn failed", {
        tenant: spec.tenant,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  },

  signal: async (pid: number, sig: "SIGTERM" | "SIGKILL"): Promise<Result<void, HostError>> => {
    try {
      process.kill(pid, sig);
      return ok(undefined);
    } catch (e) {
      // ESRCH = no such process: the worker already exited, which is the desired
      // end state for a kill — idempotent success, not an error.
      if (e instanceof Error && "code" in e && (e as { code?: string }).code === "ESRCH") {
        return ok(undefined);
      }
      return err(internalInvariantViolated("failed to signal worker process", {
        pid,
        sig,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  },

  isAlive: async (pid: number): Promise<boolean> => {
    try {
      // Signal 0 performs error checking without sending a signal — succeeds iff
      // the process exists and we may signal it.
      process.kill(pid, 0);
      return true;
    } catch (e) {
      const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
      // EPERM: the process EXISTS but we lack permission to signal it. That is a
      // live process from a liveness standpoint, AND a misconfiguration worth a
      // warning (the supervisor and worker are expected to share a uid). ESRCH
      // (no such process) is the genuine dead case → false.
      if (code === "EPERM") {
        logger?.warn("[bun-spawn] isAlive got EPERM — process exists but cannot be signalled (uid mismatch?)", { pid });
        return true;
      }
      return false;
    }
  },
});
