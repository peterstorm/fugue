# Brainstorm Summary

**Building:** A concurrency limit for runtime-width map fans: a fan can run several children at once, bounded by that limit. Plus a whole-fan budget check: once it has measured what one child costs, it refuses to start more children if the rest of the fan cannot fit the run's ceilings.

**Approach:** Approach A, one PR. It adds a concurrency limit (default 1, identical to today's sequential fan) and stores each result in its index slot. It also adds a probe-then-project budget check. The first batch of children is the probe. Before each later dispatch, the fan measures per-child spend through the existing `BudgetCapability` `spent()`/`remaining()` reads. It refuses when `settled + remainingChildren x largestPerChildSpendSeen > ceiling`. No new host port. (The user confirmed this approach and the decisions below; the coordinator relayed their answers.)

**Key Constraints:**
- Concurrency 1 must reproduce today's behavior exactly (`packages/framework/src/dag-runtime/run-mapped-fan.ts`).
- Concurrency source (user decision): a positive-int `maxConcurrency` set on the map node, default 1, capped by a host policy maximum. The cap is a ceiling, not an override: the effective value is `min(authored, hostMax)`.
- Probe (user decision): the first `min(concurrency, remaining)` children form the probe batch. The projection runs before every later dispatch. The first burst can therefore overshoot by up to one batch. That is accepted, and the host's per-call meter still bounds it.
- Mid-fan failure or refusal (user decision): when a child fails or the projection refuses, the fan starts no new children. In-flight children finish, and their outputs are validated and saved to checkpoints. The fan then returns the first error by index order.
- Unpriced or unknown-usage headroom (user decision): for `unpriced`/`unknown-usage` axes, the projection uses the known lower bound (`observedAtLeast`). It refuses once that bound alone breaches. `unbudgeted` means no projection. `available` axes (tokens, calls, usd) project in their own unit.
- Reducer input is in index order on fresh and resumed runs, whatever the completion order.
- Corrupt checkpoint entries refuse the whole fan before any child runs.
- Checkpoint reads and writes use `{index, attempt: executionEpoch}`. A retry keeps the epoch; a reroute advances it (retry is not reroute).
- Dispatch and spend authority stay with the root (ADR-0086). The framework only reads the budget through `BudgetCapability`.
- Cancellation stops new dispatch and the reducer. A child that is already completing may still save.
- A budget refusal stops the fan at a known point: it is a typed error naming the fan and the projection, never a silent partial reduce.
- The host meter still enforces per call (`packages/host/src/domain/llm-meter.ts`). The fan projection is an earlier, coarser gate on top of it, not a replacement.
- Verified from code, ceilings on resume:
  - Ceilings come only from the DAG config (`ceilingsOf(dag.config)`, `packages/host/src/adapters/node-context-factory.ts:725`).
  - Caller-supplied ceilings can only tighten them (FR-B-009).
  - A resume loads the prior spend from the ledger.
  - The DAG fingerprint covers structure only and excludes budget config (`packages/framework/src/checkpoint/fingerprint.ts`). The only way to raise ceilings for a resume is to redeploy the DAG with a larger budget, and that resume keeps the children already saved for each index.
  - Without a redeploy, resuming a fan the projection refused is refused again. This is expected behavior, and the refusal error and docs should say so.

**In Scope:**
- `maxConcurrency` on the map node (branded positive int, default 1), plus a host policy maximum that caps it.
- A bounded scheduler that fills index slots. For each index it keeps checkpoint replay, output validation, save, and abort checks.
- Probe-then-project budget admission before each dispatch after the probe batch, using only `BudgetCapability` reads.
- Drain on failure: no new dispatch; in-flight children finish and save; the first error is returned by index order.
- A typed projection-refusal error carrying the fan id, completed and remaining counts, the per-child estimate, the breached ceiling, and whether the headroom was a lower bound.
- Tests:
  - concurrency-1 equivalence with today's fan
  - index order under out-of-order completion
  - projection refusal at a known point
  - drain-and-save of in-flight siblings on failure or refusal
  - first error by index order
  - resume after refusal (refused again under the same config; continues after a redeploy with a larger budget)
  - abort mid-fan
  - corruption refusal with concurrency > 1
  - the host cap applied
  - property tests for the projection arithmetic (all headroom kinds) and for slot ordering
- Doc updates:
  - F1 plan §12 "The fan is sequential" and §13
  - ADR-0086, or a new ADR for concurrent fan scheduling and projection
  - the fan-runner comments
  - host config docs for the policy maximum

**Out of Scope:**
- A host reserve/admit port or any new spend-authority seam.
- Per-child cost estimates set on the node.
- Changes to the host per-call meter's `maxObservedCall` admission.
- Per-run ceiling overrides, or raising ceilings on resume without a redeploy.
- Cancelling in-flight siblings on failure or refusal (rejected in favor of drain-and-save).
- A one-child probe before going wide (rejected in favor of the batch probe).
- Concurrency across fans, and tenant-level or global LLM rate limiting.

**Open Questions:**
- None blocking. Specify should choose the name and location of the host policy maximum (existing host config versus tenant registry), plus its default value.
