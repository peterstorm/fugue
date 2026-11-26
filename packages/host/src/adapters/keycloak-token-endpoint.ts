/**
 * KeycloakTokenEndpoint — the injected token-endpoint PORT the live broker
 * reaches for authority. This is the only seam in the broker that performs (or,
 * in tests, *records*) I/O. Keeping it a port — never a hardcoded `fetch` — is
 * what makes the headline security invariants provable in a unit test:
 *
 *   - SC-006 / FR-303 (fail-closed, zero Entra egress): a refusal must occur
 *     BEFORE this port is ever asked to reach Entra. A test injects a fake whose
 *     method pushes to a call log; the no-egress assertion is simply "the call log
 *     is empty after a refusal".
 *   - INV-1 / FR-002 / FR-003 (only the agent's own identity federates): the port
 *     has ONE method, the agent's own `client_credentials` mint. There is no user
 *     token exchange to call, for any run origin.
 *
 * The port speaks only in already-parsed, typed inputs (a `DownstreamScope`, an
 * audience, the agent client id) and returns a `Result` on the framework error
 * channel — never throws across the boundary. Transient reach failures surface as
 * `infra-unreachable`; a settled downstream "no" surfaces as `downstream-denied`
 * (both variants already exist in framework `errors.ts`). The broker's local
 * policy gate (scope-not-assigned) is a SEPARATE, earlier check and never reaches
 * this port — see `keycloak-broker.ts`.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import type { DownstreamScope } from "../domain/capability-scope.js";

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

/**
 * Inputs for a `client_credentials` mint. Every run origin mints this way: the
 * agent authenticates as itself, and a user-origin run's initiator is never part
 * of the request (attribution lives in the broker's audit record only).
 */
export interface ClientCredentialsRequest {
  /** The agent's Keycloak client id (`origin.agentClientId`); it authenticates as itself. */
  readonly agentClientId: string;
  /** The parsed downstream scope being requested — exactly what `requires` named. */
  readonly scope: DownstreamScope;
  /** The downstream resource/audience the token is narrowed to (Graph/Dynamics resource id). */
  readonly audience: string;
}

/**
 * The token endpoint port: the agent's own `client_credentials` mint, returning
 * `Result<MintedToken, FrameworkError>` and never throwing. The broker NEVER
 * calls it on a fail-closed policy refusal — that ordering is the no-egress
 * guarantee and is asserted against a call-recording fake.
 */
export interface KeycloakTokenEndpoint {
  /**
   * `client_credentials` grant minted AS the agent's Keycloak client, narrowed
   * to exactly `scope`/`audience`. No token exchange, no user subject (FR-309).
   */
  readonly mintClientCredentials: (
    req: ClientCredentialsRequest,
  ) => Promise<Result<MintedToken, FrameworkError>>;
}
