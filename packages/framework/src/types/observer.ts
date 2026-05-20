// Observer contract — the typed domain-event interface.
//
// Lives in `types/` so the entire types layer is self-contained.
// NoopObserver also lives here (zero deps, trivial) so that `shared/`
// can construct default contexts without importing from `observer/`.
// Richer implementations (RecordingObserver, createObserver) live in
// `observer/observer.ts`.

import type { ObserverEvent } from "./events.js";

/**
 * Observer contract — single entry point for all framework events.
 *
 * Implementations that need to branch on event type use
 * `match(event).with(...).exhaustive()` from ts-pattern — adding a new
 * event variant to `ObserverEvent` surfaces as a compile error inside
 * the implementation's match block, not across a multi-method interface.
 *
 * For consumers that only care about a subset of events, use the
 * `createObserver({ "run-end": (e) => ... })` factory which accepts
 * per-event-type handlers and ignores unspecified types.
 */
export interface Observer {
  observe(event: ObserverEvent): void;
}

/** No-op observer — `observe` discards all events. Zero dependencies. */
export class NoopObserver implements Observer {
  observe(_event: ObserverEvent): void {}
}
