/**
 * Run context contract — the domain-owned shape of "a run's base NodeContext
 * plus the origin the broker authorizes against", plus the TWO pure seams that
 * derive a run's authority inputs from its inbound `AuthIdentity`:
 *
 *  - `invocationOriginForIdentity` → the framework `InvocationOrigin` (string-only)
 *    the broker gates/mints each node against (FR-W3-007).
 *  - `subjectTokenForIdentity` → the verified user `subject_token` (a branded
 *    `SubjectToken | undefined`) that a user run threads HOST-SIDE for the RFC 8693
 *    exchange; `undefined` for agent/team/admin runs (FR-030/FR-032). This is the
 *    sole place the raw token is read off the identity, and it is returned as a
 *    SEPARATE value — it NEVER becomes an `InvocationOrigin` field, keeping the
 *    framework port string-only.
 *
 * Lives in `domain/` (not the adapter that implements it) so the HTTP layer's
 * `RunDagDeps.createContext` port names its contract without an inward-pointing
 * `http → adapters` import — the port type is owned by the consumer/domain and
 * IMPLEMENTED by `adapters/node-context-factory.ts`, restoring the clean
 * `http → domain ← adapters` triangle.
 */

import { match } from "ts-pattern";
import type { DagId, InvocationOrigin, NodeContext } from "@fuguejs/framework";
import type { AuthIdentity, SubjectToken, AgentClientMap } from "./auth.js";
import { agentClientIdForDag } from "./auth.js";

/**
 * Build the `Invocation.origin` for a run from its resolved inbound identity
 * (FR-W3-007). PURE and exported so the sub-threading is directly assertable
 * without standing up the whole context factory:
 *
 *  - `user`  → `{ kind: "user", sub, agentClientId }`. The user's `sub`
 *    lands on the origin verbatim. `agentClientId` is the AGENT the user acts
 *    THROUGH — the DAG's REAL agent-type Keycloak client (resolved from the DAG
 *    id through `AGENT_CLIENT_MAP`) — NOT the inbound token's `azp` (the frontend
 *    SSO client that minted the user's login token). This distinction is
 *    security-relevant (ADR-0056, review I3): the broker gates a user hop with
 *    `assignedScopes(agentClientId)`, which must consult the AGENT's realm
 *    policy, not the frontend's. Using the frontend `azp` here would (a) gate
 *    against the wrong client and (b) let a future token exchange set `azp` to
 *    the frontend. We key on `agentClientIdForDag(map, dagId)` — the same real
 *    agent client the agent path uses — so user and agent runs of the SAME DAG
 *    resolve to the SAME agent client.
 *  - `team` / `admin` → `{ kind: "agent", agentClientId }`. There is no user
 *    subject for these, so only the resolved agent client is carried.
 *
 * FAIL CLOSED (FR-040): a DAG id with NO mapping in `AGENT_CLIENT_MAP` resolves
 * to `undefined` — this function returns `undefined` (first-class ABSENCE), and
 * the run-context factory refuses the run rather than mint as an absent/wrong
 * client. The map is INJECTED (it comes from host config), keeping this pure.
 *
 * Exhaustive over `AuthIdentity`; a new identity kind is a compile error here.
 */
export const invocationOriginForIdentity = (
  map: AgentClientMap,
  identity: AuthIdentity,
  dagId: DagId,
): InvocationOrigin | undefined => {
  // Resolve the DAG id to its REAL Keycloak agent client through the config-
  // mapped registry. `undefined` (no mapping) is first-class ABSENCE — the run
  // is refused upstream, never silently minted as a fabricated client (FR-040).
  // The framework port carries the id as a plain string (the brand is a host
  // concern), so the assignment below needs no cast.
  const agentClientId = agentClientIdForDag(map, dagId as string);
  if (agentClientId === undefined) return undefined;
  return match(identity)
    .with({ kind: "user" }, (u) => ({ kind: "user" as const, sub: u.sub, agentClientId }))
    .with({ kind: "team" }, () => ({ kind: "agent" as const, agentClientId }))
    .with({ kind: "admin" }, () => ({ kind: "agent" as const, agentClientId }))
    .exhaustive();
};

/**
 * The user's verified `subject_token` proof for a run, when (and only when) the
 * run was initiated by an OIDC `user` identity (FR-030). PURE seam, exhaustive
 * over `AuthIdentity`: the token is carried on the `user` variant ONLY, so an
 * `admin`/`team` run has none. This is the ONE place the host reads the raw token
 * off the identity to thread it HOST-SIDE (`runId → SubjectToken`) — it returns a
 * branded `SubjectToken | undefined`, NEVER an `InvocationOrigin` field, so the
 * framework port stays string-only (FR-032). A run with no resolvable user token
 * (`undefined`) makes the broker's user exchange fail closed rather than mint a
 * proof-less token.
 */
export const subjectTokenForIdentity = (identity: AuthIdentity): SubjectToken | undefined =>
  match(identity)
    .with({ kind: "user" }, (u) => u.subjectToken)
    .with({ kind: "team" }, () => undefined)
    .with({ kind: "admin" }, () => undefined)
    .exhaustive();

/** The base NodeContext for a run plus the `origin` the broker authorizes nodes against. */
export interface NodeContextForDag {
  readonly ctx: NodeContext;
  /**
   * Who initiated the run. Threaded into `runDag` alongside the broker so the
   * framework builds a per-node `Invocation { origin, runId, dagId, nodeId }`
   * and mints each node's declared scopes AT DISPATCH. Built from the inbound
   * identity (FR-W3-007).
   */
  readonly origin: InvocationOrigin;
}
