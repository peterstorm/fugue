"""
Foundry-native evaluation path for customer-summary.

Mirrors the MLflow path in run.py but scores via Microsoft's
`azure-ai-evaluation` SDK so per-case AND aggregate scores land in the
Foundry Evaluations view. It scores the same eval cases (currently 25), reuses
`build_eval_data` from run.py (so it scores the exact cases the MLflow path
scores) and produces the same `AggregateResult` shape — so run.py's
`format_results_table` and exit-code logic work unchanged — and uses the SAME
Azure OpenAI judge credentials (AZURE_OPENAI_*). Only the scoring call and the
result-shape adapter (its own `compute_aggregate_foundry`) differ.

Scorer name parity with the MLflow path is intentional so per-scorer means
can be compared 1:1 (see parity.py):

    answer_correctness  -> azure SimilarityEvaluator   (response vs. ground truth)
    faithfulness        -> azure GroundednessEvaluator  (response vs. context)
    relevance           -> azure RelevanceEvaluator     (response vs. query)
    grounding           -> deterministic score_grounding (reused from scorers.py)

Test seam: `run_evaluation_foundry` takes an injectable `evaluate_fn`
(defaulting to the real `azure.ai.evaluation.evaluate`, imported lazily so
tests using a fake never require the real package). The fake must return an
EvaluationResult-shaped mapping: `{"metrics": {...}, "rows": [...]}`.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

from run import (
    AggregateResult,
    EvalResult,
    PASS_THRESHOLD,
    build_eval_data,
)
from scorers import (
    DETERMINISTIC_SCORER_NAMES,
    SCORER_NAMES,
    _bridge_azure_env,
    score_grounding,
)


# Map our stable scorer names to azure-ai-evaluation built-in evaluator classes.
# Names are kept identical to the MLflow path so per-scorer parity is 1:1.
FOUNDRY_LLM_EVALUATOR_CLASSES = {
    "answer_correctness": "SimilarityEvaluator",
    "faithfulness": "GroundednessEvaluator",
    "relevance": "RelevanceEvaluator",
}


# --- Pure functions (functional core) ---

def build_foundry_rows(results: list[EvalResult]) -> list[dict[str, str]]:
    """Build the per-case rows the Foundry `evaluate()` consumes.

    Reuses build_eval_data (the shared pure core) so the Foundry path scores
    EXACTLY the cases the MLflow path scores, then renames columns to the
    query/response/context/ground_truth schema azure-ai-evaluation expects.
    """
    frame = build_eval_data(results)
    rows: list[dict[str, str]] = []
    for record in frame.to_dict(orient="records"):
        rows.append({
            "query": record["inputs"],
            "response": record["predictions"],
            "context": record["context"],
            "ground_truth": record["targets"],
            "customer_id": record["customer_id"],
        })
    return rows


def grounding_evaluator(*, query: str = "", response: str = "",
                        context: str = "", ground_truth: str = "",
                        customer_id: str = "", **_: Any) -> dict[str, Any]:
    """Per-row deterministic grounding evaluator (azure-ai-evaluation callable).

    Reuses the exact deterministic semantics of scorers.score_grounding so the
    Foundry `grounding` scorer is identical to the MLflow `grounding` scorer.
    azure-ai-evaluation invokes evaluators per row with keyword args and expects
    a flat dict of metric -> value.
    """
    result = score_grounding(
        inputs={"customer_id": customer_id},
        outputs={"summary": response},
        expectations={"reference_summary": ground_truth},
    )
    return {
        "grounding": float(result["score"]),
        "grounding_reason": result["justification"],
    }


def compute_aggregate_foundry(metrics: dict[str, Any],
                              scorer_names: list[str]) -> AggregateResult:
    """Adapt the Foundry `evaluate()` metrics map into an AggregateResult.

    azure-ai-evaluation aggregates per-evaluator scores under keys shaped like
    `<evaluator_name>.<metric>` (e.g. `relevance.relevance`,
    `grounding.grounding`). We name evaluators after our stable scorer names, so
    we select the mean for each scorer by matching the scorer name in the key.
    Produces the SAME AggregateResult shape as run.compute_aggregate so
    format_results_table and the exit-code logic work unchanged.
    """
    scorer_means: dict[str, float] = {}

    for name in scorer_names:
        # Prefer the canonical `<name>.<name>` mean key azure emits.
        canonical = f"{name}.{name}"
        if canonical in metrics:
            scorer_means[name] = float(metrics[canonical])
            continue
        # Fall back to any aggregate key that mentions the scorer name and is
        # a plain numeric score (skip *_reason / *_threshold / *_result keys).
        for key, value in metrics.items():
            if not key.startswith(f"{name}."):
                continue
            if any(key.endswith(suffix) for suffix in
                   ("_reason", "_threshold", "_result", ".reason")):
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                scorer_means[name] = float(value)
                break

    missing = [name for name in scorer_names if name not in scorer_means]
    if missing:
        # C1: a missing scorer means the SDK output shape did not match what we
        # asked for (renamed/absent keys) — NOT necessarily a low score. Surface
        # it loudly with both the requested-but-missing scorers and the actual
        # metric keys present so a shape mismatch is never silently read as a
        # genuine low/failed score.
        if not scorer_means and metrics:
            # ZERO expected scorers matched but metrics were non-empty: this is
            # an unambiguous contract error, not a low score.
            print(
                "ERROR: Foundry metrics shape mismatch — NONE of the expected "
                f"scorers {scorer_names} matched the SDK output. Actual metric "
                f"keys present: {sorted(metrics.keys())}. Returning a FAILED "
                "aggregate (fail-closed); this is a contract error, not a low "
                "score.",
                file=sys.stderr,
            )
        else:
            print(
                f"WARNING: Foundry metrics missing scorer(s) {missing}; actual "
                f"metric keys present: {sorted(metrics.keys())}. Treating the "
                "missing scorer(s) as a shape mismatch (fail-closed), not a low "
                "score.",
                file=sys.stderr,
            )

    if not scorer_means:
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

    overall_mean = sum(scorer_means.values()) / len(scorer_means)
    return AggregateResult(
        scorer_means=scorer_means,
        overall_mean=overall_mean,
        passed=overall_mean >= PASS_THRESHOLD,
    )


def active_scorer_names(mode: str) -> list[str]:
    """Scorers active for a given mode (ci => deterministic only)."""
    return DETERMINISTIC_SCORER_NAMES if mode == "ci" else SCORER_NAMES


# --- Imperative shell ---

def _azure_model_config() -> Any:
    """Build the AzureOpenAIModelConfiguration from AZURE_OPENAI_* env vars.

    Reuses the existing judge credentials (FR-015). Lazy import keeps the real
    package off the import path for tests that inject a fake evaluate_fn.
    """
    from azure.ai.evaluation import AzureOpenAIModelConfiguration

    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    key = os.environ.get("AZURE_OPENAI_API_KEY")
    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")
    version = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")

    if not endpoint or not key:
        raise RuntimeError(
            "Foundry eval requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY"
        )

    return AzureOpenAIModelConfiguration(
        azure_endpoint=endpoint,
        api_key=key,
        azure_deployment=deployment,
        api_version=version,
    )


def build_evaluators(mode: str) -> dict[str, Callable]:
    """Construct the azure-ai-evaluation evaluators for the given mode.

    Keys are our stable scorer names (parity with the MLflow path). LLM
    evaluators are only built in non-ci mode and reuse the AZURE_OPENAI_* judge
    creds. The deterministic grounding evaluator is always included and needs no
    Azure access. Lazy import isolates the real package from fake-seam tests.
    """
    _bridge_azure_env()
    evaluators: dict[str, Callable] = {"grounding": grounding_evaluator}

    if mode != "ci":
        import azure.ai.evaluation as aieval

        model_config = _azure_model_config()
        for scorer_name, class_name in FOUNDRY_LLM_EVALUATOR_CLASSES.items():
            evaluator_cls = getattr(aieval, class_name)
            evaluators[scorer_name] = evaluator_cls(model_config)

    return evaluators


def _real_evaluate(*, data: str, evaluators: dict[str, Callable],
                   evaluation_name: str) -> dict[str, Any]:
    """Default scoring call: the real azure-ai-evaluation `evaluate`.

    Lazy import so the real package is never required when a fake evaluate_fn
    is injected (tests, and environments without the SDK installed).
    """
    from azure.ai.evaluation import evaluate as azure_evaluate

    return azure_evaluate(
        data=data,
        evaluators=evaluators,
        evaluation_name=evaluation_name,
    )


def _write_jsonl(rows: list[dict[str, Any]]) -> str:
    """Write rows to a temp JSONL file (azure evaluate consumes a data path)."""
    fd, path = tempfile.mkstemp(suffix=".jsonl", prefix="foundry_eval_")
    with os.fdopen(fd, "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return path


def run_evaluation_foundry(
    results: list[EvalResult],
    mode: str,
    evaluate_fn: Optional[Callable[..., dict[str, Any]]] = None,
    evaluators: Optional[dict[str, Callable]] = None,
) -> AggregateResult:
    """Foundry-native evaluation. Same signature/return shape as run_evaluation.

    Records per-case AND aggregate scores via azure-ai-evaluation (visible in
    the Foundry Evaluations view). Returns an AggregateResult identical in shape
    to the MLflow path so format_results_table + exit-code logic are unchanged.

    Args:
        results: collected per-case results (shared with the MLflow path).
        mode: "full" (LLM + deterministic) or "ci" (deterministic only).
        evaluate_fn: test seam; defaults to the real azure-ai-evaluation evaluate.
        evaluators: optional pre-built evaluators (test seam / reuse).
    """
    rows = build_foundry_rows(results)
    if not rows:
        print("ERROR: No successful results to evaluate", file=sys.stderr)
        return AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)

    runner = evaluate_fn or _real_evaluate
    evaluator_map = evaluators if evaluators is not None else build_evaluators(mode)

    data_path = _write_jsonl(rows)
    try:
        outcome = runner(
            data=data_path,
            evaluators=evaluator_map,
            evaluation_name=f"customer-summary-eval-{mode}",
        )
    finally:
        try:
            Path(data_path).unlink()
        except OSError:
            pass

    # C1: do NOT silently coerce an unexpected SDK return into {}. A non-dict
    # return, or a dict missing "metrics", is a SHAPE/contract mismatch — name
    # the actual type/keys on stderr before falling through so it can never be
    # confused with a genuine low score. The verdict stays fail-closed.
    if not isinstance(outcome, dict):
        print(
            "ERROR: Foundry evaluate() returned a non-dict of type "
            f"{type(outcome).__name__!r} (expected an EvaluationResult-shaped "
            "mapping with a 'metrics' key). Treating as a contract error; "
            "returning a FAILED aggregate (fail-closed).",
            file=sys.stderr,
        )
        metrics: dict[str, Any] = {}
    elif "metrics" not in outcome:
        print(
            "ERROR: Foundry evaluate() returned a dict WITHOUT a 'metrics' key "
            f"(actual top-level keys: {sorted(outcome.keys())}). Treating as a "
            "contract error; returning a FAILED aggregate (fail-closed).",
            file=sys.stderr,
        )
        metrics = {}
    else:
        metrics = outcome["metrics"] if isinstance(outcome["metrics"], dict) else {}
        if not isinstance(outcome["metrics"], dict):
            print(
                "ERROR: Foundry evaluate() 'metrics' value is a "
                f"{type(outcome['metrics']).__name__!r}, expected a dict. "
                "Treating as a contract error; returning a FAILED aggregate "
                "(fail-closed).",
                file=sys.stderr,
            )

    return compute_aggregate_foundry(metrics, active_scorer_names(mode))
