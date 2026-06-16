/**
 * SubjectTokenRegistry — the HOST-SIDE side-channel that carries a user run's
 * verified `subject_token` from the run-context factory (which knows the `runId`
 * and the initiating identity) to the capability broker (which presents it as the
 * RFC 8693 `subject_token` proof when exchanging per hop). FR-032: this is the
 * ONLY path the raw user token travels — it NEVER crosses the framework
 * `InvocationOrigin` (which stays string-only) and is NEVER reachable from a
 * capability handle (NFR-011).
 *
 * WHY a registry and not a broker dep field: the broker is constructed ONCE at
 * boot, but each run mints a fresh `runId` inside the per-request `createContext`
 * closure. A shared registry lets the factory `bind(runId, token)` at run start
 * and the broker `resolve(runId)` at per-node dispatch, with `release(runId)` at
 * run teardown so a completed run's token does not linger in memory (NFR-014:
 * bound the in-memory token lifetime to the run).
 *
 * The stored value is a branded `SubjectToken` (the verify-seam's product); the
 * registry neither parses nor logs it. The cell is a plain `Map` — the broker
 * only ever READS through `resolveSubjectToken`, never enumerates it, so the raw
 * token has no incidental egress.
 */

import type { RunId } from "@fuguejs/framework";
import type { SubjectToken } from "../domain/auth.js";

/**
 * The host-side `runId → SubjectToken` side-channel. `bind` is called by the
 * run-context factory at run start for a user-initiated run; `resolve` is the
 * exact shape the broker's `resolveSubjectToken` dep wants; `release` clears the
 * entry at run teardown so the token does not outlive the run (NFR-014).
 */
export interface SubjectTokenRegistry {
  /** Record a user run's verified subject token, keyed on its runId. */
  readonly bind: (runId: RunId, token: SubjectToken) => void;
  /**
   * The verified subject token for a run, or `undefined` when the run has none
   * (an agent/team/admin run, or a never-bound runId). `undefined` makes the
   * broker's user exchange fail closed — it never fabricates a proof-less token.
   */
  readonly resolve: (runId: RunId) => SubjectToken | undefined;
  /** Drop a run's token at teardown so it does not linger in memory. */
  readonly release: (runId: RunId) => void;
}

/**
 * Construct an in-memory subject-token registry. One instance is created at boot
 * and shared between the run-context factory (`bind`/`release`) and the broker
 * (`resolve`, wired as `resolveSubjectToken`). The map is process-local and never
 * persisted — tokens live only for the duration of a run.
 */
export const createSubjectTokenRegistry = (): SubjectTokenRegistry => {
  const tokens = new Map<RunId, SubjectToken>();
  return {
    bind: (runId, token) => {
      tokens.set(runId, token);
    },
    resolve: (runId) => tokens.get(runId),
    release: (runId) => {
      tokens.delete(runId);
    },
  };
};
