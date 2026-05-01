"""Tests for pure functions in run.py (no mlflow dependency needed)."""
import pytest
import sys
import os

# Add eval dir to path so we can import run module
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from run import (
    parse_cases, build_eval_data, format_results_table, compute_aggregate,
    EvalCase, EvalResult, AggregateResult, collect_results,
)


class TestParseCases:
    def test_valid_cases(self):
        raw = [
            {"customer_id": "c1", "reference_summary": "summary1"},
            {"customer_id": "c2", "reference_summary": "summary2"},
        ]
        cases = parse_cases(raw)
        assert len(cases) == 2
        assert cases[0].customer_id == "c1"
        assert cases[1].reference_summary == "summary2"

    def test_missing_field_raises(self):
        with pytest.raises(ValueError, match="missing required fields"):
            parse_cases([{"customer_id": "c1"}])

    def test_empty_list(self):
        assert parse_cases([]) == []

    def test_immutability(self):
        cases = parse_cases([{"customer_id": "c1", "reference_summary": "s"}])
        with pytest.raises(AttributeError):
            cases[0].customer_id = "changed"


class TestBuildEvalData:
    def test_builds_correct_structure(self):
        results = [
            EvalResult(customer_id="c1", summary="text1", reference_summary="ref1"),
        ]
        data = build_eval_data(results)
        assert len(data) == 1
        assert data[0]["inputs"] == {"customer_id": "c1"}
        assert data[0]["outputs"] == {"summary": "text1"}
        assert data[0]["expectations"] == {"reference_summary": "ref1"}

    def test_filters_errors(self):
        results = [
            EvalResult(customer_id="c1", summary="ok", reference_summary="ref1"),
            EvalResult(customer_id="c2", summary="", reference_summary="ref2", error="failed"),
        ]
        data = build_eval_data(results)
        assert len(data) == 1
        assert data[0]["inputs"]["customer_id"] == "c1"


class TestFormatResultsTable:
    def test_contains_key_info(self):
        results = [EvalResult(customer_id="c1", summary="some summary", reference_summary="ref")]
        agg = AggregateResult(scorer_means={"factuality": 4.5}, overall_mean=4.5, passed=True)
        table = format_results_table(results, agg, mode="full")
        assert "c1" in table
        assert "4.50" in table
        assert "PASS" in table

    def test_fail_verdict(self):
        agg = AggregateResult(scorer_means={"factuality": 3.0}, overall_mean=3.0, passed=False)
        table = format_results_table([], agg, mode="full")
        assert "FAIL" in table

    def test_mode_displayed(self):
        agg = AggregateResult(scorer_means={}, overall_mean=0.0, passed=False)
        table = format_results_table([], agg, mode="ci")
        assert "mode=ci" in table


class TestComputeAggregate:
    def test_from_known_values(self):
        class FakeResult:
            metrics = {
                "factuality/score/mean": 4.5,
                "completeness/score/mean": 4.0,
                "conciseness/score/mean": 5.0,
                "grounding/score/mean": 4.5,
            }

        agg = compute_aggregate(FakeResult(), ["factuality", "completeness", "conciseness", "grounding"])
        assert agg.overall_mean == pytest.approx(4.5)
        assert agg.passed is True

    def test_below_threshold(self):
        class FakeResult:
            metrics = {
                "factuality/score/mean": 3.0,
                "completeness/score/mean": 3.0,
                "conciseness/score/mean": 3.0,
                "grounding/score/mean": 3.0,
            }

        agg = compute_aggregate(FakeResult(), ["factuality", "completeness", "conciseness", "grounding"])
        assert agg.overall_mean == pytest.approx(3.0)
        assert agg.passed is False

    def test_ci_mode_grounding_only(self):
        class FakeResult:
            metrics = {"grounding/score/mean": 4.5}

        agg = compute_aggregate(FakeResult(), ["grounding"])
        assert agg.overall_mean == pytest.approx(4.5)
        assert agg.passed is True

    def test_empty_metrics(self):
        class FakeResult:
            metrics = {}

        agg = compute_aggregate(FakeResult(), ["factuality"])
        assert agg.overall_mean == 0.0
        assert agg.passed is False


class TestCollectResults:
    def test_attaches_reference_summaries(self):
        """collect_results should attach reference_summary from cases to results."""
        from unittest.mock import patch

        cases = [
            EvalCase(customer_id="c1", reference_summary="ref1"),
            EvalCase(customer_id="c2", reference_summary="ref2"),
        ]

        def fake_summarize(base_url, customer_id):
            return EvalResult(customer_id=customer_id, summary=f"summary-{customer_id}", reference_summary="")

        with patch("run.call_summarize", side_effect=fake_summarize):
            results = collect_results("http://fake", cases, max_workers=1)

        assert len(results) == 2
        # Results are sorted by customer_id
        assert results[0].customer_id == "c1"
        assert results[0].reference_summary == "ref1"
        assert results[0].summary == "summary-c1"
        assert results[1].customer_id == "c2"
        assert results[1].reference_summary == "ref2"

    def test_handles_exception_from_future(self):
        """If call_summarize raises, collect_results should capture the error."""
        from unittest.mock import patch

        cases = [EvalCase(customer_id="c1", reference_summary="ref1")]

        def exploding_summarize(base_url, customer_id):
            raise ConnectionError("server down")

        with patch("run.call_summarize", side_effect=exploding_summarize):
            results = collect_results("http://fake", cases, max_workers=1)

        assert len(results) == 1
        assert results[0].error is not None
        assert "server down" in results[0].error
