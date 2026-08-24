# Changelog

All notable changes to `@fuguejs/framework` are documented here. The framework
and its lockstep packages (`@fuguejs/host`, `@fuguejs/fs`, `@fuguejs/ms-graph`,
`@fuguejs/pg`, `@fuguejs/oracle`, `@fuguejs/http-auth`,
`@fuguejs/document-source`, `@fuguejs/xlsx`) are versioned together. Format
follows [Keep a Changelog](https://keepachangelog.com/); this project is
pre-1.0, so a minor bump may carry breaking changes.

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
