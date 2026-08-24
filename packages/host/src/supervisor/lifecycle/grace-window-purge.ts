/**
 * Grace-window retention + auto-purge of a deregistered tenant's footprint
 * (multi-tenant spec FR-030, SC-010).
 *
 * Deregistration (the admin handler, T10) is an IMMEDIATE revoke — kill the
 * worker + invalidate the token (multi-tenant spec FR-029) — but it RETAINS the tenant's footprint
 * (filesystem mount, secrets, cache/checkpoint keys) for a configurable grace
 * window (default 7 days). This module owns the second half: deciding WHEN the
 * window has elapsed (a PURE predicate) and PURGING the footprint once it has (an
 * imperative orchestrator over injected ports).
 *
 * FUNCTIONAL CORE / IMPERATIVE SHELL:
 *   - `isGraceWindowElapsed` / `gracePurgeDueAt` / `selectPurgeable` are PURE: they
 *     take the deregistration instant, the window length, and `now` as PARAMETERS
 *     and never read a clock. That is what makes "simulate 7 days elapsing"
 *     deterministic in a test — the test just passes a `now` past the due instant.
 *   - `purgeTenantFootprint` is the imperative shell: it sequences ACL-revoke,
 *     worker-registry removal, tenant-keyspace deletion, filesystem-mount removal,
 *     and the final registry hard-delete through INJECTED ports, each returning
 *     `Result`. It NEVER calls `Date.now()`; the caller supplies `now`.
 *
 * FENCED, IDEMPOTENT + FAIL-CLOSED: the registry first reserves the exact
 * tombstone with a runtime-proven purge lease and refuses revival while it is
 * active. Every footprint port is idempotent (deleting an absent key/user/mount
 * is a no-op success), so partial failure retains the tombstone and the next
 * sweep safely retries. Hard deletion occurs only after every footprint step
 * succeeds.
 */

import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { LogPort } from "../../ports.js";
import type { TenantId } from "../../domain/tenant.js";
import type { DeregisteredTenantConfig, TenantRegistry } from "../registry/tenant-registry.js";
import type {
  BeginPurgeOutcome,
  HardDeleteOutcome,
  TenantPurgeLease,
} from "../registry/redis-registry-adapter.js";

// ── Grace window default (multi-tenant spec FR-030) ─────────────────────────────────────────────

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The DEFAULT grace window: 7 days (multi-tenant spec FR-030). Exported so the supervisor binary
 * can override it from config (`SUPERVISOR_GRACE_WINDOW_MS`) while the default is
 * a single named constant — never a magic number sprinkled across call sites.
 */
export const DEFAULT_GRACE_WINDOW_MS = 7 * DAY_MS;

// ── Pure predicates (deterministic, clock-injected) ───────────────────────────

/**
 * The instant a deregistered tenant becomes purge-eligible: its `deregisteredAt`
 * plus the grace window. PURE. (Exported so a test/UI can show the scheduled
 * purge time without re-deriving the arithmetic.)
 */
export const gracePurgeDueAt = (deregisteredAt: number, graceWindowMs: number): number =>
  deregisteredAt + graceWindowMs;

/**
 * Whether the grace window for a deregistered tenant has ELAPSED at `now`
 * (multi-tenant spec FR-030). PURE: `now >= deregisteredAt + graceWindowMs`. A non-positive window
 * makes purge due immediately (degenerate but well-defined). This is the single
 * decision point the sweep consults — the time comparison lives here, not inside
 * an I/O method, so it is trivially unit-testable with a simulated `now`.
 */
export const isGraceWindowElapsed = (
  deregisteredAt: number,
  graceWindowMs: number,
  now: number,
): boolean => now >= gracePurgeDueAt(deregisteredAt, graceWindowMs);

/**
 * From a registry snapshot, select every DEREGISTERED tenant whose grace window
 * has elapsed at `now` (multi-tenant spec FR-030, SC-010). PURE — drives the auto-purge sweep: the
 * sweep asks this which tenants are due, then purges each. Active tenants and
 * still-in-window deregistered tenants are never returned.
 */
export const selectPurgeable = (
  registry: TenantRegistry,
  graceWindowMs: number,
  now: number,
): readonly DeregisteredTenantConfig[] =>
  Array.from(registry.entries.values()).filter(
    (c): c is DeregisteredTenantConfig =>
      c.status === "deregistered" && isGraceWindowElapsed(c.deregisteredAt, graceWindowMs, now),
  );

// ── Footprint ports (imperative-shell seams) ─────────────────────────────────

/**
 * Delete a tenant's data footprint in Redis — its cache, checkpoint, token, and
 * team keys under `fugue:<tenant>:*`. Run over the SUPERVISOR's admin connection
 * (the per-tenant ACL user is being revoked alongside, so it cannot do this
 * itself), it enumerates and deletes the tenant's keyspace. Idempotent: purging
 * an already-empty keyspace is a no-op success. Returns the count deleted (for
 * the audit/log trail).
 */
interface TenantKeyspacePurgePort {
  readonly purgeKeyspace: (tenant: TenantId) => Promise<Result<number, HostError>>;
}

/**
 * Delete a tenant's filesystem mount (its `fsRoot`). Idempotent — removing an
 * absent path is a no-op success. Kept behind a port so the purge stays pure-
 * shell-over-port and the fs op can be faked deterministically.
 */
interface TenantFsPurgePort {
  readonly removeMount: (fsRoot: string) => Promise<Result<void, HostError>>;
}

/**
 * Revoke the tenant's Redis ACL user (`ACL DELUSER`). This is the SAME seam the
 * provisioner exposes (`redis-acl-provisioner.revoke`), narrowed to one method so
 * the purge depends only on what it needs. Idempotent at the Redis level.
 */
interface TenantAclRevokePort {
  readonly revokeAcl: (tenant: TenantId) => Promise<Result<void, HostError>>;
}

/**
 * Remove the tenant's worker-registry record (`fugue:supervisor:workers:<tenant>`).
 * The SAME seam `WorkerRegistry.remove` exposes, narrowed. Idempotent.
 */
interface WorkerRegistryRemovePort {
  readonly remove: (tenant: TenantId) => Promise<Result<void, HostError>>;
}

/**
 * The registry seam reserves the exact RETAINED tombstone before destructive
 * work, then admits hard deletion only through the issued lease. Registry
 * mutations are fenced for that tenant until release.
 */
interface RegistryPurgePort {
  readonly beginPurge: (tombstone: DeregisteredTenantConfig) => Promise<Result<BeginPurgeOutcome, HostError>>;
  readonly hardDelete: (lease: TenantPurgeLease) => Promise<Result<HardDeleteOutcome, HostError>>;
  readonly releasePurge: (lease: TenantPurgeLease) => Promise<void>;
}

/**
 * The full set of footprint ports the purge orchestrates. Grouped so the
 * supervisor wires them once and the sweep passes them through.
 */
export interface GracePurgeDeps {
  readonly acl: TenantAclRevokePort;
  readonly workerRegistry: WorkerRegistryRemovePort;
  readonly keyspace: TenantKeyspacePurgePort;
  readonly fs: TenantFsPurgePort;
  readonly registry: RegistryPurgePort;
}

// ── Purge result ──────────────────────────────────────────────────────────────

/**
 * The closed set of footprint-purge steps, in execution order. A failed step is
 * reported by its STEP NAME (not a stringly-typed free-form label), so a
 * persistently-stuck step is unambiguously identifiable in the sweep's log/trail.
 * Adding/removing a step is a single edit here + a compile error at the push
 * sites — the failed-step surface can never silently drift from the purge body.
 */
type PurgeStep =
  | "registry-purge-fence"
  | "acl-revoke"
  | "worker-registry-remove"
  | "keyspace-purge"
  | "fs-remove"
  | "registry-hard-delete";

/**
 * The per-step outcome of a footprint purge — a discriminated union over the two
 * genuinely different endings, so "the tenant came back" can never be mistaken
 * for "the purge finished".
 *
 * `completed`: the purge ran to the end. It attempts EVERY step (it does not
 * abort on the first failure — a transient Redis blip on one step must not leave
 * the others undone) and collects which failed. A non-empty `failedSteps` means
 * the sweep should retry on the next tick; the steps are idempotent, so
 * re-running is safe. `failedSteps` is a closed `PurgeStep` union (never a
 * free-form string), so the real failed steps survive into the sweep's outcomes
 * losslessly (multi-tenant spec SC-010 observability).
 *
 * `superseded`: the tenant was REVIVED (or re-deregistered) while the purge was
 * in flight, so the purge abandoned itself at `abortedAt`. This is neither
 * success nor failure and must NOT be retried — retrying would keep attacking a
 * live tenant. `abortedAt` names the step that was about to run.
 */
export type PurgeOutcome =
  | {
      readonly kind: "completed";
      readonly tenant: TenantId;
      readonly keysDeleted: number;
      readonly failedSteps: readonly PurgeStep[];
    }
  | {
      readonly kind: "superseded";
      readonly tenant: TenantId;
      readonly keysDeleted: number;
      readonly abortedAt: PurgeStep;
    };

// ── Imperative shell: purge one tenant's footprint ────────────────────────────

/**
 * PURGE one deregistered tenant's footprint (multi-tenant spec FR-030, SC-010).
 *
 * Order: revoke the ACL user FIRST (so even a still-running rogue worker loses
 * data-plane access before its keys are deleted), then remove the worker-registry
 * record, then delete the data keyspace, then the filesystem mount, and FINALLY
 * hard-delete the registry tombstone (so the tenant only fully disappears once its
 * footprint is gone). Every step is idempotent and `Result`-checked; a step
 * failure is collected (not thrown, not short-circuited) so the purge reports a
 * complete picture, retains the tombstone, and lets the sweep retry.
 *
 * The caller has ALREADY confirmed (via `isGraceWindowElapsed`) that the window
 * elapsed — this function does no time check itself (the clock stays in the pure
 * predicate), it just executes the purge.
 */
export const purgeTenantFootprint = async (
  deps: GracePurgeDeps,
  cfg: DeregisteredTenantConfig,
): Promise<PurgeOutcome> => {
  const tenant = cfg.id;
  const failedSteps: PurgeStep[] = [];
  let keysDeleted = 0;
  const abandon = (abortedAt: PurgeStep): PurgeOutcome => ({
    kind: "superseded", tenant, keysDeleted, abortedAt,
  });

  // Reserve the exact tombstone BEFORE any destructive I/O. The registry owns
  // this fence and rejects revival/reconfiguration until release, so there is
  // no check-to-action window between the steps below.
  const acquired = await deps.registry.beginPurge(cfg);
  if (!acquired.ok) {
    return {
      kind: "completed",
      tenant,
      keysDeleted,
      failedSteps: ["registry-purge-fence"],
    };
  }
  if (acquired.value.kind === "superseded") return abandon("registry-purge-fence");
  const lease = acquired.value.lease;

  try {
    // Revoke ACL first, then remove process/data footprints. Every operation is
    // idempotent, so collect failures and retain the tombstone for a later retry.
    const aclR = await deps.acl.revokeAcl(tenant);
    if (!aclR.ok) failedSteps.push("acl-revoke");

    const wrR = await deps.workerRegistry.remove(tenant);
    if (!wrR.ok) failedSteps.push("worker-registry-remove");

    const ksR = await deps.keyspace.purgeKeyspace(tenant);
    if (!ksR.ok) failedSteps.push("keyspace-purge");
    else keysDeleted = ksR.value;

    const fsR = await deps.fs.removeMount(cfg.fsRoot);
    if (!fsR.ok) failedSteps.push("fs-remove");

    // A partial footprint must retain its tombstone; otherwise the next sweep
    // cannot retry the failed idempotent step.
    if (failedSteps.length > 0) {
      return { kind: "completed", tenant, keysDeleted, failedSteps };
    }

    const regR = await deps.registry.hardDelete(lease);
    if (!regR.ok) {
      return {
        kind: "completed",
        tenant,
        keysDeleted,
        failedSteps: ["registry-hard-delete"],
      };
    }
    if (regR.value === "superseded") return abandon("registry-hard-delete");
    return { kind: "completed", tenant, keysDeleted, failedSteps };
  } finally {
    await deps.registry.releasePurge(lease);
  }
};

/**
 * A purge fully succeeded iff it ran to completion with no failed step. A
 * `superseded` purge is deliberately NOT a success: nothing was reclaimed
 * because the tenant came back.
 */
export const purgeSucceeded = (outcome: PurgeOutcome): boolean =>
  outcome.kind === "completed" && outcome.failedSteps.length === 0;

const warnWithoutThrowing = (
  logger: LogPort | undefined,
  message: string,
  data: Record<string, unknown>,
): void => {
  try {
    logger?.warn(message, data);
  } catch {
    // A warning transport cannot starve later due tenants in the same sweep.
  }
};

// ── Imperative shell: the sweep ───────────────────────────────────────────────

/**
 * Run one auto-purge sweep over a registry snapshot (multi-tenant spec FR-030, SC-010): select
 * every deregistered tenant whose grace window elapsed at `now`, purge each, and
 * return the outcomes. Driven by the supervisor binary on a timer (the binary
 * owns the interval; the policy — which tenants are due — lives in the pure
 * `selectPurgeable`). A per-tenant purge failure is captured in that tenant's
 * outcome and does NOT abort the sweep, so one stuck tenant never blocks purging
 * the rest.
 */
export const runGracePurgeSweep = async (
  deps: GracePurgeDeps,
  registry: TenantRegistry,
  graceWindowMs: number,
  now: number,
  logger?: LogPort,
): Promise<readonly PurgeOutcome[]> => {
  const due = selectPurgeable(registry, graceWindowMs, now);
  const outcomes: PurgeOutcome[] = [];
  for (const cfg of due) {
    // `purgeTenantFootprint` ALWAYS returns the structured outcome — success and
    // partial-failure alike. We push the GENUINE outcome (real typed
    // `failedSteps` + `keysDeleted`) in every case, so the sweep's report is
    // lossless: a persistently-stuck step is visible per tenant (multi-tenant spec SC-010). A
    // per-tenant failure is captured in that tenant's outcome and never aborts
    // the sweep, so one stuck tenant cannot block purging the rest.
    const outcome = await purgeTenantFootprint(deps, cfg);
    outcomes.push(outcome);
    if (outcome.kind === "superseded") {
      // NOT a retryable failure: the tenant is alive again, so there is nothing
      // left to reclaim. Logged distinctly so an operator can see a revival
      // raced a sweep rather than reading it as a stuck purge.
      warnWithoutThrowing(logger, "[grace-purge] tenant revived mid-purge — abandoning purge", {
        tenant: outcome.tenant,
        abortedAt: outcome.abortedAt,
        keysDeleted: outcome.keysDeleted,
      });
    } else if (outcome.failedSteps.length > 0) {
      warnWithoutThrowing(logger, "[grace-purge] tenant footprint purge partially failed — will retry next sweep", {
        tenant: outcome.tenant,
        failedSteps: outcome.failedSteps,
        keysDeleted: outcome.keysDeleted,
      });
    }
  }
  return outcomes;
};
