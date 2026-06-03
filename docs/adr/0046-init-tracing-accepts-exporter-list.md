# ADR-0046: initTracing Accepts a SpanExporter or a Non-Empty Exporter List

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

The framework's tracing pipeline (`initTracing` in `packages/framework/src/tracing/init.ts`) accepted exactly one `SpanExporter`. Existing framework and test call sites pass a single bare exporter and rely on this. A single tail-sampling processor wraps that exporter, and the entire flush/shutdown lifecycle is built around one exporter instance.

A new requirement is to deliver the same spans to more than one trace backend simultaneously — MLflow and Azure AI Foundry — without forcing callers to choose between them. The `CompositeSpanExporter` (ADR-0044) provides the fan-out mechanism: it forwards every batch to a list of downstream exporters. The open question is how the *public* `initTracing` entry point should expose this multi-backend capability.

The forces at play:

- **No regression for the single-backend default.** The overwhelmingly common configuration is one MLflow exporter. That path must stay byte-for-byte identical to today's behaviour — no new wrapper, no reordering, no extra flush coordination. This is a hard gate (SC-006): existing MLflow exporter tests and the full framework/host/customer-summary suites must pass unchanged when no second backend is configured.
- **The shipped signature is public.** `TracingConfig.exporter: SpanExporter` is part of the framework's published surface. Any change must keep existing single-exporter call sites compiling and behaving identically (FR-003, FR-027).
- **One lifecycle, not two.** Whatever shape the config takes, downstream code (the `TailSamplingProcessor`, the `NodeSDK`, the `flush`/`shutdown` handle) must continue to see a single `SpanExporter`. Two parallel pipelines would mean two flush points and two shutdown points to keep in sync — a correctness hazard.
- **Illegal states should be unrepresentable.** "Zero exporters" is meaningless: tracing with nowhere to send spans is a configuration error. Where the type system can reject it, it should.

## Options Considered

1. **New `initTracingMulti()` function alongside the existing `initTracing()`**
   - Pros: Leaves the single-exporter signature completely untouched; the multi-backend path is opt-in and visually distinct.
   - Cons: Forks the public API into two entry points that must be kept in lockstep. Two functions means two flush lifecycles and two shutdown lifecycles to maintain and document. Callers must know which one to reach for, and a future third capability forks it again. The single/multi distinction leaks into every consumer rather than being absorbed at the boundary.

2. **Require all callers to always pass an array (`readonly SpanExporter[]`)**
   - Pros: One uniform shape; no union to narrow.
   - Cons: Breaking change to a shipped API — every existing `initTracing({ exporter: mlflow })` call site must be rewritten to `{ exporter: [mlflow] }`. Violates the no-regression constraint (FR-003/FR-027) for code that has already shipped. Also makes the common, exclusive-backend case syntactically heavier for no benefit.

3. **Widen the existing field to `SpanExporter | readonly [SpanExporter, ...SpanExporter[]]` and normalize at the boundary**
   - Pros: Backwards compatible — every existing single-exporter call site keeps compiling and behaving identically (FR-003/FR-027/SC-006). One public entry point, one lifecycle. The multi-backend concern is absorbed entirely inside `initTracing`; downstream code is unchanged. The list arm can be typed as a non-empty tuple so the empty-list case is a compile error, not merely a runtime guard.
   - Cons: Introduces a union the function must narrow, and a normalization rule (single vs. one-element list vs. multi-element list vs. empty) that must be specified and tested precisely. The widening is permanent surface area.

## Decision

**Widen `TracingConfig.exporter` to `SpanExporter | readonly [SpanExporter, ...SpanExporter[]]` and normalize it to a single `SpanExporter` at the boundary (Option 3).**

The field type is `SpanExporter | readonly [SpanExporter, ...SpanExporter[]]`. A pure function, `normalizeExporter` in `packages/framework/src/tracing/init.ts`, collapses any accepted value into the single `SpanExporter` that the `TailSamplingProcessor` consumes:

- **A single exporter** is returned as-is — no `CompositeSpanExporter` wrapper, no change of any kind. This is the current behaviour, byte-for-byte.
- **A one-element list** is unwrapped to its bare exporter. This is the load-bearing guarantee for SC-006: with exactly one backend configured, no Composite wrapper is ever introduced, so the export pipeline is identical to the pre-multi-backend behaviour. Exclusive-MLflow output stays byte-for-byte equivalent.
- **A list of two or more** is wrapped in `CompositeSpanExporter` (ADR-0044), which fans every span batch out to all backends.
- **An empty list** is rejected with a clear error: `"TracingConfig.exporter: empty exporter list — provide at least one SpanExporter"`.

`normalizeExporter` is a pure function — no I/O, no SDK side effects — and is unit-testable in isolation. `initTracing` calls it once at the imperative-shell boundary; everything downstream (the `TailSamplingProcessor`, the `NodeSDK` span processor, and the returned `flush`/`shutdown` handle) sees exactly one `SpanExporter`, so there is a single coherent lifecycle regardless of how many backends were configured.

**As-built type refinement — illegal states unrepresentable.** The list arm is typed not as `readonly SpanExporter[]` but as a *non-empty tuple* `readonly [SpanExporter, ...SpanExporter[]]`. Consequently `exporter: []` is a **compile error** at literal call sites: the non-empty invariant lives in the type, not in a runtime comment (CLAUDE.md: make illegal states impossible). The runtime empty-list throw inside `normalizeExporter` is retained as **defense-in-depth** for dynamically-built lists (e.g. an exporter list assembled at bootstrap from parsed configuration) that cross an untyped boundary where the tuple type cannot be enforced statically. A `@ts-expect-error` regression test locks the compile-time rejection so the invariant cannot silently weaken. Union narrowing inside `normalizeExporter` uses a typed `isExporterList` predicate rather than an `as` cast; the single sanctioned widening-to-tuple narrowing occurs only on the `length >= 2` path, after the `length === 0` (throw) and `length === 1` (unwrap) cases have returned.

This decision builds on `CompositeSpanExporter` (ADR-0044) for the fan-out mechanism and supports the multi-backend observability work (ADR-0045).

## Consequences

**Positive:**
- Every call site keeps compiling and behaving identically, whether it passes a bare exporter or a one-element list. As-built, `bootstrap.ts` passes `composed.exporters` — always a non-empty tuple (`ExporterList = readonly [SpanExporter, ...SpanExporter[]]`), which in the MLflow-only case is a one-element tuple that `normalizeExporter` unwraps byte-for-byte to the bare exporter. Bare single-exporter call sites still exist in the framework and tests, and they too keep compiling and behaving identically — so the backwards-compat / no-regression claim holds for both shapes. No migration, no breaking change to a shipped API (FR-003/FR-027).
- The exclusive-backend case has zero `CompositeSpanExporter` overhead. The one-element-list unwrap guarantees no wrapper is introduced, so single-backend (e.g. MLflow-only) export output is byte-for-byte unchanged (SC-006).
- One public entry point and one flush/shutdown lifecycle. The multi-backend concern is fully absorbed inside `initTracing`; downstream code never branches on exporter count.
- The empty-list case is unrepresentable at literal call sites — a compile error, not a latent runtime failure. The dynamic-boundary throw covers the parsed-config path that the type system cannot reach.
- `normalizeExporter` is a pure function, trivially unit-testable across all four cases (single, one-element, multi-element, empty).

**Negative:**
- The public field type is now a union, permanently. Consumers reading the type must understand the single-vs-list-vs-tuple distinction and the normalization rules.
- Normalization introduces branching that must stay correct: a regression in the one-element-unwrap path would silently re-introduce a Composite wrapper into the single-backend default and break the SC-006 byte-for-byte guarantee. This is covered by tests but is a real maintenance invariant.
- The non-empty-tuple type carries a residual runtime guard that is unreachable from statically-typed call sites — accepted deliberately as defense-in-depth for the untyped dynamic-config boundary, at the cost of one branch that pure type-checking would deem dead.
