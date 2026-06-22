/**
 * Declarative-bootstrap PARSERS (pure functional core).
 *
 * WHY THIS EXISTS (the operational blocker it removes): the multi-tenant
 * supervisor exposes NO team-minting endpoint, and `POST /admin/tenants` requires
 * in-cluster reach to a Route-less host. On a locked-down OpenShift namespace
 * with no `exec`/`port-forward` RBAC there is no way to drive those imperative
 * calls. So tenants + team tokens must instead seed from MOUNTED files at
 * supervisor startup (GitOps: a ConfigMap of tenants + a SealedSecret of team
 * tokens), with no admin API call ever needed (ADR-0064 single-host topology).
 *
 * This module is the PURE parse boundary for those two mounted inputs. No I/O:
 * each function takes the raw file CONTENT (a string) and returns `Result` —
 * never throws. The supervisor shell (`run-bootstrap.ts`) owns the file read and
 * the idempotent apply against the registry + token store.
 *
 * FAIL-CLOSED / PARSE-DON'T-VALIDATE: a malformed file aborts boot (the shell
 * exits non-zero) rather than starting a host with a half-seeded tenant set. A
 * tenant config is validated through the SAME `parseTenantConfigBody` the admin
 * HTTP path uses, so the bootstrap and HTTP paths can never drift.
 *
 * NEVER LOG SECRETS (NFR-014): the team-token parser treats the token VALUE as a
 * secret — every error names only the team (safe) and a structural reason, never
 * the token. (Mirrors `env-file-secrets-source.ts`.)
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { tenantId } from "../../domain/tenant.js";
import { markTeam, isTeamTokenShape, TOKEN_MIN_LENGTH } from "../../domain/auth.js";
import type { Team, TeamTokenShaped } from "../../domain/auth.js";
import { parseTenantConfigBody } from "../registry/parse-tenant-config.js";
import type { ActiveTenantConfig } from "../registry/tenant-registry.js";

/** A `config-invalid` Left (HOST config-LOAD fault) describing a bootstrap-file problem. */
const fileError = (source: string, reason: string): Result<never, HostError> =>
  err({ kind: "config-invalid", message: `bootstrap '${source}': ${reason}` });

/** Same DNS-label shape the admin team-token path enforces (`admin/teams.ts`). */
const TEAM_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ── Tenants bootstrap ────────────────────────────────────────────────────────

/**
 * Parse a tenants-bootstrap file (a JSON ARRAY of tenant config objects) into a
 * list of validated `ActiveTenantConfig`. Each element is an admin-tenants
 * register body PLUS a top-level `id` string; it is branded via `tenantId` and
 * validated through the shared `parseTenantConfigBody`, so a bootstrapped tenant
 * is byte-identical to one registered over HTTP (and the registry's structural
 * idempotency then makes a re-seed a no-op, SC-009).
 *
 * Fail-closed: a non-array, a non-object/idless element, an invalid id, an
 * invalid config, OR a DUPLICATE id all abort with a Left — never a partial seed.
 * A duplicate id is ambiguous (which config wins?) so it is rejected here rather
 * than resolved last-writer-wins silently.
 */
export const parseTenantsBootstrap = (
  source: string,
  raw: string,
): Result<readonly ActiveTenantConfig[], HostError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fileError(source, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(parsed)) {
    return fileError(source, "must be a JSON array of tenant config objects");
  }
  const configs: ActiveTenantConfig[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null) {
      return fileError(source, `entry [${i}] must be a JSON object`);
    }
    const rawId = (entry as Record<string, unknown>).id;
    if (typeof rawId !== "string" || rawId.trim().length === 0) {
      return fileError(source, `entry [${i}] is missing a non-empty string 'id'`);
    }
    const idR = tenantId(rawId.trim());
    if (!idR.ok) return err(idR.error);
    if (seenIds.has(idR.value)) {
      return fileError(source, `duplicate tenant id '${idR.value}' (entry [${i}])`);
    }
    seenIds.add(idR.value);
    const cfgR = parseTenantConfigBody(idR.value, entry);
    if (!cfgR.ok) return err(cfgR.error);
    configs.push(cfgR.value);
  }
  return ok(configs);
};

// ── Team-token bootstrap ─────────────────────────────────────────────────────

/**
 * One team→token seed. The `token` is the PRE-PROVIDED raw team token (sealed
 * once, mounted to BOTH the host and the consuming team's pod) — it is hashed and
 * stored by the shell exactly as `POST /admin/teams` would store a freshly-minted
 * one, but with no one-time-capture step. `TeamTokenShaped` records that it
 * passed the `fug_`-shape gate so it will resolve via the team-token auth path.
 */
export interface TeamTokenSeed {
  readonly team: Team;
  readonly token: TeamTokenShaped;
}

/**
 * Parse a team-tokens-bootstrap file (a JSON OBJECT mapping `team → token`) into
 * a list of `TeamTokenSeed`.
 *
 * The token VALUE is a SECRET: it is validated for shape but NEVER appears in an
 * error message (NFR-014). Each token MUST carry the `fug_` team-token shape
 * (`isTeamTokenShape`) — that is the exact pre-filter the inbound auth path uses
 * to route a bearer token to the hashed team-token lookup, so a token without it
 * would be seeded yet never resolve. Rejecting the shape HERE makes that a loud
 * boot failure instead of a silent 401 for the consuming team at runtime.
 *
 * The team name is canonicalized (`.trim().toLowerCase()`) and DNS-label-shape
 * validated — identical to the admin path and the tenant-config team — so a
 * token's team matches the canonical team a tenant config registers under. A
 * duplicate team (after canonicalization) is ambiguous and rejected. Own
 * enumerable properties only (no prototype keys).
 */
export const parseTeamTokensBootstrap = (
  source: string,
  raw: string,
): Result<readonly TeamTokenSeed[], HostError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fileError(source, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fileError(source, "must be a JSON object mapping team → token");
  }
  const seeds: TeamTokenSeed[] = [];
  const seenTeams = new Set<string>();
  for (const [rawTeam, value] of Object.entries(parsed as Record<string, unknown>)) {
    const team = rawTeam.trim().toLowerCase();
    if (!TEAM_NAME_REGEX.test(team)) {
      return fileError(
        source,
        `team '${rawTeam}' is not a valid name (lowercase alphanumeric + hyphens, starting/ending alphanumeric)`,
      );
    }
    if (seenTeams.has(team)) {
      return fileError(source, `duplicate team '${team}'`);
    }
    seenTeams.add(team);
    // NEVER interpolate the token value — name only the team on any failure.
    if (typeof value !== "string") {
      return fileError(source, `team '${team}': token must be a string`);
    }
    if (!isTeamTokenShape(value)) {
      return fileError(
        source,
        `team '${team}': token must have the team-token shape ('fug_' prefix + ≥${TOKEN_MIN_LENGTH} chars) so it resolves via the team-token auth path`,
      );
    }
    seeds.push({ team: markTeam(team), token: value });
  }
  return ok(seeds);
};
