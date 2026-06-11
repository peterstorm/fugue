/**
 * Keycloak-backed CapabilityBroker — the live per-invocation authority adapter
 * (the flagship security feature). Given one node `Invocation` and the
 * `requires` it declares, it resolves a scoped, operation-narrowed handle per
 * capability, minting downstream authority through an INJECTED token endpoint.
 *
 * Authority strategy is selected by `invocation.origin.kind`, exhaustively:
 *   - `agent`  → `client_credentials` minted AS the agent's Keycloak client,
 *     requesting EXACTLY the scopes `requires` names. NO token exchange
 *     (FR-W3-009 / SC-010).
 *   - `user`   → Standard Token Exchange V2 per hop: `sub` stays the user, `azp`
 *     becomes the agent, same scope/audience narrowing (FR-W3-008 / SC-010).
 *
 * THE HEADLINE INVARIANT — fail closed BEFORE any Entra call. The agent's
 * assigned-scope check happens in the broker's local policy gate and refuses
 * (`policy-refusal`) BEFORE the token endpoint is ever asked to reach Entra. The
 * no-egress test proves the endpoint's mint/exchange methods were never called
 * on a refusal (SC-006 / FR-W3-003).
 *
 * Caching: token reuse is decided by the PURE `token-cache` over the
 * `(identity, audience, scope)` triple, so at most one token request per triple
 * per TTL window (SC-008 / US4). There are TWO caches, one per egress: the
 * Keycloak SA-token cache and the Entra app-only-token cache — BOTH are
 * `(identity, audience, scope)`-keyed reuses of the same pure `token-cache`
 * module, held in separate mutable cells in this shell. An app-only cache HIT
 * short-circuits BOTH egresses (no WIF exchange AND no SA mint) — the WIF
 * exchange is itself a token request, so caching only the SA token would leak a
 * fresh WIF egress on every resolution and violate SC-008's "at most one token
 * request per triple per TTL window". The cache values and their freshness
 * decisions stay pure; only the cells mutate and the clock (`now`) is injected.
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
import { ok, err } from "@fuguejs/framework";
import type {
  CapabilityBroker,
  Invocation,
  ScopedCapabilityHandle,
} from "@fuguejs/framework";
import type { Tracer } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import {
  parseScope,
  type DownstreamScope,
  type OperationNarrowedHandle,
} from "../domain/capability-scope.js";
import {
  cacheKey,
  cacheToken,
  lookup,
  store,
  emptyCache,
  type TokenCache,
} from "../domain/token-cache.js";
import type {
  KeycloakTokenEndpoint,
  MintedToken,
} from "./keycloak-token-endpoint.js";
import type { EntraWifExchange } from "./entra-wif.js";
import { buildGraphHandle, type GraphHttp } from "./graph-capability.js";
import { createBrokerAudit, type BrokerAudit, type BrokerAuditFields } from "./broker-audit.js";

// ───────────────────────────────────────────────────────────────────────────
// Pure scope → canonical-name / audience mappings
//
// The single source of truth for turning a parsed `DownstreamScope` back into
// the canonical `"<provider>:<operation>"` string (the cache-key + audit scope
// field) and into the downstream resource/audience the token is narrowed to.
// Exhaustive over the scope ADT — a new provider/operation is a compile error.
// ───────────────────────────────────────────────────────────────────────────

/** Canonical `"<provider>:<operation>"` name for a parsed scope (round-trips `parseScope`). */
export const scopeName = (scope: DownstreamScope): string => `${scope.provider}:${scope.operation}`;

/**
 * Downstream resource/audience a scope's token is narrowed to. Graph operations
 * target the Microsoft Graph resource; Dynamics targets the Dynamics resource.
 * Exhaustive over the scope ADT.
 */
export const audienceForScope = (scope: DownstreamScope): string =>
  match(scope)
    .with({ provider: "msgraph" }, () => "https://graph.microsoft.com")
    // KNOWN LIMITATION: the Dynamics/Dataverse path is unwired in production. The
    // correct Dataverse resource is the per-org host `https://<org>.crm.dynamics.com`
    // (its `/.default` scope), NOT this placeholder — see
    // docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md. When Dynamics is
    // wired, the per-org Dataverse host MUST come from config (threaded through
    // EntraWifConfig), never hardcoded here. This stand-in is only ever reached
    // behind the (currently unwired) Dynamics WIF exchange.
    .with({ provider: "dynamics" }, () => "https://dynamics.microsoft.com")
    .exhaustive();

// ───────────────────────────────────────────────────────────────────────────
// Narrowed-handle construction
//
// The concrete operation bodies live in `graph-capability.ts`: `buildGraphHandle`
// wraps the app-only WIF token in exactly one operation-narrowed handle, selected
// by the parsed scope. The token is closed over PRIVATELY — the returned handle
// type exposes only the operation method, with no `client`/`token` field to
// reach the raw authority through (SC-007). The broker no longer constructs a
// placeholder handle (the T10 seam is now wired through WIF + graph-capability).
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
 */
export type AssignedScopes = (agentClientId: string) => ReadonlySet<string>;

export interface KeycloakBrokerDeps {
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
  /** Shared tracer for correlated audit spans. */
  readonly tracer: Tracer;
  /** Shared logger for correlated audit records. */
  readonly logger: LogPort;
  /** Injected clock (epoch millis) — no ambient `Date.now`; the cache freshness is pure. */
  readonly now: () => number;
}

// ───────────────────────────────────────────────────────────────────────────
// Broker
// ───────────────────────────────────────────────────────────────────────────

/** A resolved entry: the capability name the node declared + its narrowed handle. */
type ResolvedCapability = {
  readonly capability: Capability;
  readonly handle: OperationNarrowedHandle;
};

/**
 * Build the audit correlation fields for one hop. `sub` is present only for a
 * user-initiated origin (an agent hop has no end-user subject).
 */
const auditFields = (
  inv: Invocation,
  scopeStr: string,
): BrokerAuditFields => {
  const base = {
    azp: inv.origin.agentClientId,
    runId: inv.runId,
    nodeId: inv.nodeId,
    scope: scopeStr,
  } satisfies Omit<BrokerAuditFields, "sub">;
  return inv.origin.kind === "user" ? { ...base, sub: inv.origin.sub } : base;
};

/**
 * Mint (or reuse a cached) downstream token for one parsed scope, dispatching on
 * origin: agent → `client_credentials`, user → Token Exchange V2. The cache is
 * consulted first (keyed on identity+audience+scope) so a fresh token is reused
 * without a second endpoint call (SC-008). Returns the token plus the next cache
 * state. NEVER reaches the endpoint for an unassigned scope — that gate fires in
 * `mintFor` BEFORE this is called.
 */
const mintToken = async (
  deps: KeycloakBrokerDeps,
  inv: Invocation,
  scope: DownstreamScope,
  cache: TokenCache,
): Promise<Result<{ token: string; cache: TokenCache; via: "client_credentials" | "token-exchange-v2" }, FrameworkError>> => {
  const audience = audienceForScope(scope);
  const scopeStr = scopeName(scope);
  // Cache identity is the user `sub` for a user hop, else the agent client — the
  // SC-008 dedup unit ("who the token is for") differs per origin.
  const identity = inv.origin.kind === "user" ? inv.origin.sub : inv.origin.agentClientId;
  const key = cacheKey(identity, audience, scopeStr);
  const now = deps.now();

  // Dispatch returns BOTH the `via` tag AND the (LAZY) mint thunk as one value,
  // so the audited strategy is a WITNESS of the branch actually taken — not a
  // parallel derivation off `origin.kind` that merely happens to agree (audit
  // integrity for the security feature: A1). The thunk stays unforced on a cache
  // hit, preserving the SC-008 dedup (and the no-egress guarantee on refusals,
  // which fire earlier in `mintFor` before this is ever reached).
  const dispatch: {
    readonly via: "client_credentials" | "token-exchange-v2";
    readonly mint: () => Promise<Result<MintedToken, FrameworkError>>;
  } = match(inv.origin)
    .with({ kind: "agent" }, (o) => ({
      via: "client_credentials" as const,
      mint: () => deps.endpoint.mintClientCredentials({ agentClientId: o.agentClientId, scope, audience }),
    }))
    .with({ kind: "user" }, (o) => ({
      via: "token-exchange-v2" as const,
      mint: () => deps.endpoint.exchangeV2({ userSub: o.sub, agentClientId: o.agentClientId, scope, audience }),
    }))
    .exhaustive();
  const via = dispatch.via;

  const cached = lookup(cache, key, now);
  if (cached !== undefined) {
    return ok({ token: cached.token, cache, via });
  }

  const mintResult = await dispatch.mint();
  if (!mintResult.ok) return err(mintResult.error);

  const minted = mintResult.value;
  const entry = cacheToken(minted.accessToken, now, minted.expiresInSec * 1000);
  return ok({ token: minted.accessToken, cache: store(cache, key, entry), via });
};

/**
 * Create the live Keycloak-backed broker. The returned `mintFor` resolves the
 * `requires` set into a scoped handle, fail-closed BEFORE any egress on an
 * unassigned scope, with a correlated audit record for every mint and refusal.
 *
 * The token cache is held in a single mutable cell in this shell (the broker is
 * long-lived across runs); the cache VALUE and its freshness decision stay pure.
 */
export const createKeycloakBroker = (deps: KeycloakBrokerDeps): CapabilityBroker => {
  const audit: BrokerAudit = createBrokerAudit(deps.tracer, deps.logger);
  // Two mutable cells threading the pure cache values across invocations, one per
  // egress: the Keycloak SA-token cache and the Entra app-only-token cache. The
  // freshness/lookup/store logic is pure (token-cache.ts); only the cells mutate.
  let saCache: TokenCache = emptyCache;
  let appOnlyCache: TokenCache = emptyCache;

  const mintFor = async (
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
    const resolved: ResolvedCapability[] = [];
    const assigned = deps.assignedScopes(inv.origin.agentClientId);

    for (const capability of requires) {
      // 1. Parse-don't-validate: an unknown/unparseable name is a policy refusal
      //    (no client id at parse time — the field stays absent).
      const parsed = parseScope(capability);
      if (!parsed.ok) {
        await audit.refusal(auditFields(inv, capability), "scope-unrecognised");
        return err(parsed.error);
      }
      const scope = parsed.value;
      const scopeStr = scopeName(scope);
      const audience = audienceForScope(scope);

      // 2. FAIL CLOSED — local policy gate BEFORE any egress or cache read. If the
      //    agent client was never assigned this scope, refuse here with zero
      //    egress. This ordering is load-bearing: the gate ALWAYS precedes both the
      //    SA and the app-only cache lookups, so a refusal never even reads a cache,
      //    let alone reaches an endpoint (SC-006 / FR-W3-003).
      if (!assigned.has(scopeStr)) {
        await audit.refusal(auditFields(inv, scopeStr), "scope-not-assigned");
        return err({ kind: "policy-refusal", scope: scopeStr, agentClientId: inv.origin.agentClientId });
      }

      // Cache identity is the user `sub` for a user hop, else the agent client —
      // the SC-008 dedup unit ("who the token is for") differs per origin. The
      // app-only token the node USES is keyed on the SAME triple as the SA token.
      const identity = inv.origin.kind === "user" ? inv.origin.sub : inv.origin.agentClientId;
      const appKey = cacheKey(identity, audience, scopeStr);
      const now = deps.now();

      // 3. APP-ONLY CACHE — check FIRST (after the gate). A hit short-circuits BOTH
      //    egresses: the WIF exchange is itself a token request, so reusing a fresh
      //    app-only token skips the SA mint AND the WIF exchange entirely (SC-008
      //    across both hops). The mint audit still fires on a hit, consistent with
      //    how the SA-cache-hit path audits (a resolution is a resolution).
      const cachedApp = lookup(appOnlyCache, appKey, now);
      if (cachedApp !== undefined) {
        // The `via` is a function of origin alone here (no branch was forced this
        // resolution); witness it from the origin so the audit names the strategy.
        const via = inv.origin.kind === "user" ? "token-exchange-v2" : "client_credentials";
        await audit.mint(auditFields(inv, scopeStr), via);
        resolved.push({
          capability,
          handle: buildGraphHandle(scope, cachedApp.token, deps.graphHttp),
        });
        continue;
      }

      // 4. Mint (or reuse) the Keycloak service-account token — the FIRST egress,
      //    and only ever reached for an assigned scope with no fresh app-only token.
      const minted = await mintToken(deps, inv, scope, saCache);
      if (!minted.ok) {
        // Transient/denied are surfaced verbatim on the Result channel; audit the
        // refusal so even endpoint-side denials are 100% covered.
        await audit.refusal(auditFields(inv, scopeStr), `mint-failed:${minted.error.kind}`);
        return err(minted.error);
      }
      saCache = minted.value.cache;

      // 5. WIF EXCHANGE — the SECOND egress (FR-W4-004). Present the Keycloak SA
      //    token as the Entra `client_assertion` to obtain an app-only Graph/
      //    Dynamics token. There is NO static Entra secret/cert: the SA token IS
      //    the credential (SC-011). A WIF denial (FIC mismatch / WIF rejection /
      //    resource-scoping denial → `downstream-denied`) or transient reach
      //    failure (`infra-unreachable`) is surfaced verbatim AND audited as a
      //    `mint-failed:<kind>` refusal, keeping SC-009 at 100% across BOTH hops.
      const wif = await deps.entraWif.exchange({
        clientAssertion: minted.value.token,
        scope,
        audience,
      });
      if (!wif.ok) {
        await audit.refusal(auditFields(inv, scopeStr), `mint-failed:${wif.error.kind}`);
        return err(wif.error);
      }

      // 6. Cache the app-only token on its own `(identity, audience, scope)` cell so
      //    the next resolution of this triple reuses it and fires NEITHER egress
      //    (SC-008). The app-only token carries its own `expiresInSec` (Entra
      //    `expires_in`); convert to absolute expiry via the pure cache arithmetic.
      appOnlyCache = store(
        appOnlyCache,
        appKey,
        cacheToken(wif.value.accessToken, now, wif.value.expiresInSec * 1000),
      );

      await audit.mint(auditFields(inv, scopeStr), minted.value.via);
      // Build the narrowed handle over the APP-ONLY token (not the SA token). The
      // operation method is the only reachable surface — the bearer is closed over.
      resolved.push({
        capability,
        handle: buildGraphHandle(scope, wif.value.accessToken, deps.graphHttp),
      });
    }

    // Assemble the scoped handle record. Each capability name maps to its
    // operation-narrowed handle (no raw client/token reachable). The single
    // trust-boundary cast mirrors `extractClients` — the narrowed handles are the
    // values a node sees for the capabilities it declared.
    const handleRecord: Record<string, OperationNarrowedHandle> = {};
    for (const r of resolved) {
      handleRecord[r.capability] = r.handle;
    }
    return ok(handleRecord as ScopedCapabilityHandle);
  };

  return { mintFor };
};
