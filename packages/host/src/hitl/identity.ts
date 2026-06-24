/**
 * Identity (de)projection for durable runs (ADR-0060). A live `AuthIdentity`'s
 * `user` variant carries the `canRunDag` authorization closure, which cannot be
 * persisted. These pure functions convert to/from the serializable
 * `PersistedIdentity` stored on a `RunRecord`.
 *
 * Direction matters for SECURITY: `toExecIdentity` reconstructs an identity for
 * the WORKER, which never authorizes — authorization happens once at the HTTP
 * boundary (run submission and approval). So a reconstructed `user` gets a
 * `canRunDag` that always returns `false`: if any execution path ever called it
 * (it must not), it fails closed rather than silently granting access.
 */

import { match } from "ts-pattern";
import type { AuthIdentity, Team } from "../domain/auth.js";
import { markTeam } from "../domain/auth.js";
import type { PersistedIdentity } from "./types.js";

// ── HITL approver identity (FR-041, US5, SC-006) ─────────────────────────────

/**
 * The config-sourced map from a Teams user's AAD object id to the team(s) they
 * approve for (FR-041). Keys are `aadObjectId`s; values are the team ids that
 * user is a member of. An aadObjectId ABSENT from this map is an UNKNOWN approver
 * — `approverTeamIdentity` returns `undefined` for it (fail-closed): a click from
 * an unmapped Teams user can authorize NOTHING.
 *
 * This is the Teams-button-path analogue of the realm JWT's `teams` claim: the
 * HTTP approve path derives the approver's team from a verified token, but a Bot
 * Framework card click carries only the clicker's `aadObjectId`, so the
 * membership must be resolved from configuration here.
 */
export type ApproverTeamMap = Readonly<Record<string, readonly string[]>>;

/**
 * Resolve a Teams approver's `aadObjectId` to the `AuthIdentity` the HITL button
 * path authorizes against — at PARITY with the HTTP approve path, which feeds a
 * resolved identity into `canAccessDag` (FR-041). We model the approver as a
 * MULTI-TEAM principal via a synthetic identity whose `canRunDag` tests the run's
 * DAG-owning team against the approver's mapped team set — mirroring how the
 * realm `user` identity delegates to its `teams` membership.
 *
 * FAIL CLOSED (SC-006): an `aadObjectId` that is `undefined` (the activity
 * carried no object id) or absent from `map` returns `undefined` — the caller
 * refuses the click and records NOTHING. A mapped approver with an EMPTY team set
 * likewise authorizes no team (`[].includes(t)` is always false).
 *
 * Returns a `user`-kind identity (not `team`) because an approver may belong to
 * several teams; `canAccessDag`'s `user` branch already delegates to the carried
 * membership predicate, so this reuses the SAME authorization logic the HTTP path
 * uses — no weaker, parallel check.
 */
export const approverTeamIdentity = (
  map: ApproverTeamMap,
  aadObjectId: string | undefined,
): AuthIdentity | undefined => {
  if (aadObjectId === undefined) return undefined;
  // Own-property lookup only — never resolve inherited Object.prototype keys
  // (`toString`, `constructor`, …) to a membership (fail-closed).
  if (!Object.prototype.hasOwnProperty.call(map, aadObjectId)) return undefined;
  const teams = map[aadObjectId] ?? [];
  return {
    kind: "user",
    // The approver's stable subject is their AAD object id; `azp` records the
    // transport that authenticated the click (the Teams bot path).
    sub: aadObjectId,
    azp: "teams-bot",
    canRunDag: (dagTeam: Team) => teams.includes(dagTeam),
  };
};

/** Project a live identity to its serializable form (drops the `canRunDag` closure). */
export const toPersistedIdentity = (identity: AuthIdentity): PersistedIdentity =>
  match(identity)
    .with({ kind: "admin" }, () => ({ kind: "admin" as const }))
    .with({ kind: "team" }, (t) => ({ kind: "team" as const, team: t.team, label: t.label }))
    .with({ kind: "user" }, (u) => ({ kind: "user" as const, sub: u.sub, azp: u.azp }))
    .exhaustive();

/**
 * Reconstruct the `AuthIdentity` the worker hands to `createNodeContextForDag`
 * (only `kind`/`sub` are used, to derive the run `origin`). A reconstructed
 * `user` gets a fail-closed `canRunDag` — the worker never authorizes.
 */
export const toExecIdentity = (identity: PersistedIdentity): AuthIdentity =>
  match(identity)
    .with({ kind: "admin" }, () => ({ kind: "admin" as const }))
    .with({ kind: "team" }, (t) => ({ kind: "team" as const, team: markTeam(t.team), label: t.label }))
    .with({ kind: "user" }, (u) => ({
      kind: "user" as const,
      sub: u.sub,
      azp: u.azp,
      // Execution never authorizes; fail closed if ever consulted.
      canRunDag: () => false,
    }))
    .exhaustive();
