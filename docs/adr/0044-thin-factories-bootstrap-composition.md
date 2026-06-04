# ADR-0044: Thin Vendor Exporter Factories with Bootstrap Composition

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

The framework (`@fuguejs/framework`) emits OpenTelemetry execution traces to exactly one
backend today: MLflow. The Azure AI Foundry observability feature requires that traces become a
**selectable, fan-out-capable** signal — an application can send traces to MLflow, to Azure AI
Foundry, or to **both at once** (for migration and side-by-side comparison), with the selection
driven entirely by configuration and changeable per environment without code changes.

The framework already has a clean seam for this. `initTracing` accepts an arbitrary
OpenTelemetry `SpanExporter`; the application builds one (`createMlflowExporter`) and hands it in
during its own startup. The framework never knows that the exporter targets MLflow — it knows only
"there is a span exporter." Backend identity, connection strings, and the choice of which backend is
active live in the application's bootstrap, not in the framework.

The architectural question is **where the new vendor knowledge should live**. Foundry adds a second
exporter (Azure Monitor / Application Insights), the need to compose two exporters into one, and a
set of vendor-specific configuration concerns (connection string vs. Entra ID, which env var selects
which backend). The forces at play:

- **Vendor-neutrality of the framework.** The framework must not gain knowledge of vendor names,
  vendor SDKs as first-class concepts, or vendor-specific configuration shapes. Today's seam keeps
  the framework's tracing layer free of any backend identity; eroding that seam would make every
  future backend a framework change.
- **Fan-out as the general case.** Single-backend export must be the one-element case of the same
  mechanism that produces dual export, so there is no special-casing between "one backend" and "two
  backends" (FR-002).
- **Configuration-driven selection.** Which backends are active, and how each authenticates, must be
  decided from configuration validated at startup (FR-001, FR-006), and that configuration shape is
  application-owned, validated by the application's Zod-over-env-and-YAML config layer (see ADR-0042).
- **Minimal new surface.** This is a two-element list (MLflow, Foundry) for the foreseeable future.
  Any mechanism introduced must not cost more than the problem it solves.
- **Zero regression.** With Foundry not enabled, MLflow behavior must be byte-for-byte unchanged
  (FR-027, SC-006), which strongly favors *extending* the existing seam over *replacing* it.

## Options Considered

1. **Backend registry inside the framework**
   The framework exposes a registration API (`registerBackend("foundry", factory)`) and reads
   configuration itself to decide which registered backends to activate.
   - Pros: Single call site for "turn on a backend"; backends are discoverable by name; new backends
     register without touching the composition code.
   - Cons: Pulls vendor identifiers (the string `"foundry"`) and configuration knowledge into the
     framework, directly breaking the vendor-neutral seam the framework currently maintains. Adds a
     lookup-and-dispatch indirection to manage what is, in practice, a two-element list. Makes the
     framework responsible for enumerating backends and for parsing per-backend config — exactly the
     concerns that today live in the application. Over-engineered for the problem.

2. **Declarative `initTracing({ backends: [...] })` with a backend-descriptor union**
   `initTracing` accepts a list of declarative backend descriptors (a discriminated union such as
   `{ kind: "mlflow", ... } | { kind: "foundry", ... }`) and interprets them internally to build the
   right exporters.
   - Pros: One declarative entry point; the caller states intent rather than wiring; the descriptor
     union makes the set of supported backends explicit in the type system.
   - Cons: Makes the framework own backend enumeration and the per-backend configuration shape — the
     same vendor-coupling problem as Option 1, now expressed as a type union the framework must own
     and evolve. Every new backend becomes a change to a framework-owned union and a
     framework-owned interpreter. The framework would be parsing connection strings and auth modes,
     which is application configuration concern, not a framework concern.

3. **Thin vendor exporter factories + composition in the application bootstrap (chosen)**
   Add a vendor exporter factory `createAzureMonitorExporter()` that mirrors the existing
   `createMlflowExporter()` — same shape, same "produce a `SpanExporter`" contract. Add a
   `CompositeSpanExporter` that fans a single span batch out to a list of child exporters. Widen
   `initTracing` to accept the composite (i.e. to accept the existing `SpanExporter` interface, which
   the composite already satisfies). The application's bootstrap reads its validated configuration,
   decides which factories to call, composes the results into the list, and hands the composite to
   `initTracing`.
   - Pros: Extends the *exact* seam already in place — "framework accepts any `SpanExporter`; the app
     picks one" simply becomes "the app picks a list." No new framework concepts: no registry, no
     descriptor union, no config parsing inside the framework. The framework gains zero vendor
     knowledge. Single-backend export is literally the one-element composite, so fan-out is not a
     special case. With Foundry not selected, the composition produces exactly the MLflow-only
     exporter that exists today, giving the byte-for-byte non-regression the spec demands.
   - Cons: The composition logic (which env var, which connection string, which backends are on) is
     spread across the application bootstrap rather than centralized behind a single framework call —
     there is no single framework-level "list of backends" object to introspect. Each new application
     must write its own composition, though that composition is small and mirrors the existing MLflow
     wiring.

## Decision

**Adopt Option 3: keep the framework vendor-neutral by adding thin vendor exporter factories and
composing the active backend set in the application bootstrap, not in the framework.**

Concrete shape of the decision:

- **Vendor exporter factory.** `createAzureMonitorExporter()` lives in the framework's tracing
  package (`packages/framework/src/tracing/azure-monitor-exporter.ts`) and mirrors the existing
  `createMlflowExporter()` (`mlflow-otlp-exporter.ts`). It produces a standard OpenTelemetry
  `SpanExporter` targeting Azure Monitor / Application Insights. It is a *factory only* — it does not
  decide whether Foundry is enabled and does not read application selection config; it is called by
  the bootstrap only when the bootstrap has decided Foundry is active.
- **Composite exporter.** `CompositeSpanExporter`
  (`packages/framework/src/tracing/composite-exporter.ts`) implements the `SpanExporter` interface
  and fans every span batch out to a list of child exporters. Because it *is* a `SpanExporter`, the
  one-backend and two-backend cases are the same code path. Its per-child fault isolation is
  specified separately (see ADR-0045).
- **Widened `initTracing`.** `initTracing` (`packages/framework/src/tracing/init.ts`) accepts the
  composite via the existing `SpanExporter` interface; the framework still sees only "a span
  exporter" (see ADR-0046 for the precise widening and its invariants).
- **Application-owned composition.** The customer-summary application composes the active backend set
  in its bootstrap. `apps/customer-summary/src/observability-composition.ts` reads the
  application's validated configuration (Zod-over-env-and-YAML, see ADR-0042), selects which
  factories to invoke, and builds the exporter *list*; `apps/customer-summary/src/bootstrap.ts`
  passes that list to the widened `initTracing`, which wraps it in a `CompositeSpanExporter` only
  when two or more backends are selected (a single-element list unwraps to the bare exporter — see
  ADR-0046). Neither app file constructs a `CompositeSpanExporter` itself; the wrapping is owned by
  the framework's `initTracing`.

**Invariant preserved:** the framework's tracing layer contains no vendor name, no connection-string
parsing, and no backend-selection logic. The set of active backends is decided exclusively in
application-owned, startup-validated configuration. The required Azure/Foundry SDK packages are
carried as hard, always-installed dependencies (see ADR-0047), so the factories wire unconditionally
with no optional-dependency or lazy-load branching.

## Consequences

**Positive:**
- The framework stays vendor-neutral: adding Foundry added a factory and a composite, but introduced
  zero vendor identifiers, zero config parsing, and zero new abstractions into the framework's
  tracing layer.
- Fan-out is not a special case. `CompositeSpanExporter` with one child is single-backend export;
  with two children it is dual export. The same mechanism serves exclusive export, side-by-side
  migration, and any future N-backend configuration.
- Non-regression is structural. When Foundry is not selected, the composition yields exactly the
  MLflow-only exporter that exists today, so MLflow output is unchanged with no defensive flags.
- The existing seam is reused rather than replaced, so the change is small and local: a new factory,
  a new composite, a widened (not redesigned) `initTracing`, and application bootstrap wiring.
- Backend selection and authentication remain where the validated configuration already lives — the
  application's config layer (ADR-0042) — keeping vendor configuration concerns out of the framework.

**Negative:**
- Backend composition is application responsibility. Each consuming application must write its own
  composition logic (which env var, which connection string, which backends are on) rather than
  flipping a single framework switch. This is mitigated by the composition being small and mirroring
  the existing MLflow wiring, but it is duplicated per application.
- There is no single framework-level object that enumerates the active backends, so framework-level
  introspection ("which backends are on?") is not available; that knowledge lives in the
  application's composition and configuration.
- Vendor exporter factories live in the framework package even though they encode vendor-specific
  exporter construction. They are deliberately kept thin (construction only, no selection logic) to
  avoid letting vendor knowledge leak into the framework's tracing seam, but their presence is a
  pragmatic compromise rather than a pure separation.
- Per-child fault isolation now matters: because export fans out, one slow or failing backend must
  not affect the other or the run. That guarantee is not provided by this decision alone — it is
  carried by the composite's isolation behavior, specified in ADR-0045.
