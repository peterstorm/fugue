# ADR-0050: Observability Backend Selection in the App Config Layer

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

The Azure AI Foundry observability feature makes trace export a *selectable* signal: an
application sends OpenTelemetry traces to MLflow, to Azure AI Foundry, or to both at once, with
the choice driven by configuration and changeable per environment without code changes. A
sibling decision (ADR-0044) established *where the vendor exporter machinery lives* — thin
factories in the framework, composed in the application bootstrap. This ADR answers the adjacent
question: **where the selection input itself lives — which surface a deployer turns the knob on.**

Two surfaces are candidates. The host already reads process-level infrastructure configuration
from Zod-validated environment variables (`MLFLOW_TRACKING_URI`, `TRACE_SAMPLE_RATIO`, OTel
endpoint), and it reads per-DAG metadata from `fugue.yaml` files colocated with each DAG
(`team`, `owner`, `route`, per-DAG concurrency/timeout overrides; see `FugueYamlSchema` in
ADR-0042). These surfaces serve different audiences and have different lifecycles:

- **`fugue.yaml` is per-DAG and loaded per-DAG.** The host's module-loader/dag-factory parses one
  `fugue.yaml` for each imported DAG. It describes that DAG's ownership and routing — metadata
  scoped to a single DAG instance.
- **Trace/observer wiring is process-level and wired once.** The exporter list, connection
  strings, and auth mode are decided a single time in the application's `bootstrap.ts` and apply
  to the whole process. They are not a property of any individual DAG.

The forces at play:

- **Scope must match the surface.** A per-process switch placed in a per-DAG file is a scope
  mismatch: a process emits one composed exporter set, but a `fugue.yaml` exists per DAG, so the
  selection would be ambiguous (which DAG's file wins?) and would have to be threaded out of the
  per-DAG loader into the process-level tracing pipeline.
- **Backend knowledge already belongs to the app/host config layer.** ADR-0042 and ADR-0044 put
  backend identity, connection strings, and selection in application-owned, startup-validated
  config — explicitly *out* of the framework and *out* of per-DAG files.
- **Fail-fast validation (FR-006).** An invalid or contradictory selection (unknown backend,
  Foundry selected without a connection string) must be reported clearly at startup, not surface
  as a silent runtime fallback.
- **Out of scope: endpoint auto-discovery (FR-024).** Project-endpoint auto-discovery of the
  Application Insights connection string is explicitly not required; the connection string is a
  configured input, even under Entra ID auth.

## Options Considered

1. **`observability.tracing.backends` keys in `fugue.yaml`**
   Extend `FugueYamlSchema` with an observability block and read the selection from each DAG's
   colocated YAML file.
   - Pros: One file format for DAG authors to learn; selection is version-controlled alongside
     DAG code; readable and reviewable in PRs.
   - Cons: Wrong scope — `fugue.yaml` is a per-DAG file, but exporter wiring is a per-process
     concern composed once in `bootstrap.ts`. Multiple DAGs in one process would each carry a
     selection, with no defined precedence. It would force the framework/host to thread per-DAG
     config out of the module-loader and into the process-level tracing pipeline, eroding the
     clean per-DAG loading boundary. It also drags vendor configuration (connection strings, auth
     mode) into the per-DAG metadata file, contradicting ADR-0042's audience split (DAG authors
     own DAG metadata; operators own process/infrastructure config including secrets).

2. **Environment variables parsed in the app's `config.ts` (Zod), resolved by a pure function,
   composed in `bootstrap.ts` (chosen)**
   Add the selection keys to the application's existing Zod env schema, validate them
   (including cross-field rules) at startup, map the parsed config to an exporter list with a
   pure `resolveObservabilityBackends()` function, and compose the result in `bootstrap.ts`.
   `fugue.yaml` is left unchanged.
   - Pros: Scope matches the surface — a per-process switch on the per-process config surface,
     wired once. Reuses the env surface that already carries the adjacent observability knobs
     (`MLFLOW_TRACKING_URI`, `TRACE_SAMPLE_RATIO`), so deployers configure backends where they
     already configure MLflow. Keeps backend knowledge in the app config layer per ADR-0042 and
     ADR-0044. Startup Zod validation gives the fail-fast, clearly-reported errors FR-006 demands.
     Twelve-factor friendly: works with the container/secret-injection workflow that already
     supplies the connection string.
   - Cons: Selection is not version-controlled alongside DAG code — it lives in deployment env,
     reviewed via infrastructure config rather than DAG PRs. This is the intended tradeoff: a
     process-level operational switch belongs with operator config, not DAG metadata.

## Decision

**Observability backend selection is parsed from environment variables in the application's
Zod `config.ts`, mapped to an exporter list by the pure `resolveObservabilityBackends()`
function, and composed in `bootstrap.ts`. `fugue.yaml` is not extended.**

`fugue.yaml` / `FugueYamlSchema` remains exactly what ADR-0042 defined: per-DAG team/owner/route
metadata loaded per-DAG by the host's module-loader/dag-factory. It carries no process-level
observability switch.

### Config surface (`apps/customer-summary/src/config.ts`)

New Zod-validated environment keys on the application's `ConfigSchema`:

- `OBSERVABILITY_TRACE_BACKENDS` — comma-separated list over `{mlflow, foundry}`. Default
  `mlflow`, so behavior is identical to today when unset (FR-003). One backend = exclusive
  export, two = dual export (FR-002). Parsed into a frozen, deduped, order-preserving tuple.
- `APPLICATIONINSIGHTS_CONNECTION_STRING` — Application Insights connection string. Optional at
  the schema level; required-when-Foundry-selected via cross-field refinement. A set-but-blank
  value is normalized to absent.
- `AZURE_AUTH_MODE` — `connection-string` (default, FR-022) or `entra-id` (opt-in, FR-023).
- `EVAL_BACKEND` — `mlflow` (default) | `foundry` | `both`, consumed by the eval CLI selector.

### Fail-closed validation

The Zod layer and `resolveObservabilityBackends()` fail **closed** — there is no silent
fallback. Each of the following is a hard startup error:

- unknown backend token (anything outside `mlflow|foundry`);
- a blank entry in the comma list;
- a duplicate backend token;
- an empty selection;
- `foundry` selected with no Application Insights connection string available.

The Foundry-without-connection-string case is caught at parse time by a Zod `superRefine`
cross-field check, and re-checked defense-in-depth inside `resolveObservabilityBackends()` so a
`Config` constructed outside `loadConfig` (e.g. in a test) still fails closed. This is the
clear-at-startup reporting FR-006 requires. A connection string is required even under Entra ID
auth: the Azure Monitor SDK needs it to locate the ingestion endpoint, and project-endpoint
auto-discovery is out of scope (FR-024) — so the string is a required configured input in both
auth modes; under Entra ID the credential governs auth while the string supplies the endpoint.

### Pure resolver (`apps/customer-summary/src/observability.ts`)

`resolveObservabilityBackends(config: Config): Result<ResolvedObservability,
ObservabilityConfigError>` is the functional core: a total function of its `Config` argument with
no I/O, no env reads, no Azure SDK contact, and therefore trivially unit-testable. It returns a
`Result` rather than throwing. `ResolvedObservability` is a **flat interface carrying `auth:
ResolvedAuth | null`**, non-null only when a Foundry backend is selected; "foundry enabled" is
**derived** via the `isFoundryEnabled` type guard (`auth !== null`) rather than stored as a
separate discriminant — so there is no boolean to drift from `traceBackends`, and the common
no-Foundry case cannot carry a meaningless or empty `auth` (illegal state made unrepresentable).
The `bootstrap.ts` imperative shell consumes the resolved
value to construct the actual `SpanExporter` instances and compose them per ADR-0044.

**Invariant:** which observability backends are active, and how Foundry authenticates, is decided
exclusively from the application's startup-validated environment config. `fugue.yaml` never
participates in process-level observability wiring.

## Consequences

**Positive:**
- Scope matches the surface: a per-process exporter switch lives on the per-process config
  surface and is wired once in `bootstrap.ts`, with no per-DAG ambiguity and no threading of
  per-DAG config into the process-level tracing pipeline.
- Backend selection stays in the app config layer where ADR-0042 and ADR-0044 already place
  backend knowledge, connection strings, and auth — the framework and per-DAG files gain nothing.
- Deployers configure backends on the same env surface that already carries MLflow and sampling
  knobs, and that integrates with container secret injection for the connection string.
- Fail-closed at startup: unknown, blank, duplicate, empty, and Foundry-without-connection-string
  selections are hard errors with actionable messages (FR-006) — no silent runtime fallback.
- The pure resolver returns a `Result` and carries `auth: ResolvedAuth | null` (foundry-enabled
  derived via the `isFoundryEnabled` type guard), so the no-Foundry path carries no meaningless
  auth and the wiring composes with the host's functional error handling.

**Negative:**
- The selection is not version-controlled alongside DAG code; it lives in deployment environment
  and is reviewed as infrastructure config rather than in DAG PRs. Accepted: a process-level
  operational switch belongs with operator config, not per-DAG metadata.
- A connection string is mandatory whenever Foundry is selected, including under Entra ID auth,
  because endpoint auto-discovery is out of scope (FR-024). Operators must supply the string even
  when the credential, not the string, governs authentication.
- Backend selection knowledge is duplicated conceptually across the env key, the Zod refinement,
  and the resolver's defense-in-depth re-check. This redundancy is deliberate (fail-closed even
  when `loadConfig` is bypassed) but means the `{mlflow, foundry}` set is enforced in more than
  one place.
