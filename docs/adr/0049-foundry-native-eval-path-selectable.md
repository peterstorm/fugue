# ADR-0049: Foundry-Native Evaluation Path, Selectable at Run Time

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

The customer-summary application has a single evaluation harness that scores a fixed
set of cases (currently 25) with LLM-judge scorers and records results through
`mlflow.evaluate()`. As Azure AI Foundry becomes a first-class observability
destination for traces (recorded separately in the trace-export decision), engineers
need their *evaluation* scores to land in the Foundry Evaluations view too — otherwise
quality assessment lives in a different tool than the trace view it should sit beside.

The forces at play:

- **Two scoring backends, one notion of "the cases."** Foundry-native scoring uses the
  `azure-ai-evaluation` SDK; MLflow scoring uses `mlflow.evaluate()`. Both must score the
  *same* cases with the *same* judge so a backend switch never silently changes what is
  being measured or what "good" means.
- **MLflow must not regress.** MLflow stays the default and its output must remain
  byte-for-byte equivalent to current behavior; adding Foundry cannot perturb the existing
  path.
- **Selection must be configuration-driven.** Operators must choose the evaluation backend
  at run time — without editing code — and per environment.
- **Parity must be enforceable, not aspirational.** The two backends are required to agree
  within a defined tolerance (mean per-scorer score within ±0.5 on the 1–5 scale). A
  tolerance that is only checked by a unit test, never exercised against real dual-backend
  output, does not actually guarantee non-divergence in practice.
- **Judge credentials already exist.** The Azure OpenAI judge-model credentials used by the
  current MLflow path must be reused, not re-provisioned, for Foundry scoring.

The question is *where* in the harness the two backends diverge, and how selection and
parity-checking are wired so the backends cannot drift on case selection or aggregation.

## Options Considered

1. **Separate `run_foundry.py` script duplicating the harness**
   - Pros: Foundry path fully isolated from MLflow path; no risk of touching the existing
     entrypoint; conceptually simple to start.
   - Cons: Duplicates case loading, result collection, and aggregation across two scripts.
     The two copies inevitably drift — a fix to case selection or aggregate computation in
     one is not reflected in the other. Worse, a parity check between two independently
     loaded/aggregated runs becomes meaningless: a "parity within ±0.5" result could be an
     artifact of divergent case sets or divergent aggregation rather than agreement between
     the scorers. The very property we want to guarantee (no systematic divergence) is
     undermined by the structure that produces it.

2. **Replace MLflow with the Foundry-native path**
   - Pros: One backend, one code path, nothing to select between.
   - Cons: Out of scope. MLflow must remain the default and fully functional; removing it
     deletes existing history and the fallback that adoption risk depends on. Rejected on
     scope grounds.

3. **A `backend` selector that branches at the single I/O seam, sharing the functional core**
   - Pros: The pure logic — case parsing, eval-data assembly, aggregate computation, and
     results-table formatting — is written once and shared by both backends. Only the scoring
     call and the result-shape adapter differ. Because both backends consume the identical
     list of `EvalResult` cases and the identical aggregation, they cannot diverge on *what*
     is scored or *how* scores are aggregated — only on the scoring itself, which is exactly
     what the parity check is meant to compare. MLflow stays byte-for-byte unchanged because
     the MLflow branch is the pre-existing code path, untouched.
   - Cons: A single entrypoint now carries branching logic and must validate the selector
     value; a malformed selector that slips past validation would be a latent footgun
     (mitigated below by fail-loud validation).

## Decision

**Add a `backend` selector that branches `run_evaluation()` at the single scoring I/O seam
between the existing MLflow path and a new Foundry-native path, with both paths consuming
the same cases and reusing the same functional core and judge credentials.**

Selection and dispatch:

- The backend is read from the `EVAL_BACKEND` environment variable (default `mlflow`) and
  may be overridden by the `--backend` CLI flag; **the CLI flag wins** over the environment.
- The allowed set is fixed as `mlflow | foundry | both`
  (`ALLOWED_BACKENDS = ("mlflow", "foundry", "both")`). The selector is validated against
  this set **before any dispatch**. An unknown value — including an `EVAL_BACKEND` typo such
  as `foundryy` that bypasses argparse's `choices` because it arrives as the flag's default —
  **fails loud** with a clear error and a non-zero exit. There is no silent fallback to
  MLflow on an unrecognized value.

Shared functional core vs. divergent seam:

- Shared (pure, written once): case parsing (`parse_cases`), eval-data assembly
  (`build_eval_data`), aggregate computation (`compute_aggregate`), and results-table
  formatting (`format_results_table`).
- Divergent (the only difference between backends): the scoring call and the adapter that
  reshapes the SDK's per-case result into the harness's common result shape. The MLflow
  branch is the unchanged `mlflow.evaluate()` path; the Foundry branch is
  `run_evaluation_foundry()`, built on `azure-ai-evaluation`. Both reuse the existing Azure
  OpenAI judge-model credentials.

Files:

- `apps/customer-summary/eval/run.py` — selector, validation, and dispatch
  (including the `both` mode below).
- `apps/customer-summary/eval/foundry_eval.py` — `run_evaluation_foundry()` and the
  result-shape adapter over `azure-ai-evaluation`.
- `apps/customer-summary/eval/parity.py` — `compute_parity`, `parity_within_tolerance`,
  and `format_parity_table`, with `PARITY_TOLERANCE = 0.5`.

As-built additions beyond the original plan (making parity enforceable end-to-end):

- **A third `--backend=both` mode.** Beyond `mlflow` and `foundry`, `both` runs *both*
  backends over the same cases, computes per-scorer deltas (`compute_parity`), prints a
  parity table, and decides a verdict via `parity_within_tolerance(deltas, tol=0.5)`. This is
  what turns the ±0.5 tolerance from a unit-tested function into an enforced, end-to-end
  property: a single command actually exercises both scorers against the same input and
  compares the aggregate results.
- **`both` exits non-zero when out of tolerance.** If any shared per-scorer mean delta
  exceeds ±0.5, or if a backend fails its own threshold, the run exits non-zero.
- **Empty scorer-overlap is an error, not a vacuous pass.** If the two backends share *no*
  comparable scorer, `both` refuses to report a vacuous "parity passed" over an empty set and
  exits non-zero. Parity over zero scorers is meaningless and is treated as a failure.
- **The Foundry adapter fails loud on unexpected SDK result shapes.** When the
  `azure-ai-evaluation` result does not match the expected shape — e.g., requested scorers
  are missing, or zero expected scorers matched while metrics were non-empty — the adapter
  fails closed: it surfaces both the requested-but-missing scorers and the actual keys on
  stderr and returns a FAILED aggregate (`overall_mean=0.0, passed=False`), rather than
  silently coercing to an empty (and therefore deceptively "passing-shaped") result.

Invariants:

- Both backends score the identical `list[EvalResult]` (the same cases) and run through the
  identical aggregation — divergence is possible only at scoring, never at case selection or
  aggregation.
- The MLflow path is the pre-existing code path, unmodified.
- An unrecognized backend value never reaches dispatch; it fails loud first.

## Consequences

**Positive:**

- MLflow remains byte-for-byte unchanged — the MLflow branch is the original code path, so
  enabling Foundry carries no regression risk to the default backend.
- Backends cannot drift on case selection or aggregation, because that logic is shared and
  written once; only the scoring call differs, which is precisely the quantity the parity
  check is designed to compare.
- The evaluation backend is selectable at run time with zero code changes, per environment,
  via `EVAL_BACKEND` (with `--backend` taking precedence).
- The judge model and credentials are reused as-is — no new credential provisioning for the
  Foundry path.
- Parity is enforced end-to-end, not merely unit-tested: `--backend=both` runs both scorers
  over the same cases and fails the run when they diverge beyond ±0.5 or share no comparable
  scorer.
- Failures are loud: an invalid selector, an out-of-tolerance parity result, an empty scorer
  overlap, and an unexpected SDK result shape all surface as explicit errors with non-zero
  exits rather than silent fallbacks or deceptive passes.

**Negative:**

- The single evaluation entrypoint now carries branching and selector-validation logic it
  previously did not — more surface area in one place. Accepted: the alternative
  (duplicated harnesses) trades this for guaranteed drift and a meaningless parity check.
- Running `--backend=both` doubles judge-model invocations for a given run (each case is
  scored twice), with the associated cost and time. Accepted: `both` is a deliberate
  parity-verification / migration mode, not the default run mode.
- The Foundry path depends on the shape of `azure-ai-evaluation` results; an SDK upgrade that
  changes that shape will trip the fail-loud adapter and require an adapter update. Accepted
  as the correct failure mode — a loud break is preferable to silently emitting empty,
  passing-shaped results.
- The ±0.5 tolerance is a chosen threshold on the 1–5 scale; if the two backends' judges
  legitimately differ by more than that on some scorer, the `both` mode will fail and force a
  human decision rather than papering over the divergence.

## Related

- ADR-0044 — Thin vendor exporter factories with bootstrap composition (the trace-export
  backend-selection counterpart to this evaluation-signal decision), with ADR-0050 —
  Observability backend selection in the app config layer (the config surface that selects the
  trace backend).
- ADR-0048 — Domain events and metrics via the Application Insights SDK (the Foundry
  domain-events and aggregated-metrics layer).
