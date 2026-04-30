"""Tests for Flow Judge scorer parsing and grounding scorer (no Ollama/MLflow dependency needed)."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from scorers import _parse_score, _parse_feedback, RUBRICS, SCORER_NAMES, score_grounding


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
        llm_scorers = [n for n in SCORER_NAMES if n != "grounding"]
        for name in llm_scorers:
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
        assert result["score"] < 4
        assert "conversation_count" in result["justification"]
        assert "FAIL" in result["justification"]

    def test_sentiment_contradiction_penalized(self):
        # cust-011 is a frustrated customer with outages
        result = score_grounding(
            inputs={"customer_id": "cust-011"},
            outputs={"summary": "Generally positive sentiment. The customer is very satisfied and happy with the service."},
            expectations={},
        )
        assert result["score"] < 4

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
