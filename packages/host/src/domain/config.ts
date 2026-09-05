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
import { LlmBudgetDeclarationSchema } from "./llm-budget.js";
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

type CredentialEndpointIssue = "not-https" | "embedded-credentials" | null;

/** Classify a secret-bearing endpoint once at the environment trust boundary. */
const credentialEndpointIssue = (raw: string): CredentialEndpointIssue => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "not-https";
    if (url.username.length > 0 || url.password.length > 0) return "embedded-credentials";
    return null;
  } catch {
    // `z.string().url()` owns malformed-URL diagnostics for these fields.
    return null;
  }
};

/** Parse an optional JSON-object env value once, with field-owned diagnostics. */
const jsonObjectEnv = <T>(
  schema: z.ZodType<T>,
  invalidJsonMessage: string,
  invalidShapeMessage: string,
) => z.string().optional().transform((raw, ctx): T => {
  let parsed: unknown = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: invalidJsonMessage });
      return z.NEVER;
    }
  }
  const shape = schema.safeParse(parsed);
  if (!shape.success) {
    ctx.addIssue({ code: "custom", message: invalidShapeMessage });
    return z.NEVER;
  }
  return shape.data;
});

// ---------------------------------------------------------------------------
// Host Config — parsed from environment variables
// ---------------------------------------------------------------------------

/**
 * A boolean env flag. Env vars arrive as strings, so the accepted spellings are
 * fixed here once — an enum, not a loose `truthy` coercion, so a typo fails the
 * parse loudly instead of silently reading as `false`.
 */
const booleanEnvFlag = () =>
  z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false);

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
  /** Azure OpenAI deployment name used only for provider routing. */
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  /** Underlying Azure OpenAI model SKU used for pricing and request authority. */
  AZURE_OPENAI_MODEL: z.string().optional(),
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
  // `.url()`: the issuer is fed to `new URL(...)` to derive the JWKS certs URL
  // (`realmJwksUri`) and, with agent creds, the Keycloak token URL — a malformed
  // value must fail at boot, not at first verify (parse-don't-validate, matching
  // the parallel REALM_JWKS_URL). The https-only gate for the secret-bearing
  // token-URL derivation is applied additionally in superRefine below.
  REALM_JWT_ISSUER: z.string().url().optional(),
  /**
   * Audience the host must appear in within an accepted realm JWT (FR-W3-006).
   * Non-empty: an explicit `REALM_JWT_AUDIENCE=""` would neuter the audience
   * check (every token's `aud` trivially "contains" the empty expectation), so
   * it is rejected at boot rather than silently weakening verification.
   */
  REALM_JWT_AUDIENCE: z.string().min(1).default("fugue-host"),
  /**
   * Override the URL the realm JWKS (signing keys) is fetched from, decoupling the
   * KEY-FETCH endpoint from the `iss` IDENTITY (`REALM_JWT_ISSUER`). The realm's
   * keys are realm-wide, not route-specific, so a token whose `iss` is the public
   * route can be signature-verified against keys fetched over the IN-CLUSTER route
   * (split-horizon, mirrors `KEYCLOAK_TOKEN_URL` for the mint and lead-desk's
   * EXTERNAL/INTERNAL issuer split). Prefer this over opening external egress.
   * Optional; when unset the verifier derives `<REALM_JWT_ISSUER>/protocol/
   * openid-connect/certs`. No secret is sent to this endpoint (public keys only).
   */
  REALM_JWKS_URL: z.string().url().optional(),
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
  AGENT_CLIENT_SCOPES: jsonObjectEnv(
    z.record(z.string(), z.array(z.string())),
    "AGENT_CLIENT_SCOPES must be valid JSON",
    "AGENT_CLIENT_SCOPES must be a JSON object of clientId → string[]",
  ).transform((scopesByClient, ctx): Readonly<Record<string, readonly string[]>> => {
    // Validate every scope NAME, not just the JSON shape: a typo'd scope
    // (`msgrpah:mail.send`) otherwise passes boot and then fail-closes EVERY
    // mint for that client at runtime.
    const badScopes: string[] = [];
    for (const [clientId, scopes] of Object.entries(scopesByClient)) {
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
    return scopesByClient;
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
  AGENT_CLIENT_MAP: jsonObjectEnv(
    z.record(z.string(), z.string().min(1)),
    "AGENT_CLIENT_MAP must be valid JSON",
    "AGENT_CLIENT_MAP must be a JSON object of dagId → non-empty Keycloak client id",
  ),
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
  KEYCLOAK_AGENT_CLIENT_CREDENTIALS: jsonObjectEnv(
    z.record(
      z.string(),
      z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).strict(),
    ),
    "KEYCLOAK_AGENT_CLIENT_CREDENTIALS must be valid JSON",
    "KEYCLOAK_AGENT_CLIENT_CREDENTIALS must be a JSON object of agentClientId → { clientId, clientSecret } (non-empty strings)",
  ),
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
   * Server-owned active-run wakeup reconciliation cadence. Runs once after the
   * worker starts and then at this bounded interval; shutdown clears the owner.
   */
  HITL_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
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
  HITL_APPROVER_TEAMS: jsonObjectEnv(
    z.record(z.string(), z.array(z.string())),
    "HITL_APPROVER_TEAMS must be valid JSON",
    "HITL_APPROVER_TEAMS must be a JSON object of aadObjectId → string[] (team ids)",
  ),
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
  HITL_TEAM_CHANNELS: jsonObjectEnv(
    z.record(z.string(), z.string().min(1)),
    "HITL_TEAM_CHANNELS must be valid JSON",
    "HITL_TEAM_CHANNELS must be a JSON object of aadGroupId → non-empty fugue team id",
  ),
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
   * initContainer-staged files). `ms-graph` wires @fuguejs/ms-graph with
   * app-only client credentials from the MSGRAPH_* fields below
   * (wiring: adapters/documents-capability.ts).
   */
  DOCUMENTS_ADAPTER: z.enum(["fs", "ms-graph"]).optional(),
  /** Root directory for the fs documents adapter — required when DOCUMENTS_ADAPTER=fs */
  DOCUMENTS_FS_ROOT: z.string().optional(),
  // ── ms-graph documents adapter (DOCUMENTS_ADAPTER=ms-graph) ──
  /** Azure app-registration tenant (directory) id — required when DOCUMENTS_ADAPTER=ms-graph */
  MSGRAPH_TENANT_ID: z.string().min(1).optional(),
  /** Azure app (client) id for the app-only client-credentials flow — required when DOCUMENTS_ADAPTER=ms-graph */
  MSGRAPH_CLIENT_ID: z.string().min(1).optional(),
  /**
   * Azure app client secret — required when DOCUMENTS_ADAPTER=ms-graph.
   * SENSITIVE: never logged — the token provider's errors carry the endpoint
   * host + HTTP status only (NFR-014, mirroring the Keycloak credentials).
   */
  MSGRAPH_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Graph API base URL including `/v1.0` (default
   * `https://graph.microsoft.com/v1.0`). Override for sovereign clouds
   * (e.g. `https://graph.microsoft.us/v1.0`); the token scope derives from
   * this URL's origin when MSGRAPH_SCOPE is unset.
   */
  MSGRAPH_BASE_URL: z.string().url().optional(),
  /**
   * OIDC v2.0 token endpoint override (sovereign clouds / tests). Default:
   * `https://login.microsoftonline.com/{MSGRAPH_TENANT_ID}/oauth2/v2.0/token`.
   */
  MSGRAPH_TOKEN_URL: z.string().url().optional(),
  /** Graph resource scope override. Default: `<Graph origin>/.default`. */
  MSGRAPH_SCOPE: z.string().min(1).optional(),
  /** Per-request timeout (ms) for Graph + token calls. Defaults: adapter 30 s, token 15 s. */
  MSGRAPH_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /**
   * Resolve `sharePointPath` refs to driveItem ids by id-based folder-walk
   * BEFORE delegating to the stock adapter (peterstorm/fugue#36): required for
   * tenants whose Graph backend rejects the documented item-path URL forms
   * tenant-wide. Default `false` — standard tenants keep the stock URL shape.
   */
  MSGRAPH_RESOLVE_PATHS: booleanEnvFlag(),
  // ── CDRator / Oister authenticated-REST capability (`authedHttp`, FR-060/NFR-010) ──
  /**
   * Base URL of the CDRator/Oister core REST API the `authedHttp` capability
   * targets (e.g. `https://rator1.ibt.oister.dk/rest-api-core`). Setting this
   * (together with the other required CDRATOR_* fields below) wires the generic
   * `@fuguejs/http-auth` capability under the key `authedHttp` at boot, so DAGs
   * declaring `requires: ["authedHttp"]` resolve. UNSET → the capability is NOT
   * registered and such DAGs fail the boot-time capability check (zero
   * regression, mirroring the optional `documents` adapter gating).
   *
   * FR-060/NFR-010: the URL + operator credentials arrive ONLY from env config
   * here; nothing is hardcoded in the capability and the credentials are never
   * logged.
   */
  CDRATOR_URL: z.string().url().optional(),
  /**
   * Absolute URL of the CDRator token endpoint the operator-password grant POSTs
   * to (e.g. `https://rator1.ibt.oister.dk/rest-api-auth`). Required when
   * CDRATOR_URL is set. Must be https — the operator password (and the optional
   * client-id/secret HTTP Basic header) are POSTed here, so cleartext http is
   * refused at boot (NFR-010).
   */
  CDRATOR_AUTH_URL: z.string().url().optional(),
  /**
   * CDRator brand key. Sent both as the static `X-RATOR-brand-key` request
   * header on the core API AND as a static `brand_key` form field on the token
   * grant. Required when CDRATOR_URL is set.
   */
  CDRATOR_BRAND_KEY: z.string().min(1).optional(),
  /** CDRator operator username (token-grant form field). Required when CDRATOR_URL is set. */
  CDRATOR_USERNAME: z.string().min(1).optional(),
  /**
   * CDRator operator password (token-grant form field). SENSITIVE (NFR-010): the
   * password is POSTed to the token endpoint and MUST NEVER be logged. Required
   * when CDRATOR_URL is set.
   */
  CDRATOR_PASSWORD: z.string().min(1).optional(),
  /**
   * Optional CDRator OAuth client id, used as the username of the HTTP Basic
   * header on the token request. Set together with CDRATOR_CLIENT_SECRET (one
   * without the other is rejected at boot). UNSET → no Basic auth on the token
   * request (operator-password grant only).
   */
  CDRATOR_CLIENT_ID: z.string().min(1).optional(),
  /**
   * Optional CDRator OAuth client secret, used as the password of the HTTP Basic
   * header on the token request. SENSITIVE (NFR-010): POSTed to the token
   * endpoint, never logged. Set together with CDRATOR_CLIENT_ID.
   */
  CDRATOR_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Token-grant flavour for the CDRator token endpoint.
   *
   * - `operator_password` (default, legacy): resource-owner grant — POSTs
   *   `grant_type=operator_password` with form `username`/`password`
   *   (CDRATOR_USERNAME/PASSWORD), optionally under an HTTP Basic client header.
   * - `client_credentials`: two-legged grant — the client authenticates via the
   *   HTTP Basic `client_id:client_secret` header (CDRATOR_CLIENT_ID/SECRET) and
   *   NO resource-owner username/password is sent. This is how the real Rator
   *   token endpoint (and flexii's own integration) actually authenticates: the
   *   body is `grant_type=client_credentials&brand_key=…&operator=…`. The
   *   operator identity (when the deployment needs one) rides in CDRATOR_OPERATOR.
   *
   * The cross-field validation below enforces the fields each flavour requires.
   */
  CDRATOR_GRANT_TYPE: z.enum(["operator_password", "client_credentials"]).default("operator_password"),
  /**
   * Optional CDRator operator identity, sent as the static `operator` form field
   * on the token grant. Used by the `client_credentials` flavour to scope the
   * minted token to an operator (Rator authorizes account access by operator
   * ownership). Ignored by the `operator_password` flavour (which identifies the
   * operator via CDRATOR_USERNAME). Never logged.
   */
  CDRATOR_OPERATOR: z.string().min(1).optional(),
  // ── Oracle discount-pricing capability (`oracle`, FR-033/FR-040/FR-041) ────
  /**
   * Oracle Easy Connect / TNS connect string the `oracle` capability dials (e.g.
   * `dbhost:1521/PRICING`). Setting this (together with the required ORACLE_USER +
   * ORACLE_PASSWORD below) wires the @fuguejs/oracle capability under the key
   * `oracle` at boot, so DAGs declaring `requires: ["oracle"]` resolve. UNSET → the
   * capability is NOT registered and such DAGs fail the boot-time capability check
   * (zero regression, FR-033 — mirrors the optional `documents`/CDRator gating).
   *
   * FR-040/FR-041: the connect string + DB credentials arrive ONLY from env config
   * here; nothing is hardcoded in the capability and the credentials are never
   * logged.
   */
  ORACLE_CONNECT_STRING: z.string().min(1).optional(),
  /** Oracle DB username. Required when ORACLE_CONNECT_STRING is set (FR-040). */
  ORACLE_USER: z.string().min(1).optional(),
  /**
   * Oracle DB password. SENSITIVE (FR-041): handed to the oracledb pool and MUST
   * NEVER be logged nor appear in any error/telemetry. Required when
   * ORACLE_CONNECT_STRING is set.
   */
  ORACLE_PASSWORD: z.string().min(1).optional(),
  /**
   * Minimum oracledb connection-pool size. Optional — the adapter defaults to 0
   * when unset. Coerced to a non-negative integer.
   */
  ORACLE_POOL_MIN: z.coerce.number().int().min(0).optional(),
  /**
   * Maximum oracledb connection-pool size. Optional — the adapter defaults to 4
   * when unset. Coerced to a positive integer.
   */
  ORACLE_POOL_MAX: z.coerce.number().int().min(1).optional(),
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
   * WORKER MODE (ADR-0074): the per-tenant ceiling on outstanding (non-terminal)
   * HITL runs, injected by the supervisor into this worker's spawn env from the
   * tenant registry's `admission.maxQueuedRuns`. The worker's `HitlRunService`
   * refuses `startRun` with `tenant-over-quota` (429) when the active-run count is
   * already at this limit — the durable-path counterpart to the supervisor's
   * request-scoped `maxConcurrentRuns` gate. ABSENT → unlimited (single-tenant
   * `main.ts` path, or a worker spawned before the field is configured).
   */
  FUGUE_MAX_QUEUED_RUNS: z.coerce.number().int().min(0).optional(),
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
   * bound is reached the supervisor REFUSES a new tenant's worker with
   * `worker-unavailable` (503) rather than evicting to make room
   * (`worker-lifecycle-manager.ts` `lazySpawn`); idle workers are reclaimed
   * separately by the TTL-based idle-evict sweep, not on-demand at the cap.
   * Optional — unset means no explicit cap (bounded only by host resources).
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
  // Accept only an explicit boolean or a recognised string token. An
  // unrecognised string (a typo'd `yes`/`on`/`enabled`) is REJECTED at boot
  // rather than silently coerced to `false` — silently disabling a data-plane
  // security control on a typo is the wrong fail direction (fail-closed-loud).
  SUPERVISOR_REDIS_ACL_ENABLED: booleanEnvFlag(),
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
  // ── Declarative bootstrap (ADR-0064 single-host; GitOps, no admin API) ─────
  /**
   * Path to a mounted TENANTS bootstrap file: a JSON ARRAY of tenant config
   * objects (each an `/admin/tenants` register body plus a top-level `id`). At
   * supervisor startup every entry is registered IDEMPOTENTLY into the tenant
   * registry, so a multi-tenant host seeds its tenants from a ConfigMap with no
   * `POST /admin/tenants` call (the Route-less, exec-less deployment blocker).
   * NON-SECRET (team, dagsRoot, secretsRef PATH, fsRoot, keycloak mapping,
   * admission, eagerPin) → ships as a ConfigMap; per-tenant secrets stay in the
   * sealed env-file at each entry's `secretsRef`. A FILE (not inline env) so it is
   * not size-bound and lives in Git. Unset → no tenant bootstrap.
   */
  TENANTS_BOOTSTRAP_PATH: z.string().optional(),
  /**
   * Inline tenants-bootstrap JSON (same array shape as `TENANTS_BOOTSTRAP_PATH`),
   * a dev/test convenience. The PATH wins when both are set. Unset → no inline
   * tenant bootstrap.
   */
  TENANTS_BOOTSTRAP: z.string().optional(),
  /**
   * Path to a mounted TEAM-TOKENS bootstrap file: a JSON OBJECT mapping
   * `team → token`, where each token is a PRE-PROVIDED `fug_` team token (sealed
   * once, mounted to BOTH this host AND the consuming team's pod). At startup each
   * token is hashed and registered into the platform team-token store IDEMPOTENTLY
   * — accepting a pre-provided token replaces the one-time `POST /admin/teams`
   * capture step. SECRET → ships as a SealedSecret. Unset → no token bootstrap.
   */
  TEAM_TOKENS_BOOTSTRAP_PATH: z.string().optional(),
  /**
   * Inline team-tokens-bootstrap JSON (same object shape as
   * `TEAM_TOKENS_BOOTSTRAP_PATH`), a dev/test convenience. The PATH wins when both
   * are set. SECRET — never commit a real token inline. Unset → no inline token
   * bootstrap.
   */
  TEAM_TOKENS_BOOTSTRAP: z.string().optional(),
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
  if (
    c.LLM_PROVIDER === "azure" &&
    (!c.AZURE_OPENAI_ENDPOINT ||
      !c.AZURE_OPENAI_API_KEY ||
      !c.AZURE_OPENAI_DEPLOYMENT ||
      !c.AZURE_OPENAI_MODEL)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["AZURE_OPENAI_ENDPOINT"],
      message:
        "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT, and AZURE_OPENAI_MODEL required when LLM_PROVIDER is 'azure'",
    });
  }
  if (c.DOCUMENTS_ADAPTER === "fs" && !c.DOCUMENTS_FS_ROOT) {
    ctx.addIssue({ code: "custom", path: ["DOCUMENTS_FS_ROOT"], message: "Required when DOCUMENTS_ADAPTER is 'fs'" });
  }
  if (c.DOCUMENTS_ADAPTER === "ms-graph" && (!c.MSGRAPH_TENANT_ID || !c.MSGRAPH_CLIENT_ID || !c.MSGRAPH_CLIENT_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["MSGRAPH_TENANT_ID"],
      message: "MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, and MSGRAPH_CLIENT_SECRET required when DOCUMENTS_ADAPTER is 'ms-graph'",
    });
  }
  // EVERY secret-bearing endpoint is classified by the SINGLE canonical
  // `credentialEndpointIssue`, so the two checks it encodes — non-HTTPS and
  // embedded URL credentials — can never drift apart per field. Each entry
  // carries only its own bespoke not-https diagnostic (what secret this
  // endpoint receives); the embedded-credentials diagnostic is uniform.
  // Splitting this table would reintroduce the gap where a field was guarded
  // by a hand-rolled `startsWith("https://")` that silently accepted
  // `https://user:secret@host` — all of these parse as `z.string().url()`, so
  // such a value reaches the endpoint (and its logs) intact.
  for (const [field, value, notHttpsMessage] of [
    ["MSGRAPH_BASE_URL", c.MSGRAPH_BASE_URL,
      "must be an https:// URL (the bearer access token is sent to this endpoint)"],
    ["MSGRAPH_TOKEN_URL", c.MSGRAPH_TOKEN_URL,
      "must be an https:// URL (the MS Graph client secret is sent to this endpoint)"],
    // The operator password and the optional client-id/secret HTTP Basic header
    // are POSTed here; an http:// token URL would leak them in cleartext.
    ["CDRATOR_AUTH_URL", c.CDRATOR_AUTH_URL,
      "must be an https:// URL (the operator password is POSTed to this endpoint)"],
    // The minted bearer token is sent as `Authorization: Bearer` to this core
    // API base URL on EVERY request.
    ["CDRATOR_URL", c.CDRATOR_URL,
      "must be an https:// URL (the minted bearer token is sent here on every request)"],
    // The review card embeds the output-under-review and an approval deep-link.
    ["TEAMS_WEBHOOK_URL", c.TEAMS_WEBHOOK_URL,
      "must be an https:// URL (HITL review content must not be sent over cleartext http)"],
    // The bot app password is POSTed to the token endpoint.
    ["BOT_TOKEN_URL", c.BOT_TOKEN_URL,
      "must be an https:// URL (the bot app password is sent to this endpoint)"],
    // The agent client secret is POSTed to the Keycloak token endpoint
    // (client-credentials mint + RFC 8693 exchange).
    ["KEYCLOAK_TOKEN_URL", c.KEYCLOAK_TOKEN_URL,
      "must be an https:// URL (the agent client secret is sent to this endpoint)"],
  ] as const) {
    if (value === undefined) continue;
    const issue = credentialEndpointIssue(value);
    if (issue === "not-https") {
      ctx.addIssue({ code: "custom", path: [field], message: notHttpsMessage });
    } else if (issue === "embedded-credentials") {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: "must not contain embedded URL credentials",
      });
    }
  }
  // ── CDRator `authedHttp` capability (FR-060/NFR-010) ───────────────────────
  // The capability is gated on CDRATOR_URL: once it is set the operator credentials,
  // brand key and token endpoint are ALL mandatory — a half-wired capability would
  // either fail-close every request or (worse) mint with missing fields. Reject the
  // mismatch at boot rather than fail on the first `authedHttp` call. Unset is the
  // valid zero-regression baseline (the capability is simply not registered).
  if (c.CDRATOR_URL !== undefined) {
    if (!c.CDRATOR_AUTH_URL) {
      ctx.addIssue({ code: "custom", path: ["CDRATOR_AUTH_URL"], message: "Required when CDRATOR_URL is set" });
    }
    if (!c.CDRATOR_BRAND_KEY) {
      ctx.addIssue({ code: "custom", path: ["CDRATOR_BRAND_KEY"], message: "Required when CDRATOR_URL is set" });
    }
    // The required token-grant fields depend on the grant flavour. operator_password
    // (default) needs the resource-owner username/password; client_credentials needs
    // the OAuth client id/secret (the HTTP Basic client) and NO username/password.
    if (c.CDRATOR_GRANT_TYPE === "client_credentials") {
      if (!c.CDRATOR_CLIENT_ID) {
        ctx.addIssue({ code: "custom", path: ["CDRATOR_CLIENT_ID"], message: "Required when CDRATOR_GRANT_TYPE is 'client_credentials'" });
      }
      if (!c.CDRATOR_CLIENT_SECRET) {
        ctx.addIssue({ code: "custom", path: ["CDRATOR_CLIENT_SECRET"], message: "Required when CDRATOR_GRANT_TYPE is 'client_credentials'" });
      }
    } else {
      if (!c.CDRATOR_USERNAME) {
        ctx.addIssue({ code: "custom", path: ["CDRATOR_USERNAME"], message: "Required when CDRATOR_URL is set (operator_password grant)" });
      }
      if (!c.CDRATOR_PASSWORD) {
        ctx.addIssue({ code: "custom", path: ["CDRATOR_PASSWORD"], message: "Required when CDRATOR_URL is set (operator_password grant)" });
      }
    }
  }
  // ── Oracle `oracle` capability (FR-033/FR-040/FR-041) ──────────────────────
  // The capability is gated on ORACLE_CONNECT_STRING: once it is set the DB
  // credentials are BOTH mandatory — a half-wired capability would fail to open a
  // pool and fail-close every query. Reject the mismatch at boot rather than on the
  // first `oracle` query. Unset is the valid zero-regression baseline (FR-033): the
  // capability is simply not registered and all ORACLE_* fields may be absent.
  if (c.ORACLE_CONNECT_STRING !== undefined) {
    if (!c.ORACLE_USER) {
      ctx.addIssue({ code: "custom", path: ["ORACLE_USER"], message: "Required when ORACLE_CONNECT_STRING is set" });
    }
    if (!c.ORACLE_PASSWORD) {
      ctx.addIssue({ code: "custom", path: ["ORACLE_PASSWORD"], message: "Required when ORACLE_CONNECT_STRING is set" });
    }
  }
  // ORACLE_POOL_MIN and ORACLE_POOL_MAX are bounded individually (min 0 / min 1)
  // but nothing rejects min > max — that spec parses OK here and then hands
  // oracledb an invalid pool, failing at pool-open instead of boot. Mirror the
  // DEFAULT_DAG_TIMEOUT_MS <= MAX_DAG_TIMEOUT_MS cross-field precedent and reject
  // an inverted pool range at boot.
  if (
    c.ORACLE_POOL_MIN !== undefined &&
    c.ORACLE_POOL_MAX !== undefined &&
    c.ORACLE_POOL_MIN > c.ORACLE_POOL_MAX
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["ORACLE_POOL_MIN"],
      message: "ORACLE_POOL_MIN must not exceed ORACLE_POOL_MAX",
    });
  }
  // Client id and secret are an inseparable pair: HTTP Basic on the token request
  // needs BOTH. One without the other is an internally-inconsistent config that
  // would silently half-build the Basic header. Reject the mismatch at boot.
  if ((c.CDRATOR_CLIENT_ID !== undefined) !== (c.CDRATOR_CLIENT_SECRET !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [c.CDRATOR_CLIENT_ID === undefined ? "CDRATOR_CLIENT_ID" : "CDRATOR_CLIENT_SECRET"],
      message: "CDRATOR_CLIENT_ID and CDRATOR_CLIENT_SECRET must be set together (HTTP Basic on the token request needs both)",
    });
  }
  // The in-Teams (Bot Framework) transport needs both the app id AND the app
  // password to mint a connector token. Enforce the pair at boot rather than
  // failing on the first review when the connector tries to authenticate.
  if (c.BOT_APP_ID !== undefined && !c.BOT_APP_PASSWORD) {
    ctx.addIssue({ code: "custom", path: ["BOT_APP_PASSWORD"], message: "Required when BOT_APP_ID is set" });
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
  // REALM_JWKS_URL is meaningful ONLY as a key-fetch override for the realm JWT
  // path, and that path is gated on REALM_JWT_ISSUER (host.ts): with the issuer
  // unset the verifier is never built and the JWKS override is silently dropped.
  // An operator who sets REALM_JWKS_URL alone believes they wired split-horizon
  // key fetch but got a no-op. Reject the half-set pair at boot (FR-001), matching
  // every other paired field here, rather than silently ignoring it. Issuer-only
  // is valid (the verifier derives the /certs endpoint from the issuer).
  if (c.REALM_JWKS_URL !== undefined && c.REALM_JWT_ISSUER === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["REALM_JWKS_URL"],
      message:
        "REALM_JWKS_URL requires REALM_JWT_ISSUER (the JWKS override only takes effect when the realm JWT path is enabled by the issuer)",
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

type ParsedHostConfig = z.infer<typeof HostConfigSchema>;

type HostLlmConfig =
  | { readonly LLM_PROVIDER: "anthropic"; readonly ANTHROPIC_API_KEY: string }
  | { readonly LLM_PROVIDER: "openai"; readonly OPENAI_API_KEY: string }
  | {
      readonly LLM_PROVIDER: "azure";
      readonly AZURE_OPENAI_ENDPOINT: string;
      readonly AZURE_OPENAI_API_KEY: string;
      readonly AZURE_OPENAI_DEPLOYMENT: string;
      readonly AZURE_OPENAI_MODEL: string;
    };

/** Parsed host configuration with provider-specific LLM requirements encoded. */
export type HostConfig = ParsedHostConfig & HostLlmConfig;

/** A provider credential that is actually present: declared, and not blank. */
const isSupplied = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const withLlmPostcondition = (config: ParsedHostConfig): HostConfig | undefined => {
  if (config.LLM_PROVIDER === "anthropic") {
    return isSupplied(config.ANTHROPIC_API_KEY)
      ? { ...config, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY }
      : undefined;
  }
  if (config.LLM_PROVIDER === "openai") {
    return isSupplied(config.OPENAI_API_KEY)
      ? { ...config, LLM_PROVIDER: "openai", OPENAI_API_KEY: config.OPENAI_API_KEY }
      : undefined;
  }

  const endpoint = config.AZURE_OPENAI_ENDPOINT;
  const apiKey = config.AZURE_OPENAI_API_KEY;
  const deployment = config.AZURE_OPENAI_DEPLOYMENT;
  const model = config.AZURE_OPENAI_MODEL;
  return isSupplied(endpoint) && isSupplied(apiKey) &&
      isSupplied(deployment) && isSupplied(model)
    ? {
        ...config,
        LLM_PROVIDER: "azure",
        AZURE_OPENAI_ENDPOINT: endpoint,
        AZURE_OPENAI_API_KEY: apiKey,
        AZURE_OPENAI_DEPLOYMENT: deployment,
        AZURE_OPENAI_MODEL: model,
      }
    : undefined;
};

// ---------------------------------------------------------------------------
// Per-DAG config — parsed from fugue.yaml (FR-100, FR-041)
// ---------------------------------------------------------------------------

export const FugueYamlSchema = LlmBudgetDeclarationSchema.extend({
  /** Team owning this DAG (required, non-empty — drives authorization isolation) */
  team: z.string().min(1),
  /** Individual owner within the team */
  owner: z.string().optional(),
  /** Environment variable names this DAG requires at runtime */
  env: z.array(z.string()).default([]),
  // applyFugueYaml merges these straight into the resolved DagRegistration,
  // bypassing the dag.ts schema, so whatever passes here reaches runtime —
  // a zero/negative would wedge the DAG (maxConcurrent: 0 → 429 forever) or
  // produce a bad Redis expiry (negative TTL).
  //
  // The invariant that MUST hold against DagRegistrationSchema.config is
  // `.positive()` on all four, plus `.int()` on maxConcurrent (a fractional
  // slot count is meaningless). The `.int()` on the three ms fields below is
  // STRICTER than DagRegistrationSchema.config, which leaves them
  // `.positive()` only — deliberate here, not required parity, so do not
  // "restore" symmetry by loosening them.
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
    const config = withLlmPostcondition(result.data);
    return config === undefined
      ? err({
          kind: "config-invalid",
          message: "LLM provider configuration did not satisfy its parsed postcondition",
        })
      : ok(config);
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
