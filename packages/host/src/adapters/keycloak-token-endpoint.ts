/**
 * KeycloakTokenEndpoint — the injected token-endpoint PORT the live broker
 * reaches for authority. This is the only seam in the broker that performs (or,
 * in tests, *records*) I/O. Keeping it a port — never a hardcoded `fetch` — is
 * what makes the two headline security invariants provable in a unit test:
 *
 *   - SC-006 / FR-W3-003 (fail-closed, zero Entra egress): a refusal must occur
 *     BEFORE this port is ever asked to reach Entra. A test injects a fake whose
 *     methods push to a call log; the no-egress assertion is simply "the call log
 *     is empty after a refusal".
 *   - SC-010 / FR-W3-009 (agent hops do 0 exchanges): the agent path calls
 *     `mintClientCredentials` only; the user path calls `exchangeV2` only. A fake
 *     that records which method ran proves the exchange count per origin.
 *
 * The port speaks only in already-parsed, typed inputs (a `DownstreamScope`, an
 * audience, identities) and returns a `Result` on the framework error channel —
 * never throws across the boundary. Transient reach failures surface as
 * `infra-unreachable`; a settled downstream "no" surfaces as `downstream-denied`
 * (both variants already exist in framework `errors.ts`). The broker's local
 * policy gate (scope-not-assigned) is a SEPARATE, earlier check and never reaches
 * this port — see `keycloak-broker.ts`.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import type { DownstreamScope } from "../domain/capability-scope.js";
import type { SubjectToken } from "../domain/auth.js";

/**
 * A minted bearer token together with its lifetime in seconds, exactly as an
 * OAuth token endpoint returns it (`access_token` + `expires_in`). The broker
 * turns `expiresInSec` into an absolute `expiresAt` via the pure `token-cache`
 * arithmetic; the port stays oblivious to the cache.
 */
export interface MintedToken {
  readonly accessToken: string;
  /** Token lifetime in SECONDS (OAuth `expires_in`); the broker converts to absolute expiry. */
  readonly expiresInSec: number;
}

/** Inputs for a `client_credentials` mint — the agent-initiated authority path. */
export interface ClientCredentialsRequest {
  /** The agent's Keycloak client id (`origin.agentClientId`); it authenticates as itself. */
  readonly agentClientId: string;
  /** The parsed downstream scope being requested — exactly what `requires` named. */
  readonly scope: DownstreamScope;
  /** The downstream resource/audience the token is narrowed to (Graph/Dynamics resource id). */
  readonly audience: string;
}

/**
 * Inputs for a Standard Token Exchange V2 — the user-initiated authority path
 * (RFC 8693 / Keycloak Standard Token Exchange). The user's `sub` is preserved on
 * the exchanged token; `azp` becomes the agent (FR-031).
 *
 * PROOF-BEARING (FR-030): `subjectToken` is the user's ACTUAL verified compact JWT
 * (branded `SubjectToken`, produced only at the verify seam). It is REQUIRED — the
 * compiler forces every user-path caller to present real proof, so the live
 * exchange can NEVER be a proof-less impersonation grant ("mint a token claiming
 * this sub"). It is threaded HOST-SIDE only: the broker resolves it from the
 * run-context side-channel (`resolveSubjectToken`) and passes it here; it never
 * crosses the framework `InvocationOrigin` (string-only, FR-032) and never reaches
 * a capability handle (NFR-011). `userSub` remains for cache-keying/audit; the
 * actual subject preserved on the wire is whatever `subjectToken` proves.
 */
export interface ExchangeV2Request {
  /** The end user's subject (`origin.sub`) — used for cache-keying/audit; the wire proof is `subjectToken`. */
  readonly userSub: string;
  /** The agent client the exchanged token's `azp` becomes (`origin.agentClientId`). */
  readonly agentClientId: string;
  /** The parsed downstream scope being requested — exactly what `requires` named. */
  readonly scope: DownstreamScope;
  /** The downstream resource/audience the exchanged token is narrowed to. */
  readonly audience: string;
  /**
   * The user's verified compact JWT presented as the RFC 8693 `subject_token`
   * (FR-030). REQUIRED: a user exchange without real proof is unrepresentable, so
   * the broker MUST resolve the run's subject token before constructing this
   * request — and fail closed when it cannot.
   */
  readonly subjectToken: SubjectToken;
}

/**
 * The token endpoint port. Two methods, one per authority strategy. Both return
 * `Result<MintedToken, FrameworkError>`; neither throws. The broker NEVER calls
 * these on a fail-closed policy refusal — that ordering is the no-egress
 * guarantee and is asserted against a call-recording fake.
 */
export interface KeycloakTokenEndpoint {
  /**
   * Agent-initiated authority: `client_credentials` grant minted AS the agent's
   * Keycloak client, narrowed to exactly `scope`/`audience`. No token exchange,
   * no user subject (FR-W3-009).
   */
  readonly mintClientCredentials: (
    req: ClientCredentialsRequest,
  ) => Promise<Result<MintedToken, FrameworkError>>;

  /**
   * User-initiated authority: Standard Token Exchange V2 of the user's token for
   * this hop. The exchanged token keeps `sub = userSub` and sets `azp =
   * agentClientId`, narrowed to `scope`/`audience` (FR-W3-008).
   */
  readonly exchangeV2: (
    req: ExchangeV2Request,
  ) => Promise<Result<MintedToken, FrameworkError>>;
}
