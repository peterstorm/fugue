// ai-foundry-observer.ts — imperative shell over the pure foundry mapping.
//
// `AiFoundryObserver implements Observer`: on each event it calls the pure
// `mapEventToFoundry` and forwards every emission to an injected
// `FoundryTelemetrySink` port. It NEVER throws — a misbehaving sink (or any
// mapping bug) must not break a run, so all work is wrapped and failures are
// logged via `fwLogger` (matching the framework's fail-tolerant observer
// contract; see observer/dispatch.ts).
//
// The observer is vendor-neutral: it depends only on the `FoundryTelemetrySink`
// interface, NOT on `applicationinsights`. The Application Insights-backed sink
// is composed at the app layer, which wraps a run-summary observer containing
// this one in a `BufferedObserver` sharing the TracingHandle policy so that
// discarded traces produce no orphaned domain events (FR-021 / SC-010). This
// observer performs NO policy gating itself.

import type { Observer } from "../types/observer.js";
import type { ObserverEvent } from "../types/events.js";
import { fwLogger } from "../logger.js";
import { mapEventToFoundry, type FoundryEmission } from "./foundry-event-mapping.js";

/**
 * Port for a Foundry / Application Insights telemetry client. The concrete
 * implementation (backed by `applicationinsights`) is supplied by the app at
 * composition time. `trackEvent`/`trackMetric` are fire-and-forget; `flush`
 * is async for graceful shutdown.
 */
export interface FoundryTelemetrySink {
  trackEvent(e: {
    name: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
  }): void;
  trackMetric(m: {
    name: string;
    value: number;
    properties?: Record<string, string>;
  }): void;
  flush(): Promise<void>;
}

/**
 * Forward a single mapped {@link FoundryEmission} to the sink, dispatching on
 * its `kind` discriminant (event → `trackEvent`, metric → `trackMetric`) and
 * spreading the optional channels. This is the ONE place the discriminant is
 * turned into a sink call; both the per-event observer here and the app's
 * run-summary observer share it so the mapping cannot drift between the two.
 *
 * It deliberately does NOT catch: each caller wraps it in its own try/catch so
 * the swallow is logged with caller-specific context (see the fail-tolerant
 * observer contract). A thrown sink error propagates to that guard.
 */
export const forwardEmission = (sink: FoundryTelemetrySink, emission: FoundryEmission): void => {
  if (emission.kind === "event") {
    sink.trackEvent({
      name: emission.name,
      properties: emission.properties,
      ...(emission.measurements ? { measurements: emission.measurements } : {}),
    });
  } else {
    sink.trackMetric({
      name: emission.name,
      value: emission.value,
      ...(emission.properties ? { properties: emission.properties } : {}),
    });
  }
};

/**
 * Domain-event observer that records DAG events to a Foundry telemetry sink
 * (FR-018/FR-019/FR-020). Pure mapping in `foundry-event-mapping.ts`; this
 * class is the thin I/O boundary.
 */
export class AiFoundryObserver implements Observer {
  constructor(private readonly sink: FoundryTelemetrySink) {}

  observe(event: ObserverEvent): void {
    // Whole method is fail-tolerant: neither the mapping nor any sink call may
    // escape and break the run. Each emission is forwarded independently so a
    // single throwing call does not drop the rest.
    let emissions: readonly FoundryEmission[];
    try {
      emissions = mapEventToFoundry(event);
    } catch (err) {
      fwLogger().warn(
        `[AiFoundryObserver] mapEventToFoundry threw for ${event.type} — skipping:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }

    for (const emission of emissions) {
      try {
        forwardEmission(this.sink, emission);
      } catch (err) {
        fwLogger().warn(
          `[AiFoundryObserver] sink.${emission.kind === "event" ? "trackEvent" : "trackMetric"} threw for '${emission.name}' (event ${event.type}) — swallowed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
