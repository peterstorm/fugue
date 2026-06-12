/**
 * Run context contract — the domain-owned shape of "a run's base NodeContext
 * plus the origin the broker authorizes against", and the PURE mapping from an
 * inbound `AuthIdentity` to that origin.
 *
 * Lives in `domain/` (not the adapter that implements it) so the HTTP layer's
 * `RunDagDeps.createContext` port names its contract without an inward-pointing
 * `http → adapters` import — the port type is owned by the consumer/domain and
 * IMPLEMENTED by `adapters/node-context-factory.ts`, restoring the clean
 * `http → domain ← adapters` triangle.
 */

import { match } from "ts-pattern";
import type { DagId, InvocationOrigin, NodeContext } from "@fuguejs/framework";
import type { AuthIdentity } from "./auth.js";
import { agentClientIdForDag } from "./auth.js";

/**
 * Build the `Invocation.origin` for a run from its resolved inbound identity
 * (FR-W3-007). PURE and exported so the sub-threading is directly assertable
 * without standing up the whole context factory:
 *
 *  - `user`  → `{ kind: "user", sub, agentClientId: dagId }`. The user's `sub`
 *    lands on the origin verbatim. `agentClientId` is the AGENT the user acts
 *    THROUGH — the DAG's agent-type Keycloak client — NOT the inbound token's
 *    `azp` (the frontend SSO client that minted the user's login token). This
 *    distinction is security-relevant (ADR-0056, review I3): the broker gates a
 *    user hop with `assignedScopes(agentClientId)`, which must consult the
 *    AGENT's realm policy, not the frontend's. Using the frontend `azp` here
 *    would (a) gate against the wrong client and (b) let a future token exchange
 *    set `azp` to the frontend. We key on `agentClientIdForDag(dagId)` — the
 *    same agent-type-client placeholder the agent path uses — so user and agent
 *    runs of the SAME DAG resolve to the SAME agent client. (The branded
 *    `AgentClientId` constructor is the single migration point for the
 *    dagId→real-Keycloak-client-id mapping threaded later; the placeholder
 *    keeps the policy lookup pointed at the agent, never the frontend.)
 *  - `team` / `admin` → `{ kind: "agent", agentClientId: dagId }`. There is no
 *    user subject for these, so the agent placeholder keyed on the DAG id stands
 *    in — identical to the pre-fix behaviour.
 *
 * Exhaustive over `AuthIdentity`; a new identity kind is a compile error here.
 */
export const invocationOriginForIdentity = (
  identity: AuthIdentity,
  dagId: DagId,
): InvocationOrigin => {
  // The branded constructor is the ONE migration point for the dagId→client
  // mapping; the framework port carries it as a plain string (the brand is a
  // host concern), so the assignment below needs no cast.
  const agentClientId = agentClientIdForDag(dagId as string);
  return match(identity)
    .with({ kind: "user" }, (u) => ({ kind: "user" as const, sub: u.sub, agentClientId }))
    .with({ kind: "team" }, () => ({ kind: "agent" as const, agentClientId }))
    .with({ kind: "admin" }, () => ({ kind: "agent" as const, agentClientId }))
    .exhaustive();
};

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
