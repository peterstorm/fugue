/**
 * Configuration schemas for the Fugue host.
 *
 * - HostConfigSchema: validates environment variables for host startup
 * - FugueYamlSchema: validates per-DAG fugue.yaml configuration
 *
 * Satisfies:
 * - FR-006: Redis URL required (host refuses to start if missing/unreachable)
 * - FR-013: Sensible defaults for all optional config fields
 * - FR-040 (host-TTL): Global TTL defaults for cache and checkpoint entries
 * - FR-041 (host-TTL): Per-DAG TTL overrides in fugue.yaml
 * - FR-100: fugue.yaml declares team, owner, env, limit overrides
 *
 * NOTE: FR-040/FR-041 collide across two specs. The host-TTL spec owns the
 * cache/checkpoint TTL fields above; the keycloak-entra-wiring spec owns the
 * agent-client and HITL-approver fields below, which cite `FR-040
 * (keycloak-entra-wiring)` / `FR-041 (keycloak-entra-wiring)` explicitly to
 * disambiguate (mirroring the SC-008 disambiguation in node-context-factory.ts).
 */

import { z } from "zod";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "./host-error.js";
import type { TenantId } from "./tenant.js";
import { parseScope } from "./capability-scope.js";

// ---------------------------------------------------------------------------
// Sensitive config sub-shapes
// ---------------------------------------------------------------------------

/**
 * The shape a single Keycloak agent-client credential takes inside the
 * `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` JSON map. SENSITIVE — `clientSecret` MUST
 * NEVER be logged (NFR-014). This is the plain config-parse shape; the
 * domain-level `KeycloakClientCredential` port type lives in
 * `adapters/agent-client-credentials.ts`.
 */
export interface KeycloakClientCredentialConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

// ---------------------------------------------------------------------------
// Host Config — parsed from environment variables
// ---------------------------------------------------------------------------

export const HostConfigSchema = z.object({
  /** Git URL for the DAGs repository */
  DAGS_REPO_URL: z.string(),
  /** Branch to track in the DAGs repo */
  DAGS_REPO_BRANCH: z.string().default("main"),
  /** Polling interval for git sync (ms) */
  DAGS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Interval for the Redis liveness probe (ms) — drives degraded/recovered transitions */
  REDIS_PROBE_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  /** Optional local path override (skips git clone, useful for dev) */
  DAGS_LOCAL_PATH: z.string().optional(),
  /** Redis connection URL — required for host to start (FR-006) */
  REDIS_URL: z.string(),
  /** HTTP port to listen on */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Maximum concurrent DAG runs across all DAGs */
  MAX_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).default(50),
  /** Default per-DAG concurrency limit when not overridden in fugue.yaml */
  DEFAULT_DAG_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** Default per-DAG timeout (ms) when not overridden in fugue.yaml */
  DEFAULT_DAG_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Maximum allowed DAG timeout regardless of per-DAG config */
  MAX_DAG_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  /** Grace period for in-flight requests during graceful shutdown */
  DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  /** LLM provider to use */
  LLM_PROVIDER: z.enum(["anthropic", "openai", "azure"]).default("anthropic"),
  /** Anthropic API key */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** OpenAI API key */
  OPENAI_API_KEY: z.string().optional(),
  /** Azure OpenAI endpoint URL */
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  /** Azure OpenAI API key */
  AZURE_OPENAI_API_KEY: z.string().optional(),
  /** Azure OpenAI deployment name */
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  /** Azure OpenAI API version (defaults to 2025-03-01-preview) */
  AZURE_OPENAI_API_VERSION: z.string().default("2025-03-01-preview"),
  /** Admin bearer token for provisioning teams and full access (required) */
  ADMIN_TOKEN: z.string().min(16),
  /**
   * Issuer URL of the fugue-platform realm whose OIDC JWTs the host accepts as a
   * first-class inbound mode (FR-W3-006). When unset, the JWT (`user`) path stays
   * disabled and only admin/`fug_` tokens are accepted (fail closed).
   *
   * Setting it wires the inbound user JWT verification path LIVE (verifier +
   * iss/aud/run-auth policy, see `host.ts`) AND selects the live Keycloak
   * capability broker for per-node downstream-scope minting. Leaving it unset
   * wires NO broker and disables the user JWT path (a JWT-shaped token 401s):
   * runs use the boot-scoped static capability set unchanged and only
   * admin/`fug_` tokens are accepted (the zero-regression, fail-closed path).
   */
  REALM_JWT_ISSUER: z.string().optional(),
  /**
   * Audience the host must appear in within an accepted realm JWT (FR-W3-006).
   * Non-empty: an explicit `REALM_JWT_AUDIENCE=""` would neuter the audience
   * check (every token's `aud` trivially "contains" the empty expectation), so
   * it is rejected at boot rather than silently weakening verification.
   */
  REALM_JWT_AUDIENCE: z.string().min(1).default("fugue-host"),
  /**
   * Keycloak realm policy: the scopes assigned to each agent client, as a JSON
   * object mapping `agentClientId → ["<provider>:<operation>", …]`. This is the
   * fail-closed gate the live broker consults BEFORE any Entra call (FR-W3-003):
   * a scope absent from a client's list is refused with zero egress. A client
   * with no entry has NO scopes (fail closed). Unset means an empty policy —
   * every minting request fails closed — so the broker is inert until configured.
   *
   * Parsed/validated here (Zod) so a malformed policy fails at boot, never at
   * runtime. The value is `Record<string, string[]>`; absent → `{}`.
   *
   * KEYS ARE REAL KEYCLOAK CLIENT IDS (FR-040 (keycloak-entra-wiring)): a DAG id is first resolved to its
   * agent-type client id through `AGENT_CLIENT_MAP` (`agentClientIdForDag`), and
   * the resulting REAL client id (`fugue-agent-mail`, …) is what the broker's
   * fail-closed gate looks up here. They are NOT DAG ids — the dagId→client
   * placeholder identity is gone.
   */
  AGENT_CLIENT_SCOPES: z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, readonly string[]>> => {
      if (raw === undefined || raw.trim() === "") return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "AGENT_CLIENT_SCOPES must be valid JSON" });
        return z.NEVER;
      }
      const shape = z.record(z.string(), z.array(z.string())).safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({ code: "custom", message: "AGENT_CLIENT_SCOPES must be a JSON object of clientId → string[]" });
        return z.NEVER;
      }
      // Validate every scope NAME, not just the JSON shape: a typo'd scope
      // (`msgrpah:mail.send`) otherwise passes boot and then fail-closes EVERY
      // mint for that client at runtime — contradicting the "fails at boot, never
      // at runtime" contract. Reject unparseable scope names here so the defect
      // surfaces at startup (review suggestion).
      const badScopes: string[] = [];
      for (const [clientId, scopes] of Object.entries(shape.data)) {
        for (const scope of scopes) {
          if (parseScope(scope) === undefined) badScopes.push(`${clientId} → "${scope}"`);
        }
      }
      if (badScopes.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `AGENT_CLIENT_SCOPES contains unrecognised scope name(s): ${badScopes.join(", ")} (expected "<provider>:<operation>", e.g. "msgraph:mail.send")`,
        });
        return z.NEVER;
      }
      return shape.data;
    }),
  /**
   * The DAG-id → REAL Keycloak agent-type client-id map (FR-040 (keycloak-entra-wiring), ADR-0056
   * Variant A: one service-account client per agent TYPE). A JSON object mapping
   * `dagId → "<real-keycloak-client-id>"` (e.g. `{ "lead-desk": "fugue-agent-mail" }`).
   *
   * This is the SINGLE migration point that replaces the dagId-identity
   * placeholder: `agentClientIdForDag(map, dagId)` resolves a run's DAG id to the
   * real client id on which `AGENT_CLIENT_SCOPES` and
   * `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` are keyed. A DAG id ABSENT from this map
   * has NO agent client — its origin resolution FAILS CLOSED (the run is refused
   * rather than minting as the wrong/absent client; FR-040 (keycloak-entra-wiring)). Absent/empty → `{}`,
   * so every DAG fails closed until mapped (the safe default).
   *
   * Parsed/validated here (Zod) so a malformed map fails at BOOT, never at
   * runtime. The value is `Readonly<Record<string, string>>`.
   */
  AGENT_CLIENT_MAP: z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, string>> => {
      if (raw === undefined || raw.trim() === "") return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "AGENT_CLIENT_MAP must be valid JSON" });
        return z.NEVER;
      }
      const shape = z.record(z.string(), z.string().min(1)).safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({
          code: "custom",
          message: "AGENT_CLIENT_MAP must be a JSON object of dagId → non-empty Keycloak client id",
        });
        return z.NEVER;
      }
      return shape.data;
    }),
  // ── Entra / Keycloak agent-client wiring (Phase 0 — config-presence gating) ──
  /**
   * Microsoft Entra (Azure AD) tenant id the host's workload-identity-federation
   * (WIF) hop targets. Validated together with ENTRA_CLIENT_ID. Under AD-3 config-
   * presence gating, setting BOTH this and ENTRA_CLIENT_ID wires the live Entra WIF
   * exchange + Graph transport NOW (`host.ts` `selectCapabilityBroker`); leaving
   * them unset keeps the fail-closed unwired stubs, preserving the zero-Entra-egress
   * baseline (SC-001). Tenant and client are an inseparable pair — one without the
   * other is rejected at boot by the superRefine below (FR-001).
   */
  ENTRA_TENANT_ID: z.string().optional(),
  /**
   * The Entra application (client) id the host federates AS over WIF. Paired with
   * ENTRA_TENANT_ID — see that field. One without the other fails boot (FR-001).
   */
  ENTRA_CLIENT_ID: z.string().optional(),
  /**
   * Override the Keycloak token endpoint URL the agent-client legs POST to
   * (client-credentials mint + RFC 8693 exchange). Optional; must be https — an
   * agent client secret is sent to this endpoint, so cleartext http is refused at
   * boot (NFR-014). When unset the live endpoint adapter derives its URL from the
   * realm issuer.
   */
  KEYCLOAK_TOKEN_URL: z.string().url().optional(),
  /**
   * Per-agent-client Keycloak credentials, as a JSON object mapping
   * `agentClientId → { "clientId": "...", "clientSecret": "..." }`. KEYS ARE REAL
   * KEYCLOAK CLIENT IDS (FR-040 (keycloak-entra-wiring) — the same ids `AGENT_CLIENT_MAP` resolves a DAG
   * id to), not DAG ids. Parsed and
   * validated here. Under AD-3 config-presence gating, a non-empty map wires the
   * live Keycloak token endpoint NOW (`host.ts` `selectCapabilityBroker`); an
   * empty/absent map keeps the fail-closed unwired endpoint, preserving SC-001.
   *
   * SENSITIVE (NFR-014): the values are client secrets and MUST NEVER be logged.
   * Parsed/validated here (Zod) so a malformed map fails at boot, never at
   * runtime. The value is `Readonly<Record<string, KeycloakClientCredentialConfig>>`;
   * absent → `{}` (empty map → every credential lookup misses → fail-closed).
   *
   * The env-map adapter (`adapters/agent-client-credentials.ts`) consumes this
   * map; a lookup miss returns `undefined` (fail-closed, FR-004) so an unknown
   * agent client never triggers egress.
   */
  KEYCLOAK_AGENT_CLIENT_CREDENTIALS: z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, KeycloakClientCredentialConfig>> => {
      if (raw === undefined || raw.trim() === "") return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "KEYCLOAK_AGENT_CLIENT_CREDENTIALS must be valid JSON" });
        return z.NEVER;
      }
      const shape = z
        .record(
          z.string(),
          z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).strict(),
        )
        .safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({
          code: "custom",
          message:
            "KEYCLOAK_AGENT_CLIENT_CREDENTIALS must be a JSON object of agentClientId → { clientId, clientSecret } (non-empty strings)",
        });
        return z.NEVER;
      }
      return shape.data;
    }),
  /**
   * The Dynamics 365 organization host the host's `dynamics:*` capabilities read
   * from (e.g. `org.crm4.dynamics.com`), used to build the per-org Graph/Dataverse
   * audience + handle (FR-042). Optional — DAGs requiring `dynamics` fail the
   * boot-time capability check when unset, exactly as today (SC-001).
   */
  DYNAMICS_ORG_HOST: z.string().optional(),
  /** OpenTelemetry OTLP exporter endpoint */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  // ── Human-in-the-loop (ADR-0060) ───────────────────────────────────────
  /**
   * Microsoft Teams Incoming Webhook (Workflows) URL for human-review
   * notifications. This is ONE of two HITL notifier transports: setting it (or
   * the Bot Framework pair `BOT_APP_ID`/`BOT_APP_PASSWORD`) ENABLES HITL, so
   * DAGs declaring a `humanReview` gate run on the durable queue (202 + runId)
   * and post a review card here. HITL is off (and a `humanReview` DAG is refused
   * with 501) only when NEITHER transport is configured.
   */
  TEAMS_WEBHOOK_URL: z.string().url().optional(),
  /**
   * Public base URL of this host, used to build the approval deep-link in the
   * Teams card (`<base>/runs/<runId>`). Required in practice when
   * TEAMS_WEBHOOK_URL is set; falls back to `http://localhost:<PORT>`.
   */
  HITL_APPROVAL_BASE_URL: z.string().url().optional(),
  /** TTL (seconds) for persisted HITL runs + decisions. Default 7 days. */
  HITL_RUN_TTL_SEC: z.coerce.number().int().min(60).default(604_800),
  /** Single-flight lock TTL (seconds) per run execution slice. Default 5 min. */
  HITL_LOCK_TTL_SEC: z.coerce.number().int().min(1).default(300),
  /** Max concurrent HITL run slices the worker processes. Default 4. */
  HITL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /**
   * Microsoft Bot Framework app id. Setting this (with BOT_APP_PASSWORD)
   * selects the IN-Teams transport: reviews post interactive Approve/Reject
   * cards and the bot endpoint (`POST /teams/messages`) records decisions
   * in-place — no link-out. Takes precedence over TEAMS_WEBHOOK_URL when both
   * are set. Requires an Azure Bot resource + Teams app manifest (see
   * ../../../../docs/runbooks/azure-bot-hitl-provisioning.md).
   */
  BOT_APP_ID: z.string().optional(),
  /** Bot Framework app password (client secret). Required when BOT_APP_ID is set. */
  BOT_APP_PASSWORD: z.string().optional(),
  /**
   * Override the Bot Framework token endpoint (single-tenant bots). Optional.
   * Must be https — the app password (client secret) is POSTed here.
   */
  BOT_TOKEN_URL: z.string().url().optional(),
  /**
   * HITL approver team membership for the in-Teams (Bot Framework) button path
   * (FR-041 (keycloak-entra-wiring), US5, SC-006), as a JSON object mapping a Teams user's
   * `aadObjectId → ["<team>", …]`. The Bot-card click carries only the clicker's
   * `aadObjectId`, so — unlike the HTTP approve path which reads the approver's
   * team off a verified token — the membership must be resolved from this config.
   * Before recording a decision the bot path authorizes the resolved approver
   * against the run's DAG-owning team (parity with `authorizeRunAccess`).
   *
   * FAIL CLOSED (SC-006): an `aadObjectId` ABSENT from this map is an unknown
   * approver whose click authorizes nothing; absent/empty map → `{}`, so EVERY
   * Teams click is refused until approvers are mapped. Parsed/validated here so a
   * malformed map fails at boot, never at runtime.
   */
  HITL_APPROVER_TEAMS: z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, readonly string[]>> => {
      if (raw === undefined || raw.trim() === "") return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "HITL_APPROVER_TEAMS must be valid JSON" });
        return z.NEVER;
      }
      const shape = z.record(z.string(), z.array(z.string())).safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({
          code: "custom",
          message: "HITL_APPROVER_TEAMS must be a JSON object of aadObjectId → string[] (team ids)",
        });
        return z.NEVER;
      }
      return shape.data;
    }),
  /**
   * Per-team CHANNEL routing for the in-Teams (Bot Framework) transport
   * (FR-041 (keycloak-entra-wiring), US5), as a JSON object mapping a Teams team's
   * `aadGroupId → "<fugue-team>"`. A SINGLE bot account serves multiple teams; the
   * channel→team key is the Teams `aadGroupId` carried on the inbound
   * `conversationUpdate` activity (`channelData.team.aadGroupId`).
   *
   * This is a CONFIDENTIALITY measure, NOT the security control: it routes a
   * team's review cards to that team's own channel (and reads inbound references
   * back per team), so a team's outputs-under-review are not posted into another
   * team's channel. The ACTION-prevention control is the authz gate
   * `canAccessDag` on the button-click path (see HITL_APPROVER_TEAMS) — routing
   * does NOT gate who may approve.
   *
   * An `aadGroupId` ABSENT from this map is an UNMAPPED team: its inbound
   * reference is stored only as the default, and its cards fall back to the
   * default channel. Absent/empty → `{}`. Parsed/validated here so a malformed
   * map fails at boot, never at runtime.
   */
  HITL_TEAM_CHANNELS: z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, string>> => {
      if (raw === undefined || raw.trim() === "") return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "HITL_TEAM_CHANNELS must be valid JSON" });
        return z.NEVER;
      }
      const shape = z.record(z.string(), z.string().min(1)).safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({
          code: "custom",
          message: "HITL_TEAM_CHANNELS must be a JSON object of aadGroupId → non-empty fugue team id",
        });
        return z.NEVER;
      }
      return shape.data;
    }),
  /** MLflow tracking server URI */
  MLFLOW_TRACKING_URI: z.string().optional(),
  /** MLflow experiment ID */
  MLFLOW_EXPERIMENT_ID: z.string().optional(),
  /** Number of failures before circuit breaker opens */
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  /** Time window for circuit breaker failure counting (ms) */
  CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Cooldown before circuit breaker transitions from open to half-open (ms) */
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Default cache TTL for DAG cache entries (FR-040) */
  DEFAULT_CACHE_TTL_MS: z.coerce.number().int().min(1000).default(300_000),
  /** Default checkpoint TTL for DAG checkpoint entries (FR-040) */
  DEFAULT_CHECKPOINT_TTL_MS: z.coerce.number().int().min(1000).default(86_400_000),
  /**
   * Optional `documents` capability adapter (ADR-0052). When unset, DAGs
   * declaring `requires: ["documents"]` fail the boot-time capability check.
   * `fs` wires @fuguejs/fs rooted at DOCUMENTS_FS_ROOT (mounted volume /
   * initContainer-staged files). Other adapters (ms-graph, …) are wired by
   * extending this enum alongside their credential config.
   */
  DOCUMENTS_ADAPTER: z.enum(["fs"]).optional(),
  /** Root directory for the fs documents adapter — required when DOCUMENTS_ADAPTER=fs */
  DOCUMENTS_FS_ROOT: z.string().optional(),
  // ── Multi-tenant single-host: worker + supervisor wiring (AD-1, AD-3) ──────
  /**
   * WORKER MODE selector (T6, FR-007): the tenant id this worker process is
   * bound to. A worker runs EXACTLY ONE tenant's DAGs and holds exactly one
   * tenant's config/secrets/fs/state. Set together with FUGUE_SECRETS_REF (the
   * superRefine below rejects one without the other). UNSET = the legacy
   * single-tenant / supervisor process (FR-035 extend-not-replace): nothing here
   * changes the existing `createHost` port-bind path.
   *
   * Shape is validated structurally here (a string) AND re-parsed through the
   * `tenantId` smart constructor in `worker-main.ts` — the brand + Redis-key/ACL
   * safety (no `:`/glob) is owned by `domain/tenant.ts`, not duplicated here.
   */
  TENANT_ID: z.string().optional(),
  /**
   * WORKER MODE (T6, FR-031): the OPAQUE secrets reference this worker resolves
   * inside its own process (env-file path today, Vault key later). Held only by
   * the worker — never dereferenced supervisor-side (FR-005/FR-006, SC-002). A
   * string here; branded via `markSecretsRef` in `worker-main.ts`. Required iff
   * TENANT_ID is set (worker mode).
   */
  FUGUE_SECRETS_REF: z.string().optional(),
  /**
   * WORKER MODE (ADR-0067): the per-tenant Redis ACL username + password the
   * supervisor mints and injects into this worker's spawn env (when
   * SUPERVISOR_REDIS_ACL_ENABLED is on) so the worker authenticates to Redis as
   * its OWN `~fugue:<tenant>:*`-scoped user. ABSENT → the worker uses the
   * `REDIS_URL` credential (ACL disabled; today's behaviour). The password is a
   * secret handed only via the spawn env — NEVER logged.
   */
  FUGUE_REDIS_ACL_USERNAME: z.string().optional(),
  FUGUE_REDIS_ACL_PASSWORD: z.string().optional(),
  /**
   * Directory under which per-tenant worker Unix-domain sockets live (T6/T7).
   * The supervisor reverse-proxies inbound HTTP to `<dir>/<tenant>.sock` (0600).
   * This is NOT an inbound public listener (FR-001): the single public HTTP
   * listener is the supervisor's; the UDS is the internal transport behind it.
   */
  WORKER_UDS_DIR: z.string().default("/run/fugue"),
  /**
   * Per-worker V8 heap cap (MB), applied by the supervisor (T8) at worker spawn
   * (`--max-old-space-size`). Optional — unset means no explicit cap. Bounds a
   * single tenant's memory blast radius on the shared host.
   */
  WORKER_HEAP_CAP_MB: z.coerce.number().int().min(1).optional(),
  /**
   * Internal HMAC signing key the SUPERVISOR uses to stamp the `X-Fugue-Tenant`
   * header on requests it reverse-proxies to a worker, and which a worker MAY
   * verify defensively (T7). This is NOT a tenant secret and NOT the Redis ACL
   * credential — it is a platform-internal integrity key. Optional: when unset,
   * the worker relies solely on 0600 socket isolation and skips header
   * verification (the socket is only reachable by the supervisor + worker).
   *
   * CONTRACT (T7 signer must match EXACTLY): header value =
   *   `<tenantId>.<hmac>` where
   *   `hmac = hex( HMAC-SHA256(key=FUGUE_SUPERVISOR_HMAC_KEY, message=tenantId) )`.
   */
  FUGUE_SUPERVISOR_HMAC_KEY: z.string().min(1).optional(),
  /**
   * SUPERVISOR upper bound on simultaneously-live workers (T8/T9). When the
   * bound is reached the supervisor evicts an idle worker before admitting a new
   * tenant (LRU). Optional — unset means no explicit cap (bounded only by host
   * resources).
   */
  SUPERVISOR_MAX_LIVE_WORKERS: z.coerce.number().int().min(1).optional(),
  /**
   * Enable per-tenant Redis ACL isolation (ADR-0067). When `true`, the supervisor
   * provisions a per-tenant `~fugue:<tenant>:*`-scoped ACL user at worker spawn and
   * hands the minted credential into the owning worker, so a compromised worker's
   * cross-tenant read is refused by Redis with NOPERM (data-plane enforcement, not
   * just application-layer key prefixing). REQUIRES a Redis/Valkey server with ACL
   * support AND that the supervisor's `REDIS_URL` credential has ACL admin rights
   * (`+@admin` or `+acl`). Default `false`: enabling it is a deliberate operational
   * step (see docs/migrations/tenant-key-namespacing.md) — with it off the worker
   * uses the shared `REDIS_URL` credential and isolation rests on key prefixing.
   */
  SUPERVISOR_REDIS_ACL_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  /**
   * Idle duration (ms) after which the supervisor may evict a worker with no
   * in-flight work (T8). Default 15 min. Eviction is graceful (drain then stop).
   */
  WORKER_IDLE_EVICT_MS: z.coerce.number().int().min(1000).default(900_000),
  /**
   * Interval (ms) at which the supervisor probes the liveness of RE-ADOPTED
   * workers (SC-006). A worker re-adopted across a supervisor restart has no
   * `handle.exited` crash watcher (its process was re-parented), so this poll is
   * its ONLY crash signal — a dead re-adopted worker is detected and restarted
   * rather than wedging the tenant at 503. Workers spawned by the live supervisor
   * are watcher-covered and skipped. Default 5s (liveness is not latency-critical).
   */
  WORKER_LIVENESS_SWEEP_MS: z.coerce.number().int().min(1000).default(5_000),
  /**
   * Per-tenant crash-loop budget (T8 resilience): the max number of AUTOMATIC
   * worker restarts the supervisor will perform for one tenant within
   * `SUPERVISOR_WORKER_RESTART_WINDOW_MS` before giving up the auto-restart (the
   * tenant then stays unavailable until a fresh request or the window slides).
   * Mirrors the supervisor-process crash-loop budget (`thin-init`). A worker that
   * boots-then-crashes-fast can otherwise pin a core. Default 5.
   */
  SUPERVISOR_MAX_WORKER_RESTARTS: z.coerce.number().int().min(1).default(5),
  /** Sliding window (ms) for `SUPERVISOR_MAX_WORKER_RESTARTS`. Default 60s. */
  SUPERVISOR_WORKER_RESTART_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  /**
   * Grace window (ms) a DEREGISTERED tenant's footprint (fs mount, secrets,
   * keyspace, ACL user, worker-registry record) is RETAINED before the auto-purge
   * sweep reclaims it (FR-030). Default 7 days. Deregister is an IMMEDIATE revoke
   * (FR-029) — this only delays the destructive footprint reclamation.
   */
  SUPERVISOR_GRACE_WINDOW_MS: z.coerce.number().int().min(1000).default(7 * 24 * 60 * 60 * 1000),
  /**
   * Cadence (ms) of the grace-window auto-purge sweep (FR-030). Each tick selects
   * deregistered tenants whose grace window has elapsed and purges their
   * footprint. Default hourly. The sweep is idempotent, so a coarse cadence only
   * delays reclamation; it never risks a double-purge.
   */
  SUPERVISOR_GRACE_PURGE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60 * 60 * 1000),
}).refine(
  (c) => c.DEFAULT_DAG_TIMEOUT_MS <= c.MAX_DAG_TIMEOUT_MS,
  { message: "DEFAULT_DAG_TIMEOUT_MS must not exceed MAX_DAG_TIMEOUT_MS" },
).superRefine((c, ctx) => {
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "Required when LLM_PROVIDER is 'anthropic'" });
  }
  if (c.LLM_PROVIDER === "openai" && !c.OPENAI_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "Required when LLM_PROVIDER is 'openai'" });
  }
  if (c.LLM_PROVIDER === "azure" && (!c.AZURE_OPENAI_ENDPOINT || !c.AZURE_OPENAI_API_KEY || !c.AZURE_OPENAI_DEPLOYMENT)) {
    ctx.addIssue({ code: "custom", path: ["AZURE_OPENAI_ENDPOINT"], message: "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT required when LLM_PROVIDER is 'azure'" });
  }
  if (c.DOCUMENTS_ADAPTER === "fs" && !c.DOCUMENTS_FS_ROOT) {
    ctx.addIssue({ code: "custom", path: ["DOCUMENTS_FS_ROOT"], message: "Required when DOCUMENTS_ADAPTER is 'fs'" });
  }
  // The review card embeds the output-under-review and an approval deep-link;
  // posting it over http would exfiltrate that in cleartext. Fail boot loudly
  // rather than send HITL review content unencrypted.
  if (c.TEAMS_WEBHOOK_URL !== undefined && !c.TEAMS_WEBHOOK_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["TEAMS_WEBHOOK_URL"], message: "must be an https:// URL (HITL review content must not be sent over cleartext http)" });
  }
  // The in-Teams (Bot Framework) transport needs both the app id AND the app
  // password to mint a connector token. Enforce the pair at boot rather than
  // failing on the first review when the connector tries to authenticate.
  if (c.BOT_APP_ID !== undefined && !c.BOT_APP_PASSWORD) {
    ctx.addIssue({ code: "custom", path: ["BOT_APP_PASSWORD"], message: "Required when BOT_APP_ID is set" });
  }
  // The app password is POSTed to the token endpoint; an http override leaks it.
  if (c.BOT_TOKEN_URL !== undefined && !c.BOT_TOKEN_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["BOT_TOKEN_URL"], message: "must be an https:// URL (the bot app password is sent to this endpoint)" });
  }
  // The agent client secret is POSTed to the Keycloak token endpoint (client-
  // credentials mint + RFC 8693 exchange); an http override leaks it in cleartext.
  if (c.KEYCLOAK_TOKEN_URL !== undefined && !c.KEYCLOAK_TOKEN_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["KEYCLOAK_TOKEN_URL"], message: "must be an https:// URL (the agent client secret is sent to this endpoint)" });
  }
  // NFR-014 (derived token URL): when KEYCLOAK_TOKEN_URL is UNSET the live
  // Keycloak endpoint DERIVES its URL from REALM_JWT_ISSUER
  // (`<issuer>/protocol/openid-connect/token`, see selectCapabilityBroker). An
  // http:// issuer therefore yields an http:// token URL over which the agent
  // client secret is POSTed in cleartext — the same leak we close above for the
  // explicit override. Guard it ONLY when the secret would actually be sent:
  // agent creds present AND no explicit (already-https-guarded) KEYCLOAK_TOKEN_URL.
  // An http:// issuer with NO agent creds POSTs no secret (JWKS-only use, e.g.
  // local/test) and stays allowed — no regression.
  if (
    Object.keys(c.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).length > 0 &&
    c.KEYCLOAK_TOKEN_URL === undefined &&
    c.REALM_JWT_ISSUER !== undefined &&
    !c.REALM_JWT_ISSUER.startsWith("https://")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["REALM_JWT_ISSUER"],
      message:
        "must be an https:// URL when KEYCLOAK_AGENT_CLIENT_CREDENTIALS is set and KEYCLOAK_TOKEN_URL is unset (the agent client secret is POSTed to the token URL derived from this issuer)",
    });
  }
  // Entra tenant and client are an inseparable pair: the WIF hop needs BOTH to
  // federate, and either one alone is an internally-inconsistent config that
  // would silently half-wire the Entra leg. Reject the mismatch at boot (FR-001)
  // rather than fail-close every Entra mint at runtime. Both-unset is the valid
  // zero-regression baseline (SC-001).
  if ((c.ENTRA_TENANT_ID !== undefined) !== (c.ENTRA_CLIENT_ID !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [c.ENTRA_TENANT_ID === undefined ? "ENTRA_TENANT_ID" : "ENTRA_CLIENT_ID"],
      message: "ENTRA_TENANT_ID and ENTRA_CLIENT_ID must be set together (tenant present iff client present)",
    });
  }
  // WORKER MODE (FR-007): a worker is bound to exactly one tenant AND must know
  // where to resolve that tenant's secrets. TENANT_ID without FUGUE_SECRETS_REF
  // is a half-wired worker that could boot with no secrets (fail-open); the
  // reverse is a secrets ref with no tenant to scope keys/ACL under. Reject the
  // mismatch at boot rather than fail at first resolution. Both-unset is the
  // valid legacy single-tenant / supervisor process (FR-035).
  if ((c.TENANT_ID !== undefined) !== (c.FUGUE_SECRETS_REF !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [c.TENANT_ID === undefined ? "TENANT_ID" : "FUGUE_SECRETS_REF"],
      message:
        "TENANT_ID and FUGUE_SECRETS_REF must be set together (worker mode requires both: the bound tenant and where to resolve its secrets)",
    });
  }
});

// ---------------------------------------------------------------------------
// Worker UDS path — pure helper (SHARED CONTRACT, T7 imports this)
// ---------------------------------------------------------------------------

/**
 * The per-tenant worker Unix-domain socket path: `<udsDir>/<tenant>.sock`.
 *
 * SHARED CONTRACT (do not change the shape — the T7 supervisor derives the same
 * path to reverse-proxy inbound HTTP to the worker): `udsDir` defaults to
 * `WORKER_UDS_DIR` (`/run/fugue`). The socket is bound by the worker and
 * chmod'd 0600 so only the supervisor + worker (same uid) can reach it — that
 * 0600 socket isolation is the primary per-tenant boundary (FR-007); the
 * `X-Fugue-Tenant` HMAC header is a defensive secondary check.
 *
 * Pure: no I/O, deterministic — trivially testable. `tenant` is a branded
 * `TenantId`, so it is already known to be `:`/glob-free (`TENANT_ID_REGEX`),
 * meaning the interpolation can never escape `udsDir`.
 */
export const workerSocketPath = (udsDir: string, tenant: TenantId): string =>
  `${udsDir.replace(/\/+$/, "")}/${tenant}.sock`;

export type HostConfig = z.infer<typeof HostConfigSchema>;

// ---------------------------------------------------------------------------
// Per-DAG config — parsed from fugue.yaml (FR-100, FR-041)
// ---------------------------------------------------------------------------

export const FugueYamlSchema = z.object({
  /** Team owning this DAG (required, non-empty — drives authorization isolation) */
  team: z.string().min(1),
  /** Individual owner within the team */
  owner: z.string().optional(),
  /** Environment variable names this DAG requires at runtime */
  env: z.array(z.string()).default([]),
  // NOTE: these numeric overrides MUST mirror the constraints on DagRegistrationSchema.config
  // (int + positive). applyFugueYaml merges them straight into the resolved DagRegistration,
  // bypassing the dag.ts schema — so a zero/negative here would otherwise reach runtime
  // (maxConcurrent: 0 wedges the DAG at 429 forever; negative TTL → bad Redis expiry).
  /** Per-DAG concurrency limit override */
  maxConcurrent: z.number().int().positive().optional(),
  /** Per-DAG timeout override (ms) */
  timeoutMs: z.number().int().positive().optional(),
  /** Custom route path override (defaults to DAG ID) */
  route: z.string().optional(),
  /** Per-DAG cache TTL override (FR-041) */
  cacheTtlMs: z.number().int().positive().optional(),
  /** Per-DAG checkpoint TTL override (FR-041) */
  checkpointTtlMs: z.number().int().positive().optional(),
  /** Per-run LLM token budget (FR-W1-001) — enforced per runId by the metered-llm decorator. */
  llmBudgetTokens: z.number().int().positive().optional(),
});

export type FugueYaml = z.infer<typeof FugueYamlSchema>;

// ---------------------------------------------------------------------------
// Parse functions — return Result, never throw (functional core)
// ---------------------------------------------------------------------------

/**
 * Parse and validate host configuration from environment variables.
 * Returns Result with config-invalid HostError on failure.
 */
export const parseHostConfig = (env: Record<string, string | undefined>): Result<HostConfig, HostError> => {
  const result = HostConfigSchema.safeParse(env);
  if (result.success) {
    return ok(result.data);
  }
  const message = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return err({ kind: "config-invalid", message });
};

/**
 * Parse and validate a fugue.yaml file content.
 * Returns Result with validation-failed HostError on failure.
 */
export const parseFugueYaml = (
  data: unknown,
  path: string,
): Result<FugueYaml, HostError> => {
  const result = FugueYamlSchema.safeParse(data);
  if (result.success) {
    return ok(result.data);
  }
  return err({ kind: "validation-failed", path, issues: result.error.issues });
};
