#!/usr/bin/env python3
"""
Eval sidecar for customer-summary service.

Loads eval cases, calls the summarize endpoint, and evaluates responses
using MLflow's built-in LLM-as-judge (Azure OpenAI gpt-4o-mini) and
deterministic grounding scorer. Results are logged to the MLflow experiment
and visible in the MLflow UI evaluation tab.

Modes:
  --mode=full  All scorers including LLM-judged via Azure OpenAI (default)
  --mode=ci    Deterministic grounding scorer only (no LLM calls, fast, CI-safe)

Backends (run-time selectable, no code changes):
  --backend=mlflow   Score via mlflow.evaluate() (DEFAULT)
  --backend=foundry  Score via azure-ai-evaluation (Foundry Evaluations view)
  --backend=both     Run BOTH paths over the same results and check per-scorer
                     parity (SC-005, +/-0.5); non-zero exit if out of tolerance.
  Default comes from EVAL_BACKEND env (default "mlflow"); --backend wins.

Exits with code 1 if aggregate mean score < threshold.

Env vars:
  APP_BASE_URL            - Base URL of the summary service (default: http://host.containers.internal:3000)
  MLFLOW_TRACKING_URI     - MLflow tracking server URI
  MLFLOW_EXPERIMENT_NAME  - Experiment name for eval results (default: Default)
  EVAL_CASES_PATH         - Path to eval cases JSON (default: fixtures/eval/cases.json)
  AZURE_OPENAI_ENDPOINT   - Azure OpenAI endpoint
  AZURE_OPENAI_API_KEY    - Azure OpenAI API key
  AZURE_OPENAI_DEPLOYMENT - Azure OpenAI deployment name (default: gpt-4o-mini)
  AZURE_OPENAI_API_VERSION - Azure OpenAI API version
  EVAL_WORKERS            - Number of parallel workers for summarize calls (default: 4)
  EVAL_BACKEND            - Default eval backend: mlflow|foundry|both (default: mlflow; --backend overrides)
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd


PASS_THRESHOLD = 4.0

ALLOWED_BACKENDS = ("mlflow", "foundry", "both")

ALLOWED_MODES = ("full", "ci")


# --- Pure domain types ---

@dataclass(frozen=True)
class EvalCase:
    customer_id: str
    reference_summary: str


@dataclass(frozen=True)
class EvalResult:
    customer_id: str
    summary: str
    reference_summary: str
    error: Optional[str] = None


@dataclass(frozen=True)
class AggregateResult:
    scorer_means: dict[str, float]
    overall_mean: float
    passed: bool


# --- Pure functions (functional core) ---

def parse_cases(raw: list[dict[str, Any]]) -> list[EvalCase]:
    """Parse raw JSON into validated EvalCase objects."""
    cases = []
    for item in raw:
        if "customer_id" not in item or "reference_summary" not in item:
            raise ValueError(f"Invalid eval case: missing required fields in {item}")
        cases.append(EvalCase(
            customer_id=item["customer_id"],
            reference_summary=item["reference_summary"],
        ))
    return cases


def build_eval_data(results: list[EvalResult]) -> "pd.DataFrame":
    """Build a pandas DataFrame for mlflow.evaluate().

    Columns:
      - inputs: str (a prompt string referencing the customer_id, used as the
        model input context — NOT the bare customer_id)
      - predictions: str (the generated summary)
      - targets: str (reference summary — passed to mlflow.evaluate() as the
        `targets` column; the genai metrics consume it via col_mapping)
      - context: str (a copy of the reference summary; exists for the Foundry
        path's query/response/context/ground_truth schema mapping, not for any
        MLflow grading context)
      - customer_id: str (for grounding scorer fixture lookup)
    """
    import pandas as pd

    rows = []
    for r in results:
        if r.error is None:
            rows.append({
                "inputs": f"Summarize conversation history for customer {r.customer_id}.",
                "predictions": r.summary,
                "targets": r.reference_summary,
                "context": r.reference_summary,
                # Keep customer_id for grounding scorer fixture lookup
                "customer_id": r.customer_id,
            })
    return pd.DataFrame(rows)


def compute_aggregate(eval_table: Any, scorer_names: list[str]) -> AggregateResult:
    """Compute mean scores from MLflow evaluation results."""
    metrics = eval_table.metrics
    scorer_means: dict[str, float] = {}

    for name in scorer_names:
        key = f"{name}/score/mean"
        if key in metrics:
            scorer_means[name] = metrics[key]
        else:
            # Try an EXACT-suffix match anchored to the scorer name rather than
            # a loose substring scan: a `name in k` test can bind to the FIRST
            # loosely-matching key (a `_v2` variant, or a scorer name that is a
            # substring of another) and silently average in the wrong scorer.
            # Anchor on `{name}/` ... `/score/mean` and log which non-canonical
            # key was selected before accepting it.
            for k, v in metrics.items():
                if k.startswith(f"{name}/") and k.endswith("/score/mean"):
                    print(
                        f"WARNING: MLflow metric for scorer {name!r} matched a "
                        f"non-canonical key {k!r} (value={v}); expected canonical "
                        f"key {key!r}. Accepting the anchored-suffix match.",
                        file=sys.stderr,
                    )
                    scorer_means[name] = v
                    break

    missing = [name for name in scorer_names if name not in scorer_means]
    if missing:
        # Parallels foundry_eval.compute_aggregate_foundry: a missing scorer means
        # the eval output shape did not contain the expected key — NOT a genuine
        # low score. Surface it loudly so a shape mismatch is never silently
        # averaged away (and never escapes the SC-005 parity overlap).
        if not scorer_means:
            # ZERO expected scorers matched. Either MLflow returned NO metrics at
            # all (empty dict — e.g. every row errored) or it returned keys but
            # none matched what we asked for. BOTH are unambiguous contract errors
            # (fail-closed at ERROR), never a genuine low score. Mirrors the
            # severity of foundry_eval.compute_aggregate_foundry's equivalent
            # branch so the most severe MLflow failure mode is not under-reported
            # as a mere WARNING in log-level-filtered pipelines.
            detail = (
                "returned NO metrics at all (empty dict)"
                if not metrics
                else (
                    f"returned metric keys {sorted(metrics.keys())}, none matching "
                    "the expected scorers"
                )
            )
            print(
                f"ERROR: MLflow metrics shape mismatch — expected scorers "
                f"{scorer_names}; the run {detail}. Returning a FAILED aggregate "
                "(fail-closed); this is a contract error, not a low score.",
                file=sys.stderr,
            )
        else:
            print(
                f"WARNING: MLflow metrics missing scorer(s) {missing}; actual "
                f"metric keys present: {sorted(metrics.keys())}. Treating the "
                "missing scorer(s) as a shape mismatch (fail-closed), not a low score.",
                file=sys.stderr,
            )
        # Fail closed for ANY missing expected scorer, including the partial case
        # where some scorers survived: a silently-dropped scorer (judge misconfig,
        # renamed metric key, SDK output-shape drift) must never be averaged away
        # to PASS over the survivors. Report the surviving means for visibility but
        # force passed=False — matching the "fail-closed" log text above.
        overall_mean = sum(scorer_means.values()) / len(scorer_means) if scorer_means else 0.0
        return AggregateResult(
            scorer_means=scorer_means,
            overall_mean=overall_mean,
            passed=False,
        )

    overall_mean = sum(scorer_means.values()) / len(scorer_means)
    return AggregateResult(
        scorer_means=scorer_means,
        overall_mean=overall_mean,
        passed=overall_mean >= PASS_THRESHOLD,
    )


def format_results_table(results: list[EvalResult], aggregate: AggregateResult, mode: str) -> str:
    """Format results as a human-readable table."""
    lines = []
    lines.append("=" * 70)
    lines.append(f"EVAL RESULTS (mode={mode})")
    lines.append("=" * 70)
    lines.append("")

    # Per-case summary
    lines.append(f"{'Customer ID':<15} {'Status':<10} {'Summary (truncated)'}")
    lines.append("-" * 70)
    for r in results:
        status = "ERROR" if r.error else "OK"
        summary_preview = (r.summary[:40] + "...") if len(r.summary) > 40 else r.summary
        lines.append(f"{r.customer_id:<15} {status:<10} {summary_preview}")

    lines.append("")
    lines.append("-" * 70)
    lines.append("SCORER MEANS:")
    for name, score in aggregate.scorer_means.items():
        lines.append(f"  {name:<20} {score:.2f}")
    lines.append(f"  {'OVERALL':<20} {aggregate.overall_mean:.2f}")
    lines.append("")

    verdict = "PASS" if aggregate.passed else f"FAIL (threshold: {PASS_THRESHOLD})"
    lines.append(f"VERDICT: {verdict}")
    lines.append("=" * 70)

    return "\n".join(lines)


# --- Imperative shell ---

def load_cases(path: str) -> list[EvalCase]:
    """Load and parse eval cases from JSON file."""
    raw = json.loads(Path(path).read_text())
    return parse_cases(raw)


def call_summarize(base_url: str, customer_id: str) -> EvalResult:
    """POST to summarize endpoint and return result."""
    import requests

    url = f"{base_url.rstrip('/')}/summarize"
    try:
        resp = requests.post(url, json={"customer_id": customer_id}, timeout=60)
        resp.raise_for_status()
        body = resp.json()
        if body.get("status") != "ok":
            return EvalResult(
                customer_id=customer_id,
                summary="",
                reference_summary="",
                error=f"Non-ok status: {body.get('status')}: {body.get('message', '')}",
            )
        summary_obj = body.get("summary", {})
        summary_text = summary_obj.get("summary", "") if isinstance(summary_obj, dict) else str(summary_obj)
        return EvalResult(
            customer_id=customer_id,
            summary=summary_text,
            reference_summary="",  # filled later
        )
    except Exception as e:
        return EvalResult(
            customer_id=customer_id,
            summary="",
            reference_summary="",
            error=str(e),
        )


def collect_results(base_url: str, cases: list[EvalCase], max_workers: int = 4) -> list[EvalResult]:
    """Call summarize for each case in parallel and attach reference summaries."""
    # Map customer_id -> reference_summary for quick lookup
    ref_map = {c.customer_id: c.reference_summary for c in cases}
    results: list[EvalResult] = []

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(call_summarize, base_url, case.customer_id): case.customer_id
            for case in cases
        }
        for future in as_completed(futures):
            cid = futures[future]
            try:
                result = future.result()
            except Exception as e:
                result = EvalResult(customer_id=cid, summary="", reference_summary="", error=str(e))
            # Attach reference summary
            results.append(EvalResult(
                customer_id=result.customer_id,
                summary=result.summary,
                reference_summary=ref_map.get(result.customer_id, ""),
                error=result.error,
            ))

    # Sort by customer_id for deterministic output
    results.sort(key=lambda r: r.customer_id)
    return results


def run_evaluation(results: list[EvalResult], mode: str) -> AggregateResult:
    """Run MLflow evaluation with LLM-as-judge metrics.

    Uses mlflow.evaluate() which stores results in the MLflow experiment,
    visible in the MLflow UI evaluation tab.
    """
    eval_data = build_eval_data(results)

    if eval_data.empty:
        print("ERROR: No successful results to evaluate", file=sys.stderr)
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

    import mlflow
    from scorers import get_scorers, SCORER_NAMES, DETERMINISTIC_SCORER_NAMES

    scorers = get_scorers(mode=mode)
    active_names = DETERMINISTIC_SCORER_NAMES if mode == "ci" else SCORER_NAMES

    # mlflow.evaluate() logs results to the active experiment
    # Disable all default metrics; only use our custom scorers
    eval_result = mlflow.evaluate(
        data=eval_data,
        predictions="predictions",
        targets="targets",
        extra_metrics=scorers,
        evaluator_config={
            "col_mapping": {"inputs": "inputs"},
            "metrics": scorers,
        },
        model_type="text",
    )

    return compute_aggregate(eval_result, active_names)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run eval suite for customer-summary")
    parser.add_argument(
        "--mode",
        choices=["full", "ci"],
        default=os.environ.get("EVAL_MODE", "full"),
        help="full: all scorers (requires Azure OpenAI). ci: deterministic only (default: full)",
    )
    # NOTE: choices validates CLI-passed values only — NOT the env defaults. Both
    # --backend/EVAL_BACKEND and --mode/EVAL_MODE can pick up env-default values
    # that bypass argparse choices, so each is re-validated against its allowed
    # set (ALLOWED_BACKENDS / ALLOWED_MODES) in main() — a bogus EVAL_BACKEND or
    # EVAL_MODE fails loud instead of falling through to a catch-all dispatch
    # (e.g. EVAL_MODE=cii silently running LLM judges instead of CI-only).
    parser.add_argument(
        "--backend",
        choices=list(ALLOWED_BACKENDS),
        default=os.environ.get("EVAL_BACKEND", "mlflow"),
        help=(
            "mlflow: score via mlflow.evaluate() (default). "
            "foundry: score via azure-ai-evaluation. "
            "both: run both paths and check parity (SC-005). "
            "CLI flag wins over EVAL_BACKEND env."
        ),
    )
    return parser.parse_args()


def run_mlflow_backend(results: list[EvalResult], mode: str) -> AggregateResult:
    """Imperative-shell wrapper for the MLflow path.

    Sets the MLflow experiment then runs run_evaluation. Kept as a thin seam so
    backend=both can invoke the EXACT same MLflow behavior as backend=mlflow
    (FR-016: single-backend MLflow behavior is byte-for-byte unchanged).
    """
    import mlflow
    experiment_name = os.environ.get("MLFLOW_EXPERIMENT_NAME", "Default")
    mlflow.set_experiment(experiment_name)
    print(f"MLflow experiment: {experiment_name}")

    print(f"Running MLflow evaluation (mode={mode})...")
    return run_evaluation(results, mode=mode)


def run_foundry_backend(results: list[EvalResult], mode: str) -> AggregateResult:
    """Imperative-shell wrapper for the Foundry path."""
    from foundry_eval import run_evaluation_foundry

    print(f"Running Foundry evaluation (mode={mode})...")
    return run_evaluation_foundry(results, mode=mode)


def run_both_backends(results: list[EvalResult], mode: str) -> int:
    """Run BOTH backends over the SAME results and enforce per-scorer parity.

    Wires parity.py against real data (SC-005). Returns an exit code:
      0  -> both backends pass their own thresholds AND every shared per-scorer
            mean is within +/-0.5.
      1  -> a backend failed its threshold, parity was out of tolerance, OR the
            two backends share no comparable scorer (empty overlap is treated as
            an error — never a vacuous pass).
    """
    from parity import compute_parity, parity_within_tolerance, format_parity_table

    mlflow_agg = run_mlflow_backend(results, mode)

    # Fault-isolate the Foundry leg: if it raises (missing creds RuntimeError,
    # SDK import failure, scoring error) the whole `both` run must NOT die with
    # an uncaught traceback that discards the already-computed MLflow verdict.
    # Surface a DISTINCT error naming it as a Foundry-leg failure and return 1,
    # preserving the printed MLflow result.
    try:
        foundry_agg = run_foundry_backend(results, mode)
    except Exception as e:
        print(format_results_table(results, mlflow_agg, mode=f"{mode} (mlflow)"))
        print(
            "ERROR: Foundry-leg construction/scoring FAILED during backend=both "
            f"({type(e).__name__}: {e}). The MLflow leg already ran (result above) "
            "and is preserved; failing the parity run fail-closed.",
            file=sys.stderr,
        )
        return 1

    print(format_results_table(results, mlflow_agg, mode=f"{mode} (mlflow)"))
    print(format_results_table(results, foundry_agg, mode=f"{mode} (foundry)"))

    deltas = compute_parity(mlflow_agg.scorer_means, foundry_agg.scorer_means)

    if not deltas:
        print(
            "ERROR: parity check has no comparable scorers — the MLflow and "
            "Foundry paths produced no shared scorer means "
            f"(mlflow={sorted(mlflow_agg.scorer_means)}, "
            f"foundry={sorted(foundry_agg.scorer_means)}). "
            "Refusing to vacuous-pass an empty parity set.",
            file=sys.stderr,
        )
        return 1

    print(format_parity_table(deltas))
    # Inherit parity.PARITY_TOLERANCE (the single source of truth) rather than
    # re-stating 0.5 here — otherwise the printed table and the pass/fail check
    # could silently disagree if the tolerance is ever retuned.
    within = parity_within_tolerance(deltas)
    if not within:
        print(
            "ERROR: eval-backend parity OUT OF TOLERANCE (SC-005, +/-0.5).",
            file=sys.stderr,
        )

    backends_pass = mlflow_agg.passed and foundry_agg.passed
    return 0 if (backends_pass and within) else 1


def main() -> int:
    """Main entry point. Returns exit code."""
    args = parse_args()
    mode = args.mode
    backend = args.backend

    # Re-validate the resolved backend (which may have come from the
    # EVAL_BACKEND env default, NOT validated by argparse choices) BEFORE
    # dispatch so a typo like EVAL_BACKEND=foundryy fails loud instead of
    # silently routing to a catch-all.
    if backend not in ALLOWED_BACKENDS:
        allowed = "|".join(ALLOWED_BACKENDS)
        print(
            f"ERROR: EVAL_BACKEND/--backend must be {allowed}, got {backend!r}",
            file=sys.stderr,
        )
        return 1

    if mode not in ALLOWED_MODES:
        allowed = "|".join(ALLOWED_MODES)
        print(
            f"ERROR: EVAL_MODE/--mode must be {allowed}, got {mode!r}",
            file=sys.stderr,
        )
        return 1

    base_url = os.environ.get("APP_BASE_URL", "http://host.containers.internal:3000")
    cases_path = os.environ.get("EVAL_CASES_PATH", "fixtures/eval/cases.json")
    try:
        max_workers = int(os.environ.get("EVAL_WORKERS", "4"))
    except ValueError:
        print("ERROR: EVAL_WORKERS must be a numeric value", file=sys.stderr)
        return 1

    print(f"Eval mode: {mode}")
    print(f"Eval backend: {backend}")
    print(f"Loading eval cases from: {cases_path}")
    try:
        cases = load_cases(cases_path)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        print(f"ERROR: Failed to load eval cases from {cases_path}: {e}", file=sys.stderr)
        return 1
    print(f"Loaded {len(cases)} eval cases")

    # Validate fixtures exist for grounding scorer
    from scorers import validate_fixtures
    fixture_warnings = validate_fixtures([c.customer_id for c in cases])
    if fixture_warnings:
        print(f"WARNING: {len(fixture_warnings)} fixture issues:", file=sys.stderr)
        for w in fixture_warnings:
            print(f"  {w}", file=sys.stderr)

    print(f"Calling summarize endpoint at: {base_url} (workers={max_workers})")
    results = collect_results(base_url, cases, max_workers=max_workers)

    errors = [r for r in results if r.error]
    if errors:
        print(f"WARNING: {len(errors)} cases failed:", file=sys.stderr)
        for r in errors:
            print(f"  {r.customer_id}: {r.error}", file=sys.stderr)

    # Exhaustive dispatch — no else-catches-everything. The resolved backend is
    # already validated above, so the final else is a defensive guard only.
    if backend == "both":
        return run_both_backends(results, mode)
    elif backend == "foundry":
        aggregate = run_foundry_backend(results, mode)
    elif backend == "mlflow":
        aggregate = run_mlflow_backend(results, mode)
    else:
        allowed = "|".join(ALLOWED_BACKENDS)
        print(
            f"ERROR: EVAL_BACKEND/--backend must be {allowed}, got {backend!r}",
            file=sys.stderr,
        )
        return 1

    print(format_results_table(results, aggregate, mode=mode))

    return 0 if aggregate.passed else 1


if __name__ == "__main__":
    sys.exit(main())
