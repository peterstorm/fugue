/**
 * The acceptance world for run-start admission: one assembly of the production
 * run path over the identity fakes, shared by the CT-1 behaviour and budget
 * files so both submit through exactly the same path.
 *
 * A submission enters at proxyToWorker, crosses an in-process UDS transport
 * into a worker that applies host.ts's fail-closed tenant-header check, and is
 * served by an app mounting createAuthMiddleware then createRunDagHandler in
 * createRouter's order. The route's identity deps come from
 * composeRunAuthorityWiring over the fake transports, the production config
 * parser and a test catalog parsed by the production catalog parser (OOS-004):
 * nothing in admission is stubbed, no AuthIdentity, plan or authority is
 * hand-built. createContext, executeDag, hitl.startRun and setConcurrency are
 * recording observation points; refusals serialize through errorResponse.
 *
 * Those five production seams (RunPathSeams) are injected by each acceptance
 * file, never imported here: the file under test names in code every seam it
 * exercises, and this module only assembles them.
 *
 * Two variants of one path: the behaviour variant mints a CI token per named
 * team; the lean variant (the AS-036 budget) mints none, so its setup carries
 * nothing the budget does not measure.
 *
 * Each acceptance file loads the wiring module when it builds a world, before
 * this module imports the catalog parser: until run-authority-wiring.ts exists
 * every acceptance testcase is collected and fails on that one missing module.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { dagId as makeDagId, gitSha, ok, runId as makeRunId } from "@fuguejs/framework";
import type { DagId, Result, RunId } from "@fuguejs/framework";
import { z } from "zod";
import type { AuthMiddlewareDeps } from "../../../http/middleware/auth.js";
import type { RunDagDeps } from "../../../http/handlers/run-dag.js";
import { createErrorHandler } from "../../../http/middleware/error-handler.js";
import type { HostEnv } from "../../../http/env.js";
import { freeze } from "../../../domain/registry.js";
import type { RegisteredDag } from "../../../domain/registry.js";
import type { HostState } from "../../../domain/host-state.js";
import { initConcurrency } from "../../../domain/concurrency.js";
import type { ConcurrencyState } from "../../../domain/concurrency.js";
import { initCircuit } from "../../../domain/circuit-breaker.js";
import type { CircuitState } from "../../../domain/circuit-breaker.js";
import { parseHostConfig } from "../../../domain/config.js";
import { createRedisTokenStore } from "../../../adapters/token-store.js";
import { markTenant } from "../../../domain/tenant.js";
import type { Tenant, TenantId } from "../../../domain/tenant.js";
import { tenantId as parseTenantId } from "../../../domain/tenant-id.js";
import { TENANT_HEADER_NAME, verifyTenantHeader } from "../../../domain/tenant-header.js";
import { canonicalTeam, formatToken, hashToken } from "../../../domain/auth.js";
import type { AuthenticatedUser, Team } from "../../../domain/auth.js";
import { epochMsOf } from "../../../domain/duration.js";
import type { TokenStorePort } from "../../../ports.js";
import type {
  AdmitRunAuthorityFn,
  AdmittedRun,
  AuthorizedRun,
  CapabilityCatalog,
  ComposeRunAuthorityWiringFn,
  DelegatedAuthorizationHeaderName,
  RunAuthority,
  RunStartWiring,
  SyncRunBracket,
} from "../../../domain/run-authority-contract.js";
import {
  createCapturingAuditSink,
  createCapturingLogger,
  createCapturingTracer,
  createFakeRealmVerifier,
  createIdentityTransports,
  createInMemoryRedis,
  createInProcessUdsTransport,
  createJwtSigner,
  identityDeploymentEnv,
} from "./identity-fakes.js";
import type {
  CapturingLogger,
  IdentityDeployment,
  IdentityTransportFakes,
  InMemoryRedis,
  InProcessUdsTransport,
  JwtClaims,
  JwtSigner,
} from "./identity-fakes.js";
import { createCredentialLedger } from "./credential-sentinel.js";
import type { CredentialLedger } from "./credential-sentinel.js";

// ── The deployment ───────────────────────────────────────────────────────────

export const DELEGATED_HEADER: DelegatedAuthorizationHeaderName = "X-Fugue-Delegated-Authorization";

const REALM_ISSUER = "https://realm.acceptance.test/realms/fugue";
const REALM_AUDIENCE = "fugue-host";
const REALM_TOKEN_URL = "https://realm.acceptance.test/realms/fugue/protocol/openid-connect/token";
export const ADMIN_TOKEN = "acceptance-admin-token-0123456789abcdef";

export const ENTRA_TENANT = "3f6c1a52-8d4e-4b7a-9c21-5e0d7f8a9b10";
export const BLUEPRINT = "b1e2c3d4-5f60-4718-a9b0-c1d2e3f4a5b6";
export const AGENT_ENTRA_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const ALLOWED_CLIENT = "c0ffee00-1234-4abc-8def-0123456789ab";
const DELEGATED_SCOPE = "access_agent";

export const AGENT_CLIENT = "fugue-agent-mail";
export const USER_SUB = "realm-user-7f3a";
export const USER_OID = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const FRONTEND_CLIENT = "leaddesk-frontend";

export const SUPERVISOR_HMAC_KEY = "acceptance-supervisor-hmac-key-0123456789";
const SOCKET_PATH = "/run/fugue/acme.sock";
/** The routed tenant's team, which owns the acceptance DAGs. */
export const TEAM_A = canonicalTeam("team-a");

const unwrap = <T, E>(
  r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
  what: string,
): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.value;
};

export const TENANT_ID: TenantId = unwrap(parseTenantId("acme"), "tenant id");
const TENANT: Tenant = markTenant(TENANT_ID, TEAM_A);

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The shape of a deployment under test; identityDeploymentOf spells it with the constants above. */
export type DeploymentShape = {
  /** Brokered (realm configured, catalog brokered) unless false. */
  readonly brokered?: boolean;
  /** The DAG ids AGENT_CLIENT_MAP maps to AGENT_CLIENT. */
  readonly mappedDags: readonly string[];
  /** Override the delegation leg's keys; an omitted key stays at its wired value, an undefined one is unset. */
  readonly delegation?: { readonly clients?: readonly string[] | undefined; readonly scope?: string | undefined };
};

export const identityDeploymentOf = (shape: DeploymentShape): IdentityDeployment => {
  if (shape.brokered === false) return { adminToken: ADMIN_TOKEN, agentClientMap: {}, agentClientCredentials: {} };
  const delegation = shape.delegation ?? {};
  return {
    adminToken: ADMIN_TOKEN,
    realm: { issuer: REALM_ISSUER, audience: REALM_AUDIENCE, tokenUrl: REALM_TOKEN_URL },
    agentClientMap: Object.fromEntries(shape.mappedDags.map((id) => [id, AGENT_CLIENT])),
    agentClientCredentials: { [AGENT_CLIENT]: { clientId: AGENT_CLIENT, clientSecret: "agent-client-secret-acceptance" } },
    entra: { tenant: ENTRA_TENANT, model: "agent-id", blueprint: BLUEPRINT, agentIdentities: { [AGENT_CLIENT]: AGENT_ENTRA_ID } },
    delegation: {
      custodyKeys: "generated",
      clients: "clients" in delegation ? delegation.clients : [ALLOWED_CLIENT],
      scope: "scope" in delegation ? delegation.scope : DELEGATED_SCOPE,
    },
  };
};

// ── DAGs and signers ─────────────────────────────────────────────────────────

export type NodeSpec = { readonly id: string; readonly requires: readonly string[]; readonly humanReview?: boolean };

const sha = gitSha("c".repeat(40));

/** A healthy registered DAG of fetch nodes, each requiring its capabilities; a humanReview node makes it a HITL DAG. */
export const acceptanceDag = (id: string, team: Team, nodes: readonly NodeSpec[]): RegisteredDag => ({
  id: makeDagId(id),
  team,
  route: `/dags/${id}/run`,
  dag: {
    id: makeDagId(id),
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: "fetch",
      requires: n.requires,
      ...(n.humanReview === true ? { humanReview: { prompt: "Approve?" } } : {}),
    })),
    edges: [],
  } as unknown as RegisteredDag["dag"],
  inputSchema: z.object({ query: z.string() }),
  config: { timeout: 5000, maxConcurrency: 10, cacheTtlMs: 0, checkpointTtlMs: 3_600_000 },
  meta: { description: `acceptance ${id}`, version: "1.0" },
  loadedAt: Date.now(),
  sha,
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: `/tmp/dags/${team}/${id}/dag.ts`,
});

/** The realm's and Entra's signing keys, and a rogue key under Entra's kid (a signature failure). */
export type AcceptanceSigners = { readonly realm: JwtSigner; readonly entra: JwtSigner; readonly rogue: JwtSigner };

export const createAcceptanceSigners = async (): Promise<AcceptanceSigners> => {
  const entra = await createJwtSigner("entra-key-1");
  return { realm: await createJwtSigner("realm-key-1"), entra, rogue: await createJwtSigner(entra.kid) };
};

// ── The run path's production seams ──────────────────────────────────────────

/**
 * The five production seams the run path is assembled from, injected by each
 * acceptance file (see the module comment). The wiring seam is the contract's
 * ComposeRunAuthorityWiringFn, exactly. The four route seams use method syntax
 * on purpose: method parameters compare bivariantly, so each production factory
 * slots in with its own, narrower, parameter types.
 */
export type RunPathSeams = Readonly<{
  proxyToWorker(
    deps: { readonly hmacKey: string; readonly transport: InProcessUdsTransport["transport"]; readonly logger: CapturingLogger },
    inbound: Request,
    tenant: Tenant,
    socketPath: string,
  ): Promise<Result<Response, unknown>>;
  createAuthMiddleware(deps: AuthMiddlewareDeps): (c: Context<HostEnv>, next: Next) => Promise<Response | void>;
  createRunDagHandler(deps: RunDagDeps): (c: Context<HostEnv>) => Promise<Response>;
  errorResponse(c: Context<HostEnv>, status: number, error: string, message: string): Response;
  composeRunAuthorityWiring: ComposeRunAuthorityWiringFn;
}>;

// ── The world ────────────────────────────────────────────────────────────────

/** behaviour: a CI token minted per named team. lean (AS-036): no team token; the same submission path. */
export type WorldVariant<T extends string> =
  | { readonly kind: "behaviour"; readonly teams: Readonly<Record<T, Team>> }
  | { readonly kind: "lean" };

export type AcceptanceWorldOptions<D extends string, T extends string> = {
  readonly seams: RunPathSeams;
  readonly signers: AcceptanceSigners;
  /** The registry, keyed by the name a submission uses. */
  readonly dags: Readonly<Record<D, RegisteredDag>>;
  /** The raw test catalog, parsed by the production parseCapabilityCatalog. */
  readonly catalog: Readonly<Record<string, unknown>>;
  readonly deployment: IdentityDeployment;
  readonly variant: WorldVariant<T>;
};

/** What the recording observation points saw past admission. */
export type Observed = {
  readonly contexts: readonly unknown[];
  readonly executions: readonly unknown[];
  readonly hitlStarts: readonly unknown[];
  readonly concurrencyWrites: number;
};

export type Submission<D extends string> = {
  readonly dag: D;
  /** The Authorization header value, verbatim; undefined sends none. */
  readonly authorization?: string;
  /** The X-Fugue-Delegated-Authorization header value, verbatim; undefined sends none. */
  readonly delegated?: string;
  readonly forgedTenant?: string;
};

export type Submitted = {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  readonly response: Response;
};

export type AcceptanceWorld<D extends string, T extends string> = {
  readonly ledger: CredentialLedger;
  readonly fakes: IdentityTransportFakes;
  readonly observed: Observed;
  readonly workerLogger: CapturingLogger;
  readonly proxyLogger: CapturingLogger;
  readonly auditRecords: readonly unknown[];
  readonly spans: readonly unknown[];
  readonly uds: InProcessUdsTransport;
  readonly responses: readonly Submitted[];
  readonly errors: readonly unknown[];
  readonly teamTokens: Readonly<Record<T, string>>;
  /** The inbound request a submission is, built outside any timed region. */
  readonly requestOf: (s: Submission<D>) => Request;
  /** Send an inbound request through proxyToWorker; throws when the proxy fails, after capturing its error. */
  readonly forward: (inbound: Request) => Promise<Submitted>;
  readonly submit: (s: Submission<D>) => Promise<Submitted>;
  /** A realm user token carrying the realm-user-token sentinel as its jti, recorded in the ledger. */
  readonly realmUserToken: (overrides?: JwtClaims) => Promise<string>;
  /** An Entra user token carrying the entra-user-token sentinel as its jti, recorded in the ledger. */
  readonly entraUserToken: (overrides?: JwtClaims, signer?: JwtSigner) => Promise<string>;
};

type ComposedWiring = {
  readonly wiring: RunStartWiring;
  readonly fakes: IdentityTransportFakes;
  readonly storage: InMemoryRedis;
  readonly workerLogger: CapturingLogger;
  readonly spans: readonly unknown[];
  readonly auditRecords: readonly unknown[];
};

/** The injected composeRunAuthorityWiring over the fakes, with the production catalog parser. */
const composeWiring = async (
  options: AcceptanceWorldOptions<string, string>,
  ledger: CredentialLedger,
): Promise<ComposedWiring> => {
  const { parseCapabilityCatalog } = await import("../../../domain/capability-catalog.js");
  const config = unwrap(parseHostConfig(identityDeploymentEnv(options.deployment)), "host config");
  const catalog: CapabilityCatalog = unwrap(parseCapabilityCatalog(options.catalog), "test catalog");
  const fakes = createIdentityTransports({
    ledger,
    realm: { issuer: REALM_ISSUER, signer: options.signers.realm },
    entra: { tenants: [ENTRA_TENANT], signer: options.signers.entra },
  });
  const storage = createInMemoryRedis();
  const workerLogger = createCapturingLogger();
  const tracer = createCapturingTracer();
  const audit = createCapturingAuditSink();
  const wiring = unwrap(
    options.seams.composeRunAuthorityWiring({
      config,
      catalog,
      redis: storage.redis,
      routedTenant: TENANT_ID,
      transports: fakes.transports,
      logger: workerLogger,
      tracer,
      audit: audit.sink,
      now: () => epochMsOf(Date.now()),
    }),
    "composeRunAuthorityWiring",
  );
  return { wiring, fakes, storage, workerLogger, spans: tracer.spans, auditRecords: audit.records };
};

const circuitStore = (): RunDagDeps["circuit"] => {
  const circuits = new Map<DagId, CircuitState>();
  return {
    get: (id: DagId) => circuits.get(id) ?? initCircuit(Date.now()),
    set: (id: DagId, s: CircuitState) => {
      circuits.set(id, s);
    },
  };
};

type Recordings = { readonly contexts: unknown[]; readonly executions: unknown[]; readonly hitlStarts: unknown[] };

type ObservationPoints = Pick<RunDagDeps, "hitl" | "createContext" | "executeDag">;

/**
 * The recording observation points past admission, each typed by what
 * admission hands it (an AdmittedRun, a RunAuthority, an AuthorizedRun). They
 * answer with the least the route needs to finish (a context holding only the
 * run id, a canned result), never a full NodeContextForDag, HitlRunService or
 * executor result: the world's one cast, narrowed to exactly these three fields.
 */
const recordingObservationPoints = (recordings: Recordings): ObservationPoints => {
  const points = {
    hitl: {
      startRun: async (admitted: AdmittedRun, input: unknown) => {
        recordings.hitlStarts.push({ admitted, input });
        return ok({ runId: admitted.runId });
      },
    },
    createContext: async (_registered: RegisteredDag, requestedRunId: RunId, _signal: AbortSignal, authority: RunAuthority) => {
      recordings.contexts.push(authority);
      return { ctx: { runId: requestedRunId }, authority, meterMintedLlm: (meter: unknown) => meter };
    },
    executeDag: async (_dag: unknown, _input: unknown, _ctx: unknown, run: AuthorizedRun) => {
      recordings.executions.push(run);
      return ok({ result: "done" });
    },
  };
  return points as unknown as ObservationPoints;
};

/** What the route takes from the wiring; RunDagDeps declares these two fields from the Phase 4 cut-over on. */
type RunStartIdentityDeps = { readonly admitRunAuthority: AdmitRunAuthorityFn; readonly runAuthority: SyncRunBracket };

/** The route's deps: admission and the sync bracket from the wiring, every hop past admission a recording observation point. */
const observedRouteDeps = (wiring: RunStartWiring, logger: CapturingLogger): { observed: Observed; deps: RunDagDeps } => {
  const recordings: Recordings = { contexts: [], executions: [], hitlStarts: [] };
  let concurrency: ConcurrencyState = initConcurrency(50, 10);
  let concurrencyWrites = 0;
  let runCounter = 0;
  const identity: RunStartIdentityDeps = { admitRunAuthority: wiring.admitRunAuthority, runAuthority: wiring.lifecycle };
  const deps = {
    ...identity,
    ...recordingObservationPoints(recordings),
    getConcurrency: () => concurrency,
    setConcurrency: (next: ConcurrencyState) => {
      concurrencyWrites += 1;
      concurrency = next;
    },
    circuit: circuitStore(),
    circuitConfig: { threshold: 5, windowMs: 60_000 },
    clock: () => Date.now(),
    newRunId: () => makeRunId(`acceptance-run-${++runCounter}`),
    logger,
  } satisfies RunDagDeps;
  const observed: Observed = {
    ...recordings,
    get concurrencyWrites() {
      return concurrencyWrites;
    },
  };
  return { observed, deps };
};

type WorkerAppInput = {
  readonly seams: RunPathSeams;
  readonly hostState: HostState;
  readonly deps: RunDagDeps;
  readonly tokenStore: TokenStorePort;
  readonly logger: CapturingLogger;
  readonly realmSigner: JwtSigner;
  readonly brokered: boolean;
};

/** The worker app in createRouter's order: host state, auth middleware, the run route; the realm JWT path only when brokered. */
const workerApp = ({ seams, hostState, deps, tokenStore, logger, realmSigner, brokered }: WorkerAppInput): Hono<HostEnv> => {
  const app = new Hono<HostEnv>();
  app.onError(createErrorHandler(logger));
  app.use("*", async (c, next) => {
    c.set("hostState", hostState);
    await next();
  });
  const realmJwt = {
    verify: createFakeRealmVerifier(realmSigner),
    expectedIss: REALM_ISSUER,
    expectedAud: REALM_AUDIENCE,
    authorizeUserRun: (user: AuthenticatedUser, dagTeam: Team) => user.teams.includes(dagTeam),
  };
  app.use("*", seams.createAuthMiddleware({ adminToken: ADMIN_TOKEN, tokenStore, logger, ...(brokered ? { realmJwt } : {}) }));
  app.post("/dags/:id/run", seams.createRunDagHandler(deps));
  app.notFound((c) => seams.errorResponse(c, 404, "not-found", "No route"));
  return app;
};

/** The worker's fail-closed tenant-header check (host.ts), in front of the app. */
const tenantCheckedWorker =
  (app: Hono<HostEnv>) =>
  (req: Request): Response | Promise<Response> => {
    const outcome = verifyTenantHeader(SUPERVISOR_HMAC_KEY, TENANT_ID, req.headers.get(TENANT_HEADER_NAME) ?? undefined);
    if (outcome.kind === "ok") return app.fetch(req);
    const status = outcome.kind === "absent" || outcome.kind === "malformed" ? 401 : 403;
    return new Response(JSON.stringify({ error: "tenant principal verification failed", reason: outcome.kind }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

const mintTeamTokens = async <T extends string>(
  store: TokenStorePort,
  variant: WorldVariant<T>,
): Promise<Readonly<Record<T, string>>> => {
  const teams: readonly (readonly [string, Team])[] = variant.kind === "behaviour" ? Object.entries<Team>(variant.teams) : [];
  const minted: (readonly [string, string])[] = [];
  for (const [name, team] of teams) {
    const token = formatToken(crypto.getRandomValues(new Uint8Array(32)));
    unwrap(await store.store(team, await hashToken(token), { team, label: `${team}-ci`, createdAt: Date.now() }), "team token");
    minted.push([name, token]);
  }
  return Object.fromEntries(minted) as Record<T, string>;
};

const jsonBody = z.record(z.string(), z.unknown());

type Submitter<D extends string> = Pick<AcceptanceWorld<D, never>, "responses" | "errors" | "requestOf" | "forward" | "submit">;

/** Submissions through proxyToWorker, every response and proxy error captured for the credential scan. */
const createSubmitter = <D extends string>(
  proxyToWorker: RunPathSeams["proxyToWorker"],
  dags: Readonly<Record<D, RegisteredDag>>,
  uds: InProcessUdsTransport,
  proxyLogger: CapturingLogger,
): Submitter<D> => {
  const responses: Submitted[] = [];
  const errors: unknown[] = [];
  const requestOf = (s: Submission<D>): Request => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (s.authorization !== undefined) headers.Authorization = s.authorization;
    if (s.delegated !== undefined) headers[DELEGATED_HEADER] = s.delegated;
    if (s.forgedTenant !== undefined) headers[TENANT_HEADER_NAME] = s.forgedTenant;
    return new Request(`http://fugue.acceptance.test/dags/${dags[s.dag].id}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "acceptance" }),
    });
  };
  const forward = async (inbound: Request): Promise<Submitted> => {
    const proxied = await proxyToWorker({ hmacKey: SUPERVISOR_HMAC_KEY, transport: uds.transport, logger: proxyLogger }, inbound, TENANT, SOCKET_PATH);
    if (!proxied.ok) {
      errors.push(proxied.error);
      throw new Error(`proxyToWorker failed: ${JSON.stringify(proxied.error)}`);
    }
    const response = proxied.value;
    const text = await response.text();
    const json = text.length > 0 ? jsonBody.parse(JSON.parse(text)) : {};
    const submitted = { status: response.status, text, json, response };
    responses.push(submitted);
    return submitted;
  };
  return { responses, errors, requestOf, forward, submit: (s) => forward(requestOf(s)) };
};

const withoutUndefined = (claims: JwtClaims): JwtClaims =>
  Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));

const realmUserTokens =
  (signers: AcceptanceSigners, ledger: CredentialLedger) =>
  async (overrides: JwtClaims = {}): Promise<string> => {
    const token = await signers.realm.sign(
      withoutUndefined({
        iss: REALM_ISSUER,
        aud: [REALM_AUDIENCE],
        azp: FRONTEND_CLIENT,
        sub: USER_SUB,
        teams: ["team-a"],
        entra_oid: USER_OID,
        entra_tid: ENTRA_TENANT,
        iat: nowSec(),
        exp: nowSec() + 300,
        jti: ledger.sentinels["realm-user-token"],
        ...overrides,
      }),
    );
    ledger.record("realm-user-token", token);
    return token;
  };

const entraUserTokens =
  (signers: AcceptanceSigners, ledger: CredentialLedger) =>
  async (overrides: JwtClaims = {}, signer: JwtSigner = signers.entra): Promise<string> => {
    const token = await signer.sign(
      withoutUndefined({
        iss: `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`,
        tid: ENTRA_TENANT,
        aud: BLUEPRINT,
        azp: ALLOWED_CLIENT,
        oid: USER_OID,
        sub: "entra-pairwise-subject",
        scp: `User.Read ${DELEGATED_SCOPE}`,
        ver: "2.0",
        iat: nowSec(),
        nbf: nowSec() - 30,
        exp: nowSec() + 3600,
        jti: ledger.sentinels["entra-user-token"],
        ...overrides,
      }),
    );
    ledger.record("entra-user-token", token);
    return token;
  };

export const createAcceptanceWorld = async <D extends string, T extends string = never>(
  options: AcceptanceWorldOptions<D, T>,
): Promise<AcceptanceWorld<D, T>> => {
  const ledger = createCredentialLedger();
  const composed = await composeWiring(options, ledger);
  const logger = composed.workerLogger;
  const tokenStore = createRedisTokenStore(composed.storage.redis, TENANT_ID, logger);
  const teamTokens = await mintTeamTokens(tokenStore, options.variant);
  const registry = freeze(Object.values<RegisteredDag>(options.dags), sha, Date.now());
  const hostState: HostState = { phase: "ready", registry, lastSyncAt: Date.now(), lastSyncSha: sha };
  const { observed, deps } = observedRouteDeps(composed.wiring, logger);
  const brokered = options.deployment.realm !== undefined;
  const app = workerApp({ seams: options.seams, hostState, deps, tokenStore, logger, realmSigner: options.signers.realm, brokered });
  const uds = createInProcessUdsTransport(tenantCheckedWorker(app));
  const proxyLogger = createCapturingLogger();
  return {
    ledger,
    fakes: composed.fakes,
    observed,
    workerLogger: logger,
    proxyLogger,
    auditRecords: composed.auditRecords,
    spans: composed.spans,
    uds,
    teamTokens,
    ...createSubmitter(options.seams.proxyToWorker, options.dags, uds, proxyLogger),
    realmUserToken: realmUserTokens(options.signers, ledger),
    entraUserToken: entraUserTokens(options.signers, ledger),
  };
};
