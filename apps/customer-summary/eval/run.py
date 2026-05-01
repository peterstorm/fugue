#!/usr/bin/env python3
"""
Eval sidecar for customer-summary service.

Loads eval cases, calls the summarize endpoint, and evaluates responses
using MLflow GenAI scorers (factuality, completeness, conciseness, grounding).

Modes:
  --mode=full  All scorers including LLM-judged via Ollama (default)
  --mode=ci    Deterministic grounding scorer only (no Ollama, fast, CI-safe)

Exits with code 1 if aggregate mean score < threshold.

Env vars:
  APP_BASE_URL        - Base URL of the summary service (default: http://host.containers.internal:3000)
  MLFLOW_TRACKING_URI - MLflow tracking server URI
  EVAL_CASES_PATH     - Path to eval cases JSON (default: fixtures/eval/cases.json)
  OLLAMA_BASE_URL     - Ollama API URL (default: http://localhost:11434)
  OLLAMA_TIMEOUT_SEC  - Timeout for Ollama calls in seconds (default: 120)
  EVAL_WORKERS        - Number of parallel workers for summarize calls (default: 4)
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


PASS_THRESHOLD = 4.0


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


def build_eval_data(results: list[EvalResult]) -> list[dict[str, Any]]:
    """Build the data structure expected by mlflow.genai.evaluate()."""
    return [
        {
            "inputs": {"customer_id": r.customer_id},
            "outputs": {"summary": r.summary},
            "expectations": {"reference_summary": r.reference_summary},
        }
        for r in results
        if r.error is None
    ]


def compute_aggregate(eval_table: Any, scorer_names: list[str]) -> AggregateResult:
    """Compute mean scores from MLflow evaluation results."""
    metrics = eval_table.metrics
    scorer_means: dict[str, float] = {}

    for name in scorer_names:
        key = f"{name}/score/mean"
        if key in metrics:
            scorer_means[name] = metrics[key]
        else:
            # Try alternate key formats
            for k, v in metrics.items():
                if name in k and "mean" in k:
                    scorer_means[name] = v
                    break

    if not scorer_means:
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

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
    """Run MLflow GenAI evaluation and compute aggregate."""
    eval_data = build_eval_data(results)

    if not eval_data:
        print("ERROR: No successful results to evaluate", file=sys.stderr)
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

    import mlflow.genai
    from scorers import get_scorers, SCORER_NAMES, DETERMINISTIC_SCORER_NAMES

    scorers = get_scorers(mode=mode)
    active_names = DETERMINISTIC_SCORER_NAMES if mode == "ci" else SCORER_NAMES

    eval_result = mlflow.genai.evaluate(
        data=eval_data,
        scorers=scorers,
    )

    return compute_aggregate(eval_result, active_names)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run eval suite for customer-summary")
    parser.add_argument(
        "--mode",
        choices=["full", "ci"],
        default=os.environ.get("EVAL_MODE", "full"),
        help="full: all scorers (requires Ollama). ci: deterministic only (default: full)",
    )
    return parser.parse_args()


def main() -> int:
    """Main entry point. Returns exit code."""
    args = parse_args()
    mode = args.mode

    base_url = os.environ.get("APP_BASE_URL", "http://host.containers.internal:3000")
    cases_path = os.environ.get("EVAL_CASES_PATH", "fixtures/eval/cases.json")
    max_workers = int(os.environ.get("EVAL_WORKERS", "4"))

    print(f"Eval mode: {mode}")
    print(f"Loading eval cases from: {cases_path}")
    cases = load_cases(cases_path)
    print(f"Loaded {len(cases)} eval cases")

    # Validate fixtures exist for grounding scorer
    from scorers import validate_fixtures
    fixture_warnings = validate_fixtures(cases_path)
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

    print(f"Running MLflow GenAI evaluation (mode={mode})...")
    aggregate = run_evaluation(results, mode=mode)

    print(format_results_table(results, aggregate, mode=mode))

    return 0 if aggregate.passed else 1


if __name__ == "__main__":
    sys.exit(main())
