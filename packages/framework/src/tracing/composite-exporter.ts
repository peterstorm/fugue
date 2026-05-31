/**
 * CompositeSpanExporter — fan-out span export to N child SpanExporters.
 *
 * Why this exists (FR-002, FR-011, FR-026): selecting two or more trace
 * backends must deliver the *same* spans to *all* of them simultaneously,
 * with consistent run/DAG/node identities (a single span instance is handed
 * to every child). One backend failing or hanging must never affect any
 * other (FR-025, FR-026, SC-009).
 *
 * Fault-isolation policy (AD-2):
 * - `export()` fans out to every child concurrently. Each child's `export`
 *   is wrapped so that a synchronous throw OR an error `ExportResult` is
 *   caught, logged (rate-limited), and counted per-child — never rethrown.
 * - The aggregate result is SUCCESS if at least one child succeeded, and
 *   FAILED only if *every* child failed (with an aggregated error). This
 *   keeps a single dead backend from inflating `exportFailed` while still
 *   surfacing a total outage. Fail-fast and always-SUCCESS are REJECTED.
 * - `shutdown()`/`forceFlush()` fan out via `Promise.allSettled` and never
 *   reject, so one slow/broken backend cannot wedge the SDK shutdown chain.
 *   Partial failure is logged per-child at `warn`; a *total* outage (every
 *   child rejected) is additionally logged once at `error` so a full outage is
 *   distinguishable from full success rather than masked.
 * - A child whose callback-based `export` never fires is bounded by a per-child
 *   settle deadline ({@link EXPORT_SETTLE_TIMEOUT_MS}) and counted as a failure,
 *   so a hung backend can never wedge the flush/shutdown boundary (SC-009).
 *
 * This exporter is intentionally vendor-neutral: it knows nothing about
 * MLflow, Foundry, or any other backend — only the OTel `SpanExporter`
 * contract. Span transformation lives in the per-vendor child exporters.
 */
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { fwLogger } from "../logger.js";

/** Per-child cumulative export-failure count, exposed for health checks. */
export interface ChildFailureCount {
  readonly index: number;
  readonly failures: number;
}

/**
 * Per-child bounded settle deadline (ms). A child's `export` is callback-based:
 * a child doing async I/O returns `void` and fires its callback later. If that
 * callback never fires (hung socket, DNS black-hole, never-resolving promise),
 * the composite would otherwise wait forever and wedge the flush/shutdown
 * boundary (FR-025/FR-026/SC-009). After this deadline a non-firing child is
 * counted as that child's failure and settles the composite.
 *
 * Chosen at 30s: export is off the run's critical path, so we tolerate a
 * genuinely slow-but-working backend, while still guaranteeing the composite
 * cannot hang indefinitely. A total hang therefore surfaces as FAILED (an
 * actionable outage) rather than an invisible wedge.
 */
export const EXPORT_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Rate-limited per-child failure logging. Logs at true powers of ten —
 * occurrences 1, 10, 100, 1000, … — to surface a misbehaving backend at first
 * occurrence without spamming logs when it stays broken under high span volume.
 */
const logChildFailure = (
  counter: { count: number },
  index: number,
  reason: string,
): void => {
  counter.count++;
  const c = counter.count;
  // True powers of ten: 1, 10, 100, 1000, … (not every multiple of the
  // current order of magnitude).
  const shouldLog = c === 1 || c === Math.pow(10, Math.floor(Math.log10(c)));
  if (shouldLog) {
    fwLogger().warn(
      `[CompositeSpanExporter] child #${index} export failed (occurrence ${c}): ${reason}`,
    );
  }
};

export class CompositeSpanExporter implements SpanExporter {
  private readonly children: readonly SpanExporter[];
  /** One mutable failure counter per child, index-aligned with `children`. */
  private readonly failureCounters: ReadonlyArray<{ count: number }>;
  /** Per-child settle deadline; injectable so tests need not wait 30s. */
  private readonly settleTimeoutMs: number;

  /**
   * @param children Non-empty list of child exporters, typed as a non-empty
   *   tuple `readonly [SpanExporter, ...SpanExporter[]]`. Because this is the
   *   *only* accepted shape (no widening array supertype in the union),
   *   `new CompositeSpanExporter([])` is a genuine compile error at every
   *   literal call site. The same spans are forwarded to each child.
   * @param settleTimeoutMs Per-child settle deadline; defaults to
   *   {@link EXPORT_SETTLE_TIMEOUT_MS}. Lowered in tests to avoid 30s waits.
   *
   * The runtime empty-check is retained as defense-in-depth: the non-empty
   * tuple type rejects `[]` at literal call sites, but the dynamic-config
   * boundary (T5 bootstrap, {@link normalizeExporter}) builds the child list
   * from resolved config as a wide `readonly SpanExporter[]` and reaches this
   * constructor only via a single audited internal re-narrow (`as` cast). If a
   * future change ever funnels an empty array through that cast, this guard
   * fails fast rather than constructing a composite that silently drops every
   * span — which is never intended.
   */
  constructor(
    children: readonly [SpanExporter, ...SpanExporter[]],
    settleTimeoutMs: number = EXPORT_SETTLE_TIMEOUT_MS,
  ) {
    if (children.length === 0) {
      throw new Error(
        "CompositeSpanExporter requires at least one child exporter (got empty list)",
      );
    }
    this.children = [...children];
    this.failureCounters = this.children.map(() => ({ count: 0 }));
    this.settleTimeoutMs = settleTimeoutMs;
  }

  /**
   * Cumulative per-child export failures. A "failure" is either a thrown
   * error from `child.export` or an `ExportResult` with a non-SUCCESS code.
   */
  get childFailureCounts(): ReadonlyArray<ChildFailureCount> {
    return this.failureCounters.map((c, index) => ({ index, failures: c.count }));
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const total = this.children.length;
    let settled = 0;
    let anySuccess = false;
    const errors: Error[] = [];
    let done = false;

    const finalize = (): void => {
      if (done) return;
      done = true;
      if (anySuccess) {
        // SUCCESS unless all children failed (AD-2).
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      const aggregated = new Error(
        `CompositeSpanExporter: all ${total} child exporter(s) failed: ` +
          errors.map((e) => e.message).join("; "),
      );
      resultCallback({ code: ExportResultCode.FAILED, error: aggregated });
    };

    const onChildDone = (index: number, result: ExportResult): void => {
      if (result.code === ExportResultCode.SUCCESS) {
        anySuccess = true;
      } else {
        const reason = result.error?.message ?? "unknown error";
        logChildFailure(this.failureCounters[index]!, index, reason);
        errors.push(result.error ?? new Error(reason));
      }
      settled++;
      if (settled === total) finalize();
    };

    const onChildThrow = (index: number, err: unknown): void => {
      const error = err instanceof Error ? err : new Error(String(err));
      logChildFailure(this.failureCounters[index]!, index, error.message);
      errors.push(error);
      settled++;
      if (settled === total) finalize();
    };

    // Fan out concurrently. Each child gets the same span instances so run /
    // DAG / node identities stay consistent across backends (FR-011).
    this.children.forEach((child, index) => {
      // Single fire-once latch shared across the real callback, the sync-throw
      // path, and the settle-deadline timer — a child can only settle once, so
      // none of these double-count (guards FR-025/FR-026/SC-009).
      let childCallbackFired = false;

      // Per-child settle deadline. If the child's callback-based export never
      // fires (hung socket, DNS black-hole, never-resolving promise / rejected
      // async work), the composite would wait forever and wedge the
      // flush/shutdown boundary. Count a timed-out child as its own failure so
      // the composite still settles; all-hang ⇒ all-fail ⇒ FAILED.
      const timer = setTimeout(() => {
        if (childCallbackFired) return;
        childCallbackFired = true;
        onChildThrow(
          index,
          new Error(`export did not settle within ${this.settleTimeoutMs}ms`),
        );
      }, this.settleTimeoutMs);
      // Do not keep the event loop alive solely for this deadline timer.
      (timer as { unref?: () => void }).unref?.();

      try {
        child.export(spans, (result) => {
          // Guard against a misbehaving child invoking its callback twice, or
          // firing after the settle deadline already counted it.
          if (childCallbackFired) return;
          childCallbackFired = true;
          clearTimeout(timer);
          onChildDone(index, result);
        });
      } catch (err) {
        // Synchronous throw from a child's export — isolate it. If the child
        // had not yet fired its callback (and the deadline has not elapsed),
        // count this as that child's outcome. A throw *after* a successful
        // callback is swallowed by the latch (no double-count).
        if (!childCallbackFired) {
          childCallbackFired = true;
          clearTimeout(timer);
          onChildThrow(index, err);
        }
      }
    });
  }

  /**
   * Race a child lifecycle promise against the per-child settle deadline. A
   * child whose forceFlush()/shutdown() promise never resolves (hung socket,
   * never-resolving SDK drain) would otherwise wedge Promise.allSettled forever.
   * On deadline the race rejects with a timeout error, which allSettled records
   * as a rejection (surfaced by logRejections) — extending export()'s
   * fault-isolation guarantee (FR-025/FR-026/SC-009) to the lifecycle methods.
   */
  private withSettleDeadline(op: () => Promise<void>, label: string): Promise<void> {
    return new Promise<void>((resolveOp, rejectOp) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectOp(new Error(`${label} did not settle within ${this.settleTimeoutMs}ms`));
      }, this.settleTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      op().then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveOp();
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectOp(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * Force-flush every child. Never rejects: a single slow/broken backend must
   * not wedge the run's flush boundary (FR-025). Per-child rejections are
   * caught and logged.
   */
  async forceFlush(): Promise<void> {
    const results = await Promise.allSettled(
      this.children.map((child, index) => {
        const flush = (child as { forceFlush?: () => Promise<void> }).forceFlush;
        if (!flush) return Promise.resolve();
        return this.withSettleDeadline(
          () => Promise.resolve(flush.call(child)),
          `child #${index} forceFlush`,
        );
      }),
    );
    this.logRejections(results, "forceFlush");
  }

  /**
   * Shut down every child. Never rejects (same rationale as `forceFlush`).
   */
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      this.children.map((child, index) => {
        const sd = (child as { shutdown?: () => Promise<void> }).shutdown;
        if (!sd) return Promise.resolve();
        return this.withSettleDeadline(
          () => Promise.resolve(sd.call(child)),
          `child #${index} shutdown`,
        );
      }),
    );
    this.logRejections(results, "shutdown");
  }

  /**
   * Surface per-child lifecycle rejections. Best-effort-but-loud: partial
   * failure stays isolated (per-child `warn`, never rejects — one dead backend
   * must not break the lifecycle), but a *total* outage (every child rejected)
   * is logged once at `error` level with an aggregated message, so a caller
   * awaiting `flush()`/`shutdown()` as a persistence signal can tell a full
   * outage apart from full success rather than seeing it collapse into
   * rate-limited warns.
   */
  private logRejections(results: PromiseSettledResult<void>[], op: string): void {
    const reasons: string[] = [];
    results.forEach((r, index) => {
      if (r.status === "rejected") {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        reasons.push(`#${index}: ${reason}`);
        fwLogger().warn(`[CompositeSpanExporter] child #${index} ${op}() failed: ${reason}`);
      }
    });
    if (reasons.length > 0 && reasons.length === results.length) {
      fwLogger().error(
        `[CompositeSpanExporter] ${op}() — ALL ${results.length} child exporter(s) failed: ` +
          reasons.join("; "),
      );
    }
  }
}
