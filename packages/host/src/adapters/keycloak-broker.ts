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
  InvocationOrigin,
  ScopedCapabilityHandle,
} from "@fuguejs/framework";
import type { Tracer } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import {
  parseScope,
  type DownstreamScope,
  type OperationNarrowedHandle,
} from "../domain/capability-scope.js";
// Side-channel: importing the registry augmentation keeps it in this module's
// graph, so any consumer of the broker also sees the `"<provider>:<operation>"`
// scope keys on `CapabilityRegistry` AND the C6 soundness assertions that make
// the `handleRecord` cast below sound by construction.
import type { CapabilityRegistryWired } from "../domain/capability-registry.js";
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
 * Early-refresh skew margin (epoch millis). A cached token is treated as stale
 * this many millis BEFORE its real `expires_in`, so a token looked up just
 * before expiry is re-minted rather than presented downstream microseconds
 * before it lapses — which would 401 and (mis)map to `downstream-denied`, the
 * never-retried category (review I2, ADR-0059). The margin is capped at a
 * fraction of the token's own lifetime in `marginFor` so a short-lived token is
 * never pinned permanently stale.
 */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Effective cache TTL for a freshly minted token: its lifetime minus the
 * early-refresh skew, but never less than half its lifetime (so a token whose
 * own `expires_in` is below `2 × skew` still caches for a useful window instead
 * of being born stale). Pure.
 */
const effectiveTtlMs = (expiresInSec: number): number => {
  const lifetimeMs = expiresInSec * 1000;
  const margin = Math.min(TOKEN_REFRESH_SKEW_MS, Math.floor(lifetimeMs / 2));
  return lifetimeMs - margin;
};

/**
 * The SC-008 token-dedup identity for a hop — "who the minted token is FOR".
 *   - agent hop → the agent client (`client_credentials` mints AS that client).
 *   - user hop  → the user subject AND the agent client it acts THROUGH. Keying
 *     on `sub` ALONE (the prior behaviour) would serve a token exchanged for
 *     `(userA, agentX)` to `(userA, agentY)` while the audit claims Y minted it
 *     (review I3); including `agentClientId` makes the dedup unit
 *     `(sub, agentClientId)` so distinct agents never share a user's token.
 * The `\x1f` (UNIT SEPARATOR) joiner can appear in neither a `sub` nor a client
 * id (both printable), so the composite is injective — same property the cache
 * key relies on.
 */
const cacheIdentityFor = (origin: InvocationOrigin): string =>
  origin.kind === "user" ? `${origin.sub}\x1f${origin.agentClientId}` : origin.agentClientId;

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

/** The downstream-mint strategy for an origin: the `via` audit witness + the
 * (lazy) endpoint thunk. Returning both as one value keeps the audited strategy a
 * WITNESS of the branch actually taken (audit integrity A1), not a parallel
 * derivation off `origin.kind` that merely happens to agree. */
const saDispatch = (
  deps: KeycloakBrokerDeps,
  inv: Invocation,
  scope: DownstreamScope,
  audience: string,
): {
  readonly via: "client_credentials" | "token-exchange-v2";
  readonly mint: () => Promise<Result<MintedToken, FrameworkError>>;
} =>
  match(inv.origin)
    .with({ kind: "agent" }, (o) => ({
      via: "client_credentials" as const,
      mint: () => deps.endpoint.mintClientCredentials({ agentClientId: o.agentClientId, scope, audience }),
    }))
    .with({ kind: "user" }, (o) => ({
      via: "token-exchange-v2" as const,
      mint: () => deps.endpoint.exchangeV2({ userSub: o.sub, agentClientId: o.agentClientId, scope, audience }),
    }))
    .exhaustive();

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
  // CRITICAL (review I1): every `… = store(thatCache, …)` reads the CURRENT cell
  // at assignment time (synchronously, after the await) — it NEVER assigns a
  // pre-await snapshot — so a mint of triple A cannot clobber a concurrent mint
  // of triple B (lost update). And concurrent mints of the SAME triple are
  // single-flighted below, so SC-008's "≤1 token request per triple per TTL"
  // holds under concurrency, not just single-threaded.
  let saCache: TokenCache = emptyCache;
  let appOnlyCache: TokenCache = emptyCache;

  // Single-flight: in-flight app-only-token acquisitions keyed on the same
  // `(identity, audience, scope)` cache key the tokens are stored under. A second
  // concurrent resolution of the SAME triple AWAITS the first's promise instead
  // of firing its own SA mint + WIF exchange — so two parallel `mintFor`s for one
  // triple produce ONE egress pair, not two (SC-008 under concurrency).
  const inFlight = new Map<string, Promise<Result<{ token: string; via: "client_credentials" | "token-exchange-v2" }, FrameworkError>>>();

  /** Acquire the app-only token for one triple, doing the SA mint (or SA-cache
   * reuse) then the WIF exchange, storing BOTH caches by re-reading the live cell
   * at store time. Reached only on an app-only-cache MISS, AFTER the fail-closed
   * gate, so it never runs for an unassigned scope (no-egress guarantee holds). */
  const doAcquireAppToken = async (
    inv: Invocation,
    scope: DownstreamScope,
    audience: string,
    cacheK: string,
  ): Promise<Result<{ token: string; via: "client_credentials" | "token-exchange-v2" }, FrameworkError>> => {
    // The whole body is fenced: an injected port that THROWS (instead of
    // returning `err(...)` per its contract) is mapped onto the Result channel,
    // so the shared in-flight promise below can NEVER reject — a rejection
    // would poison every concurrent waiter and escape as a process-level
    // unhandledRejection.
    try {
      // Re-check the app-only cache inside the critical section: a just-settled
      // concurrent acquisition of this same triple may have populated it.
      const cachedApp = lookup(appOnlyCache, cacheK, deps.now());
      if (cachedApp !== undefined) {
        const via = inv.origin.kind === "user" ? "token-exchange-v2" : "client_credentials";
        return ok({ token: cachedApp.token, via });
      }

      // SA token — reuse a fresh one (its lifetime is independent of the WIF token's)
      // or mint a new one and cache it, re-reading the live `saCache` cell on store.
      const dispatch = saDispatch(deps, inv, scope, audience);
      let saToken: string;
      const saCached = lookup(saCache, cacheK, deps.now());
      if (saCached !== undefined) {
        saToken = saCached.token;
      } else {
        const mintResult = await dispatch.mint();
        if (!mintResult.ok) return err(mintResult.error);
        saToken = mintResult.value.accessToken;
        // Early-refresh margin (I2); re-read the live cell so a concurrent mint of a
        // DIFFERENT triple isn't clobbered (no lost update). The store-time sweep
        // (token-cache.ts) drops already-stale entries, bounding the cell.
        const saStoredAt = deps.now();
        saCache = store(
          saCache,
          cacheK,
          cacheToken(saToken, saStoredAt, effectiveTtlMs(mintResult.value.expiresInSec)),
          saStoredAt,
        );
      }

      // WIF exchange — present the SA token as the Entra `client_assertion`.
      const wif = await deps.entraWif.exchange({ clientAssertion: saToken, scope, audience });
      if (!wif.ok) return err(wif.error);

      const appStoredAt = deps.now();
      appOnlyCache = store(
        appOnlyCache,
        cacheK,
        cacheToken(wif.value.accessToken, appStoredAt, effectiveTtlMs(wif.value.expiresInSec)),
        appStoredAt,
      );
      return ok({ token: wif.value.accessToken, via: dispatch.via });
    } catch (e) {
      // Port-contract violation (a throw across the port boundary) — surface as
      // the retriable reach-failure kind, named for the hop this origin mints by.
      return err({
        kind: "infra-unreachable",
        operation: inv.origin.kind === "user" ? "token-exchange" : "client-credentials",
        message: `capability port threw across the boundary: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const acquireAppToken = (
    inv: Invocation,
    scope: DownstreamScope,
    audience: string,
    cacheK: string,
  ): Promise<Result<{ token: string; via: "client_credentials" | "token-exchange-v2" }, FrameworkError>> => {
    const existing = inFlight.get(cacheK);
    if (existing) return existing;
    const p = doAcquireAppToken(inv, scope, audience, cacheK);
    inFlight.set(cacheK, p);
    // Observe BOTH settlement paths on `p` itself: `void p.finally(...)` would
    // create an UNOBSERVED derived promise, so any rejection of `p` (a port
    // contract violation) would surface as a process-level unhandledRejection.
    // `doAcquireAppToken` is fenced to never reject, and this keeps the cleanup
    // rejection-safe even if that invariant is ever broken.
    const cleanup = (): void => {
      if (inFlight.get(cacheK) === p) inFlight.delete(cacheK);
    };
    p.then(cleanup, cleanup);
    return p;
  };

  const mintFor = async (
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>> => {
    const resolved: ResolvedCapability[] = [];
    const assigned = deps.assignedScopes(inv.origin.agentClientId);

    for (const capability of requires) {
      // 0. Pass-through: a capability this broker does not `provides()` —
      //    whether a plain name (`http`/`db`/`llm`) or a colon-named CUSTOM
      //    capability registered via ADR-0051 augmentation (`mycorp:widget`) —
      //    is NOT a downstream scope it mints. It is a static client the
      //    boot-scoped base context already supplies: skip it so a mixed
      //    `requires` (static + minted) resolves both, with the framework
      //    merging the minted scope handles OVER the base (C1). Skipping
      //    EXACTLY the `!parseScope(...).ok` set keeps `mintFor` and `provides`
      //    in agreement: the broker mints precisely the names `provides()`
      //    claims, and everything else stays run-start-validated against the
      //    base context (`provides` is `false` for it), never policy-refused
      //    here.
      const parsed = parseScope(capability);
      if (!parsed.ok) continue;
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

      // Cache identity is the SC-008 dedup unit ("who the token is for"): the
      // agent client, or `(sub, agentClientId)` for a user hop (I3). The app-only
      // token the node USES is keyed on the SAME triple as the SA token.
      const identity = cacheIdentityFor(inv.origin);
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

      // 4. MISS → acquire (single-flighted) the app-only token: the SA mint (FIRST
      //    egress) then the WIF exchange (SECOND egress, FR-W4-004 — the SA token
      //    is the `client_assertion`; no static Entra secret, SC-011). Concurrent
      //    resolutions of the SAME triple share one acquisition (SC-008). A WIF/SA
      //    denial (`downstream-denied`) or reach failure (`infra-unreachable`) is
      //    surfaced verbatim AND audited as a `mint-failed:<kind>` refusal, keeping
      //    SC-009 at 100% across BOTH hops.
      const acquired = await acquireAppToken(inv, scope, audience, appKey);
      if (!acquired.ok) {
        await audit.refusal(auditFields(inv, scopeStr), `mint-failed:${acquired.error.kind}`);
        return err(acquired.error);
      }

      await audit.mint(auditFields(inv, scopeStr), acquired.value.via);
      // Build the narrowed handle over the APP-ONLY token (not the SA token). The
      // operation method is the only reachable surface — the bearer is closed over.
      resolved.push({
        capability,
        handle: buildGraphHandle(scope, acquired.value.token, deps.graphHttp),
      });
    }

    // Assemble the scoped handle record. Each capability name maps to its
    // operation-narrowed handle (no raw client/token reachable). The cast widens
    // the dynamically-keyed record to the registry-shaped `ScopedCapabilityHandle`;
    // it is SOUND by construction (C6): `buildGraphHandle` is exhaustive over the
    // scope ADT and returns exactly `HandleForScope<scope>`, and the per-scope
    // `_Equal` assertions in `capability-registry.ts` (witnessed by the
    // `CapabilityRegistryWired` marker imported above) pin each registry entry to
    // that same handle type — so a scope key can never be augmented with a
    // mismatched client without failing compilation there. This stays the SINGLE
    // broker-side trust-boundary cast (the other is `extractClients`).
    const handleRecord: Record<string, OperationNarrowedHandle> = {};
    for (const r of resolved) {
      handleRecord[r.capability] = r.handle;
    }
    return ok(handleRecord as ScopedCapabilityHandle);
  };

  // `provides` tells run-start validation which capabilities the broker mints
  // per-node (so they are NOT demanded on the boot-scoped base context). Exactly
  // the well-formed downstream scope names: a plain capability (`http`) parses to
  // `false` → still validated against the base context; a malformed scope name
  // (`msgraph:bogus`) also parses to `false` → caught at run-start as
  // `missing-capability` rather than silently deferred to a dispatch refusal.
  const provides = (cap: Capability): boolean => parseScope(cap).ok;

  return { mintFor, provides };
};
