/**
 * Keycloak-backed CapabilityBroker — the live per-invocation authority adapter
 * (the flagship security feature). Given one node `Invocation` and the
 * `requires` it declares, it resolves a scoped, operation-narrowed handle per
 * capability, minting downstream authority through an INJECTED token endpoint.
 *
 * Authority strategy is selected by the invocation's `origin.kind`, exhaustively:
 *   - `agent`  → `client_credentials` minted AS the agent's Keycloak client,
 *     requesting EXACTLY the scopes `requires` names. NO token exchange
 *     (FR-W3-009 / SC-010).
 *   - `user`   → Standard Token Exchange V2 per hop: `sub` stays the user, `azp`
 *     becomes the agent, same scope/audience narrowing (FR-W3-008 / SC-010).
 *
 * THE HEADLINE INVARIANT — fail closed BEFORE any Entra call. The pure capability
 * gate (`domain/capability-gate.ts`) refuses an unassigned scope (`policy-refusal`)
 * BEFORE the token endpoint is ever asked to reach Entra, and before either cache
 * is read. The no-egress test proves the endpoint's mint/exchange methods were
 * never called on a refusal (SC-006 / FR-W3-003).
 *
 * Caching: two single-flight token cells (`token-cell.ts`), one per egress — the
 * Keycloak SA token and the Entra app-only token — both keyed on the
 * `(identity, audience, scope)` triple, so at most one token request per triple
 * per TTL window, under concurrency too (SC-008 / US4). An app-only cache HIT
 * short-circuits BOTH egresses (no WIF exchange AND no SA mint) — the WIF
 * exchange is itself a token request, so caching only the SA token would leak a
 * fresh WIF egress on every resolution.
 *
 * Narrowing: on success the minted authority is wrapped in the operation-narrowed
 * handle types from `capability-scope.ts` (`MailSendHandle` / `SitesReadHandle` /
 * `DynamicsReadHandle`). The node sees ONLY the named operation — no raw client,
 * no token field is reachable from the handle (US4 / FR-W3-004/005 / SC-007).
 *
 * @satisfies US4 US5 US6 US7 FR-W3-002 FR-W3-003 FR-W3-008 FR-W3-009 FR-W4-004
 *   FR-X-004 SC-006 SC-007 SC-009 SC-010 SC-011
 */

import { match } from "ts-pattern";
import type { Result, FrameworkError, Capability } from "@fuguejs/framework";
import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type {
  CapabilityBroker,
  Invocation,
  InvocationOrigin,
  ScopedCapabilityHandle,
  ScopedNonLlmCapability,
} from "@fuguejs/framework";
import type { Tracer } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import {
  parseScope,
  scopeName,
  type OperationNarrowedHandle,
} from "../domain/capability-scope.js";
import { decideGate, type GateDecision, type GatedScope } from "../domain/capability-gate.js";
import { agentClientIdFromFrameworkOrigin, type AgentClientId, type SubjectToken } from "../domain/auth.js";
import type { RunId } from "@fuguejs/framework";
// Side-channel: importing the registry augmentation keeps it in this module's
// graph, so any consumer of the broker also sees the `"<provider>:<operation>"`
// scope keys on `CapabilityRegistry` AND the C6 soundness assertions that make
// the `handleRecord` cast below sound by construction.
import type { CapabilityRegistryWired } from "../domain/capability-registry.js";
// DO NOT REMOVE — referencing `CapabilityRegistryWired` in an exported type-level
// position pins the side-channel import above into this module's compile graph.
// Without a reference, a "remove unused import" cleanup could silently drop it,
// taking the C6 `_Equal` soundness assertions out of the broker's compilation and
// leaving the `handleRecord as ScopedCapabilityHandle` cast (below) unchecked —
// a scope key augmented with the wrong handle type would then compile and crash a
// node at runtime. The reference makes the guarantee un-droppable, not advisory.
export type _BrokerHandleCastSoundness = CapabilityRegistryWired;
import { cacheKey, compositeKey } from "../domain/token-cache.js";
import type {
  KeycloakTokenEndpoint,
  MintedToken,
} from "./keycloak-token-endpoint.js";
import type { EntraWifExchange } from "./entra-wif.js";
import { buildGraphHandle, type GraphHttp } from "./graph-capability.js";
import { createBrokerAudit, type BrokerAudit, type BrokerAuditFields } from "./broker-audit.js";
import { createTokenCell, type FreshToken, type TokenAcquisition, type TokenCell } from "./token-cell.js";

// ───────────────────────────────────────────────────────────────────────────
// Broker dependencies
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the set of downstream scope STRINGS assigned to an agent client in the
 * Keycloak realm policy. This is the cheap, deterministic fail-closed gate: a
 * scope absent from this set is refused BEFORE any token endpoint call. Injected
 * (not hardcoded) so it can be wired from the realm config and faked in tests.
 *
 * Returns the assigned scope names (canonical `"<provider>:<operation>"`). A
 * client with no entry is treated as having NO scopes (fail closed).
 *
 * The parameter demands a branded `AgentClientId`, not a bare `string`: the
 * fail-closed gate is the most security-relevant consumer, and the brand makes
 * it a COMPILE error to call it with some other identity string in scope (the
 * user's `sub`, the frontend `azp`). The only `AgentClientId` the broker holds
 * comes from re-narrowing the framework origin at the call site below
 * (`agentClientIdFromFrameworkOrigin`).
 */
export type AssignedScopes = (agentClientId: AgentClientId) => ReadonlySet<string>;

interface KeycloakBrokerDeps {
  /** The injected Keycloak token endpoint — the FIRST egress (records calls in tests). */
  readonly endpoint: KeycloakTokenEndpoint;
  /**
   * The injected Entra Workload Identity Federation exchange — the SECOND egress.
   * The Keycloak SA token minted by `endpoint` is presented to this as the
   * `client_assertion` to obtain an app-only Graph/Dynamics token (FR-W4-004).
   * Reached ONLY after the fail-closed gate AND a successful Keycloak mint, so a
   * refusal records zero calls here too (the no-egress guarantee extends to it).
   */
  readonly entraWif: EntraWifExchange;
  /**
   * The injected Graph HTTP transport the narrowed operation handles drive. Held
   * here (not stored on a handle) so the app-only token presented as a bearer is
   * never reachable from node code (SC-007).
   */
  readonly graphHttp: GraphHttp;
  /** Realm policy: which scopes each agent client is assigned (fail-closed gate). */
  readonly assignedScopes: AssignedScopes;
  /**
   * The configured per-org Dynamics/Dataverse host (`DYNAMICS_ORG_HOST`, FR-042)
   * the `dynamics:read` capability's token audience and read URL target
   * (`https://<host>/api/data/v9.2`). UNSET (`undefined`) → a `dynamics:read`
   * scope FAILS CLOSED with zero egress (the documented unset behaviour). `msgraph`
   * scopes never depend on it.
   */
  readonly dynamicsOrgHost?: string;
  /**
   * Resolve the verified user `subject_token` for a run, from the HOST-SIDE
   * side-channel the run-context factory bound at run start (FR-030/FR-032). The
   * `user` branch of `saDispatch` calls this with `inv.runId` and presents the
   * resolved token as the RFC 8693 `subject_token` proof. An AGENT hop never has
   * (nor asks for) one — it mints via `client_credentials`. Returns `undefined`
   * when no verified user token is resolvable for the run, which makes the user
   * exchange FAIL CLOSED rather than issue a proof-less token (FR-030). The raw
   * token reaches the broker ONLY through this resolver — never via
   * `InvocationOrigin` (string-only, FR-032) and never on a handle (NFR-011).
   */
  readonly resolveSubjectToken: (runId: RunId) => SubjectToken | undefined;
  /** Shared tracer for correlated audit spans. */
  readonly tracer: Tracer;
  /** Shared logger for correlated audit records. */
  readonly logger: LogPort;
  /** Injected clock (epoch millis) — no ambient `Date.now`; the cache freshness is pure. */
  readonly now: () => number;
}

// ───────────────────────────────────────────────────────────────────────────
// Egress hops and their failure attribution
// ───────────────────────────────────────────────────────────────────────────

/**
 * The hop a reach failure is attributed to. Each legal `operation`/`hop` pairing
 * is one variant, so an attribution such as `{ operation: "mint", hop:
 * "entra-wif" }` cannot be written.
 */
type EgressHop =
  | { readonly operation: "mint"; readonly hop: "client-credentials" }
  | { readonly operation: "exchange"; readonly hop: "token-exchange" }
  | { readonly operation: "federation"; readonly hop: "entra-wif" }
  | { readonly operation: "mint"; readonly hop: "broker-internal" };

const WIF_HOP: EgressHop = { operation: "federation", hop: "entra-wif" };
const BROKER_INTERNAL_HOP: EgressHop = { operation: "mint", hop: "broker-internal" };

/** The SA hop an origin mints by: a user hop exchanges, an agent hop mints `client_credentials`. */
const saHopFor = (origin: InvocationOrigin): EgressHop =>
  origin.kind === "user"
    ? { operation: "exchange", hop: "token-exchange" }
    : { operation: "mint", hop: "client-credentials" };

const infraUnreachable = (hop: EgressHop, message: string): FrameworkError => ({
  kind: "infra-unreachable",
  operation: hop.operation,
  hop: hop.hop,
  message,
});

/**
 * Call an injected port whose contract is "errors on the Result channel, never
 * thrown". A throw anyway (a contract violation) becomes the retriable
 * `infra-unreachable`, attributed to the hop that threw — a thrown EntraWif
 * failure is `federation`/`entra-wif`, not the SA hop the origin mints by.
 */
const callPort = async <T>(
  hop: EgressHop,
  call: () => Promise<Result<T, FrameworkError>>,
): Promise<Result<T, FrameworkError>> => {
  try {
    return await call();
  } catch (e) {
    return err(infraUnreachable(hop, `capability port threw across the boundary: ${safeErrorMessage(e)}`));
  }
};

// ───────────────────────────────────────────────────────────────────────────
// Broker context
// ───────────────────────────────────────────────────────────────────────────

/** The SA-mint strategy an audit record names. */
type MintVia = "client_credentials" | "token-exchange-v2";

/**
 * Everything one broker instance threads through a resolution: its injected
 * dependencies, its audit emitter and its two token cells. Built once per
 * broker (the broker is long-lived across runs).
 *
 * BOTH cells are keyed on the SAME `(identity, audience, scope)` triple, where
 * `audience` is the DOWNSTREAM resource (Graph/Dynamics). For the app-only token
 * that is its real audience. For the SA token it is NOT — the SA token's own
 * audience is the Entra exchange (`api://AzureADTokenExchange`); the downstream
 * audience is the right SA dedup key only by DELIBERATE COINCIDENCE: each
 * downstream scope maps 1:1 to one downstream audience (`audienceForScope`), so
 * the triple and the SA token's true dedup unit "(identity, scope)" partition
 * the cells identically today. If a future provider broke that 1:1 mapping the
 * SA cell would need its own key derivation — the cells are separate precisely
 * so that split can happen without touching the app-only path.
 */
interface BrokerContext {
  readonly deps: KeycloakBrokerDeps;
  readonly audit: BrokerAudit;
  readonly saTokens: TokenCell<MintVia, FrameworkError>;
  readonly appOnlyTokens: TokenCell<MintVia, FrameworkError>;
}

/**
 * A token cell whose structural backstop maps any throw that escapes the
 * per-port fences (`callPort`) — the injected clock during a store — onto a
 * typed `infra-unreachable`, so the in-flight promise shared with waiters never
 * rejects.
 */
const brokerTokenCell = (now: () => number, label: string): TokenCell<MintVia, FrameworkError> =>
  createTokenCell<MintVia, FrameworkError>({
    now,
    onThrow: (e) =>
      infraUnreachable(
        BROKER_INTERNAL_HOP,
        `${label} acquisition threw across the in-flight boundary: ${safeErrorMessage(e)}`,
      ),
  });

const createBrokerContext = (deps: KeycloakBrokerDeps): BrokerContext => ({
  deps,
  audit: createBrokerAudit(deps.tracer, deps.logger),
  saTokens: brokerTokenCell(deps.now, "SA-token"),
  appOnlyTokens: brokerTokenCell(deps.now, "app-token"),
});

// ───────────────────────────────────────────────────────────────────────────
// Resolution
// ───────────────────────────────────────────────────────────────────────────

/** A resolved entry: the capability name the node declared + its narrowed handle. */
type ResolvedCapability = {
  readonly capability: Capability;
  readonly handle: OperationNarrowedHandle;
};

/**
 * The `via` a resolution reports when this call minted nothing (a cache hit or a
 * shared in-flight acquisition): a function of the invocation origin alone.
 */
const viaForOrigin = (origin: InvocationOrigin): MintVia =>
  origin.kind === "user" ? "token-exchange-v2" : "client_credentials";

/** The `via` for an acquisition: the minting branch's witness, or the origin's strategy on reuse. */
const viaOf = (acquired: TokenAcquisition<MintVia>, origin: InvocationOrigin): MintVia =>
  acquired.acquisition === "minted" ? acquired.witness : viaForOrigin(origin);

/**
 * The SC-008 token-dedup identity for a hop — "who the minted token is FOR".
 *   - agent hop → the agent client (`client_credentials` mints AS that client).
 *   - user hop  → the user subject AND the agent client it acts THROUGH. Keying
 *     on `sub` ALONE would serve a token exchanged for `(userA, agentX)` to
 *     `(userA, agentY)` while the audit claims Y minted it (review I3).
 * The pair is joined via `compositeKey` (token-cache.ts), the single owner of
 * the delimiter and its injectivity argument.
 */
const cacheIdentityFor = (origin: InvocationOrigin): string =>
  origin.kind === "user" ? compositeKey(origin.sub, origin.agentClientId) : origin.agentClientId;

/**
 * Build the audit correlation fields for one hop. `sub` is present only for a
 * user-initiated origin (an agent hop has no end-user subject).
 */
const auditFields = (inv: Invocation, scopeStr: string): BrokerAuditFields => {
  const base = {
    azp: inv.origin.agentClientId,
    runId: inv.runId,
    nodeId: inv.nodeId,
    scope: scopeStr,
  } satisfies Omit<BrokerAuditFields, "sub">;
  return inv.origin.kind === "user" ? { ...base, sub: inv.origin.sub } : base;
};

/** The downstream-mint strategy for an origin: the `via` audit witness + the
 * (lazy) endpoint thunk. Returning both as one value keeps the audited strategy a
 * WITNESS of the branch actually taken (audit integrity A1), not a parallel
 * derivation off `origin.kind` that merely happens to agree.
 *
 * USER branch (FR-030): resolves the run's verified `subject_token` from the
 * host-side side-channel and FAILS CLOSED with `policy-refusal` when none is
 * resolvable — it NEVER calls `exchangeV2` without proof, so no proof-less token
 * can ever be minted merely asserting a subject. The fail-closed thunk distinguishes
 * this LOCAL refusal (no proof to present) from a `downstream-denied` (the IdP
 * said no) and from an `infra-unreachable` (the endpoint was unreachable). */
const saDispatch = (
  deps: KeycloakBrokerDeps,
  inv: Invocation,
  gated: GatedScope,
): {
  readonly via: MintVia;
  readonly mint: () => Promise<Result<MintedToken, FrameworkError>>;
} => {
  const { scope, audience } = gated;
  return match(inv.origin)
    .with({ kind: "agent" }, (o) => ({
      via: "client_credentials" as const,
      mint: () => deps.endpoint.mintClientCredentials({ agentClientId: o.agentClientId, scope, audience }),
    }))
    .with({ kind: "user" }, (o) => {
      // FR-030 fail-closed: the token lives ONLY in the host-side side-channel
      // (never on the string-only `InvocationOrigin`, FR-032). Absent it, refuse
      // locally before any egress rather than fabricate a proof-less token.
      const subjectToken = deps.resolveSubjectToken(inv.runId);
      if (subjectToken === undefined) {
        return {
          via: "token-exchange-v2" as const,
          mint: async (): Promise<Result<MintedToken, FrameworkError>> =>
            err({ kind: "policy-refusal", scope: scopeName(scope), agentClientId: o.agentClientId }),
        };
      }
      return {
        via: "token-exchange-v2" as const,
        mint: () =>
          deps.endpoint.exchangeV2({ userSub: o.sub, agentClientId: o.agentClientId, scope, audience, subjectToken }),
      };
    })
    .exhaustive();
};

/** Mint the Keycloak SA token (the FIRST egress), fenced on the origin's own hop. */
const mintSaToken = (
  ctx: BrokerContext,
  inv: Invocation,
  gated: GatedScope,
): Promise<Result<FreshToken<MintVia>, FrameworkError>> =>
  callPort(saHopFor(inv.origin), async () => {
    const dispatch = saDispatch(ctx.deps, inv, gated);
    const minted = await dispatch.mint();
    if (!minted.ok) return minted;
    return ok({ token: minted.value.accessToken, expiresInSec: minted.value.expiresInSec, witness: dispatch.via });
  });

/**
 * Acquire the app-only token on an app-only-cache MISS: obtain the SA token (its
 * own cell — reused while fresh, its lifetime is independent of the WIF
 * token's), then present it to the WIF exchange (the SECOND egress, FR-W4-004 —
 * no static Entra secret, SC-011). Reached only AFTER the fail-closed gate.
 */
const acquireAppOnlyToken = async (
  ctx: BrokerContext,
  inv: Invocation,
  gated: GatedScope,
  key: string,
): Promise<Result<FreshToken<MintVia>, FrameworkError>> => {
  const sa = await ctx.saTokens.obtain(key, () => mintSaToken(ctx, inv, gated));
  if (!sa.ok) return sa;
  const { scope, audience } = gated;
  const wif = await callPort(WIF_HOP, () =>
    ctx.deps.entraWif.exchange({ clientAssertion: sa.value.token, scope, audience }),
  );
  if (!wif.ok) return wif;
  return ok({
    token: wif.value.accessToken,
    expiresInSec: wif.value.expiresInSec,
    witness: viaOf(sa.value, inv.origin),
  });
};

/**
 * Mint one gated capability: obtain the app-only token (a fresh cached one
 * short-circuits BOTH egresses; concurrent resolutions of one triple share one
 * acquisition), audit the outcome, build the narrowed handle over the app-only
 * token. A denial (`downstream-denied`) or reach failure (`infra-unreachable`)
 * from either hop is surfaced verbatim AND audited as a `mint-failed:<kind>`
 * refusal, keeping SC-009 at 100% across BOTH hops.
 */
const mintCapabilityHandle = async (
  ctx: BrokerContext,
  inv: Invocation,
  capability: Capability,
  gated: GatedScope,
): Promise<Result<ResolvedCapability, FrameworkError>> => {
  const scopeStr = scopeName(gated.scope);
  const key = cacheKey(cacheIdentityFor(inv.origin), gated.audience, scopeStr);
  const acquired = await ctx.appOnlyTokens.obtain(key, () => acquireAppOnlyToken(ctx, inv, gated, key));
  if (!acquired.ok) {
    await ctx.audit.refusal(auditFields(inv, scopeStr), `mint-failed:${acquired.error.kind}`);
    return err(acquired.error);
  }
  await ctx.audit.mint(auditFields(inv, scopeStr), viaOf(acquired.value, inv.origin), acquired.value.acquisition);
  return ok({
    capability,
    handle: buildGraphHandle(gated.scope, acquired.value.token, ctx.deps.graphHttp, ctx.deps.dynamicsOrgHost),
  });
};

/** Audit a gate refusal and return it as the `policy-refusal` it is. */
const refuse = async (
  ctx: BrokerContext,
  inv: Invocation,
  refusal: Extract<GateDecision, { kind: "refused" }>,
): Promise<Result<never, FrameworkError>> => {
  const scopeStr = scopeName(refusal.scope);
  await ctx.audit.refusal(auditFields(inv, scopeStr), refusal.reason);
  return err({ kind: "policy-refusal", scope: scopeStr, agentClientId: inv.origin.agentClientId });
};

/**
 * Assemble the scoped handle record. Each capability name maps to its
 * operation-narrowed handle (no raw client/token reachable). The cast widens
 * the dynamically-keyed record to the registry-shaped `ScopedCapabilityHandle`;
 * it is SOUND by construction (C6): `buildGraphHandle` returns exactly
 * `HandleForScope<scope>` — its `HANDLE_BUILDERS` mapped record pins each
 * scope key's builder to that scope's handle type at compile time (a
 * swapped builder fails compilation there) — and the per-scope
 * `_Equal` assertions in `capability-registry.ts` (witnessed by the
 * `CapabilityRegistryWired` marker imported above) pin each registry entry to
 * that same handle type — so a scope key can never be augmented with a
 * mismatched client without failing compilation there. This stays the SINGLE
 * broker-side trust-boundary cast (the other is `extractClients`).
 */
const buildHandleRecord = (resolved: readonly ResolvedCapability[]): ScopedCapabilityHandle => {
  const handleRecord: Record<
    string,
    ScopedNonLlmCapability<OperationNarrowedHandle>
  > = {};
  for (const r of resolved) {
    handleRecord[r.capability] = {
      clientKind: "non-llm",
      client: r.handle,
    };
  }
  return handleRecord as ScopedCapabilityHandle;
};

/**
 * Resolve `requires` in order: the pure gate decides each capability (pass
 * through, refuse, or mint), and the first refusal or mint failure ends the
 * resolution. The gate runs before any cache read or egress for its capability.
 */
const doMintFor = async (
  ctx: BrokerContext,
  inv: Invocation,
  requires: readonly Capability[],
): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
  const resolved: ResolvedCapability[] = [];
  // Re-narrow the framework-erased brand at this single host re-entry point so
  // the fail-closed gate is keyed on a typed `AgentClientId`, never an
  // arbitrary identity string (the user `sub`, the frontend `azp`).
  const assigned = ctx.deps.assignedScopes(agentClientIdFromFrameworkOrigin(inv.origin.agentClientId));

  for (const capability of requires) {
    const decision = decideGate(capability, assigned, ctx.deps.dynamicsOrgHost);
    if (decision.kind === "pass-through") continue;
    if (decision.kind === "refused") return refuse(ctx, inv, decision);
    const minted = await mintCapabilityHandle(ctx, inv, capability, decision);
    if (!minted.ok) return minted;
    resolved.push(minted.value);
  }

  return ok(buildHandleRecord(resolved));
};

/**
 * The port contract is "errors flow on the Result channel, never thrown". The
 * egress hops are fenced by `callPort`, but the injected `AssignedScopes`
 * (called in `doMintFor`) is equally a port — a throwing implementation would
 * reject the promise, violating the contract AND exiting before any audit record
 * fires (an SC-009 coverage gap). Fence the whole body: a throw becomes
 * `infra-unreachable` WITH a correlated `mint-failed:…` refusal record. The
 * audit emitter itself never throws (documented contract with a last-resort
 * sink), so this fence cannot recurse.
 */
const mintForFenced = async (
  ctx: BrokerContext,
  inv: Invocation,
  requires: readonly Capability[],
): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
  try {
    return await doMintFor(ctx, inv, requires);
  } catch (e) {
    const infraErr = infraUnreachable(
      BROKER_INTERNAL_HOP,
      `broker dependency threw across the boundary: ${safeErrorMessage(e)}`,
    );
    // The scope is unknown at this fence (the throw may precede scope
    // parsing); `"*"` keeps the SC-009 record correlated without inventing
    // a scope name the resolution never reached.
    await ctx.audit.refusal(auditFields(inv, "*"), `mint-failed:${infraErr.kind}`);
    return err(infraErr);
  }
};

/**
 * Create the live Keycloak-backed broker. The returned `mintFor` resolves the
 * `requires` set into a scoped handle, fail-closed BEFORE any egress on an
 * unassigned scope, with a correlated audit record for every mint and refusal.
 */
export const createKeycloakBroker = (deps: KeycloakBrokerDeps): CapabilityBroker => {
  const ctx = createBrokerContext(deps);

  const mintFor = (
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => mintForFenced(ctx, inv, requires);

  // `provides` tells run-start validation which capabilities the broker mints
  // per-node (so they are NOT demanded on the boot-scoped base context). Exactly
  // the well-formed downstream scope names: a plain capability (`http`) parses to
  // `false` → still validated against the base context; a malformed scope name
  // (`msgraph:bogus`) also parses to `false` → caught at run-start as
  // `missing-capability` rather than silently deferred to a dispatch refusal.
  const provides = (cap: Capability): boolean => parseScope(cap) !== undefined;

  return { mintFor, provides };
};
