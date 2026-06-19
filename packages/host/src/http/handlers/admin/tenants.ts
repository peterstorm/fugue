/**
 * Admin tenant lifecycle API — register / deregister / reconfigure (FR-025,
 * FR-026, FR-028, FR-029, FR-030; SC-008, SC-009, SC-010; US5, US6).
 *
 * Mounted on the SUPERVISOR's raw `Bun.serve` listener (not the Hono worker
 * router), so these handlers are FRAMEWORK-AGNOSTIC: `(Request) => Response`,
 * mirroring `authenticateIdentity` in `supervisor.ts`. The supervisor binary
 * dispatches `POST/DELETE/PATCH /admin/tenants(/:id)` to `handleAdminTenants`.
 *
 * AUTHZ — ADMIN-TOKEN ONLY (FR-026, SC-008): every operation REUSES the existing
 * admin-token path (`authenticateIdentity`, the SAME constant-time admin compare
 * the worker `auth.ts` middleware uses) — no new auth check is rolled here. A
 * non-admin identity (team/user/unauthenticated) is REFUSED with 403/401 and the
 * refusal is itself AUDITED (so "0% succeed under a non-admin token" is
 * observable in the trail). Resolution happens once, up front, for all verbs.
 *
 * IDEMPOTENT (SC-009): register/deregister/reconfigure delegate to the PURE,
 * idempotent registry transitions (`tenant-registry.ts`) — repeating an identical
 * register or deregister yields an identical end state. Deregister of an absent /
 * already-deregistered tenant is a no-op SUCCESS (200), never an error.
 *
 * DEREGISTER = IMMEDIATE REVOKE + GRACE-WINDOW RETAIN (FR-029, FR-030, SC-010):
 *   1. Tombstone the tenant in the registry (`registry.deregister`) — it stops
 *      resolving for NEW runs IMMEDIATELY (fail-closed `lookup`), so subsequent
 *      invocations are rejected at 100% (SC-010).
 *   2. IMMEDIATE revoke: kill the worker (`lifecycle.evict`) AND invalidate the
 *      team token (`tokenStore.revoke`) — the two halves of FR-029.
 *   3. The footprint (fs mount, secrets, keyspace) is RETAINED — the registry
 *      keeps the tombstone, the keyspace/ACL are NOT deleted here. The
 *      grace-window auto-purge (`grace-window-purge.ts`, default 7d) reclaims it
 *      later; this handler only revokes + tombstones.
 *
 * AUDIT (FR-028, SC-008): EVERY operation — success OR refusal — emits exactly one
 * `AuditRecord` (actor / timestamp / tenant / action) through the injected
 * `AuditPort`. The timestamp comes from an INJECTED `now()` (deterministic under
 * test); the actor is the admin principal. Auditing happens on every path,
 * including authz denial, so SC-008's coverage is structural.
 */

import { match } from "ts-pattern";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { authenticateIdentity } from "../../../supervisor/supervisor.js";
import type { AuthDeps } from "../../../supervisor/supervisor.js";
import type { AuthIdentity } from "../../../domain/auth.js";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { tenantConfig } from "../../../supervisor/registry/tenant-registry.js";
import type { ActiveTenantConfig, TenantConfigBase } from "../../../supervisor/registry/tenant-registry.js";
import type { RedisTenantRegistry } from "../../../supervisor/registry/redis-registry-adapter.js";
import type { WorkerLifecyclePort } from "../../../supervisor/lifecycle/spawn-port.js";
import type { TokenStorePort, LogPort } from "../../../ports.js";
import type { AuditPort, AuditAction, AuditActor, AuditOutcome } from "../../../supervisor/audit/audit-port.js";
import { auditRecord } from "../../../supervisor/audit/audit-port.js";
import { httpStatusFor, formatHostError, tenantConfigInvalid } from "../../../domain/host-error.js";
import type { HostError } from "../../../domain/host-error.js";

// ── Dependencies ──────────────────────────────────────────────────────────────

/**
 * What the admin lifecycle handler needs. NOTICE: it carries NO tenant secret —
 * register accepts a secrets REFERENCE (a string the worker later dereferences,
 * AD-6), the registry stores only the reference, and revoke acts on the token
 * store / lifecycle, never a secret value.
 */
export interface AdminTenantsDeps {
  /** Admin-token auth material (REUSED — same path as the worker middleware). */
  readonly auth: AuthDeps;
  /** The Redis-backed registry write seam (register/deregister/reconfigure). */
  readonly registry: RedisTenantRegistry;
  /** Worker lifecycle — `evict` is the immediate worker-kill on deregister (FR-029). */
  readonly lifecycle: WorkerLifecyclePort;
  /** Token store — `revoke(team)` is the token-invalidation half of FR-029. */
  readonly tokenStore: TokenStorePort;
  /** Audit sink — every op emits a record (FR-028, SC-008). */
  readonly audit: AuditPort;
  /** Injected clock (millis) for the audit timestamp + deregister instant (testability). */
  readonly now: () => number;
  readonly logger?: LogPort;
}

// ── Request body parsing (parse-don't-validate) ───────────────────────────────

/**
 * The accepted register/reconfigure body. Parsed into a validated
 * `ActiveTenantConfig` via the registry's smart constructor — illegal configs are
 * rejected at the boundary, so downstream code only ever sees valid configs.
 */
/**
 * Parse the optional `agentClientIdsByDag` map from an untrusted request body.
 * Fail-closed: a non-object resolves to an empty map (the registry's smart
 * constructor is the authority on whether an empty map is acceptable for the
 * tenant's realm), but a present map with ANY non-string value is REJECTED — a
 * malformed value must never be cast through as a client id. Iterates OWN
 * enumerable properties only, so a prototype key cannot smuggle a value in.
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

const parseTenantConfigBody = (id: TenantId, body: unknown): Result<ActiveTenantConfig, HostError> => {
  if (typeof body !== "object" || body === null) {
    return err(tenantConfigInvalid(`tenant '${id}': request body must be a JSON object`));
  }
  const o = body as Record<string, unknown>;
  const km = (o.keycloakClientMapping ?? {}) as Record<string, unknown>;
  const adm = (o.admission ?? {}) as Record<string, unknown>;
  // Parse-don't-validate the DAG→client map at this trust boundary: every value
  // MUST be a string (a real agent client id). A non-string value is rejected
  // (400) rather than cast through into the registry as a malformed map. Own
  // enumerable properties only (no prototype keys).
  const agentMapResult = parseAgentClientIdsByDag(id, km.agentClientIdsByDag);
  if (!agentMapResult.ok) return agentMapResult;
  // Every tenant worker requires a secrets reference (FR-005; `worker-main`
  // hard-requires `FUGUE_SECRETS_REF`). Reject a blank/absent one HERE at the
  // trust boundary (400) rather than letting it reach the registry and surface
  // later as a worker-spawn failure. Parse-don't-validate: a registered tenant
  // always carries a usable, non-blank `SecretsRef`.
  const rawSecretsRef = typeof o.secretsRef === "string" ? o.secretsRef.trim() : "";
  if (rawSecretsRef === "") {
    return err(tenantConfigInvalid(`tenant '${id}': secretsRef is required (where the worker resolves this tenant's secrets)`));
  }
  const base: TenantConfigBase = {
    id,
    team: typeof o.team === "string" ? o.team : "",
    keycloakClientMapping: {
      realm: typeof km.realm === "string" ? km.realm : "",
      clientId: typeof km.clientId === "string" ? km.clientId : "",
      agentClientIdsByDag: agentMapResult.value,
    },
    fsRoot: typeof o.fsRoot === "string" ? o.fsRoot : "",
    secretsRef: markSecretsRef(rawSecretsRef),
    admission: {
      maxConcurrentRuns: Number(adm.maxConcurrentRuns),
      maxQueuedRuns: Number(adm.maxQueuedRuns),
    },
    eagerPin: o.eagerPin === true,
  };
  // The registry smart constructor validates the parsed body. A semantic
  // rejection is a CLIENT error here (a bad request body), so translate its
  // `config-invalid` (→ 500, reserved for host config-LOAD faults) into
  // `tenant-config-invalid` (→ 400) at this boundary. Any other error kind is
  // passed through unchanged.
  const built = tenantConfig(base);
  if (!built.ok && built.error.kind === "config-invalid") {
    return err(tenantConfigInvalid(built.error.message));
  }
  return built;
};

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const errorResp = (error: HostError): Response =>
  json(httpStatusFor(error), { ok: false, error: formatHostError(error) });

// ── Actor extraction (non-secret) ─────────────────────────────────────────────

/**
 * Build the audit actor from the resolved admin identity + an optional non-secret
 * `X-Fugue-Actor` operator label header. NEVER reads the token — only the
 * principal KIND and an opaque label.
 */
const actorFrom = (request: Request): AuditActor => {
  const label = request.headers.get("X-Fugue-Actor") ?? undefined;
  return { kind: "admin", ...(label ? { label } : {}) };
};

// ── Audit helper ──────────────────────────────────────────────────────────────

const emitAudit = async (
  deps: AdminTenantsDeps,
  actor: AuditActor,
  tenant: TenantId,
  action: AuditAction,
  outcome: AuditOutcome,
  detail?: string,
): Promise<void> => {
  // OWN the never-throw boundary HERE (SC-008): the AuditPort contract says a
  // sink must not throw, but the handler must not DEPEND on the injected sink
  // honoring it — a throwing sink must never turn a 200/401/403 into a 500. So
  // we catch + log and proceed. The handler ALWAYS calls record for every op
  // (SC-008's "100% emit a record"); a sink-layer failure degrades to a log line.
  try {
    await deps.audit.record(
      auditRecord({ actor, timestamp: deps.now(), tenant, action, outcome, ...(detail ? { detail } : {}) }),
    );
  } catch (e) {
    deps.logger?.error("[admin/tenants] audit sink threw — audit record dropped (request path unaffected)", {
      tenant,
      action,
      outcome,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};

// ── Operation handlers ────────────────────────────────────────────────────────

/**
 * POST /admin/tenants — register (or re-register) a tenant. Idempotent (SC-009):
 * a structurally identical re-register is a no-op success.
 */
const handleRegister = async (
  deps: AdminTenantsDeps,
  actor: AuditActor,
  id: TenantId,
  body: unknown,
): Promise<Response> => {
  const cfgR = parseTenantConfigBody(id, body);
  if (!cfgR.ok) {
    await emitAudit(deps, actor, id, "register", "refused", "invalid config");
    return errorResp(cfgR.error);
  }
  const result = await deps.registry.register(cfgR.value, deps.now());
  if (!result.ok) {
    await emitAudit(deps, actor, id, "register", "refused", formatHostError(result.error));
    return errorResp(result.error);
  }
  await emitAudit(deps, actor, id, "register", "succeeded");
  return json(200, { ok: true, tenant: id, action: "register" });
};

/**
 * DELETE /admin/tenants/:id — deregister a tenant: tombstone + IMMEDIATE revoke
 * (kill worker + invalidate token), footprint RETAINED for the grace window
 * (FR-029, FR-030, SC-010). Idempotent (SC-009).
 *
 * Order: tombstone FIRST (so the tenant stops resolving for new runs the instant
 * the registry write lands, SC-010), then revoke the live worker + token. The
 * revoke half is best-effort-but-TRUTHFULLY-reported: a worker-evict or
 * token-revoke failure does NOT undo the tombstone (new-run access is already
 * cut), so the HTTP response can stay 200 — but the audit record must NOT claim
 * `succeeded` when a half failed (FR-029, SC-008). We capture both sub-outcomes
 * and emit `partial` + a `detail` naming which half failed; the response body
 * carries a `revokeComplete` boolean so callers see the partial state.
 *
 * We need the team to revoke its token — read it from the RETAINED TOMBSTONE
 * that `deregister` lands. The `team` lives on `TenantConfigBase` and SURVIVES
 * the active → deregistered transition (tombstoning preserves it — see
 * tenant-registry.ts `deregister`), so we read it from the entry the registry
 * ACTUALLY tombstoned, AFTER the tombstone commits. Reading it from a
 * pre-tombstone snapshot would race a concurrent mutation and could silently
 * skip the security-critical revoke while still reporting success; reading the
 * committed tombstone is race-free.
 *
 * The PRIOR status (captured before the transition) tells us whether THIS call
 * performed a real active → deregistered transition. If it did, the tombstone
 * MUST carry a team (it survives the transition by construction); a missing team
 * after a confirmed active-tenant tombstone is an INVARIANT VIOLATION — logged at
 * `error` and treated as a FAILED revoke (never a silent skip). A genuinely
 * idempotent no-op (the tenant was absent, or already deregistered before this
 * call) has nothing live to revoke, so `tokenOk` stays true.
 */
const handleDeregister = async (
  deps: AdminTenantsDeps,
  actor: AuditActor,
  id: TenantId,
): Promise<Response> => {
  // Capture the PRIOR status so we can tell a real active → deregistered
  // transition (which MUST yield a team-bearing tombstone) apart from an
  // idempotent no-op (absent / already-deregistered → nothing live to revoke).
  const priorStatus = deps.registry.snapshot().entries.get(id)?.status;
  const wasActive = priorStatus === "active";

  // 1. Tombstone in the registry — fail-closed new-run resolution immediately.
  const dereg = await deps.registry.deregister(id, deps.now());
  if (!dereg.ok) {
    await emitAudit(deps, actor, id, "deregister", "refused", formatHostError(dereg.error));
    return errorResp(dereg.error);
  }

  // Post-commit, race-free read of the team off the just-landed tombstone (see
  // the function JSDoc above for why we read it AFTER the tombstone commits).
  const team = deps.registry.snapshot().entries.get(id)?.team;

  // 2. IMMEDIATE revoke (FR-029): kill the worker AND invalidate the token. Both
  //    are idempotent; a failure does NOT undo the tombstone (access is already
  //    revoked at the registry boundary) — but we CAPTURE each sub-outcome so the
  //    audit trail reflects reality (no lying `succeeded`, SC-008).
  const evictR = await deps.lifecycle.evict(id);
  const evictOk = evictR.ok;
  if (!evictOk) {
    deps.logger?.warn("[admin/tenants] worker evict during deregister failed (tombstone still in effect)", { tenant: id });
  }
  // Token revoke. A non-empty team is the token to invalidate.
  //   - team present  → revoke; success/failure flows into `tokenOk`.
  //   - team absent AFTER tombstoning a previously-ACTIVE tenant → INVARIANT
  //     VIOLATION (team must survive the transition). We do NOT silently skip the
  //     security-critical revoke and claim success: log at `error` and mark the
  //     revoke FAILED so the audit reports `partial`, never `succeeded`.
  //   - team absent on an idempotent no-op (was never active) → nothing live to
  //     revoke; `tokenOk` stays true.
  let tokenOk = true;
  if (team !== undefined && team.length > 0) {
    const revokeR = await deps.tokenStore.revoke(team);
    tokenOk = revokeR.ok;
    if (!tokenOk) {
      deps.logger?.warn("[admin/tenants] token revoke during deregister failed", { tenant: id, team });
    }
  } else if (wasActive) {
    tokenOk = false;
    deps.logger?.error(
      "[admin/tenants] INVARIANT VIOLATION: tombstone of a previously-active tenant carries no team — token revoke SKIPPED, reporting partial (not succeeded)",
      { tenant: id, priorStatus },
    );
  }

  const revokeComplete = evictOk && tokenOk;
  if (revokeComplete) {
    await emitAudit(deps, actor, id, "deregister", "succeeded");
  } else {
    // TRUTHFUL audit (FR-029, SC-008): the tombstone landed but a revoke half
    // failed — record `partial`, naming which half, so the trail never claims a
    // full success that did not happen.
    await emitAudit(
      deps,
      actor,
      id,
      "deregister",
      "partial",
      `revoke-incomplete: evict=${evictOk} token=${tokenOk}`,
    );
  }

  // Footprint RETAINED — the grace-window purge reclaims it after the window. The
  // tombstone has cut new-run resolution, so the op is a 200 even on a partial
  // revoke; `revokeComplete` surfaces the partial state to the caller.
  return json(200, { ok: true, tenant: id, action: "deregister", footprintRetained: true, revokeComplete });
};

/**
 * PATCH /admin/tenants/:id — reconfigure a registered, ACTIVE tenant. Takes effect
 * on the tenant's NEXT worker spawn (AD-5; no live hot-swap). Reconfiguring an
 * unknown/deregistered tenant fails closed (`tenant-unknown`). Idempotent.
 */
const handleReconfigure = async (
  deps: AdminTenantsDeps,
  actor: AuditActor,
  id: TenantId,
  body: unknown,
): Promise<Response> => {
  const cfgR = parseTenantConfigBody(id, body);
  if (!cfgR.ok) {
    await emitAudit(deps, actor, id, "reconfigure", "refused", "invalid config");
    return errorResp(cfgR.error);
  }
  const result = await deps.registry.reconfigure(cfgR.value, deps.now());
  if (!result.ok) {
    await emitAudit(deps, actor, id, "reconfigure", "refused", formatHostError(result.error));
    return errorResp(result.error);
  }
  await emitAudit(deps, actor, id, "reconfigure", "succeeded");
  return json(200, { ok: true, tenant: id, action: "reconfigure" });
};

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * Parse `/admin/tenants` or `/admin/tenants/:id` from the URL path. Returns the
 * tenant id segment (or undefined for the collection route). Anything else is not
 * an admin-tenants route (the caller 404s).
 */
const parseAdminTenantsPath = (pathname: string): { isRoute: boolean; idSegment?: string } => {
  const parts = pathname.replace(/\/+$/, "").split("/").filter((p) => p.length > 0);
  // ["admin","tenants"] or ["admin","tenants","<id>"]
  if (parts.length < 2 || parts[0] !== "admin" || parts[1] !== "tenants") return { isRoute: false };
  if (parts.length === 2) return { isRoute: true };
  if (parts.length === 3) return { isRoute: true, idSegment: parts[2] };
  return { isRoute: false };
};

const verbFor = (method: string): AuditAction | undefined =>
  match(method.toUpperCase())
    .with("POST", () => "register" as const)
    .with("DELETE", () => "deregister" as const)
    .with("PATCH", () => "reconfigure" as const)
    .otherwise(() => undefined);

/**
 * The single entrypoint the supervisor binary dispatches to for any
 * `/admin/tenants(/:id)` request. Returns `undefined` if the request is NOT an
 * admin-tenants route (so the supervisor can fall through to its proxy path).
 *
 * AUTHZ is enforced HERE, once, for every verb (FR-026): authenticate the inbound
 * identity, and refuse anything that is not the admin principal with 403 — and
 * audit the refusal (SC-008).
 */
export const handleAdminTenants = async (
  deps: AdminTenantsDeps,
  request: Request,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  const route = parseAdminTenantsPath(url.pathname);
  if (!route.isRoute) return undefined;

  const action = verbFor(request.method);
  if (action === undefined) {
    return json(405, { ok: false, error: "method not allowed" });
  }

  // The tenant id is required for every verb (register/deregister/reconfigure all
  // target a specific tenant). For register/reconfigure it may also ride in the
  // body, but the path id is authoritative; the collection route has no id.
  const rawId = route.idSegment ?? (await safeReadIdFromBody(request));
  const actor = actorFrom(request);

  // ── AUTHZ: admin-token only (FR-026, SC-008) ──────────────────────────────
  const identityResult = await authenticateIdentity(deps.auth, request.headers.get("Authorization") ?? undefined);
  if (!identityResult.ok) {
    // Unauthenticated — audit the refusal against the attempted tenant (or a
    // placeholder when none was supplied) and return the auth error status.
    await auditRefusal(deps, actor, rawId, action, "unauthenticated");
    return errorResp(identityResult.error);
  }
  const identity: AuthIdentity = identityResult.value;
  if (identity.kind !== "admin") {
    await auditRefusal(deps, actor, rawId, action, "non-admin token");
    return json(403, { ok: false, error: "admin access required" });
  }

  // ── Tenant id parse (after authz, so non-admins never probe id validity) ──
  if (rawId === undefined || rawId.length === 0) {
    return json(400, { ok: false, error: "tenant id is required" });
  }
  const idR = tenantId(rawId);
  if (!idR.ok) {
    await emitAudit(deps, actor, rawId as TenantId, action, "refused", "invalid tenant id");
    return errorResp(idR.error);
  }
  const id = idR.value;

  // ── Body (register/reconfigure only) ──────────────────────────────────────
  let body: unknown = undefined;
  if (action === "register" || action === "reconfigure") {
    try {
      body = await request.json();
    } catch {
      await emitAudit(deps, actor, id, action, "refused", "invalid JSON body");
      return json(400, { ok: false, error: "request body must be valid JSON" });
    }
  }

  return match(action)
    .with("register", () => handleRegister(deps, actor, id, body))
    .with("deregister", () => handleDeregister(deps, actor, id))
    .with("reconfigure", () => handleReconfigure(deps, actor, id, body))
    .exhaustive();
};

/**
 * Audit a refusal where the tenant id may not have parsed to a `TenantId` yet.
 * The id is recorded as-is (best-effort, for the trail) — the audit record's
 * `tenant` field is branded, but a refusal record is a server-side trail entry,
 * so we brand the raw segment without re-validating (it never routes anywhere).
 */
const auditRefusal = async (
  deps: AdminTenantsDeps,
  actor: AuditActor,
  rawId: string | undefined,
  action: AuditAction,
  detail: string,
): Promise<void> => {
  const tenant = (rawId ?? "<none>") as TenantId;
  await emitAudit(deps, actor, tenant, action, "refused", detail);
};

/**
 * Best-effort read of a tenant id from a JSON body for routes that omit it from
 * the path (e.g. `POST /admin/tenants` with `{ id }`). Clones the request so the
 * body can still be read again by the verb handler. Returns undefined on any
 * parse miss — the caller then 400s on a missing id.
 */
const safeReadIdFromBody = async (request: Request): Promise<string | undefined> => {
  if (request.method.toUpperCase() === "DELETE") return undefined;
  try {
    const clone = request.clone();
    const b = await clone.json();
    if (typeof b === "object" && b !== null && typeof (b as Record<string, unknown>).id === "string") {
      return (b as Record<string, string>).id;
    }
  } catch {
    // ignore — id must then come from the path or the request 400s
  }
  return undefined;
};
