# Architecture Decision Records

Numbered, immutable decision records for the framework runtime. New ADRs append; existing ADRs gain `Status: Superseded by ADR NNNN` lines rather than disappearing.

## Reading order for newcomers

Start with these to understand the runtime as it stands today:

1. [ADR 0001](0001-single-package-layered-modules.md) — package layout.
2. [ADR 0021](0021-single-path-runtime.md) — current execution path (subsumes 0002, 0007).
3. [ADR 0019](0019-runtime-routing-predicate.md) — what triggers the durable runtime.
4. [ADR 0017](0017-derive-deps-from-edges.md) — DAG topology model.
5. [ADR 0016](0016-structural-match-predicates.md) — conditional-edge predicates.
6. [ADR 0008](0008-event-envelope-and-time.md) + [ADR 0014](0014-idempotent-appendevent.md) — durability invariants.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-single-package-layered-modules.md) | Single package, layered modules | Accepted |
| [0002](0002-rundag-backcompat-shim.md) | `runDag` back-compat shim | Superseded by 0021 |
| [0003](0003-event-sourcing-redis-streams.md) | Event sourcing via Redis Streams | Accepted (timestamp-source superseded by 0008) |
| [0004](0004-traceevent-post-transition.md) | `TraceEvent` post-transition with FROM/TO | Accepted |
| [0005](0005-retry-layering.md) | Retry layering — inner machine, outer queue | Accepted |
| [0006](0006-joblike-minimal-write-side.md) | `JobLike` minimal write-side | Accepted |
| [0007](0007-rundag-legacy-fast-path.md) | Legacy fast path opt-in | Superseded by 0021 |
| [0008](0008-event-envelope-and-time.md) | Event envelope with `recordedAtMs` | Accepted |
| [0009](0009-runtime-routing-by-node-config.md) | Routing by node config | Accepted (amended by 0019) |
| [0010](0010-queue-payload-envelope.md) | Queue `{state, context}` envelope | Accepted |
| [0011](0011-queue-retry-config-single-source.md) | Queue retry config — single source | Accepted |
| [0012](0012-tool-call-surface.md) | LLM tool-call surface + GenAI tracing | Accepted |
| [0013](0013-onhumanreview-hook-crash-retry.md) | `onHumanReview` hook-crash retry | Accepted |
| [0014](0014-idempotent-appendevent.md) | Deterministic dedup keys | Accepted |
| [0015](0015-conditional-edges.md) | Conditional edges | Accepted (`when` payload superseded by 0016) |
| [0016](0016-structural-match-predicates.md) | Structural-match predicates | Accepted |
| [0017](0017-derive-deps-from-edges.md) | Derive deps from edges | Accepted |
| [0018](0018-onbackground-on-state-machine-path.md) | `onBackground` on the SM path | Accepted |
| [0019](0019-runtime-routing-predicate.md) | Routing predicate — full disjunction | Accepted |
| [0020](0020-ontrace-vs-run-end-ordering.md) | `onTrace` precedes `run-end` | Accepted |
| [0021](0021-single-path-runtime.md) | Single-path runtime | Accepted |
| [0022](0022-legacy-path-retirement-criteria.md) | Legacy-path retirement criteria | Accepted |
| [0023](0023-genai-semconv-source-of-truth.md) | OTel GenAI semconv as source of truth for LLM telemetry | Accepted |
| [0024](0024-llm-types-in-types-layer.md) | LLM types in types layer | Accepted |
| [0025](0025-freshness-witness-contract.md) | Freshness witness contract (Phase 3) | Accepted |
| [0026](0026-human-intervention-telemetry.md) | Human intervention as first-class telemetry | Accepted |
| [0027](0027-confidence-calibration-workflow.md) | Bucketed confidence calibration workflow | Accepted |
| [0028](0028-function-based-predicates.md) | Function-based predicates with confidence gating | Accepted |
| [0029](0029-mandatory-routing-decisions.md) | Mandatory routing decisions on wave-done | Accepted |
| [0030](0030-state-machine-pure-transitions.md) | Pure state machine transitions | Accepted |
| [0031](0031-immutable-registry-snapshot.md) | Immutable registry snapshot | Accepted |
| [0032](0032-framework-independence.md) | Framework independence | Accepted |
| [0033](0033-dag-registration-host-contract.md) | DAG registration host contract | Accepted |
| [0034](0034-raw-git-via-bun-spawn.md) | Raw git via Bun.spawn | Accepted |
| [0035](0035-hono-http-server.md) | Hono HTTP server | Accepted |
| [0036](0036-layered-error-handling.md) | Layered error handling | Accepted |
| [0037](0037-pure-concurrency-limiter.md) | Pure concurrency limiter | Accepted |
| [0038](0038-pure-circuit-breaker.md) | Pure circuit breaker | Accepted |
| [0039](0039-big-bang-rename.md) | Big-bang rename @ai-summary → @fugue | Accepted |
| [0040](0040-single-instance-in-memory-state.md) | Single instance in-memory state | Accepted |
| [0041](0041-separate-dags-repository.md) | Separate DAGs repository | Accepted |
| [0042](0042-config-via-zod-env-yaml.md) | Config via Zod env/YAML | Accepted |
| [0043](0043-otel-tracing-for-host-operations.md) | OTel tracing for host operations | Accepted |

## Conventions

- **Number** is assigned at merge time, not at draft time. Drafts in `docs/plans/**` that propose an ADR number may collide with concurrent work; the actual ADR number is whatever's next free when it lands.
- **Status** values: `Proposed`, `Accepted`, `Superseded by ADR NNNN`. Never `Rejected` (rejected ideas live in plan docs, not as ADRs).
- **Related** lists adjacent or amending ADRs; **Supersedes** lists ADRs this one replaces; **Superseded by** lists the inverse.
- Code that depends on an ADR's decision should cite it inline with `// ADR NNNN: <one-line reason>`.
- When a decision is reversed or significantly amended, write a new ADR rather than editing the old one — the historical record is the value.

## Numbering integrity

Verified 2026-05-22: all 43 ADRs present, no gaps, no duplicates. 0002 and 0007 are correctly marked `Superseded by 0021`. Cross-references (`git grep "ADR 00"`) all resolve. ADRs 0030–0043 cover `@fuguejs/host` architectural decisions (state machines, registry, git adapter, HTTP server, error handling, concurrency, circuit breaker, config, tracing).

A stale `## ADR 0020` heading exists in `docs/plans/2026-05-10-typed-tool-names.md` — that plan is still draft and proposed claiming slot 0020 before slot 0020 was assigned to `ontrace-vs-run-end-ordering`. The plan must renumber its proposal when it leaves draft; the ADR itself is unaffected.
