# ADR-0047: Azure / Foundry SDKs as Hard Dependencies

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

Exporting traces, scoring evaluations, and emitting domain events / metrics to Azure AI Foundry requires several vendor SDKs: `@azure/monitor-opentelemetry-exporter` (the Azure Monitor OTLP-equivalent span exporter), `@azure/identity` (credential resolution via `DefaultAzureCredential`), `applicationinsights` (the Application Insights client used to emit custom domain events and metrics), and the Python `azure-ai-evaluation` package (Foundry-native evaluators run in the eval sidecar).

The question is how these SDKs should be wired into the package graph: as **optional** dependencies loaded lazily only when Foundry is enabled, or as **hard** dependencies that are always installed and eagerly importable.

There is precedent in the codebase for the optional/lazy pattern: `MlflowOtlpExporter` wraps its inner OTLP exporter behind a lazy `import()` so the MLflow path costs nothing when unused. The brainstorm carried this pattern forward and noted the Azure SDKs as optional/lazy. That note was later superseded by an explicit user decision (FR-029) to treat them as hard dependencies.

The forces in tension:
- **Install weight.** The Azure SDKs are non-trivial in size; every application carries them whether or not it enables Foundry.
- **Wiring simplicity.** Lazy loading forces conditional code paths — `import()` guards, "feature not installed" error surfaces, and runtime branches that must be tested in both the installed and not-installed states.
- **Runtime cost vs. install cost.** Construction of an Azure exporter is already gated by configuration: an exporter is only built when a Foundry connection string is present (see ADR-0044). So whether the dependency is installed or not has no bearing on runtime behavior when Foundry is disabled — it only affects install size.

## Options Considered

1. **Optional peer dependencies + lazy `import()` (the `MlflowOtlpExporter` pattern)**
   - Pros: Applications that never use Foundry pay zero install weight for the Azure SDKs; mirrors the existing MLflow exporter pattern, so the codebase stays internally consistent.
   - Cons: Adds a conditional code path and a "feature not installed" runtime error surface that must exist and be tested purely to handle a state the project has decided it does not want; the dependency is already config-gated at construction time, so lazy loading buys nothing at runtime; two install states (present / absent) double the surface that must be reasoned about and tested.

2. **Hard dependencies — always installed, eagerly importable (chosen)**
   - Pros: No lazy `import()` guards, no not-installed branch, no "feature unavailable" error path; the only gate is the existing config check at exporter construction; one install state to reason about and test; imports resolve statically, so type-checking and bundling see the real modules.
   - Cons: Every application carries the Azure SDK install weight even when Foundry is disabled. Accepted as a deliberate trade: install size is paid once at install, not per run.

## Decision

**The Azure / Foundry SDKs are hard `dependencies` — always installed and eagerly importable. No optional/lazy loading.**

Specifically:
- `@azure/monitor-opentelemetry-exporter` and `@azure/identity` are hard `dependencies` of the **framework** package (`packages/framework/package.json`). They are imported by the Azure Monitor exporter factory, which the framework owns.
- `applicationinsights` (and `@azure/identity`, for `DefaultAzureCredential`) is a hard `dependency` of the **app** package (`apps/customer-summary/package.json`). It backs the domain-event / metric sink that is composed at the app layer.
- The Python `azure-ai-evaluation` package is a hard dependency in the eval sidecar's `requirements.txt` (`apps/customer-summary/eval/requirements.txt`).

**Placement nuance (as-built).** "Hard dependency" is unconditional, but each dependency lives in the package where its `import` actually occurs, not in a single catch-all location. The framework's domain-event observer depends only on a vendor-neutral `FoundryTelemetrySink` port — it has no compile-time knowledge of Application Insights. The `applicationinsights`-backed implementation of that port is composed at the app layer, so the `applicationinsights` import — and therefore the dependency — belongs to the app. Conversely, the Azure Monitor span exporter factory lives in the framework, so its Azure SDKs are framework dependencies. This keeps the framework vendor-neutral at its port boundary (see ADR-0048) while still satisfying the "always installed" guarantee everywhere an import resolves.

**Invariant.** No `import()` of an Azure / Foundry SDK is guarded by a try/catch or a feature-detection check. The single gate on Foundry behavior is the configuration check at exporter / sink construction time — when no connection string is present, the exporter / sink is simply not constructed. The dependency being installed never changes runtime behavior; it only changes install size.

## Consequences

**Positive:**
- No conditional load paths: no lazy `import()` guards, no "feature not installed" error surface, no dual install-state branching to write or test.
- A single, simple gate — configuration presence at construction time — governs all Foundry behavior, consistent with how every other exporter is wired (ADR-0044).
- Static imports mean type-checking, bundling, and IDE tooling see the real modules; no dynamic-import indirection to reason about.
- Dependencies sit where their imports occur, preserving the framework's vendor-neutral `FoundryTelemetrySink` port boundary (ADR-0048) — the framework never imports `applicationinsights`.
- FR-027 still holds: with Foundry disabled the SDKs are installed but never constructed, so existing framework, host, and app tests pass unchanged and MLflow behavior is untouched.

**Negative:**
- Every application carries the Azure SDK install weight (node_modules size, and the Python `azure-ai-evaluation` footprint in the sidecar) even when Foundry is never enabled. This is the accepted trade for unconditional wiring.
- The codebase is now internally inconsistent with `MlflowOtlpExporter`, which still uses the optional/lazy pattern for its inner OTLP exporter. Future readers must understand that the lazy pattern is a deliberate exception for MLflow, not the standard.
- SDK version churn is now carried by every consumer rather than only by Foundry-enabled deployments; versions must be pinned and updated in lockstep across the framework and app packages.
