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
 * Resolve the authenticated caller and enforce DAG team isolation.
 * The successful arm carries the identity required by run orchestration;
 * refusal arms own the shared 401/403 wire contract.
 */
export const authorizeDagAccess = (
  c: Context<HostEnv>,
  dagId: DagId,
  registered: RegisteredDag,
): DagAccessDecision => {
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity) {
    return {
      ok: false,
      response: errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied"),
    };
  }
  if (canAccessDag(identity, registered.team)) {
    return { ok: true, identity };
  }

  const callerTeam = identity.kind === "team" ? identity.team : identity.kind;
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
