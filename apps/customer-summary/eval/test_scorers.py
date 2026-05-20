"""Tests for scorers: grounding scorer, built-in metrics, and scorer registry."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from scorers import (
    SCORER_NAMES,
    LLM_SCORER_NAMES, DETERMINISTIC_SCORER_NAMES,
    score_grounding, get_scorers, validate_fixtures,
)


class TestScorerNames:
    def test_llm_and_deterministic_partition_scorer_names(self):
        """LLM + deterministic should equal all scorer names."""
        assert set(LLM_SCORER_NAMES + DETERMINISTIC_SCORER_NAMES) == set(SCORER_NAMES)

    def test_llm_scorers_are_builtin(self):
        assert "answer_correctness" in LLM_SCORER_NAMES
        assert "faithfulness" in LLM_SCORER_NAMES
        assert "relevance" in LLM_SCORER_NAMES

    def test_grounding_in_deterministic(self):
        assert "grounding" in SCORER_NAMES
        assert "grounding" in DETERMINISTIC_SCORER_NAMES
        assert "grounding" not in LLM_SCORER_NAMES


class TestGroundingScorer:
    """Tests for the deterministic grounding scorer."""

    def test_grounded_summary_scores_high(self):
        result = score_grounding(
            inputs={"customer_id": "cust-001"},
            outputs={"summary": "Customer had billing inquiry about invoice charges."},
            expectations={},
        )
        assert result["score"] >= 4
        assert "PASS" in result["justification"]

    def test_wrong_conversation_count_penalized(self):
        result = score_grounding(
            inputs={"customer_id": "cust-001"},
            outputs={"summary": "Across 10 conversations, the customer discussed billing."},
            expectations={},
        )
        assert result["score"] <= 4
        assert "conversation_count" in result["justification"]
        assert "FAIL" in result["justification"]

    def test_sentiment_contradiction_penalized(self):
        result = score_grounding(
            inputs={"customer_id": "cust-004"},
            outputs={"summary": "Negative sentiment. The customer is dissatisfied and frustrated with the service."},
            expectations={},
        )
        assert result["score"] < 5
        assert "sentiment_consistency" in result["justification"]
        assert "FAIL" in result["justification"]

    def test_missing_fixture_returns_neutral(self):
        result = score_grounding(
            inputs={"customer_id": "nonexistent-999"},
            outputs={"summary": "Some summary."},
            expectations={},
        )
        assert result["score"] == 3
        assert "Could not load fixture" in result["justification"]

    def test_ungrounded_topic_penalized(self):
        result = score_grounding(
            inputs={"customer_id": "cust-001"},
            outputs={"summary": "Customer had major shipping delays and delivery problems."},
            expectations={},
        )
        assert "shipping" in result["justification"].lower() or result["score"] <= 4


class TestGetScorers:
    def test_ci_mode_returns_only_deterministic(self):
        scorers = get_scorers(mode="ci")
        assert len(scorers) == len(DETERMINISTIC_SCORER_NAMES)

    def test_full_mode_returns_all(self):
        scorers = get_scorers(mode="full")
        assert len(scorers) == len(SCORER_NAMES)

    def test_full_mode_scorer_names(self):
        scorers = get_scorers(mode="full")
        names = [s.name for s in scorers]
        for expected in SCORER_NAMES:
            assert expected in names


class TestValidateFixtures:
    def test_existing_fixtures_no_warnings(self):
        warnings = validate_fixtures(["cust-001", "cust-002"])
        assert warnings == []

    def test_missing_fixture_returns_warning(self):
        warnings = validate_fixtures(["nonexistent-999"])
        assert len(warnings) == 1
        assert "nonexistent-999" in warnings[0]

    def test_empty_list(self):
        assert validate_fixtures([]) == []
