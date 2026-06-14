// Pure decision logic of the HITL smoke driver, extracted from `smoke.ts` so it
// is unit-testable without a running host. All I/O (fetch, polling, env) stays in
// `smoke.ts`; everything here is a total function over plain values.

/** The decision the smoke run delivers to the gate. */
export type Decision = "approve" | "reject";

/**
 * Parse the `SMOKE_DECISION` env value into a `Decision`. Anything other than the
 * explicit string `"reject"` is treated as `"approve"` (the default), so an unset
 * or unexpected value runs the happy path rather than failing opaquely.
 */
export const parseDecision = (raw: string | undefined): Decision =>
  raw === "reject" ? "reject" : "approve";

/** The terminal run status expected for a given decision. */
export const expectedTerminal = (decision: Decision): "completed" | "failed" =>
  decision === "reject" ? "failed" : "completed";

/** The POST body for `/runs/:id/approve` for the chosen decision. */
export const decisionBody = (decision: Decision, actor: string): Record<string, unknown> =>
  decision === "reject"
    ? { decision: "reject", reason: "smoke: rejected for demo", actor }
    : { decision: "approve", actor };

/**
 * A poll is done when the run reaches the wanted status OR hits the terminal
 * `failed` status — there is no point polling a dead run. The CALLER distinguishes
 * the two: reaching `want` is success; `failed` is surfaced with the run's
 * recorded error. (`completed` is also terminal, and is itself a valid `want`.)
 */
export const isPollDone = (status: unknown, want: string): boolean =>
  status === want || status === "failed";
