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
 * Parse the optional `agentClientIdsByDag` map from an untrusted body.
 * Fail-closed: a non-object resolves to an empty map (the registry smart
 * constructor is the authority on whether an empty map is acceptable), but a
 * present map with ANY non-string value is REJECTED — a malformed value must
 * never be cast through as a client id. Iterates OWN enumerable properties only,
 * so a prototype key cannot smuggle a value in.
 */
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
 * Parse an untrusted tenant config body into a validated `ActiveTenantConfig`.
 *
 * The `id` arrives already branded (its smart constructor `tenantId` is the seam
 * that validates/brands it); this parser validates the remaining fields and
 * delegates the final invariant checks to the `tenantConfig` smart constructor.
 *
 * Any semantic rejection is translated to `tenant-config-invalid` (→ 400 on the
 * HTTP path; a fatal boot abort on the bootstrap path) rather than the registry's
 * `config-invalid` (→ 500, reserved for host config-LOAD faults).
 */
export const parseTenantConfigBody = (id: TenantId, body: unknown): Result<ActiveTenantConfig, HostError> => {
  if (typeof body !== "object" || body === null) {
    return err(tenantConfigInvalid(`tenant '${id}': request body must be a JSON object`));
  }
  const o = body as Record<string, unknown>;
  const km = (o.keycloakClientMapping ?? {}) as Record<string, unknown>;
  const adm = (o.admission ?? {}) as Record<string, unknown>;
  // Parse-don't-validate the DAG→client map at this trust boundary: every value
  // MUST be a string (a real agent client id). A non-string value is rejected
  // rather than cast through into the registry as a malformed map. Own
  // enumerable properties only (no prototype keys).
  const agentMapResult = parseAgentClientIdsByDag(id, km.agentClientIdsByDag);
  if (!agentMapResult.ok) return agentMapResult;
  // Every tenant worker requires a secrets reference (multi-tenant spec FR-005; `worker-main`
  // hard-requires `FUGUE_SECRETS_REF`). Reject a blank/absent one HERE at the
  // trust boundary rather than letting it reach the registry and surface later as
  // a worker-spawn failure. Parse-don't-validate: a registered tenant always
  // carries a usable, non-blank `SecretsRef`.
  const rawSecretsRef = normalizedField(o.secretsRef);
  if (rawSecretsRef === "") {
    return err(tenantConfigInvalid(`tenant '${id}': secretsRef is required (where the worker resolves this tenant's secrets)`));
  }
  // Every tenant worker requires a DAG root — it becomes the worker's
  // DAGS_LOCAL_PATH (the per-tenant directory it globs `dags/**​/dag.ts` under, so
  // the worker discovers ONLY this team's DAGs). Reject a blank/absent one HERE at
  // the trust boundary rather than letting it reach the registry; the registry
  // smart constructor (`tenantConfig`) is the final tenant-owned `/dags/<id>`
  // assertion. Parse-don't-validate: a registered tenant always carries a usable
  // dagsRoot.
  const rawDagsRoot = normalizedField(o.dagsRoot);
  if (rawDagsRoot === "") {
    return err(tenantConfigInvalid(`tenant '${id}': dagsRoot is required (the per-tenant directory the worker discovers DAGs under)`));
  }
  // Canonicalize and validate the team HERE at the trust boundary, symmetric with
  // secretsRef/dagsRoot above (rather than defaulting to "" and leaning on the
  // registry to reject it). The canonical `.trim().toLowerCase()` form is
  // load-bearing — `canAccessDag` compares `Team` with strict `===` and team
  // tokens are stored under the canonical team, so a verbatim `"Foo"` here would
  // silently 403 a token stored under `"foo"`. The registry `tenantConfig` is the
  // final team↔tenant 1:1 authority; this boundary owns the non-blank+canonical shape.
  const rawTeam = normalizedField(o.team, canonicalizeTeamName);
  if (rawTeam === "") {
    return err(tenantConfigInvalid(`tenant '${id}': team is required (the canonical team that owns this tenant's DAGs and token)`));
  }
  // Every tenant requires a per-tenant on-disk mount (`fsRoot`) — the directory the
  // grace-window purge reclaims and the worker's confined filesystem root. Reject a
  // blank/absent one HERE, symmetric with dagsRoot/secretsRef; the registry
  // `tenantConfig` is the final tenant-owned `/srv/<id>` authority over this value.
  const rawFsRoot = normalizedField(o.fsRoot);
  if (rawFsRoot === "") {
    return err(tenantConfigInvalid(`tenant '${id}': fsRoot is required (the per-tenant on-disk mount the worker is confined to)`));
  }
  // Parse-don't-validate the admission limits at this trust boundary: both MUST be
  // numbers. A non-number (`"5"`, `true`, `[]`, `null`) is REJECTED rather than
  // coerced via `Number(...)` into a valid-looking limit. The registry smart
  // constructor (`tenantConfig`) is the final non-negative-integer assertion over
  // these already-typed numbers.
  if (typeof adm.maxConcurrentRuns !== "number" || typeof adm.maxQueuedRuns !== "number") {
    return err(tenantConfigInvalid(`tenant '${id}': admission.maxConcurrentRuns and admission.maxQueuedRuns are required and must be numbers`));
  }
  // Parse the Keycloak realm/clientId HERE at the trust boundary, symmetric with
  // secretsRef/dagsRoot/team above (rather than defaulting a non-string to "" and
  // leaning on the registry to reject it later as "non-empty" — which misdescribes
  // the actual fault for, e.g., `realm: 123`). Both are required and non-blank.
  const rawRealm = normalizedField(km.realm);
  if (rawRealm === "") {
    return err(tenantConfigInvalid(`tenant '${id}': keycloakClientMapping.realm is required and must be a non-blank string`));
  }
  const rawClientId = normalizedField(km.clientId);
  if (rawClientId === "") {
    return err(tenantConfigInvalid(`tenant '${id}': keycloakClientMapping.clientId is required and must be a non-blank string`));
  }
  const base: TenantConfigBase = {
    id,
    // Non-blank-checked above. Brand via `canonicalTeam` (not `markTeam`) so the
    // canonical form is enforced BY CONSTRUCTION here rather than depending on the
    // local ordering that `rawTeam` was already canonicalized — idempotent, since
    // `rawTeam` is `canonicalizeTeamName(o.team)`. The canonical team is load-bearing
    // for `canAccessDag`'s strict `===` and team-token routing.
    team: canonicalTeam(rawTeam),
    keycloakClientMapping: {
      realm: rawRealm,
      clientId: rawClientId,
      agentClientIdsByDag: agentMapResult.value,
    },
    fsRoot: rawFsRoot,
    dagsRoot: rawDagsRoot,
    secretsRef: markSecretsRef(rawSecretsRef),
    admission: {
      maxConcurrentRuns: adm.maxConcurrentRuns,
      maxQueuedRuns: adm.maxQueuedRuns,
    },
    eagerPin: o.eagerPin === true,
  };
  // The registry smart constructor validates the parsed body. A semantic
  // rejection is a CLIENT error here (a bad config), so translate its
  // `config-invalid` (→ 500, reserved for host config-LOAD faults) into
  // `tenant-config-invalid` (→ 400) at this boundary. Any other error kind is
  // passed through unchanged.
  const built = tenantConfig(base);
  if (!built.ok && built.error.kind === "config-invalid") {
    return err(tenantConfigInvalid(built.error.message));
  }
  return built;
};
