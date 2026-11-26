/**
 * Acceptance fakes for the identity contracts (CT-1 to CT-6): network, storage
 * and clock edges ONLY.
 *
 * Here: zero-latency realm-token, Entra-token, Entra-JWKS and Graph transports
 * with request capture; a JWKS signer for realm and Entra user tokens; a fake
 * realm signature verifier; setSystemTime clock control; an in-process UDS
 * transport into the worker app; an in-memory RedisPort / HitlRedisPort with
 * SharedInfra; an in-process QueueBackend; recording Bot Framework and webhook
 * transports; a fake Bot Framework token verifier; a capturing audit sink,
 * logger and tracer; and the deployment configuration fixture.
 *
 * NOT here, by design: no fake realm mint, Entra authority, user-token
 * verifier, custody cipher, custody store, capability authority or planner.
 * Those come from composeRunAuthorityWiring, so an acceptance test exercises
 * production's adapters, request bodies and decisions.
 *
 * Every opaque token a fake issues is one of the ledger's sentinels
 * (credential-sentinel.ts), which the FR-022 scan always looks for. Every signed
 * JWT a fake issues carries a sentinel as its jti claim, but its own value
 * differs from that sentinel, so it is recorded in the ledger and the scan looks
 * for it too. A fake that issued any other opaque token would go unscanned.
 */

import { setSystemTime } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from "jose";
import type { CryptoKey, JWK } from "jose";
import { err, ok } from "@fuguejs/framework";
import type { Result, Tracer } from "@fuguejs/framework";
import { markSignatureVerified } from "../../../domain/auth.js";
import type { RealmJwtClaims, VerifyRealmJwt } from "../../../domain/auth.js";
import { epochMsOf } from "../../../domain/duration.js";
import type { EpochMs, IdentityTransports, JwksTransport } from "../../../domain/run-authority-contract.js";
import type { HttpPost, HttpPostResponse } from "../../../adapters/fetch-http-post.js";
import type { GraphHttp, GraphRequest } from "../../../adapters/graph-capability.js";
import type { HitlRedisPort, LogPort, RedisExpiry, RedisPort, RedisValueGuard, SharedInfra } from "../../../ports.js";
import type { UdsTransport } from "../../../supervisor/uds-proxy.js";
import type { BotConnectorPort, ConversationReference, VerifyBotToken } from "../../../hitl/adapters/bot/ports.js";
import type { WebhookHttp } from "../../../hitl/adapters/webhook-notifier.js";
import { fakeInfra } from "../../fixtures/host-boot-fakes.js";
import type { CredentialKind, CredentialLedger } from "./credential-sentinel.js";

/** The in-process QueueBackend: the framework's in-memory backend delivers each enqueued job to the started worker. */
export { createInMemoryBackend as createInProcessQueueBackend } from "@fuguejs/framework";

// ── JWT signing (realm and Entra user tokens, realm assertions) ──────────────

export type JwtClaims = Readonly<Record<string, unknown>>;

export type JwtSigner = {
  readonly kid: string;
  /** The public JSON Web Key Set a JWKS endpoint publishes for this signer. */
  readonly jwks: { readonly keys: readonly JWK[] };
  /** Sign `claims` RS256 under this signer's key; `header.kid` overrides the advertised kid. */
  readonly sign: (claims: JwtClaims, header?: { readonly kid?: string }) => Promise<string>;
  /** Verify a token's signature against this signer's public key (no claim policy). */
  readonly verify: (token: string) => Promise<Result<JwtClaims, string>>;
};

export const createJwtSigner = async (kid: string): Promise<JwtSigner> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return {
    kid,
    jwks: { keys: [publicJwk] },
    sign: (claims, header) =>
      new SignJWT({ ...claims }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: header?.kid ?? kid }).sign(privateKey),
    verify: async (token) => verifyWith(publicKey, token),
  };
};

const verifyWith = async (publicKey: CryptoKey, token: string): Promise<Result<JwtClaims, string>> => {
  try {
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    return ok(payload);
  } catch (e) {
    return err(e instanceof Error ? e.name : "verification-failed");
  }
};

/**
 * The realm signature verifier at the network edge: checks the signature
 * against the realm signer's key in-process (no JWKS fetch) and brands the
 * claims. The production claim policy (validateRealmJwtClaims) still runs in
 * the auth middleware.
 */
export const createFakeRealmVerifier = (realm: JwtSigner): VerifyRealmJwt => async (token) => {
  const verified = await realm.verify(token);
  return verified.ok
    ? ok(markSignatureVerified(verified.value as unknown as RealmJwtClaims))
    : err({ kind: "invalid", reason: verified.error });
};

// ── Identity transports ──────────────────────────────────────────────────────

/** One form POST a token endpoint received. */
export type CapturedFormPost = { readonly url: string; readonly form: Readonly<Record<string, string>> };

/** A scripted answer for one token request; `undefined` falls through to the default answer. */
export type TokenEndpointScript = (request: CapturedFormPost) => HttpPostResponse | undefined;

export type IdentityRequests = {
  readonly realmToken: readonly CapturedFormPost[];
  readonly entraToken: readonly CapturedFormPost[];
  readonly entraJwks: readonly string[];
  readonly graph: readonly GraphRequest[];
};

export type IdentityTransportFakes = {
  /** The transports composeRunAuthorityWiring takes, as instantly-answering fakes. */
  readonly transports: IdentityTransports;
  readonly requests: IdentityRequests;
  /** The Entra requests that were on-behalf-of exchanges. */
  readonly onBehalfOfExchanges: () => readonly CapturedFormPost[];
  /** Realm-token, Entra-token and Graph requests: every token or resource egress (JWKS excluded). */
  readonly tokenEgress: () => number;
};

export const ENTRA_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";
export const ON_BEHALF_OF_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Entra's v2.0 signing-key URL for a tenant. */
export const entraJwksUrl = (tenant: string): string => `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;

export type IdentityTransportOptions = {
  readonly ledger: CredentialLedger;
  readonly realm: { readonly issuer: string; readonly signer: JwtSigner };
  /** The Entra tenants whose JWKS URL publishes this signer's keys. */
  readonly entra: { readonly tenants: readonly string[]; readonly signer: JwtSigner };
  readonly script?: { readonly realmToken?: TokenEndpointScript; readonly entraToken?: TokenEndpointScript };
};

const formOf = (url: string, body: string): CapturedFormPost => ({
  url,
  form: Object.fromEntries(new URLSearchParams(body)),
});

const tokenResponse = (json: Record<string, unknown>): HttpPostResponse => ({
  status: 200,
  json: { token_type: "Bearer", expires_in: 3600, ...json },
});

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A realm token endpoint answering client_credentials, scope "entra-exchange <capability>", with an RS256 assertion whose aud and scope carry exactly what the realm granted (AD-4). */
const realmTokenAnswer =
  (options: Pick<IdentityTransportOptions, "ledger" | "realm">) =>
  async (request: CapturedFormPost): Promise<HttpPostResponse> => {
    if (request.form.grant_type !== "client_credentials") {
      return { status: 400, json: { error: "unsupported_grant_type" } };
    }
    const scope = request.form.scope ?? "";
    const assertion = await options.realm.signer.sign({
      iss: options.realm.issuer,
      aud: scope.split(" ").includes("entra-exchange") ? [ENTRA_EXCHANGE_AUDIENCE] : ["account"],
      azp: request.form.client_id,
      sub: `service-account-${request.form.client_id ?? "unknown"}`,
      scope,
      iat: nowSec(),
      exp: nowSec() + 300,
      jti: options.ledger.sentinels["realm-assertion"],
    });
    options.ledger.record("realm-assertion", assertion);
    return tokenResponse({ access_token: assertion, expires_in: 300, scope });
  };

/** An Entra token endpoint issuing a sentinel per grant: app or T1 client credentials, on-behalf-of, refresh redeem. */
const entraTokenAnswer =
  (sentinels: CredentialLedger["sentinels"]) =>
  (request: CapturedFormPost): HttpPostResponse => {
    const issue = (kind: CredentialKind): string => sentinels[kind];
    const { form } = request;
    if (form.grant_type === "client_credentials") {
      // The agent-id blueprint step names the agent identity in fmi_path and yields T1.
      return tokenResponse({ access_token: issue(form.fmi_path !== undefined ? "t1-token" : "entra-app-access-token") });
    }
    if (form.grant_type === ON_BEHALF_OF_GRANT && form.requested_token_use === "on_behalf_of") {
      return tokenResponse({ access_token: issue("obo-access-token"), refresh_token: issue("refresh-token") });
    }
    if (form.grant_type === "refresh_token") {
      // A redeem answers with a new refresh credential that custody must drop unread (D1).
      return tokenResponse({ access_token: issue("obo-access-token"), refresh_token: issue("redeem-refresh-token") });
    }
    return { status: 400, json: { error: "invalid_request" } };
  };

/** A form-POST transport that captures each request, then answers it by script or, failing that, by default. */
const capturingTokenEndpoint = (
  captured: CapturedFormPost[],
  scripted: TokenEndpointScript | undefined,
  answer: (request: CapturedFormPost) => HttpPostResponse | Promise<HttpPostResponse>,
): HttpPost => ({
  post: async (url, body) => {
    const request = formOf(url, body);
    captured.push(request);
    return scripted?.(request) ?? (await answer(request));
  },
});

/** Entra's signing-key endpoint: publishes the signer's keys at each configured tenant's URL, 404 elsewhere. */
const capturingEntraJwks =
  (captured: string[], entra: IdentityTransportOptions["entra"]): JwksTransport =>
  async (url) => {
    captured.push(url);
    const published = entra.tenants.some((tenant) => entraJwksUrl(tenant) === url);
    return published ? { status: 200, json: entra.signer.jwks } : { status: 404, json: {} };
  };

const capturingGraph = (captured: GraphRequest[]): GraphHttp => ({
  request: async (req) => {
    captured.push(req);
    return { status: 200, json: {} };
  },
});

export const createIdentityTransports = (options: IdentityTransportOptions): IdentityTransportFakes => {
  const realmToken: CapturedFormPost[] = [];
  const entraToken: CapturedFormPost[] = [];
  const entraJwks: string[] = [];
  const graph: GraphRequest[] = [];

  const transports: IdentityTransports = {
    realmToken: capturingTokenEndpoint(realmToken, options.script?.realmToken, realmTokenAnswer(options)),
    entraToken: capturingTokenEndpoint(entraToken, options.script?.entraToken, entraTokenAnswer(options.ledger.sentinels)),
    entraJwks: capturingEntraJwks(entraJwks, options.entra),
    graph: capturingGraph(graph),
  };

  return {
    transports,
    requests: { realmToken, entraToken, entraJwks, graph },
    onBehalfOfExchanges: () => entraToken.filter((r) => r.form.requested_token_use === "on_behalf_of"),
    tokenEgress: () => realmToken.length + entraToken.length + graph.length,
  };
};

// ── Clock ────────────────────────────────────────────────────────────────────

/**
 * Wall-clock control through setSystemTime, so production clocks
 * (`() => epochMsOf(Date.now())`), jose's temporal checks and Redis TTLs in the
 * storage fake all read the same controlled instant.
 */
export type ClockControl = {
  readonly now: () => EpochMs;
  readonly set: (atMs: number) => void;
  readonly advance: (ms: number) => void;
  /** Back to the real wall clock. */
  readonly restore: () => void;
};

export const createClockControl = (): ClockControl => ({
  now: () => epochMsOf(Date.now()),
  set: (atMs) => {
    setSystemTime(new Date(atMs));
  },
  advance: (ms) => {
    setSystemTime(new Date(Date.now() + ms));
  },
  restore: () => {
    setSystemTime();
  },
});

// ── In-process UDS transport into the worker app ─────────────────────────────

export type WorkerFetch = (request: Request) => Response | Promise<Response>;

/** One request the supervisor forwarded, and the worker's answer, exactly as they crossed the socket. */
export type ForwardedExchange = {
  readonly socketPath: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly body: string;
};

export type InProcessUdsTransport = {
  readonly transport: UdsTransport;
  readonly exchanges: readonly ForwardedExchange[];
  /** While false, every connect fails as a refused socket (the worker is down). */
  readonly setReachable: (reachable: boolean) => void;
};

export const createInProcessUdsTransport = (worker: WorkerFetch): InProcessUdsTransport => {
  const exchanges: ForwardedExchange[] = [];
  let reachable = true;
  const transport: UdsTransport = async (socketPath, request) => {
    if (!reachable) return err({ reason: `connect ECONNREFUSED ${socketPath}` });
    const headers = Object.fromEntries(request.headers);
    const response = await worker(request);
    const body = await response.clone().text();
    exchanges.push({
      socketPath,
      method: request.method,
      path: new URL(request.url).pathname,
      headers,
      status: response.status,
      responseHeaders: Object.fromEntries(response.headers),
      body,
    });
    return ok(response);
  };
  return {
    transport,
    exchanges,
    setReachable: (next) => {
      reachable = next;
    },
  };
};

// ── Storage: in-memory Redis ─────────────────────────────────────────────────

type StoredValue = { readonly value: string; readonly expiresAtMs?: number };

export type InMemoryRedis = {
  /** A RedisPort whose transaction methods are all present, so it is also a HitlRedisPort. */
  readonly redis: RedisPort & HitlRedisPort;
  /** Every live string key (optionally under a prefix) with its stored bytes. */
  readonly entries: (prefix?: string) => readonly { readonly key: string; readonly value: string }[];
  /** Whole seconds left on a live key, or undefined for an absent or non-expiring key. */
  readonly ttlSecOf: (key: string) => number | undefined;
};

type StoredHash = { readonly fields: Map<string, string>; expiresAtMs?: number };

type RedisCommands = RedisPort & HitlRedisPort;

type ExpiryOptions = RedisExpiry | { readonly expiresInSec?: number };

/** The in-memory keyspace every command group reads and writes; expired strings are evicted on read. */
type RedisKeyspace = {
  readonly strings: Map<string, StoredValue>;
  readonly hashes: Map<string, StoredHash>;
  readonly sets: Map<string, Set<string>>;
  readonly live: (key: string) => string | undefined;
  readonly put: (key: string, value: string, opts?: ExpiryOptions) => void;
};

const expiryOf = (opts: ExpiryOptions | undefined): number | undefined => {
  if (opts?.expiresInSec !== undefined) return Date.now() + opts.expiresInSec * 1000;
  if (opts !== undefined && "expiresInMs" in opts && opts.expiresInMs !== undefined) return Date.now() + opts.expiresInMs;
  return undefined;
};

const createRedisKeyspace = (): RedisKeyspace => {
  const strings = new Map<string, StoredValue>();
  const live = (key: string): string | undefined => {
    const stored = strings.get(key);
    if (stored === undefined) return undefined;
    if (stored.expiresAtMs !== undefined && stored.expiresAtMs <= Date.now()) {
      strings.delete(key);
      return undefined;
    }
    return stored.value;
  };
  const put = (key: string, value: string, opts?: ExpiryOptions): void => {
    const expiresAtMs = expiryOf(opts);
    strings.set(key, expiresAtMs === undefined ? { value } : { value, expiresAtMs });
  };
  return { strings, hashes: new Map(), sets: new Map(), live, put };
};

const keyCommands = ({ strings, hashes, sets, live, put }: RedisKeyspace): Pick<RedisCommands, "get" | "set" | "del" | "scan"> => ({
  get: async (key) => ok(live(key) ?? null),
  set: async (key, value, opts) => {
    put(key, value, opts);
    return ok("OK");
  },
  del: async (key, ...more) => {
    const removed = [key, ...more].filter((k) => {
      const had = live(k) !== undefined || hashes.has(k) || sets.has(k);
      strings.delete(k);
      hashes.delete(k);
      sets.delete(k);
      return had;
    });
    return ok(removed.length);
  },
  scan: async (pattern) => {
    const prefix = pattern.replace(/\*$/, "");
    return ok({ cursor: "0", keys: [...strings.keys()].filter((k) => k.startsWith(prefix) && live(k) !== undefined) });
  },
});

const setCommands = ({ sets }: RedisKeyspace): Pick<RedisCommands, "sAdd" | "sRem" | "sMembers"> => ({
  sAdd: async (key, member) => {
    const set = sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    sets.set(key, set);
    return ok(added);
  },
  sRem: async (key, member) => ok(sets.get(key)?.delete(member) === true ? 1 : 0),
  sMembers: async (key) => ok([...(sets.get(key) ?? [])]),
});

type GuardedWrite =
  | "setNx"
  | "compareAndDelete"
  | "compareAndExpire"
  | "setIfValue"
  | "setIfValues"
  | "setNxIfPresent";

const guardedWriteCommands = ({ strings, live, put }: RedisKeyspace): Pick<RedisCommands, GuardedWrite> => ({
  setNx: async (key, value, opts) => {
    if (live(key) !== undefined) return ok(false);
    put(key, value, opts);
    return ok(true);
  },
  compareAndDelete: async (key, expected) => {
    if (live(key) !== expected) return ok(false);
    strings.delete(key);
    return ok(true);
  },
  compareAndExpire: async (key, expected, expiresInSec) => {
    if (live(key) !== expected) return ok(false);
    put(key, expected, { expiresInSec });
    return ok(true);
  },
  setIfValue: async (guardKey, expected, key, value, opts) => {
    if (live(guardKey) !== expected) return ok(false);
    put(key, value, opts);
    return ok(true);
  },
  setIfValues: async (guards: readonly RedisValueGuard[], key, value, opts) => {
    if (!guards.every((guard) => live(guard.key) === guard.expectedValue)) return ok(false);
    put(key, value, opts);
    return ok(true);
  },
  setNxIfPresent: async (guardKey, key, value, opts) => {
    if (live(guardKey) === undefined) return ok("not-present" as const);
    if (live(key) !== undefined) return ok("exists" as const);
    put(key, value, opts);
    return ok("created" as const);
  },
});

const hashCommands = ({ hashes }: RedisKeyspace): Pick<RedisCommands, "hGetAll" | "hSet"> => ({
  hGetAll: async (key) => {
    const hash = hashes.get(key);
    if (hash === undefined || (hash.expiresAtMs !== undefined && hash.expiresAtMs <= Date.now())) {
      hashes.delete(key);
      return ok({});
    }
    return ok(Object.fromEntries(hash.fields));
  },
  hSet: async (key, field, value, opts) => {
    const hash = hashes.get(key) ?? { fields: new Map<string, string>() };
    hash.fields.set(field, value);
    const expiresAtMs = expiryOf(opts);
    if (expiresAtMs !== undefined) hash.expiresAtMs = expiresAtMs;
    hashes.set(key, hash);
    return ok(undefined);
  },
});

export const createInMemoryRedis = (): InMemoryRedis => {
  const keyspace = createRedisKeyspace();
  const { strings, live } = keyspace;
  return {
    redis: { ...keyCommands(keyspace), ...setCommands(keyspace), ...guardedWriteCommands(keyspace), ...hashCommands(keyspace) },
    entries: (prefix = "") =>
      [...strings.keys()]
        .filter((key) => key.startsWith(prefix))
        .flatMap((key) => {
          const value = live(key);
          return value === undefined ? [] : [{ key, value }];
        }),
    ttlSecOf: (key) => {
      const stored = live(key) === undefined ? undefined : strings.get(key);
      return stored?.expiresAtMs === undefined ? undefined : Math.floor((stored.expiresAtMs - Date.now()) / 1000);
    },
  };
};

/** SharedInfra over the in-memory Redis, logging and tracing into the capturing sinks. */
export const createSharedInfra = (deps: {
  readonly redis: RedisPort;
  readonly logger: LogPort;
  readonly tracer: Tracer;
}): SharedInfra => ({ ...fakeInfra(deps.redis), logger: deps.logger, tracer: deps.tracer });

// ── Notifier transports and the bot token verifier ───────────────────────────

export type RecordingBotConnector = BotConnectorPort & {
  readonly sent: readonly { readonly ref: ConversationReference; readonly activity: unknown }[];
};

export const createRecordingBotConnector = (): RecordingBotConnector => {
  const sent: { readonly ref: ConversationReference; readonly activity: unknown }[] = [];
  return {
    sent,
    sendToConversation: async (ref, activity) => {
      sent.push({ ref, activity });
      return ok(undefined);
    },
  };
};

export type RecordingWebhookHttp = WebhookHttp & {
  readonly posted: readonly { readonly url: string; readonly body: unknown }[];
};

const parseJsonOrText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const createRecordingWebhookHttp = (status = 200): RecordingWebhookHttp => {
  const posted: { readonly url: string; readonly body: unknown }[] = [];
  return {
    posted,
    post: async (url, jsonBody) => {
      posted.push({ url, body: parseJsonOrText(jsonBody) });
      return { status };
    },
  };
};

/** Accepts exactly `Bearer <acceptedToken>`; anything else is an invalid Bot Framework token. */
export const createFakeVerifyBotToken = (acceptedToken: string): VerifyBotToken => async (authHeader) =>
  authHeader === `Bearer ${acceptedToken}` ? ok(undefined) : err({ kind: "invalid", reason: "not the accepted bot token" });

// ── Capturing logger, tracer and audit sink ──────────────────────────────────

export type CapturedLogLine = {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly data?: Record<string, unknown>;
};

export type CapturingLogger = LogPort & { readonly lines: readonly CapturedLogLine[] };

export const createCapturingLogger = (): CapturingLogger => {
  const lines: CapturedLogLine[] = [];
  const at = (level: CapturedLogLine["level"]) => (msg: string, data?: Record<string, unknown>) => {
    lines.push(data === undefined ? { level, msg } : { level, msg, data });
  };
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
};

export type CapturedSpan = { readonly name: string; readonly spanType: string };

export type CapturingTracer = Tracer & { readonly spans: readonly CapturedSpan[] };

export const createCapturingTracer = (): CapturingTracer => {
  const spans: CapturedSpan[] = [];
  return {
    spans,
    withSpan: async (name, spanType, fn) => {
      spans.push({ name, spanType });
      return fn();
    },
  };
};

/** One call the audit sink received: its method name and arguments, as passed. */
export type AuditCall = { readonly method: string; readonly args: readonly unknown[] };

/**
 * An audit sink that records every method call and resolves: the wiring's audit
 * channel (a LogPort), and any later contract's audit port, whatever its method
 * names.
 */
export type CapturingAuditSink = {
  readonly sink: LogPort & Readonly<Record<string, (...args: readonly unknown[]) => Promise<void>>>;
  readonly records: readonly AuditCall[];
};

export const createCapturingAuditSink = (): CapturingAuditSink => {
  const records: AuditCall[] = [];
  // A Proxy answers every property, so its empty target is typed as what the Proxy serves.
  const sink = new Proxy({} as CapturingAuditSink["sink"], {
    get: (_target, property) =>
      // `then` stays undefined so the sink is never mistaken for a promise.
      typeof property === "string" && property !== "then"
        ? async (...args: readonly unknown[]) => {
            records.push({ method: property, args });
          }
        : undefined,
  });
  return { sink, records };
};

// ── Deployment configuration ─────────────────────────────────────────────────

/** A deployment's identity configuration, described by meaning; `identityDeploymentEnv` spells it as host env. */
export type IdentityDeployment = {
  readonly adminToken: string;
  /** The realm; absent → an unbrokered host (no realm JWT path, no capability brokering). */
  readonly realm?: { readonly issuer: string; readonly audience: string; readonly tokenUrl: string };
  /** DAG id → agent client id (AGENT_CLIENT_MAP). */
  readonly agentClientMap: Readonly<Record<string, string>>;
  /** Agent client id → its realm client credentials (KEYCLOAK_AGENT_CLIENT_CREDENTIALS). */
  readonly agentClientCredentials: Readonly<Record<string, { readonly clientId: string; readonly clientSecret: string }>>;
  /** The Entra leg; absent → dark. A model left undefined is an unset ENTRA_IDENTITY_MODEL. */
  readonly entra?: {
    readonly tenant: string;
    readonly model?: "agent-id" | "app-registration";
    readonly blueprint?: string;
    /** Agent client id → its Entra identity (application) id (ENTRA_AGENT_IDENTITIES). */
    readonly agentIdentities: Readonly<Record<string, string>>;
  };
  /** The delegation leg's keys; each one left undefined stays unset. */
  readonly delegation?: {
    readonly custodyKeys?: "generated";
    readonly clients?: readonly string[];
    readonly scope?: string;
  };
};

/** A DELEGATED_CUSTODY_KEYS value: the active kid and one fresh base64 32-byte key. */
export const generatedCustodyKeyring = (): string =>
  JSON.stringify({
    active: "k1",
    keys: { k1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") },
  });

const BASE_HOST_ENV: Readonly<Record<string, string>> = {
  DAGS_REPO_URL: "https://github.com/test/dags.git",
  DAGS_LOCAL_PATH: "/tmp/test-dags",
  REDIS_URL: "redis://localhost:6379",
  PORT: "8080",
  DAGS_POLL_INTERVAL_MS: "60000",
  REDIS_PROBE_INTERVAL_MS: "60000",
  LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "test-key",
};

const definedEntries = (record: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** The host env a deployment is configured by, for the production config parser. */
export const identityDeploymentEnv = (deployment: IdentityDeployment): Record<string, string> =>
  definedEntries({
    ...BASE_HOST_ENV,
    ADMIN_TOKEN: deployment.adminToken,
    REALM_JWT_ISSUER: deployment.realm?.issuer,
    REALM_JWT_AUDIENCE: deployment.realm?.audience,
    KEYCLOAK_TOKEN_URL: deployment.realm?.tokenUrl,
    AGENT_CLIENT_MAP: JSON.stringify(deployment.agentClientMap),
    KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify(deployment.agentClientCredentials),
    ENTRA_TENANT_ID: deployment.entra?.tenant,
    ENTRA_IDENTITY_MODEL: deployment.entra?.model,
    ENTRA_BLUEPRINT_CLIENT_ID: deployment.entra?.blueprint,
    ENTRA_AGENT_IDENTITIES: deployment.entra === undefined ? undefined : JSON.stringify(deployment.entra.agentIdentities),
    DELEGATED_CUSTODY_KEYS: deployment.delegation?.custodyKeys === "generated" ? generatedCustodyKeyring() : undefined,
    DELEGATED_CLIENT_APPS: deployment.delegation?.clients?.join(","),
    DELEGATED_SCOPE: deployment.delegation?.scope,
  });
