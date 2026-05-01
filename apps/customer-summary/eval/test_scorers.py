"""Tests for Flow Judge scorer parsing, grounding scorer, and scorer registry (no Ollama/MLflow dependency needed)."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from scorers import (
    _parse_score, _parse_feedback, RUBRICS, SCORER_NAMES,
    LLM_SCORER_NAMES, DETERMINISTIC_SCORER_NAMES,
    score_grounding, get_scorers, validate_fixtures, _call_flow_judge,
)


class TestParseScore:
    def test_extracts_score(self):
        assert _parse_score("<feedback>Good job</feedback>\n<score>4</score>") == 4

    def test_extracts_score_with_whitespace(self):
        assert _parse_score("<score> 5 </score>") == 5

    def test_returns_none_on_missing(self):
        assert _parse_score("No score here") is None

    def test_extracts_from_multiline(self):
        text = """<feedback>
The summary covers all key points accurately.
</feedback>
<score>5</score>"""
        assert _parse_score(text) == 5

    def test_clamps_out_of_range_high(self):
        assert _parse_score("<score>10</score>") == 5

    def test_clamps_out_of_range_low(self):
        assert _parse_score("<score>0</score>") == 1


class TestParseFeedback:
    def test_extracts_feedback(self):
        text = "<feedback>The summary is accurate and complete.</feedback>\n<score>5</score>"
        assert _parse_feedback(text) == "The summary is accurate and complete."

    def test_extracts_multiline_feedback(self):
        text = "<feedback>\nLine 1.\nLine 2.\n</feedback>\n<score>4</score>"
        assert "Line 1" in _parse_feedback(text)
        assert "Line 2" in _parse_feedback(text)

    def test_returns_raw_on_missing_tags(self):
        assert _parse_feedback("Just some text") == "Just some text"


class TestRubrics:
    def test_all_llm_scorers_have_rubrics(self):
        for name in LLM_SCORER_NAMES:
            assert name in RUBRICS
            assert "criteria" in RUBRICS[name]
            assert "rubric" in RUBRICS[name]

    def test_rubrics_have_5_scores(self):
        for name in RUBRICS:
            rubric = RUBRICS[name]["rubric"]
            for i in range(1, 6):
                assert f"Score {i}" in rubric

    def test_grounding_in_scorer_names(self):
        assert "grounding" in SCORER_NAMES
        assert "grounding" in DETERMINISTIC_SCORER_NAMES
        assert "grounding" not in LLM_SCORER_NAMES


class TestScorerNames:
    def test_llm_and_deterministic_partition_scorer_names(self):
        """LLM + deterministic should equal all scorer names."""
        assert set(LLM_SCORER_NAMES + DETERMINISTIC_SCORER_NAMES) == set(SCORER_NAMES)


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
        # cust-001 has 2 conversations; claiming 10 triggers penalty (1.5) → score=4
        assert result["score"] <= 4
        assert "conversation_count" in result["justification"]
        assert "FAIL" in result["justification"]

    def test_sentiment_contradiction_penalized(self):
        # cust-004 has strong positive sentiment (3 positive, 0 negative keywords).
        # Claiming negative sentiment should trigger contradiction penalty.
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
        # cust-001 has billing and product conversations, NOT shipping
        result = score_grounding(
            inputs={"customer_id": "cust-001"},
            outputs={"summary": "Customer had major shipping delays and delivery problems."},
            expectations={},
        )
        assert "shipping" in result["justification"].lower() or result["score"] <= 4


class TestGetScorers:
    def test_ci_mode_returns_only_deterministic(self):
        scorers = get_scorers(mode="ci")
        # In CI mode, should only have grounding-related scorer(s)
        assert len(scorers) == len(DETERMINISTIC_SCORER_NAMES)

    def test_full_mode_returns_all(self):
        scorers = get_scorers(mode="full")
        assert len(scorers) == len(SCORER_NAMES)


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


class TestCallFlowJudgeErrorHandling:
    def test_returns_none_score_on_api_failure(self):
        """When Ollama is unreachable, _call_flow_judge should return score=None, not crash."""
        pytest.importorskip("openai", reason="openai SDK not installed")
        import scorers
        # Save original and point at unreachable URL
        orig_client = scorers._client
        orig_url = scorers.OLLAMA_BASE_URL
        try:
            scorers._client = None  # Force re-creation
            scorers.OLLAMA_BASE_URL = "http://localhost:1"  # unreachable
            result = _call_flow_judge(
                output="test summary",
                reference_summary="test ref",
                scorer_name="factuality",
            )
            assert result["score"] is None
            assert "failed" in result["feedback"].lower() or "Flow Judge call failed" in result["feedback"]
        finally:
            scorers._client = orig_client
            scorers.OLLAMA_BASE_URL = orig_url
