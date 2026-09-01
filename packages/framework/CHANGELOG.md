# Changelog

All notable changes to `@fuguejs/framework` are documented here. The framework
and its lockstep packages (`@fuguejs/host`, `@fuguejs/fs`, `@fuguejs/ms-graph`,
`@fuguejs/pg`, `@fuguejs/oracle`, `@fuguejs/http-auth`,
`@fuguejs/document-source`, `@fuguejs/xlsx`) are versioned together. Format
follows [Keep a Changelog](https://keepachangelog.com/); this project is
pre-1.0, so a minor bump may carry breaking changes.

## [Unreleased]

### Added

- **Budget capability.** `budget` is the seventh built-in capability. Its
  read-only `spent()` and `remaining()` views expose settled spend and
  admission-safe projected headroom. `fixedBudgetCapability` is available from
  `@fuguejs/framework/testing`.
- **File spend store.** `@fuguejs/framework/file` exports
  `createFileSpendStore`, a digest-addressed, locked, atomic whole-snapshot
  persistence surface for host spend-ledger adapters.

### Changed

- **Breaking (source):** `BaseNodeContext` / explicit `NodeContext` literals now
  require `budget: null` when no budget capability is wired. Prefer
  `makeNodeContext`, whose `NodeContextInit.budget` remains optional.
- **Breaking (source):** a `CapabilityHandle<K>` whose registered client extends
  `LlmClient` must declare `clientKind: "llm"` and a `pricingModel` policy.
  Non-LLM handles cannot declare these fields, and mixed LLM/non-LLM registry
  unions are rejected. An augmented LLM subtype must additionally provide a
  declarative string-keyed `runScopedOperations` alias map. The host interprets
  that map into a frozen run-scoped facade, so adapter code cannot retain a boot
  client and bypass the shared Run Spend Authority.
- **Breaking (source/wire):** `Spend` now carries `usage: "known" | "unknown"`.
  Unknown usage is durable and absorbing; token/USD admission fails closed,
  while call-only ceilings remain evaluable.
- **Breaking (source):** `Spend`, `MicroUsd`, and `UnpricedModels` are opaque
  smart-constructed values. Spend arithmetic saturates at
  `Number.MAX_SAFE_INTEGER` so overflow fails closed instead of poisoning or
  creating budget headroom.
- **Breaking (source):** every broker capability value is a tagged `llm` or
  `non-llm` binding. Scoped LLM bindings always carry `runScopedOperations`;
  augmented clients cannot omit their aliases, narrow a standard operation's
  contract, or promise a narrower alias result. `MintingAuthority` requires its
  host-owned LLM meter, making broker-without-meter wiring unrepresentable.
  Untagged and over-delivered runtime values are rejected before merge.
- **Breaking (source):** directly annotated `NodeDef` values now default their
  capability generic to `readonly []`; only capabilities named by an explicit
  requirement tuple are non-null in `run`.
- **Breaking (configuration):** Azure hosts must set `AZURE_OPENAI_MODEL` to the
  underlying pricing SKU separately from the arbitrary
  `AZURE_OPENAI_DEPLOYMENT` routing alias.
- **Breaking (source):** `withRetryLimits` now returns a typed `Result` and is
  exported from the executor surface. Every retry override re-enters
  `validateDagShape`; the unchecked `DagDef` brand constructor is no longer
  exported, and validated DAGs snapshot caller-owned node data before branding.

### Fixed

- Malformed provider cache parts can no longer exceed inclusive `tokensIn` and
  bypass token budgets; violations settle as durable unknown usage.
- HTTP hard deadlines include context construction, and late successful effects
  are diagnosed after a terminal 408.
- Redis spend retention now outlives shorter checkpoint TTLs for resumable HITL
  runs, with real-Redis transaction coverage.
- Successful provider results are parsed as complete own-data `LlmResponse`
  envelopes before settlement. Their already schema-parsed output is preserved
  exactly, so transforming schemas are never applied twice by spend authority.
- Listener-stop and hostile Keycloak diagnostic failures can no longer abort
  later teardown or escape typed Result boundaries.
- Every positive priced call consumes at least one micro-USD; positive overflow
  saturates, so sub-micro calls and infinity cannot create budget headroom.
- Metered LLM requests, fixed pricing policies, node requirements, broker
  claims, and invocation origins are parsed into immutable snapshots before
  crossing authority seams. Caller aliases, malformed discriminants, and
  stateful accessors cannot make provider egress differ from pricing or identity
  authorization.
- Host shutdown and every post-acquisition boot abort attempt all teardown
  steps and preserve primary plus cleanup failures instead of reporting
  incomplete cleanup as success.
- Unknown errors must satisfy the complete `FrameworkError` variant parser;
  known discriminants with missing payload can no longer select retry or
  authorization handling.
- Hostile request-body, confidence-extractor, checkpoint-inspection, logger, and
  wrapped-cause values preserve their original typed failure boundaries.

## [0.5.1] — 2026-08-24

### Fixed

- Release CI now installs the Redis binary required by the BullMQ integration
  test before running the publish gate. The `v0.5.0` workflow stopped before
  publication, so `0.5.1` is the first npm release containing the changes
  described below.

[0.5.1]: https://github.com/peterstorm/fugue/releases/tag/v0.5.1

## [0.5.0] — 2026-08-24

### Added

- **File-backed durable runtime.** The dependency-free
  `@fuguejs/framework/file` subpath now provides an append-only event journal,
  checkpoint projection, durable `JobLike`, freshness index, atomic file
  operations, and crash-safe resume with checkpoint/log agreement proofs.
- **Durable HITL execution fencing.** Run leases, execution generations,
  notification delivery, creation intents, and freshness completion state are
  persisted so retries, reroutes, replacement workers, and expired slices fail
  closed without losing progress or duplicating acknowledged writes.
- **Production adapter capabilities.** The host can wire Microsoft Graph
  document access with optional path resolution, Oracle thin-mode access, and
  reusable HTTP authentication through the lockstep adapter packages.

### Changed

- Checkpoint, witness, freshness, and execution identifiers use stricter branded
  and correlated types across persistence boundaries.
- Multi-tenant host registration, purge, worker lifecycle, diagnostics, and
  timeout cleanup now enforce tenant ownership and preserve typed failure
  outcomes under hostile infrastructure behavior.

[0.5.0]: https://github.com/peterstorm/fugue/releases/tag/v0.5.0

## [0.2.0] — 2026-06-14

### Breaking

- **No node implicitly receives the DAG input (C0).** A node with zero incoming
  edges is now rejected by `defineDag` unless it is a *source node*. Previously
  the first/root/classifier node silently received the DAG request; that implicit
  wiring is gone — the request flows only along explicit edges.

  **Migration** — for a root node that consumes the request (a fetch/transform/
  LLM node), add an explicit edge from the `DAG_INPUT` sentinel:

  ```ts
  import { DAG_INPUT } from "@fuguejs/framework";

  defineDag({
    nodes: { "fetch-crm": fetchCustomer, /* … */ },
    edges: [
      { from: DAG_INPUT, to: "fetch-crm" }, // ← feed the request explicitly
      { from: "fetch-crm", to: "extract-features" },
      // …
    ],
  });
  ```

  For a root that consumes *nothing* (a pure data source), build it with
  `createSourceNode` (or declare `"$input"` via `defineSources`) instead. The
  validator's error message names the offending node and both remedies.

### Added

- **Source nodes & `$input` edges (C0).** `createSourceNode` for roots that need
  no DAG input, the `DAG_INPUT` (`"$input"`) edge sentinel, and the `defineSources`
  shape helper.
- **`Clock` capability (C2).** A first-class injected clock (`systemClock` /
  `fixedClock`) so nodes read time through a capability instead of ambient `Date`.
- **`fugue new` scaffold (C3).** Generates a lint-clean DAG (`dag.ts`, `fugue.yaml`,
  `README.md`, optional `prompts/`) for each shape, with `--llm` and `--review`
  variants. Plus `fugue lint` / `describe` / `capabilities`.
- **First-class human-review gates (ADR-0060).** `createHumanReviewNode` and
  `withHumanReview` declare an HITL gate that suspends the run for an approve /
  reject / approve-with-edit / reroute decision, resolved by the host's durable
  HITL engine (async HTTP API + in-Teams Bot Framework approval transport). The
  gate prompt is a branded `NonEmptyString` — a blank prompt is unrepresentable.
- **Identity-scoped capabilities.** Per-identity capability scoping via Keycloak
  token exchange, JWT validation, and LLM metering across host and framework.
- **Lint checks & golden examples.** Fan-in-key-mismatch and shape-helper
  advisories; golden example DAGs `08`/`09`/`10`.

### Fixed

- **BullMQ event-log dedup now matches ADR 0014 (last-seen-only).** The BullMQ
  adapter's `appendEvent` scanned the last 8 stream entries for a matching
  `dedupKey`; ADR 0014 specifies dedup against the *most recent* entry only
  (`XREVRANGE +/- COUNT 1`). The deeper scan wrongly dropped a legitimately
  recurring transition key and diverged from the in-memory backend. Now depth-1,
  consistent across both backends.

[0.2.0]: https://github.com/peterstorm/fugue/releases/tag/v0.2.0
