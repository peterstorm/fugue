/**
 * Shared tenant-config PARSE BOUNDARY (parse-don't-validate).
 *
 * This is the ONE validated parser that turns an untrusted JSON-shaped tenant
 * config body into a validated `ActiveTenantConfig`. It is shared by BOTH write
 * paths so they can never drift:
 *   - the admin HTTP handler (`http/handlers/admin/tenants.ts`, `POST/PATCH
 *     /admin/tenants(/:id)`), and
 *   - the declarative BOOTSTRAP path (`supervisor/bootstrap/*`), which seeds
 *     tenants from a mounted ConfigMap at supervisor startup with no admin API.
 *
 * Both feed the SAME `tenantConfig` smart constructor (`tenant-registry.ts`), so
 * a config that registers over HTTP and the identical config seeded from the
 * bootstrap file produce a byte-identical `ActiveTenantConfig` — and the registry
 * `register`'s structural-equality idempotency (multi-tenant spec SC-009) then treats a
 * bootstrap-then-HTTP (or re-boot) of the same config as a no-op.
 *
 * PURE: no I/O. Takes an already-branded `TenantId` plus the untrusted body and
 * returns `Result` — never throws. Illegal states are rejected at this boundary
 * so downstream code only ever sees a valid `ActiveTenantConfig`.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { markSecretsRef } from "../../domain/tenant.js";
import { canonicalTeam, canonicalizeTeamName } from "../../domain/auth.js";
import type { TenantId } from "../../domain/tenant.js";
import { tenantConfig } from "./tenant-registry.js";
import type { ActiveTenantConfig, TenantConfigBase } from "./tenant-registry.js";
import { tenantConfigInvalid } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";

/**
 * Normalize a required string field from an untrusted config object, or `""`
 * when it is absent or not a string.
 *
 * ONE encoding of the coerce-or-empty step that six required fields share
 * (`secretsRef`, `dagsRoot`, `team`, `fsRoot`, `keycloakClientMapping.realm`,
 * `keycloakClientMapping.clientId`). A non-string is deliberately folded to `""`
 * rather than coerced with `String(...)`: `{ dagsRoot: 123 }` must be REJECTED as
 * missing, not silently accepted as the path `"123"`.
 *
 * `normalize` defaults to `trim`; `team` passes `canonicalizeTeamName` instead,
 * because its canonical lowercase form is load-bearing for token lookup. Each
 * caller keeps its own blank check so the rejection names the specific field and
 * explains what that field is for.
 */
const normalizedField = (
  raw: unknown,
  normalize: (value: string) => string = (value) => value.trim(),
): string => (typeof raw === "string" ? normalize(raw) : "");

/**
 * Parse the optional `agentClientIdsByDag` map from an untrusted body.
 * Fail-closed: a non-object resolves to an empty map, while any present
 * non-string value is rejected. Only own enumerable properties are read.
 */
const parseAgentClientIdsByDag = (
  id: TenantId,
  raw: unknown,
): Result<Record<string, string>, HostError> => {
  if (typeof raw !== "object" || raw === null) return ok({});
  const out: Record<string, string> = {};
  for (const [dag, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return err(
        tenantConfigInvalid(
          `tenant '${id}': keycloakClientMapping.agentClientIdsByDag['${dag}'] must be a string client id`,
        ),
      );
    }
    out[dag] = value;
  }
  return ok(out);
};

/**
 * Parse one required, non-blank string field at the trust boundary. A blank or
 * absent value is rejected HERE rather than reaching the registry and surfacing
 * later as a worker-spawn failure (parse-don't-validate); `requirement` names
 * the field and what it is for.
 */
const parseRequiredField = (
  id: TenantId,
  raw: unknown,
  requirement: string,
  normalize?: (value: string) => string,
): Result<string, HostError> => {
  const value = normalizedField(raw, normalize);
  return value === "" ? err(tenantConfigInvalid(`tenant '${id}': ${requirement}`)) : ok(value);
};

/**
 * Parse-don't-validate the admission limits at this trust boundary: both MUST be
 * numbers. A non-number (`"5"`, `true`, `[]`, `null`) is REJECTED rather than
 * coerced via `Number(...)` into a valid-looking limit. The registry smart
 * constructor (`tenantConfig`) is the final non-negative-integer assertion over
 * these already-typed numbers.
 */
const parseAdmission = (
  id: TenantId,
  adm: Record<string, unknown>,
): Result<TenantConfigBase["admission"], HostError> => {
  if (typeof adm.maxConcurrentRuns !== "number" || typeof adm.maxQueuedRuns !== "number") {
    return err(tenantConfigInvalid(`tenant '${id}': admission.maxConcurrentRuns and admission.maxQueuedRuns are required and must be numbers`));
  }
  return ok({ maxConcurrentRuns: adm.maxConcurrentRuns, maxQueuedRuns: adm.maxQueuedRuns });
};

/**
 * The registry smart constructor validates the parsed body. A semantic
 * rejection is a CLIENT error here (a bad config), so translate its
 * `config-invalid` (→ 500, reserved for host config-LOAD faults) into
 * `tenant-config-invalid` (→ 400) at this boundary. Any other error kind is
 * passed through unchanged.
 */
const buildTenantConfig = (base: TenantConfigBase): Result<ActiveTenantConfig, HostError> => {
  const built = tenantConfig(base);
  if (!built.ok && built.error.kind === "config-invalid") {
    return err(tenantConfigInvalid(built.error.message));
  }
  return built;
};

/**
 * Parse an untrusted tenant config body into a validated `ActiveTenantConfig`.
 *
 * The `id` arrives already branded (its smart constructor `tenantId` is the seam
 * that validates/brands it); this parser validates the remaining fields and
 * delegates the final invariant checks to the `tenantConfig` smart constructor.
 *
 * Any semantic rejection is translated to `tenant-config-invalid` (→ 400 on the
 * HTTP path; a fatal boot abort on the bootstrap path) rather than the registry's
 * `config-invalid` (→ 500, reserved for host config-LOAD faults).
 *
 * Fields are parsed in a fixed order, so the FIRST fault is the one reported.
 */
export const parseTenantConfigBody = (id: TenantId, body: unknown): Result<ActiveTenantConfig, HostError> => {
  if (typeof body !== "object" || body === null) {
    return err(tenantConfigInvalid(`tenant '${id}': request body must be a JSON object`));
  }
  const o = body as Record<string, unknown>;
  const km = (o.keycloakClientMapping ?? {}) as Record<string, unknown>;
  const adm = (o.admission ?? {}) as Record<string, unknown>;
  // Every value of the DAG→client map MUST be a string (a real agent client id).
  const agentMapResult = parseAgentClientIdsByDag(id, km.agentClientIdsByDag);
  if (!agentMapResult.ok) return agentMapResult;
  // Every tenant worker requires a secrets reference (multi-tenant spec FR-005).
  const secretsRef = parseRequiredField(id, o.secretsRef, "secretsRef is required (where the worker resolves this tenant's secrets)");
  if (!secretsRef.ok) return secretsRef;
  // The DAG root becomes the worker's DAGS_LOCAL_PATH: it discovers ONLY this team's DAGs.
  const dagsRoot = parseRequiredField(id, o.dagsRoot, "dagsRoot is required (the per-tenant directory the worker discovers DAGs under)");
  if (!dagsRoot.ok) return dagsRoot;
  // The canonical `.trim().toLowerCase()` team form is load-bearing: `canAccessDag`
  // compares `Team` with strict `===` and team tokens are stored under the canonical team.
  const team = parseRequiredField(id, o.team, "team is required (the canonical team that owns this tenant's DAGs and token)", canonicalizeTeamName);
  if (!team.ok) return team;
  // The per-tenant on-disk mount the grace-window purge reclaims.
  const fsRoot = parseRequiredField(id, o.fsRoot, "fsRoot is required (the per-tenant on-disk mount the worker is confined to)");
  if (!fsRoot.ok) return fsRoot;
  const admission = parseAdmission(id, adm);
  if (!admission.ok) return admission;
  // Keycloak realm/clientId are both required and non-blank (symmetric with the fields above).
  const realm = parseRequiredField(id, km.realm, "keycloakClientMapping.realm is required and must be a non-blank string");
  if (!realm.ok) return realm;
  const clientId = parseRequiredField(id, km.clientId, "keycloakClientMapping.clientId is required and must be a non-blank string");
  if (!clientId.ok) return clientId;
  return buildTenantConfig({
    id,
    // Brand via `canonicalTeam` (not `markTeam`) so the canonical form is enforced
    // BY CONSTRUCTION here — idempotent, since `team` is already canonicalized.
    team: canonicalTeam(team.value),
    keycloakClientMapping: {
      realm: realm.value,
      clientId: clientId.value,
      agentClientIdsByDag: agentMapResult.value,
    },
    fsRoot: fsRoot.value,
    dagsRoot: dagsRoot.value,
    secretsRef: markSecretsRef(secretsRef.value),
    admission: admission.value,
    eagerPin: o.eagerPin === true,
  });
};
