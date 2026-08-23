import type { Context } from "hono";
import type { DagId } from "@fuguejs/framework";
import type { HostEnv } from "../env.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { errorResponse } from "../response.js";

export type DagAccessDecision =
  | { readonly ok: true; readonly identity: AuthIdentity }
  | { readonly ok: false; readonly response: Response };

/**
 * Read the authenticated identity the auth middleware placed on the context,
 * or the shared 401 when it is absent.
 *
 * ONE definition of both the cast and the "middleware not applied" contract.
 * Three handlers open-coded this; a handler that ever spelled the 401 slightly
 * differently would tell a caller that an unauthenticated request had failed for
 * a different reason than it actually did. Absence here is a WIRING bug (the
 * middleware did not run), not a caller error — which is why the message says so.
 */
export const requireAuthIdentity = (c: Context<HostEnv>): DagAccessDecision => {
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  return identity
    ? { ok: true, identity }
    : {
        ok: false,
        response: errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied"),
      };
};

/**
 * The label naming the caller in a 403 body: the team for a team token, and the
 * identity KIND otherwise (`admin`, `user`) — never a user id or token, which
 * would put an identifier into an error body readable by the wrong caller.
 */
export const callerTeamLabel = (identity: AuthIdentity): string =>
  identity.kind === "team" ? identity.team : identity.kind;

/**
 * Resolve the authenticated caller and enforce DAG team isolation.
 * The successful arm carries the identity required by run orchestration;
 * refusal arms own the shared 401/403 wire contract.
 */
export const authorizeDagAccess = (
  c: Context<HostEnv>,
  dagId: DagId,
  registered: RegisteredDag,
): DagAccessDecision => {
  const authed = requireAuthIdentity(c);
  if (!authed.ok) return authed;
  const { identity } = authed;
  if (canAccessDag(identity, registered.team)) {
    return { ok: true, identity };
  }

  const callerTeam = callerTeamLabel(identity);
  return {
    ok: false,
    response: errorResponse(
      c,
      403,
      "forbidden",
      `Token for team '${callerTeam}' cannot access DAG '${dagId}' (owned by '${registered.team}')`,
      { dagId, details: { callerTeam, dagTeam: registered.team } },
    ),
  };
};
