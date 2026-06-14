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
import type { AuthIdentity } from "../domain/auth.js";
import type { PersistedIdentity } from "./types.js";

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
    .with({ kind: "team" }, (t) => ({ kind: "team" as const, team: t.team, label: t.label }))
    .with({ kind: "user" }, (u) => ({
      kind: "user" as const,
      sub: u.sub,
      azp: u.azp,
      // Execution never authorizes; fail closed if ever consulted.
      canRunDag: () => false,
    }))
    .exhaustive();
