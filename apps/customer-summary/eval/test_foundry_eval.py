"""Tests for the Foundry-native eval path (FR-013/014/015/016, SC-002).

A FAKE azure-ai-evaluation `evaluate` is injected via the `evaluate_fn` seam,
so NO live Azure/network is touched. We verify:
  - EvalResults are mapped to the query/response/context/ground_truth rows the
    SDK consumes, covering ALL successful cases (SC-002: 100% scored).
  - The deterministic grounding evaluator reuses score_grounding semantics.
  - The metrics map is adapted into an AggregateResult of the correct shape.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

import pytest

from run import EvalResult, AggregateResult
import foundry_eval
from foundry_eval import (
    build_foundry_rows,
    compute_aggregate_foundry,
    grounding_evaluator,
    run_evaluation_foundry,
    active_scorer_names,
)


def _three_results():
    return [
        EvalResult(customer_id="cust-001", summary="Billing inquiry about invoice.", reference_summary="ref-1"),
        EvalResult(customer_id="cust-002", summary="Technical login error.", reference_summary="ref-2"),
        EvalResult(customer_id="cust-003", summary="Shipping delay reported.", reference_summary="ref-3"),
    ]


class TestBuildFoundryRows:
    def test_maps_columns_to_sdk_schema(self):
        rows = build_foundry_rows([
            EvalResult(customer_id="c1", summary="the summary", reference_summary="the ref"),
        ])
        assert len(rows) == 1
        r = rows[0]
        assert r["response"] == "the summary"
        assert r["ground_truth"] == "the ref"
        assert r["context"] == "the ref"
        assert r["customer_id"] == "c1"
        assert "Summarize" in r["query"]

    def test_scores_all_successful_cases(self):
        rows = build_foundry_rows(_three_results())
        assert len(rows) == 3  # SC-002: 100% of valid cases mapped
        assert {r["customer_id"] for r in rows} == {"cust-001", "cust-002", "cust-003"}

    def test_filters_errored_cases(self):
        rows = build_foundry_rows([
            EvalResult(customer_id="ok", summary="s", reference_summary="r"),
            EvalResult(customer_id="bad", summary="", reference_summary="r", error="boom"),
        ])
        assert len(rows) == 1
        assert rows[0]["customer_id"] == "ok"


class TestGroundingEvaluator:
    def test_reuses_score_grounding_semantics(self):
        out = grounding_evaluator(
            customer_id="cust-001",
            response="Customer had billing inquiry about invoice charges.",
            ground_truth="ref",
        )
        assert "grounding" in out
        assert isinstance(out["grounding"], float)
        assert out["grounding"] >= 4.0
        assert "grounding_reason" in out

    def test_missing_fixture_returns_neutral(self):
        out = grounding_evaluator(customer_id="nonexistent-999", response="x", ground_truth="r")
        assert out["grounding"] == 3.0


class TestActiveScorerNames:
    def test_ci_is_deterministic_only(self):
        assert active_scorer_names("ci") == ["grounding"]

    def test_full_is_all_scorers(self):
        names = active_scorer_names("full")
        assert "grounding" in names
        assert "relevance" in names
        assert "answer_correctness" in names
        assert "faithfulness" in names


class TestComputeAggregateFoundry:
    def test_canonical_keys(self):
        metrics = {
            "answer_correctness.answer_correctness": 4.5,
            "faithfulness.faithfulness": 4.0,
            "relevance.relevance": 5.0,
            "grounding.grounding": 4.5,
        }
        agg = compute_aggregate_foundry(
            metrics, ["answer_correctness", "faithfulness", "relevance", "grounding"]
        )
        assert agg.scorer_means["relevance"] == 5.0
        assert agg.overall_mean == pytest.approx(4.5)
        assert agg.passed is True

    def test_ignores_reason_and_threshold_keys(self):
        # Force the NON-canonical fallback path by OMITTING the canonical
        # `grounding.grounding` key — otherwise the canonical branch short-
        # circuits and the reason/threshold filtering is never exercised (the
        # old version was a tautology). The fallback must pick the numeric score
        # and skip *_reason / *_threshold keys.
        metrics = {
            "grounding.grounding_reason": "because",
            "grounding.grounding_threshold": 3.0,
            "grounding.grounding_score": 4.5,
        }
        agg = compute_aggregate_foundry(metrics, ["grounding"])
        assert agg.scorer_means == {"grounding": 4.5}
        assert agg.overall_mean == pytest.approx(4.5)

    def test_fallback_picks_score_over_reason_sibling(self):
        # A scorer present ONLY via a non-`<name>.<name>` key (e.g.
        # `relevance.relevance_score`) with a sibling `relevance.relevance_reason`.
        # Fallback must pick the numeric score and skip the reason string.
        metrics = {
            "relevance.relevance_reason": "the response is on-topic",
            "relevance.relevance_score": 4.7,
        }
        agg = compute_aggregate_foundry(metrics, ["relevance"])
        assert agg.scorer_means == {"relevance": 4.7}
        assert agg.overall_mean == pytest.approx(4.7)

    def test_missing_scorer_warns_and_fails_closed(self, capsys):
        # Requested scorers absent from the matched means => shape mismatch.
        # Must emit a stderr WARNING naming the missing scorer(s) AND the actual
        # keys present, and fail-closed (not silently read as a low score).
        metrics = {"grounding.grounding": 4.5}
        agg = compute_aggregate_foundry(
            metrics, ["answer_correctness", "faithfulness", "relevance", "grounding"]
        )
        err = capsys.readouterr().err
        assert "WARNING" in err
        assert "answer_correctness" in err
        assert "grounding.grounding" in err  # actual keys present surfaced
        # grounding still scored; the present scorer is honored.
        assert agg.scorer_means == {"grounding": 4.5}

    def test_zero_expected_matched_but_metrics_nonempty_is_contract_error(self, capsys):
        # NONE of the requested scorers matched but metrics non-empty: an
        # unambiguous contract error logged loudly; failed aggregate returned.
        metrics = {"some_renamed.metric": 4.9, "another.key": 5.0}
        agg = compute_aggregate_foundry(metrics, ["relevance", "grounding"])
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "some_renamed.metric" in err or "another.key" in err
        assert agg.passed is False
        assert agg.scorer_means == {}

    def test_below_threshold_fails(self):
        metrics = {"grounding.grounding": 3.0}
        agg = compute_aggregate_foundry(metrics, ["grounding"])
        assert agg.passed is False

    def test_empty_metrics(self):
        agg = compute_aggregate_foundry({}, ["relevance"])
        assert agg == AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)


class TestRunEvaluationFoundryWithFake:
    """End-to-end Foundry path using a FAKE evaluate_fn (no live Azure)."""

    def test_produces_aggregate_of_correct_shape(self):
        captured = {}

        def fake_evaluate(*, data, evaluators, evaluation_name):
            # data is a JSONL path the adapter wrote; read it back to assert
            # all cases were handed to the SDK.
            with open(data) as fh:
                lines = [json.loads(line) for line in fh if line.strip()]
            captured["rows"] = lines
            captured["evaluation_name"] = evaluation_name
            captured["evaluator_keys"] = sorted(evaluators.keys())
            return {
                "metrics": {
                    "answer_correctness.answer_correctness": 4.2,
                    "faithfulness.faithfulness": 4.6,
                    "relevance.relevance": 4.8,
                    "grounding.grounding": 4.4,
                },
                "rows": lines,
            }

        evaluators = {
            "answer_correctness": lambda **k: {},
            "faithfulness": lambda **k: {},
            "relevance": lambda **k: {},
            "grounding": grounding_evaluator,
        }

        agg = run_evaluation_foundry(
            _three_results(), mode="full",
            evaluate_fn=fake_evaluate, evaluators=evaluators,
        )

        assert isinstance(agg, AggregateResult)
        assert len(captured["rows"]) == 3  # SC-002
        assert "customer-summary-eval-full" == captured["evaluation_name"]
        assert set(agg.scorer_means.keys()) == {
            "answer_correctness", "faithfulness", "relevance", "grounding"
        }
        assert agg.overall_mean == pytest.approx((4.2 + 4.6 + 4.8 + 4.4) / 4)
        assert agg.passed is True

    def test_ci_mode_scores_grounding_only(self):
        def fake_evaluate(*, data, evaluators, evaluation_name):
            return {"metrics": {"grounding.grounding": 4.5}, "rows": []}

        agg = run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        assert agg.scorer_means == {"grounding": 4.5}
        assert agg.passed is True

    def test_no_results_returns_failed_aggregate(self):
        def fake_evaluate(*, data, evaluators, evaluation_name):
            raise AssertionError("evaluate_fn must not be called with no rows")

        agg = run_evaluation_foundry(
            [EvalResult(customer_id="x", summary="", reference_summary="r", error="boom")],
            mode="ci", evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        assert agg.passed is False
        assert agg.scorer_means == {}

    def test_non_dict_sdk_return_is_contract_error(self, capsys):
        # C1: a non-dict SDK return must NOT be silently coerced to {} and read
        # as a low score — it must surface a clear ERROR naming the actual type
        # and fail-closed.
        def fake_evaluate(*, data, evaluators, evaluation_name):
            return None  # unexpected: not a dict

        agg = run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "non-dict" in err
        assert "NoneType" in err
        assert agg.passed is False
        assert agg.scorer_means == {}

    def test_dict_without_metrics_key_is_contract_error(self, capsys):
        # C1: a dict missing "metrics" is a shape mismatch — surface the actual
        # top-level keys on stderr and fail-closed.
        def fake_evaluate(*, data, evaluators, evaluation_name):
            return {"rows": [], "studio_url": "https://x"}  # no "metrics"

        agg = run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "metrics" in err
        assert "studio_url" in err  # actual keys surfaced
        assert agg.passed is False
        assert agg.scorer_means == {}

    def test_metrics_value_not_a_dict_is_contract_error(self, capsys):
        # C1: a dict WITH a "metrics" key whose VALUE is not a dict is a shape
        # mismatch — must surface an ERROR and fail-closed, never be read as a
        # genuine low score. Exercises foundry_eval.py:310-318.
        def fake_evaluate(*, data, evaluators, evaluation_name):
            return {"metrics": "not-a-dict"}

        agg = run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "metrics" in err
        assert agg.passed is False
        assert agg.scorer_means == {}

    def test_temp_data_file_is_cleaned_up(self):
        seen_path = {}

        def fake_evaluate(*, data, evaluators, evaluation_name):
            seen_path["path"] = data
            assert os.path.exists(data)
            return {"metrics": {"grounding.grounding": 5.0}, "rows": []}

        run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        assert not os.path.exists(seen_path["path"])  # cleaned up

    def test_fewer_rows_returned_than_submitted_warns(self, capsys):
        # Fix 5: if evaluate() returns fewer per-row results than submitted, some
        # rows errored/were dropped and are silently averaged into the aggregate.
        # Must emit a WARNING naming the drop count — additive, does NOT change
        # the verdict (the aggregate still comes from the metrics map).
        def fake_evaluate(*, data, evaluators, evaluation_name):
            # 3 rows submitted (_three_results), only 1 row comes back.
            return {"metrics": {"grounding.grounding": 5.0}, "rows": [{"grounding": 5.0}]}

        agg = run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        err = capsys.readouterr().err
        assert "WARNING" in err
        assert "1 per-row" in err      # returned count surfaced
        assert "3 row(s) were submitted" in err
        assert "2 row(s) were dropped" in err  # submitted - returned
        # Verdict still derives from the metrics map, unaffected by the warning.
        assert agg.scorer_means == {"grounding": 5.0}
        assert agg.passed is True

    def test_equal_rows_returned_does_not_warn(self, capsys):
        # Boundary: returned == submitted must NOT warn (no drop).
        def fake_evaluate(*, data, evaluators, evaluation_name):
            return {
                "metrics": {"grounding.grounding": 5.0},
                "rows": [{"grounding": 5.0}, {"grounding": 5.0}, {"grounding": 5.0}],
            }

        run_evaluation_foundry(
            _three_results(), mode="ci",
            evaluate_fn=fake_evaluate, evaluators={"grounding": grounding_evaluator},
        )
        err = capsys.readouterr().err
        assert "were dropped" not in err
