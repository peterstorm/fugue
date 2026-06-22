/**
 * Declarative bootstrap — IMPERATIVE SHELL (file read + idempotent apply).
 *
 * Seeds the tenant registry and the team-token store from MOUNTED files at
 * supervisor startup, so a multi-tenant host comes up fully provisioned via
 * GitOps (a ConfigMap of tenants + a SealedSecret of team tokens) with NO admin
 * API call and NO `oc exec` — the operational blocker on a locked-down OpenShift
 * namespace (see `parse-bootstrap.ts` for the why).
 *
 * The pure parse/validate lives in `parse-bootstrap.ts`; this shell owns the two
 * effects it cannot: reading the files (injected `readFile`, fail-closed) and
 * applying the parsed result against the live registry + token store. The apply
 * is IDEMPOTENT end-to-end so re-running it on every boot (and on a re-seed of an
 * unchanged file) converges without error:
 *   - tenants → `registry.register`, whose structural-equality check makes an
 *     unchanged config a no-op (SC-009);
 *   - team tokens → reconcile against the store: an identical team+token is a
 *     no-op, a rotated token (same team, new value) UPSERTS, and the same token
 *     reused across two teams fails closed.
 *
 * FAIL-CLOSED: any read/parse/apply error returns a Left; the caller
 * (`main-supervisor.ts`) logs it and exits non-zero so the pod restarts rather
 * than serving a half-seeded host. Tenants are applied BEFORE team tokens, and
 * every token's team is then cross-checked against an active tenant — a token for
 * an unknown team is a misconfiguration caught at boot, not a silent runtime 403.
 *
 * NEVER LOG SECRETS (NFR-014): a team token's value never reaches a log line or
 * an error message here; only the team name and structural reasons do.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { hashToken } from "../../domain/auth.js";
import type { Team, TokenGrant } from "../../domain/auth.js";
import type { TokenStorePort, LogPort } from "../../ports.js";
import type { RedisTenantRegistry } from "../registry/redis-registry-adapter.js";
import { activeTenants } from "../registry/tenant-registry.js";
import { parseTenantsBootstrap, parseTeamTokensBootstrap } from "./parse-bootstrap.js";
import type { TeamTokenSeed } from "./parse-bootstrap.js";

// ── Inputs + dependencies ────────────────────────────────────────────────────

/**
 * The four bootstrap config knobs, already read off `HostConfig`. For each kind a
 * `*Path` (a mounted file — the production path: ConfigMap / SealedSecret) takes
 * precedence over the inline `*` JSON (an env-var convenience for dev/tests). All
 * optional: with none set, bootstrap is a no-op (the legacy single-tenant path).
 */
export interface BootstrapInputs {
  readonly tenantsPath?: string;
  readonly tenantsInline?: string;
  readonly teamTokensPath?: string;
  readonly teamTokensInline?: string;
}

export interface BootstrapDeps {
  /** The live registry — `register` (idempotent) seeds tenants; `snapshot` cross-checks token teams. */
  readonly registry: Pick<RedisTenantRegistry, "register" | "snapshot">;
  /** The supervisor's platform-keyed team-token store (where inbound team tokens resolve). */
  readonly tokenStore: TokenStorePort;
  /** Injected clock for the grant `createdAt` (testability). */
  readonly now: () => number;
  /** Read a mounted file's UTF-8 content; fail closed (Left) on ANY read error. */
  readonly readFile: (path: string) => Result<string, HostError>;
  readonly logger?: LogPort;
}

/** What bootstrap applied — counts only (never a token value), for the boot log. */
export interface BootstrapSummary {
  readonly tenantsApplied: number;
  readonly teamTokensApplied: number;
}

// ── Source resolution (path wins over inline) ─────────────────────────────────

const resolveSource = (
  deps: BootstrapDeps,
  kind: string,
  filePath: string | undefined,
  inline: string | undefined,
): Result<{ source: string; raw: string } | undefined, HostError> => {
  if (filePath !== undefined && filePath.trim().length > 0) {
    const read = deps.readFile(filePath);
    if (!read.ok) return err(read.error);
    return ok({ source: filePath, raw: read.value });
  }
  if (inline !== undefined && inline.trim().length > 0) {
    return ok({ source: `${kind} (inline)`, raw: inline });
  }
  return ok(undefined);
};

// ── Team-token reconcile (idempotent / upsert) ────────────────────────────────

/**
 * Idempotently reconcile ONE team→token seed against the store:
 *   - hash already present for the SAME team → no-op (the common re-boot case);
 *   - hash already present for a DIFFERENT team → the same token was reused across
 *     teams: fail closed (a forged-collision-resistant token can only collide by
 *     misconfiguration);
 *   - hash absent, team free → store;
 *   - hash absent, team taken (a ROTATED token) → revoke the stale token, then
 *     store the new one (UPSERT).
 * The token value is never logged or placed in an error message.
 */
const reconcileTeamToken = async (
  deps: BootstrapDeps,
  seed: TeamTokenSeed,
): Promise<Result<void, HostError>> => {
  const hash = await hashToken(seed.token);
  const existing = await deps.tokenStore.resolve(hash);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) {
    if (existing.value.team === seed.team) return ok(undefined); // identical → no-op
    return err({
      kind: "config-invalid",
      message: `bootstrap team-token: the token provided for team '${seed.team}' is already in use by team '${existing.value.team}' (a token must be unique per team)`,
    });
  }
  const grant: TokenGrant = {
    team: seed.team,
    label: `${seed.team} token (bootstrap)`,
    createdAt: deps.now(),
  };
  const stored = await deps.tokenStore.store(seed.team, hash, grant);
  if (stored.ok) return ok(undefined);
  if (stored.error.kind === "team-already-exists") {
    // Rotation: the team exists with a DIFFERENT (stale) token. Revoke it then
    // store the new one — upsert. Single-supervisor boot is single-threaded, so
    // the revoke→store pair has no concurrent writer to race.
    deps.logger?.info("[bootstrap] rotating team token (team already had a different token)", { team: seed.team });
    const revoked = await deps.tokenStore.revoke(seed.team);
    if (!revoked.ok) return err(revoked.error);
    const reStored = await deps.tokenStore.store(seed.team, hash, grant);
    if (!reStored.ok) return err(reStored.error);
    return ok(undefined);
  }
  return err(stored.error);
};

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Run the full declarative bootstrap: seed tenants, then team tokens. Returns the
 * applied counts on success, a Left on the first read/parse/apply failure
 * (fail-closed). A no-op (returns zero counts) when no bootstrap input is set.
 */
export const runBootstrap = async (
  deps: BootstrapDeps,
  inputs: BootstrapInputs,
): Promise<Result<BootstrapSummary, HostError>> => {
  // ── 1. Tenants ───────────────────────────────────────────────────────────
  const tenantSrc = resolveSource(deps, "TENANTS_BOOTSTRAP", inputs.tenantsPath, inputs.tenantsInline);
  if (!tenantSrc.ok) return err(tenantSrc.error);
  let tenantsApplied = 0;
  if (tenantSrc.value !== undefined) {
    const configsR = parseTenantsBootstrap(tenantSrc.value.source, tenantSrc.value.raw);
    if (!configsR.ok) return err(configsR.error);
    for (const cfg of configsR.value) {
      const reg = await deps.registry.register(cfg, deps.now());
      if (!reg.ok) return err(reg.error);
      tenantsApplied++;
    }
    deps.logger?.info("[bootstrap] tenants seeded", { count: tenantsApplied, source: tenantSrc.value.source });
  }

  // ── 2. Team tokens ─────────────────────────────────────────────────────────
  const tokenSrc = resolveSource(deps, "TEAM_TOKENS_BOOTSTRAP", inputs.teamTokensPath, inputs.teamTokensInline);
  if (!tokenSrc.ok) return err(tokenSrc.error);
  let teamTokensApplied = 0;
  if (tokenSrc.value !== undefined) {
    const seedsR = parseTeamTokensBootstrap(tokenSrc.value.source, tokenSrc.value.raw);
    if (!seedsR.ok) return err(seedsR.error);

    // Cross-check every token's team against an ACTIVE tenant (post-tenant-seed):
    // a token for a team no tenant owns would resolve at the boundary but never
    // route — fail closed at boot rather than 403 the team at runtime.
    const activeTeams = new Set<Team>(activeTenants(deps.registry.snapshot()).map((t) => t.team));
    for (const seed of seedsR.value) {
      if (!activeTeams.has(seed.team)) {
        return err({
          kind: "config-invalid",
          message: `bootstrap team-token: team '${seed.team}' has a token but no active tenant owns it — register the tenant (TENANTS_BOOTSTRAP) for this team`,
        });
      }
    }

    for (const seed of seedsR.value) {
      const reconciled = await reconcileTeamToken(deps, seed);
      if (!reconciled.ok) return err(reconciled.error);
      teamTokensApplied++;
    }
    deps.logger?.info("[bootstrap] team tokens seeded", { count: teamTokensApplied, source: tokenSrc.value.source });
  }

  return ok({ tenantsApplied, teamTokensApplied });
};
