/**
 * CT-1 — Run-start authority admission: the run-authority types.
 *
 * Declarations only: types, sealed unions and function signatures, no runtime
 * value. Every type here is declared once, in this file. The modules that build
 * or read these values import them from here and never redeclare them, the
 * capability-catalog and identity-topology types included.
 *
 * A branded type is minted only by the builders its owning module exports, so
 * holding one is a proof of how it was built:
 *
 *   - jwt-validation.ts      RealmSubject (validateRealmJwtClaims: the verified realm `sub`)
 *   - duration.ts            EpochMs, DurationMs (epochMsOf, durationOfSeconds, durationOfMs,
 *                            addDuration, remainingUntil: the only instant arithmetic)
 *   - redacted-secret.ts     RedactedSecret (redactSecret; revealSecret is its only reader)
 *   - capability-catalog.ts  CapabilityScope, CapabilityCatalog, BrokeredNamespaces, AdmittedCapability
 *   - config.ts              DelegatedScope, CustodyKeyring (loadConfig's parsers)
 *   - delegated-custody.ts   CustodySeconds, DelegationWindow (INV-8)
 *   - entra-user-token.ts    VerifiedEntraClaims (validateEntraUserTokenClaims), issuerFor
 *   - run-authority.ts       RunAccess, UnbrokeredAccess, DelegatedTokenExpectation, VerifiedDelegationGrant,
 *                            BoundAuthority (with establishment and the custody module), and every Fn below
 *   - run-authority-admission.ts  AdmittedRun (admitRunAuthority)
 *   - run-authority-lifecycle.ts  AuthorizedRun (authorizedRunOf)
 *
 * authority-legs.ts builds the unbranded leg values (planAuthorityLegs,
 * delegationOf, mintLegsOf) and its configuration faults over the
 * EntraDirectory, EntraLeg, DelegationLeg, KeycloakLeg, AuthorityLegs, MintLegs
 * and IdentityConfigFault declared here, which it imports and never redeclares.
 * Likewise the later contracts import, never redeclare, what run start already
 * needs of them: CT-2 RunMintingAuthority, CT-3 SyncRunEnding, AuthorizedRun
 * and SyncRunBracket (its RunAuthorityLifecycle extends the bracket), and
 * adapters/run-authority-wiring.ts the IdentityTransports, RunStartWiring and
 * ComposeRunAuthorityWiringFn it implements.
 *
 * No credential material is representable in any value below except as a
 * `RedactedSecret` (FR-022, INV-3): refusals carry check names, configuration
 * key names and requirement references, never a claim value or a token.
 */

import type { DagId, InvocationOrigin, MintingAuthority, NodeId, Result, RunId, Tracer } from "@fuguejs/framework";
import type { LogPort, RedisPort } from "../ports.js";
import type { AgentClientId, Team } from "./auth.js";
import type { HostConfig, KeycloakClientCredentialConfig } from "./config.js";
import type { RegisteredDag } from "./registry.js";
import type { TenantId } from "./tenant-id.js";

// ── Brands and collection shapes ─────────────────────────────────────────────

declare const brand: unique symbol;

/** A nominal type: `T` minted only by the builder its declaration names. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NonEmptyArray<T> = readonly [T, ...T[]];
/** size ≥ 1; branded only by the builder of the type that holds it. */
export type NonEmptyReadonlySet<T> = Brand<ReadonlySet<T>, "NonEmptySet">;
/** size ≥ 1; branded only inside RunAccess's builders (accessOf, parseRunAccess). */
export type NonEmptyReadonlyMap<K, V> = Brand<ReadonlyMap<K, V>, "NonEmpty">;

// ── Entra identities ─────────────────────────────────────────────────────────

/** An Entra object id (a GUID); parsed only by jwt-validation.ts's parseEntraObjectId or the claim validator. */
export type EntraObjectId = Brand<string, "EntraObjectId">;
/** An Entra tenant id (a GUID). */
export type EntraTenantId = Brand<string, "EntraTenantId">;
/** An Entra application (client) id (a GUID): a blueprint, an agent identity or a delegated-token client. */
export type EntraClientId = Brand<string, "EntraClientId">;

/** The person an Entra token or the realm's entra_oid/entra_tid claims name. */
export type EntraPrincipal = { readonly oid: EntraObjectId; readonly tid: EntraTenantId };

/**
 * The realm token's verified `sub`: the person a user-origin run is attributed
 * to. Branded so an `azp`, a team label or an Entra oid cannot stand where the
 * subject is expected (originOf copies it into the run's InvocationOrigin).
 */
export type RealmSubject = Brand<string, "RealmSubject">;

/** The human who started a user-origin run: the realm subject and their Entra principal. Attribution only, never authority. */
export type Initiator = { readonly realmSub: RealmSubject; readonly entra: EntraPrincipal };

/**
 * The identity the planner reads. Structural, so `AuthIdentity` is assignable
 * to it once its `user` variant carries the realm subject as a RealmSubject and
 * the realm Entra principal; the planner never reads an authorization policy or
 * a token from it.
 */
export type RunAuthorityIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "team"; readonly team: Team; readonly label: string }
  | { readonly kind: "user"; readonly sub: RealmSubject; readonly azp: string; readonly entra: EntraPrincipal };

// ── Time ─────────────────────────────────────────────────────────────────────

/** An instant, ms since the epoch. Every identity-subsystem clock is `() => EpochMs`. */
export type EpochMs = Brand<number, "EpochMs">;
/** A non-negative span of ms. No arithmetic mixes it with a bare number. */
export type DurationMs = Brand<number, "DurationMs">;

// ── Secrets ──────────────────────────────────────────────────────────────────

declare const redactedSecret: unique symbol;

/**
 * A credential held without exposure: a frozen value with no enumerable own
 * property whose `toJSON`, `toString` and `Bun.inspect` rendering are all
 * `"[redacted]"`. Built only by redactSecret; read only by revealSecret,
 * whose callers are the Entra form-body builders, the custody cipher's seal
 * and the user-token verifier.
 */
export type RedactedSecret = {
  readonly [redactedSecret]: true;
  readonly toJSON: () => "[redacted]";
  readonly toString: () => "[redacted]";
};

// ── Capability catalog (owned by capability-catalog.ts) ──────────────────────

/** A capability's authority mode. Every catalog entry declares one; there is no default (AD-2). */
export type AuthorityMode = "app" | "delegated";
/** The downstream resource a brokered capability reaches. */
export type CapabilityResource = "graph" | "dynamics";
/** One catalog entry: its authority mode and its resource, both required (AD-2: no default). */
export type CapabilityDefinition = { readonly authority: AuthorityMode; readonly resource: CapabilityResource };

/**
 * A capability the parsed catalog declares, carrying that entry's definition.
 * Minted only by the catalog module, once per entry of a parsed
 * `CapabilityCatalog`, so no scope exists without an authority mode and a
 * resource. authorityOf (INV-2 owner) and resourceOf are its only readers of
 * `definition`, and are total; every other module, checkAdmittedAuthority's
 * mode-changed and resource-changed comparisons included, reads the mode and
 * the resource through them.
 */
export type CapabilityScope = Brand<
  { readonly name: string; readonly definition: CapabilityDefinition },
  "CapabilityScope"
>;
/**
 * Built only by parseCapabilityCatalog: each catalog key maps to the scope
 * minted for it, whose `name` is that key and whose `definition` is that
 * entry's authority and resource.
 */
export type CapabilityCatalog = Brand<ReadonlyMap<string, CapabilityScope>, "CapabilityCatalog">;
/** The one namespace rule's set: the built-in providers (msgraph, dynamics) ∪ the catalog's key prefixes. */
export type BrokeredNamespaces = Brand<ReadonlySet<string>, "BrokeredNamespaces">;

/** One capability a run admitted, with the resource it was admitted against. Built only by admittedCapabilityOf and parseRunAccess. */
export type AdmittedCapability = Brand<{ readonly name: string; readonly resource: CapabilityResource }, "AdmittedCapability">;

// ── Requirements ─────────────────────────────────────────────────────────────

/** One node's declared capability, as the runtime node inventory gives it: unparsed. */
export type RawCapabilityRequirement = { readonly nodeId: NodeId; readonly capability: string };
/** A brokered requirement, parsed by classifyCapabilities. */
export type CapabilityRequirement = { readonly nodeId: NodeId; readonly scope: CapabilityScope };
/** One shape: a refusal names a requirement as the inventory gave it. */
export type RequirementRef = RawCapabilityRequirement;

// ── Run access (built and read only in run-authority.ts) ─────────────────────

export type AccessEntry<M extends AuthorityMode> = { readonly mode: M; readonly capability: AdmittedCapability };

/**
 * Pass 1's per-run mode resolution, persisted with the authority. Name-keyed,
 * so no name sits under two modes; both maps and `passThrough` (the names pass 1
 * classified not-brokered, AD-12) are disjoint. Built only by accessOf and
 * parseRunAccess.
 */
export type RunAccess = Brand<
  | {
      readonly kind: "app";
      readonly app: ReadonlyMap<string, AccessEntry<"app">>;
      readonly delegated?: never;
    }
  | {
      readonly kind: "delegating";
      readonly delegated: NonEmptyReadonlyMap<string, AccessEntry<"delegated">>;
      readonly app: ReadonlyMap<string, AccessEntry<"app">>;
    },
  "RunAccess"
> & { readonly passThrough: ReadonlySet<string> };

export type AppAccess = Extract<RunAccess, { readonly kind: "app" }>;
export type DelegatingAccess = Extract<RunAccess, { readonly kind: "delegating" }>;

/** An unbrokered host's access: every requirement name passes through. Built only by unbrokeredAccessOf and parseRunAccess. */
export type UnbrokeredAccess = Brand<{ readonly kind: "unbrokered"; readonly passThrough: ReadonlySet<string> }, "UnbrokeredAccess">;

/** What every RunAuthority variant carries; parseRunAccess parses either. */
export type AdmittedAccess = RunAccess | UnbrokeredAccess;

// ── Identity topology (owned by authority-legs.ts and delegated-custody.ts) ──

/** One scope token, no whitespace (DELEGATED_SCOPE); parsed by loadConfig. No default (D4). */
export type DelegatedScope = Brand<string, "DelegatedScope">;
/** 0 < seconds ≤ HITL_RUN_TTL_SEC; built only by parseCustodySeconds. */
export type CustodySeconds = Brand<number, "CustodySeconds">;
/** DELEGATED_CUSTODY_KEYS parsed: every key 32 bytes and `active` one of them; built only by loadConfig's parser. */
export type CustodyKeyring = Brand<
  { readonly active: string; readonly keys: ReadonlyMap<string, Uint8Array> },
  "CustodyKeyring"
>;

/** The deployment's Entra identity model, declared by ENTRA_IDENTITY_MODEL with no default (AD-3). */
export type EntraDirectory =
  | {
      readonly model: "agent-id";
      readonly tenant: EntraTenantId;
      readonly blueprint: EntraClientId;
      readonly agents: ReadonlyMap<AgentClientId, EntraClientId>;
    }
  | {
      readonly model: "app-registration";
      readonly tenant: EntraTenantId;
      readonly agents: ReadonlyMap<AgentClientId, EntraClientId>;
    };

/** The keys whose presence wires the delegation leg (D4: no defaults). */
export type DelegationLegKey = "DELEGATED_CUSTODY_KEYS" | "DELEGATED_CLIENT_APPS" | "DELEGATED_SCOPE";
/** The keys whose presence wires the Entra leg. */
export type EntraLegKey = "ENTRA_TENANT_ID" | "ENTRA_AGENT_IDENTITIES";
/** The key whose presence wires the Keycloak leg. */
export type KeycloakLegKey = "KEYCLOAK_AGENT_CLIENT_CREDENTIALS";

/**
 * delegationOf's unavailable answer: the Entra leg's missing keys when it is
 * dark (no delegation leg exists then), else the dark delegation leg's.
 */
export type DelegationUnavailableKey = EntraLegKey | DelegationLegKey;

/** The delegation leg exists only inside a wired Entra leg; dark names every unset key (D4: no defaults). */
export type DelegationLeg =
  | {
      readonly kind: "wired";
      readonly keys: CustodyKeyring;
      readonly maxSec: CustodySeconds;
      readonly clients: NonEmptyReadonlySet<EntraClientId>;
      readonly scope: DelegatedScope;
    }
  | { readonly kind: "dark"; readonly missing: NonEmptyArray<DelegationLegKey> };

export type EntraLeg =
  | { readonly kind: "wired"; readonly directory: EntraDirectory; readonly delegation: DelegationLeg }
  | {
      readonly kind: "dark";
      readonly missing: NonEmptyArray<EntraLegKey>;
      /** Every other set ENTRA_* or DELEGATED_* key, named (never valued) in the boot warning. */
      readonly ignored: readonly string[];
    };

export type DelegatingEntraLeg = Extract<EntraLeg, { readonly kind: "wired" }> & {
  readonly delegation: Extract<DelegationLeg, { readonly kind: "wired" }>;
};

export type KeycloakLeg =
  | {
      readonly kind: "wired";
      readonly tokenUrl: string;
      readonly credentials: Readonly<Record<string, KeycloakClientCredentialConfig>>;
    }
  | { readonly kind: "unwired"; readonly missing: KeycloakLegKey };

export type AuthorityLegs = { readonly keycloak: KeycloakLeg; readonly entra: EntraLeg };

/**
 * A refused identity configuration: only for a configured leg, or a removed
 * key. planAuthorityLegs returns every fault, not the first; the wiring returns
 * them as its Err and host.ts reports them as identity-config-invalid. Names
 * keys and ids, never a secret.
 */
export type IdentityConfigFault =
  | { readonly kind: "identity-model-missing" }
  | { readonly kind: "identity-model-unknown"; readonly value: string }
  | { readonly kind: "blueprint-missing" }
  | { readonly kind: "blueprint-forbidden"; readonly model: "app-registration" }
  | { readonly kind: "agent-identity-missing"; readonly agentClientIds: readonly AgentClientId[] }
  | { readonly kind: "agent-identity-orphan"; readonly agentClientIds: readonly string[] }
  | { readonly kind: "agent-identity-shared"; readonly entraClientId: string; readonly agentClientIds: readonly AgentClientId[] }
  | { readonly kind: "removed-key"; readonly key: "ENTRA_CLIENT_ID"; readonly replacement: string }
  | { readonly kind: "custody-max-exceeds-run-ttl"; readonly maxSec: number; readonly runTtlSec: number };

/**
 * THE dark-leg rule's answer (mintLegsOf over AuthorityLegs): wired iff both
 * legs are; dark names every missing key of both. Derived where it is used,
 * never stored beside a leg it could disagree with.
 */
export type MintLegs =
  | {
      readonly kind: "wired";
      readonly keycloak: Extract<KeycloakLeg, { readonly kind: "wired" }>;
      readonly entra: Extract<EntraLeg, { readonly kind: "wired" }>;
    }
  | { readonly kind: "dark"; readonly missing: NonEmptyArray<KeycloakLegKey | EntraLegKey> };

/**
 * The boot brokering state, built once by brokeringOf (IN-21) and consumed
 * unchanged by the planner, the lifecycle's drift check and the wiring:
 * brokered iff REALM_JWT_ISSUER is set. It carries the Entra leg the planner
 * reads (delegationOf, delegatedAudienceFor) and no mint decision: the mint
 * path derives that from AuthorityLegs with mintLegsOf, so no brokering state
 * can pair a wired mint with a dark Entra leg.
 */
export type BrokeringNow =
  | { readonly kind: "brokered"; readonly catalog: CapabilityCatalog; readonly entra: EntraLeg }
  | { readonly kind: "unbrokered" };

// ── Run authority ────────────────────────────────────────────────────────────

/**
 * A user-delegated run's window (INV-8): the run deadline, fixed at
 * establishment, and the custody expiry, never after it. Built only by
 * openDelegationWindow, renewDelegationWindow (keeps runDeadlineMs) and
 * parseDelegationWindow.
 */
export type DelegationWindow = Brand<
  { readonly runDeadlineMs: EpochMs; readonly custodyExpiresAtMs: EpochMs },
  "DelegationWindow"
>;

/**
 * The one authority a run acts under, decided before any HITL fork,
 * concurrency slot or token egress. No variant holds a run id (BoundAuthority
 * pairs it) or an audience (INV-5: delegatedAudienceFor answers it).
 */
export type RunAuthority =
  | {
      readonly kind: "unbrokered";
      readonly principal: { readonly kind: "agent" } | { readonly kind: "user"; readonly initiator: Initiator };
      readonly access: UnbrokeredAccess;
    }
  | { readonly kind: "agent"; readonly agentClientId: AgentClientId; readonly access: AppAccess }
  | {
      readonly kind: "user-app";
      readonly agentClientId: AgentClientId;
      readonly initiator: Initiator;
      readonly access: AppAccess;
    }
  | {
      readonly kind: "user-delegated";
      readonly agentClientId: AgentClientId;
      readonly initiator: Initiator;
      readonly access: DelegatingAccess;
      readonly delegation: DelegationWindow;
    };

export type BrokeredRunAuthority = Exclude<RunAuthority, { readonly kind: "unbrokered" }>;
export type UserDelegatedAuthority = Extract<RunAuthority, { readonly kind: "user-delegated" }>;

// ── Delegated presentation ───────────────────────────────────────────────────

/** The header a run-starting caller presents the Entra user token in (AD-7, FR-036). */
export type DelegatedAuthorizationHeaderName = "X-Fugue-Delegated-Authorization";

/** parseDelegatedTokenHeader's answer: `X-Fugue-Delegated-Authorization: Bearer <compact JWT>`. */
export type DelegatedHeader =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly token: RedactedSecret }
  | { readonly kind: "malformed" };

/**
 * What a delegated token must satisfy. Built only by expectationFor, shared by
 * pass 1 and planReauthorization: the audience from delegatedAudienceFor
 * (INV-5), the clients and scope from the wired DelegationLeg (D4). No issuer:
 * issuerFor(tenant) derives it where it is checked.
 */
export type DelegatedTokenExpectation = Brand<
  {
    readonly tenant: EntraTenantId;
    readonly audience: EntraClientId;
    readonly clients: NonEmptyReadonlySet<EntraClientId>;
    readonly scope: DelegatedScope;
  },
  "DelegatedTokenExpectation"
>;

/** The claims validateEntraUserTokenClaims proved: the principal, the client that obtained the token and its expiry. */
export type VerifiedEntraClaims = Brand<
  { readonly principal: EntraPrincipal; readonly client: EntraClientId; readonly expiresAtMs: EpochMs },
  "VerifiedEntraClaims"
>;

/** A verified, bound delegated presentation: the step's token (still redacted) and its validated claims. Built only by admitDelegatedPresentation. */
export type VerifiedDelegationGrant = Brand<
  { readonly token: RedactedSecret; readonly claims: VerifiedEntraClaims },
  "VerifiedDelegationGrant"
>;

/** What the shell's signature check yields: claims only, never trusted beyond their signature. */
export type DelegatedPresentation =
  | { readonly kind: "signature-verified"; readonly claims: unknown }
  | { readonly kind: "signature-rejected"; readonly reason: "malformed" | "signature" };

// ── Plans ────────────────────────────────────────────────────────────────────

export type RunAuthorityPlan =
  | Exclude<RunAuthority, { readonly kind: "user-delegated" }>
  | {
      readonly kind: "user-delegated-pending";
      readonly agentClientId: AgentClientId;
      readonly initiator: Initiator;
      readonly access: DelegatingAccess;
      readonly grant: VerifiedDelegationGrant;
    };

export type PendingPlan = Extract<RunAuthorityPlan, { readonly kind: "user-delegated-pending" }>;

/** Pass 1's result: a decided plan, or the one step that needs the verifier. */
export type AdmissionStep =
  | { readonly kind: "decided"; readonly plan: Exclude<RunAuthorityPlan, { readonly kind: "user-delegated-pending" }> }
  | {
      readonly kind: "verify-delegated";
      readonly token: RedactedSecret;
      readonly expect: DelegatedTokenExpectation;
      readonly pending: {
        readonly agentClientId: AgentClientId;
        readonly initiator: Initiator;
        readonly access: DelegatingAccess;
      };
    };

export type VerifyDelegatedStep = Extract<AdmissionStep, { readonly kind: "verify-delegated" }>;

/** An admitted run, taken whole so no identity, plan or run id is paired wrongly. Built only by admitRunAuthority. */
export type AdmittedRun<P extends RunAuthorityPlan = RunAuthorityPlan> = Brand<
  { readonly runId: RunId; readonly dagId: DagId; readonly ownerTeam: Team; readonly plan: P },
  "AdmittedRun"
>;

/**
 * An authority paired with its run id. Built only by bindAdmission,
 * establishDelegation, boundAuthorityOf (the record's own runId) and
 * renewedAuthority: no loose pair anywhere.
 */
export type BoundAuthority<A extends RunAuthority = RunAuthority> = Brand<
  { readonly runId: RunId; readonly authority: A },
  "BoundAuthority"
>;

/** Pass 1's input. The agent mapping is the DAG's AGENT_CLIENT_MAP entry; requirements are classified first. */
export type AgentMapping =
  | { readonly kind: "mapped"; readonly agentClientId: AgentClientId }
  | { readonly kind: "unmapped" };

export type RunAuthorityInput = {
  readonly dagId: DagId;
  readonly identity: RunAuthorityIdentity;
  readonly agent: AgentMapping;
  readonly requirements: readonly RawCapabilityRequirement[];
  readonly brokering: BrokeringNow;
  readonly header: DelegatedHeader;
};

// ── Refusals ─────────────────────────────────────────────────────────────────

/** The failed check of a delegated token, never a claim value (AS-040). */
export type DelegatedTokenInvalidReason =
  | "malformed"
  | "signature"
  | "issuer"
  | "tenant"
  | "audience"
  | "client"
  | "expired"
  | "not-yet-valid"
  | "not-delegated"
  | "scope"
  | "version";

/** Why delegated authority could not be established; built only by runAuthorityRefusalOf. `window-closed`: IN-19. */
export type DelegationNotEstablishedReason =
  | "refused"
  | "federation-rejected"
  | "grant-missing"
  | "unreachable"
  | "unconfigured"
  | "defect"
  | "window-closed";

export type RunAuthorityRefusal =
  /** Every unknown brokered-namespace requirement, ahead of every other refusal. */
  | { readonly kind: "capability-unknown"; readonly capabilities: NonEmptyArray<RequirementRef> }
  /** An agent-origin (admin or team) run whose DAG requires a delegated capability (FR-006). */
  | { readonly kind: "delegated-capability-requires-user"; readonly nodeId: NodeId; readonly capability: string }
  /** No delegated token on a run that needs one; the response names the header and the audience (FR-007). */
  | {
      readonly kind: "delegated-token-required";
      readonly requirements: NonEmptyArray<RequirementRef>;
      readonly audience: EntraClientId;
    }
  | { readonly kind: "delegated-token-invalid"; readonly reason: DelegatedTokenInvalidReason }
  | { readonly kind: "identity-binding-mismatch"; readonly field: "oid" | "tid" }
  /** Re-authorization only (AD-13). */
  | { readonly kind: "reauthorization-initiator-mismatch"; readonly field: "identity" | "oid" | "tid" }
  /** Re-authorization only: under one second of the run deadline left. */
  | { readonly kind: "reauthorization-window-closed" }
  /** Re-authorization only: the recorded agent left the Entra directory since establishment. */
  | { readonly kind: "reauthorization-agent-unmapped" }
  /** Re-authorization only: names the header and the audience; no node or requirement. */
  | { readonly kind: "reauthorization-token-required"; readonly audience: EntraClientId }
  /** A delegated token sent to a run that needs no delegation. */
  | { readonly kind: "delegated-token-unexpected" }
  /** Delegation without a wired delegation leg: delegationOf's missing keys, never a default (D4). */
  | { readonly kind: "delegation-unconfigured"; readonly missing: NonEmptyArray<DelegationUnavailableKey> }
  | { readonly kind: "agent-client-unmapped"; readonly dagId: DagId }
  | { readonly kind: "delegation-not-established"; readonly reason: DelegationNotEstablishedReason };

/** The statuses a refusal answers with. */
export type RunAuthorityRefusalStatus = 400 | 401 | 403 | 410 | 500 | 502 | 503;

/**
 * A table keyed by exactly `K` with `V` values: the result is a mapped type
 * over `K`, and `T` compiles only when it maps every member of `K` and nothing
 * else, so a new member fails to compile until its row is written and a stale
 * row is refused.
 */
type ExactTable<
  K extends PropertyKey,
  V,
  T extends { readonly [P in K]: V } & { readonly [P in Exclude<keyof T, K>]: never },
> = { readonly [P in K]: T[P] };

/**
 * Each refusal's HTTP status, as a type the status table is checked against.
 * Keyed by RunAuthorityRefusal's kinds and, for `delegation-not-established`,
 * by DelegationNotEstablishedReason: only the status literals are written here.
 */
export type RunAuthorityRefusalHttpStatus = ExactTable<
  RunAuthorityRefusal["kind"],
  RunAuthorityRefusalStatus | { readonly [R in DelegationNotEstablishedReason]: RunAuthorityRefusalStatus },
  {
    "capability-unknown": 503;
    "delegated-capability-requires-user": 403;
    "delegated-token-required": 401;
    "delegated-token-invalid": 401;
    "identity-binding-mismatch": 403;
    "reauthorization-initiator-mismatch": 403;
    "reauthorization-window-closed": 410;
    "reauthorization-agent-unmapped": 503;
    "reauthorization-token-required": 401;
    "delegated-token-unexpected": 400;
    "delegation-unconfigured": 503;
    "agent-client-unmapped": 503;
    "delegation-not-established": ExactTable<
      DelegationNotEstablishedReason,
      RunAuthorityRefusalStatus,
      {
        refused: 403;
        "federation-rejected": 502;
        "grant-missing": 403;
        unreachable: 503;
        unconfigured: 503;
        defect: 500;
        "window-closed": 503;
      }
    >;
  }
>;

/**
 * The `details` of a refused submission's error response
 * (`{ ok: false, error: "run-authority-refused", message, details, dagId }`):
 * the typed refusal itself, whatever its status, since it names only checks,
 * keys, nodes and capabilities.
 */
export type RunAuthorityRefusalDetails = { readonly refusal: RunAuthorityRefusal };

/** Pass 1's refusals: everything static. A malformed header is its only token refusal. */
export type PlanRefusal =
  | Exclude<
      RunAuthorityRefusal,
      {
        readonly kind:
          | "delegated-token-invalid"
          | "identity-binding-mismatch"
          | "delegation-not-established"
          | "reauthorization-initiator-mismatch"
          | "reauthorization-window-closed"
          | "reauthorization-agent-unmapped"
          | "reauthorization-token-required";
      }
    >
  | { readonly kind: "delegated-token-invalid"; readonly reason: "malformed" };

/** planReauthorization's static subset; the endpoint then adds PresentationRefusal and EstablishmentRefusal. */
export type ReauthorizationRefusal =
  | Extract<
      RunAuthorityRefusal,
      {
        readonly kind:
          | "reauthorization-initiator-mismatch"
          | "reauthorization-window-closed"
          | "delegation-unconfigured"
          | "reauthorization-agent-unmapped"
          | "reauthorization-token-required";
      }
    >
  | { readonly kind: "delegated-token-invalid"; readonly reason: "malformed" };

/** malformed: non-object claims, a missing or non-GUID oid/tid, a missing or non-numeric exp/nbf (IN-1). */
export type ClaimRefusal = {
  readonly kind: "delegated-token-invalid";
  readonly reason: Exclude<DelegatedTokenInvalidReason, "signature">;
};

export type BindingRefusal = Extract<RunAuthorityRefusal, { readonly kind: "identity-binding-mismatch" }>;

/** Pass 2's refusals, in order: signature-rejected {malformed | signature}, then ClaimRefusal (AD-7's order), then BindingRefusal. */
export type PresentationRefusal =
  | { readonly kind: "delegated-token-invalid"; readonly reason: "signature" }
  | ClaimRefusal
  | BindingRefusal;

/** admitRunAuthority's refusals: every pass-1 refusal outranks every pass-2 one. */
export type AdmissionRefusal = PlanRefusal | PresentationRefusal;

/** The lifecycle brackets' only Err. */
export type EstablishmentRefusal = Extract<RunAuthorityRefusal, { readonly kind: "delegation-not-established" }>;

// ── Mint-path routing and drift ──────────────────────────────────────────────

export type RequirementRoute =
  /** Outside every brokered namespace: another provider serves it. */
  | { readonly kind: "pass-through" }
  | { readonly kind: "app"; readonly capability: AdmittedCapability }
  | { readonly kind: "delegated"; readonly capability: AdmittedCapability }
  /** In a brokered namespace, absent from the admitted access: fail closed (NFR-010). */
  | { readonly kind: "refused-not-admitted"; readonly capability: string };

/** One way a resumed run's requirement no longer classifies as it was admitted (AD-12; resource-changed: IN-22). */
export type AuthorityChange =
  | { readonly capability: string; readonly change: "mode-changed" | "removed" | "newly-brokered" }
  | {
      readonly capability: string;
      readonly change: "resource-changed";
      readonly from: CapabilityResource;
      readonly to: CapabilityResource;
    };

/** Sorted by capability. */
export type AuthorityChanged = { readonly kind: "authority-changed"; readonly changes: NonEmptyArray<AuthorityChange> };

/** The same step pass 2 consumes. */
export type ReauthorizationPlan = { readonly kind: "verify"; readonly step: VerifyDelegatedStep };

/** Who a run acts as, for the approver's view (AD-9): delegating iff the access is delegating. */
export type ExecutesAs = { readonly agent: AgentClientId; readonly asAgent: readonly string[] } & (
  | { readonly kind: "app" }
  | {
      readonly kind: "delegating";
      readonly onBehalfOf: { readonly initiator: Initiator; readonly capabilities: NonEmptyArray<string> };
    }
);

// ── Entra signing keys ───────────────────────────────────────────────────────

/** A JWS key resolver in the shape jose's jwtVerify consumes (structural: the domain imports no jose). */
export type JwsKeyResolver = (protectedHeader: unknown, token: unknown) => Promise<unknown>;

/**
 * Entra's signing keys for a JWKS URL: resolved once per URL and cached
 * (lazyJwks: single flight, reset on failure), fetched only through the
 * injected JWKS transport. Built by the wiring.
 */
export type EntraJwks = (jwksUri: string) => Promise<JwsKeyResolver>;

// ── Identity transports (ports the wiring composes over; AD-11) ──────────────
//
// Declared here, structurally, so this domain file imports no adapter: the
// existing HttpPost (fetch-http-post.ts) and GraphHttp (graph-capability.ts)
// adapter ports have exactly these shapes and satisfy them unchanged.

/** A form-POST token endpoint (the realm's, Entra's): resolves to the status and parsed JSON body, rejects on a transport failure. */
export type TokenEndpointTransport = {
  readonly post: (
    url: string,
    body: string,
  ) => Promise<{ readonly status: number; readonly json: Record<string, unknown> }>;
};

/** A GET of a JSON Web Key Set document; EntraJwks resolves Entra's signing keys through it. */
export type JwksTransport = (
  url: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<{ readonly status: number; readonly json: unknown }>;

/** The Graph resource transport a capability handle presents its bearer credential through. */
export type GraphTransport = {
  readonly request: (req: {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly bearer: string;
    readonly body?: Record<string, unknown>;
  }) => Promise<{ readonly status: number; readonly json: Record<string, unknown> }>;
};

/** Every network edge of the identity subsystem. Production: fetch-based, built in host.ts; acceptance: in-process fakes. */
export type IdentityTransports = {
  readonly realmToken: TokenEndpointTransport;
  readonly entraToken: TokenEndpointTransport;
  readonly entraJwks: JwksTransport;
  readonly graph: GraphTransport;
};

// ── Run-start brackets and the wiring (adapters/run-authority-wiring.ts) ─────

/** The framework minting authority minus the host's LLM meter: the one handle a bracket mints through (INV-6). */
export type RunMintingAuthority = Pick<MintingAuthority, "broker" | "origin">;

/**
 * A bracket's run: exactly one minting handle iff the authority is brokered.
 * Built only by run-authority-lifecycle.ts's authorizedRunOf(bound), whose
 * `minting` is the capability authority's forRun over that same bound.
 */
export type AuthorizedRun = Brand<
  | { readonly kind: "unbrokered"; readonly authority: Extract<RunAuthority, { readonly kind: "unbrokered" }> }
  | { readonly kind: "brokered"; readonly authority: BrokeredRunAuthority; readonly minting: RunMintingAuthority },
  "AuthorizedRun"
>;

/** How a sync run's body ended; `aborted` covers the route's timeout and a client cancel. */
export type SyncRunEnding = { readonly outcome: "completed" | "failed" | "aborted" };

/**
 * The sync run path's bracket: the route's whole view of the run-authority
 * lifecycle (INV-4, INV-6 sibling), which holds no custody store and no release.
 * Binds or establishes the admitted run, reads the one run deadline, builds the
 * AuthorizedRun, runs the body and releases custody by the body's ending (a
 * rejected body: released, then rethrown). An establishment fault is released
 * and answered as its EstablishmentRefusal; the body never runs.
 */
export type SyncRunBracket = {
  readonly withEstablishedAuthority: <T>(
    run: AdmittedRun,
    window: DurationMs,
    body: (run: AuthorizedRun, deadlineMs: EpochMs) => Promise<{ readonly ending: SyncRunEnding; readonly value: T }>,
  ) => Promise<Result<T, EstablishmentRefusal>>;
};

/**
 * Two-pass admission, composed: pass 1 over the registered DAG's requirements,
 * the Entra user-token verifier only on a verify-delegated step, then pass 2.
 * No establishment; every refusal precedes the HITL fork, concurrency and egress.
 */
export type AdmitRunAuthorityFn = (
  identity: RunAuthorityIdentity,
  registered: RegisteredDag,
  header: DelegatedHeader,
  runId: RunId,
) => Promise<Result<AdmittedRun, AdmissionRefusal>>;

/**
 * Everything composeRunAuthorityWiring is given; its only free inputs. `audit`
 * is the audit channel: each identity audit record is one structured line on
 * it, apart from the diagnostic `logger`.
 */
export type ComposeRunAuthorityWiringInput = {
  readonly config: HostConfig;
  readonly catalog: CapabilityCatalog;
  readonly redis: RedisPort;
  readonly routedTenant: TenantId;
  readonly transports: IdentityTransports;
  readonly logger: LogPort;
  readonly tracer: Tracer;
  readonly audit: LogPort;
  readonly now: () => EpochMs;
};

/**
 * What run start takes from the one wiring: admission and the sync bracket.
 * The production RunAuthorityWiring carries more (the later contracts' views)
 * and is assignable to this one.
 */
export type RunStartWiring = {
  readonly admitRunAuthority: AdmitRunAuthorityFn;
  readonly lifecycle: SyncRunBracket;
};

// ── Function signatures (each bound to its module by the plan's export bindings) ──

/** Pass 1, pure: classify first, decide every static refusal, build the expectation. No token check. */
export type PlanRunAuthorityFn = (input: RunAuthorityInput) => Result<AdmissionStep, PlanRefusal>;

/** Pass 2, pure: signature outcome, claims (AD-7's order), binding; the grant carries the step's token. */
export type AdmitDelegatedPresentationFn = (
  step: VerifyDelegatedStep,
  presentation: DelegatedPresentation,
  nowMs: EpochMs,
) => Result<PendingPlan, PresentationRefusal>;

/** The realm principal and the verified Entra claims name the same person iff oid and tid are equal (FR-009). */
export type BindDelegatedPrincipalFn = (
  realm: EntraPrincipal,
  verified: VerifiedEntraClaims,
) => Result<EntraPrincipal, BindingRefusal>;

/** Pure claim validation in AD-7's fixed order: malformed, version, issuer, tenant, audience, client, expired, not-yet-valid, not-delegated, scope. */
export type ValidateEntraUserTokenClaimsFn = (
  claims: unknown,
  expect: DelegatedTokenExpectation,
  nowMs: EpochMs,
) => Result<VerifiedEntraClaims, ClaimRefusal>;

/** `https://login.microsoftonline.com/{tenant}/v2.0`: the one derivation of the Entra v2.0 issuer. */
export type IssuerForFn = (tenant: EntraTenantId) => string;

/** The signature check: RS256 only, over the tenant's keys; takes only a verify-delegated step and yields claims only. */
export type VerifyEntraUserTokenFn = (
  step: VerifyDelegatedStep,
  jwks: EntraJwks,
  signal: AbortSignal,
) => Promise<DelegatedPresentation>;

/** The only RunAuthority → InvocationOrigin derivation: agent → {agent}; user-app | user-delegated → {user, sub: initiator.realmSub}. */
export type OriginOfFn = (run: BrokeredRunAuthority) => InvocationOrigin;

/** The mint path's one routing rule: an app access has no delegated route. */
export type RouteRequirementFn = {
  (access: AppAccess, brokered: BrokeredNamespaces, name: string): Exclude<RequirementRoute, { readonly kind: "delegated" }>;
  (access: RunAccess, brokered: BrokeredNamespaces, name: string): RequirementRoute;
};

/**
 * AD-12: Ok iff every current requirement classifies under `now` as it was
 * admitted. For each admitted capability the boot catalog's scope is compared
 * with the persisted entry: its mode through authorityOf (else mode-changed)
 * and its resource through resourceOf against the AdmittedCapability's
 * resource (else resource-changed{from: admitted, to: catalog}, IN-22).
 */
export type CheckAdmittedAuthorityFn = (
  access: AdmittedAccess,
  now: BrokeringNow,
  requirements: readonly RawCapabilityRequirement[],
) => Result<void, AuthorityChanged>;

/** AD-13, pure: every refusal before any JWKS egress; otherwise pass 1's expectation for the recorded agent. */
export type PlanReauthorizationFn = (
  bound: BoundAuthority<UserDelegatedAuthority>,
  identity: RunAuthorityIdentity,
  header: DelegatedHeader,
  legs: AuthorityLegs,
  nowMs: EpochMs,
) => Result<ReauthorizationPlan, ReauthorizationRefusal>;

export type ExecutesAsOfFn = (authority: RunAuthority) => ExecutesAs | { readonly kind: "unbrokered" };

/** Pass 1: one entry per brokered name under authorityOf's mode; delegating iff any is delegated. */
export type AccessOfFn = (requirements: readonly CapabilityRequirement[]) => RunAccess;
/** Pass 1 on an unbrokered host: passThrough = every requirement name. */
export type UnbrokeredAccessOfFn = (requirements: readonly RawCapabilityRequirement[]) => UnbrokeredAccess;
/** The run-store boundary: a duplicate name, an empty delegated map, a key unequal to its capability, an unknown mode or resource → Err. */
export type ParseRunAccessFn = (raw: unknown) => Result<AdmittedAccess, "access-corrupt">;

/**
 * The ONLY production composition of the identity subsystem: legs, adapters,
 * custody, the capability authority, admission and the lifecycle. Faults are
 * returned, never thrown.
 */
export type ComposeRunAuthorityWiringFn = (
  input: ComposeRunAuthorityWiringInput,
) => Result<RunStartWiring, readonly IdentityConfigFault[]>;

// duration.ts: finite and ≥ 0, else throw (a defect); pure, no clock.
export type EpochMsOfFn = (ms: number) => EpochMs;
export type DurationOfSecondsFn = (seconds: number) => DurationMs;
export type DurationOfMsFn = (ms: number) => DurationMs;
export type AddDurationFn = (at: EpochMs, duration: DurationMs) => EpochMs;
/** max(0, deadline − now). */
export type RemainingUntilFn = (deadline: EpochMs, now: EpochMs) => DurationMs;
