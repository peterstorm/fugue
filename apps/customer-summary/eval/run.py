#!/usr/bin/env python3
"""
Eval sidecar for customer-summary service.

Loads eval cases, calls the summarize endpoint, and evaluates responses
using MLflow GenAI scorers (factuality, completeness, conciseness).

Exits with code 1 if aggregate mean score < 4.0.

Env vars:
  APP_BASE_URL        - Base URL of the summary service (default: http://host.containers.internal:3000)
  MLFLOW_TRACKING_URI - MLflow tracking server URI
  ANTHROPIC_API_KEY   - API key for Claude judge model
  EVAL_CASES_PATH     - Path to eval cases JSON (default: fixtures/eval/cases.json)
"""

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import requests


SCORER_NAMES = ["factuality", "completeness", "conciseness", "grounding"]
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


def format_results_table(results: list[EvalResult], aggregate: AggregateResult) -> str:
    """Format results as a human-readable table."""
    lines = []
    lines.append("=" * 70)
    lines.append("EVAL RESULTS")
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

    verdict = "PASS ✓" if aggregate.passed else f"FAIL ✗ (threshold: {PASS_THRESHOLD})"
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
    url = f"{base_url.rstrip('/')}/summarize"
    try:
        resp = requests.post(url, json={"customer_id": customer_id}, timeout=60)
        resp.raise_for_status()
        body = resp.json()
        # Response shape: { status: "ok", customerId, summary: { summary: "...", keyTopics, ... } }
        if body.get("status") != "ok":
            return EvalResult(
                customer_id=customer_id,
                summary="",
                reference_summary="",
                error=f"Non-ok status: {body.get('status')}: {body.get('message', '')}",
            )
        summary_obj = body.get("summary", {})
        # Extract the text summary from the nested object
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


def collect_results(base_url: str, cases: list[EvalCase]) -> list[EvalResult]:
    """Call summarize for each case and attach reference summaries."""
    results = []
    for case in cases:
        result = call_summarize(base_url, case.customer_id)
        # Attach reference summary from the case
        results.append(EvalResult(
            customer_id=result.customer_id,
            summary=result.summary,
            reference_summary=case.reference_summary,
            error=result.error,
        ))
    return results


def run_evaluation(results: list[EvalResult]) -> AggregateResult:
    """Run MLflow GenAI evaluation and compute aggregate."""
    eval_data = build_eval_data(results)

    if not eval_data:
        print("ERROR: No successful results to evaluate", file=sys.stderr)
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

    import mlflow.genai
    from scorers import get_scorers, SCORER_NAMES

    eval_result = mlflow.genai.evaluate(
        data=eval_data,
        scorers=get_scorers(),
    )

    return compute_aggregate(eval_result, SCORER_NAMES)


def main() -> int:
    """Main entry point. Returns exit code."""
    base_url = os.environ.get("APP_BASE_URL", "http://host.containers.internal:3000")
    cases_path = os.environ.get("EVAL_CASES_PATH", "fixtures/eval/cases.json")

    print(f"Loading eval cases from: {cases_path}")
    cases = load_cases(cases_path)
    print(f"Loaded {len(cases)} eval cases")

    print(f"Calling summarize endpoint at: {base_url}")
    results = collect_results(base_url, cases)

    errors = [r for r in results if r.error]
    if errors:
        print(f"WARNING: {len(errors)} cases failed:", file=sys.stderr)
        for r in errors:
            print(f"  {r.customer_id}: {r.error}", file=sys.stderr)

    print("Running MLflow GenAI evaluation...")
    aggregate = run_evaluation(results)

    print(format_results_table(results, aggregate))

    return 0 if aggregate.passed else 1


if __name__ == "__main__":
    sys.exit(main())
