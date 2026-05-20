# Pass-4 follow-ups — deferred work

**Created:** 2026-05-12
**Status:** Open
**Source:** `docs/plans/2026-05-12-framework-review-remediation-pass-4.md`, §0 (D12, D13) and §7 (Q4, Q5).

Items below were explicitly deferred during the pass-4 remediation because they widen the public surface or require new ports. They become candidates the first time an external consumer materialises and the surface is allowed to grow.

---

## Q4 — Coherent telemetry factory (D12)

**Today.** `TailSamplingProcessor` and `BufferedObserver` are wired independently by callers. Each holds its own copy of an effective policy: the tail-sampling decision (which traces are exported to MLflow) and the observer-event persistence policy (which runs get a summary written through). The two can diverge — a caller that flushes via `errorOnly()` may still export every trace.

**Desired.**

```ts
const telemetry = createCoherentTelemetry({
  exporter: mlflowOtlpExporter,
  policy: anyOf(errorOnly(), hadRetry()),
});
// telemetry.tracer, telemetry.processor, telemetry.observer all share `policy`.
```

A single value object that hands back a `Tracer`, a `SpanProcessor`, and an `Observer` all parameterised by one `PersistencePolicy`. Eliminates the divergence class entirely.

**Why deferred.** Net-new public surface (`createCoherentTelemetry`, the `Telemetry` value type, and probably a `PolicyResult` shape that survives both decisions). Pass 4's licence is "fix the existing surface, don't grow it." Revisit when the first external consumer arrives and the API contract can stabilise against a real use case.

**Acceptance.** When implemented, the factory must:
- Accept one `PersistencePolicy` and produce both the tail-sample decision and the observer-persistence decision from it.
- Be usable without `initTracing` (it composes the lower-level pieces).
- Keep the lower-level pieces (`TailSamplingProcessor`, `BufferedObserver`) callable independently — callers that genuinely want divergence retain that option.

---

## Q5 — Multi-process `resolveDependents` (D13)

**Today.** The scheduler's `resolveDependents` reads `activeRegistry` — a process-local `Map<string, TaskConfig>`. When a parent task fires on worker A, worker B's scheduler instance cannot resolve A's dependents from its own registry. A multi-process deployment that splits scheduler instances across workers silently drops dependent fan-out.

**Desired.** A `TaskRegistryStore` port:

```ts
interface TaskRegistryStore {
  read(): Promise<TaskRegistry>;
  // optional: subscribe() for change notifications.
}
```

`CronScheduler` reads from this store rather than from a local `Map`. Backends:
- In-memory (single process) — drop-in for today's behaviour.
- Redis-hash backed — every scheduler instance reads the same registry.
- A `subscribe()` upgrade for hot-reload across instances.

**Why deferred.** Adds a new port + at least one backend. Today's single-process deployments work; the failure mode only surfaces under horizontal scheduler scale-out, which no consumer has reached yet. Documented as a known constraint in `packages/framework/README.md` §Scheduler.

**Acceptance.** When implemented, `CronScheduler` must:
- Accept an optional `registryStore` opt; fall back to the in-memory map for callers that don't supply one.
- Resolve dependents from the store, not the local map, when one is provided.
- Document the consistency model (read-your-writes vs eventual) on the store interface.

---

## How to pick this up

Either item is a self-contained PR. Q4 should not block on Q5; Q5 should not block on Q4. Both should land behind their respective ADR before any code change — the public-surface widening is the load-bearing decision, the wiring is mechanical once that is made.
