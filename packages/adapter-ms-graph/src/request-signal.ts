/**
 * THE one per-request `AbortSignal` composition for this package.
 *
 * Both request paths — the stock adapter's `graphGet` and the path-resolving
 * wrapper's `graphJson` — bound their fetch with the caller's signal plus a
 * per-request timeout. They previously each composed that inline and DISAGREED
 * on a non-positive `timeoutMs`: one treated it as "no timeout", the other
 * applied `AbortSignal.timeout(0)` and aborted every request immediately. Since
 * `requestTimeoutMs` is an unvalidated optional `number` on a publicly exported
 * adapter factory, that divergence was reachable from one config object.
 *
 * A leaf module with no package-internal imports, so both callers can use it
 * without a cycle (`index.ts` re-exports `path-resolving.ts`).
 */

/** The subset of `ReadOpts` this composition needs — kept structural, not imported. */
interface SignalCarrier {
  readonly signal?: AbortSignal;
}

/**
 * Compose the caller signal with a per-request timeout.
 *
 * A non-positive `timeoutMs` means "no timeout" — the knob is opt-out, not a
 * zero-length budget. Returns `undefined` when neither source contributes, so
 * callers can pass it straight to `fetch` without an extra branch.
 */
export const buildSignal = (
  opts: SignalCarrier | undefined,
  timeoutMs: number,
): AbortSignal | undefined => {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
};
