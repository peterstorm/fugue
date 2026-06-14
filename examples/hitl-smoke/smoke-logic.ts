// Pure decision logic of the HITL smoke driver, extracted from `smoke.ts` so it
// is unit-testable without a running host. All I/O (fetch, polling, env) stays in
// `smoke.ts`; everything here is a total function over plain values.

/** The decision the smoke run delivers to the gate. */
export type Decision = "approve" | "reject";

/**
 * Outcome of parsing `SMOKE_DECISION`: either a recognised decision, or an
 * explicit rejection of an unrecognised value. An unset/empty value is NOT an
 * error — it means "use the default (approve)". Any other value is a typo
 * (`Reject`, `approev`, …) and is surfaced as `{ ok: false }` so the harness can
 * fail loudly at the boundary instead of silently coercing it to the happy path.
 */
export type ParsedDecision =
  | { readonly ok: true; readonly decision: Decision }
  | { readonly ok: false; readonly raw: string };

/**
 * Parse the `SMOKE_DECISION` env value. Unset/empty → the default `approve`.
 * `approve`/`reject` → that decision. Anything else fails loudly: an operator
 * exercising the reject path who fat-fingers the value must NOT get a green
 * "HITL loop OK" that silently ran approve and never tested rejection.
 */
export const parseDecision = (raw: string | undefined): ParsedDecision => {
  if (raw === undefined || raw === "") return { ok: true, decision: "approve" };
  if (raw === "approve" || raw === "reject") return { ok: true, decision: raw };
  return { ok: false, raw };
};

/** The terminal run status expected for a given decision. */
export const expectedTerminal = (decision: Decision): "completed" | "failed" =>
  decision === "reject" ? "failed" : "completed";

/** The POST body for `/runs/:id/approve` for the chosen decision. */
export const decisionBody = (decision: Decision, actor: string): Record<string, unknown> =>
  decision === "reject"
    ? { decision: "reject", reason: "smoke: rejected for demo", actor }
    : { decision: "approve", actor };

/** Run statuses with no further transition — polling one is pointless. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * A poll is done when the run reaches the wanted status OR reaches ANY terminal
 * status (`completed` / `failed`) — there is no point polling a run that can no
 * longer transition. The CALLER distinguishes the cases: reaching `want` is
 * success; reaching a DIFFERENT terminal status is a failure to surface with the
 * run's recorded error.
 *
 * The `completed`-while-waiting-for-`suspended` case is the one that matters:
 * it catches a humanReview DAG that ran straight through to `completed` WITHOUT
 * ever parking at the gate (a dropped-gate regression — exactly what this smoke
 * test exists to catch). Without treating `completed` as terminal here, the
 * caller would spin to an opaque timeout instead of reporting "run did not park".
 */
export const isPollDone = (status: unknown, want: string): boolean =>
  status === want || (typeof status === "string" && TERMINAL_STATUSES.has(status));
