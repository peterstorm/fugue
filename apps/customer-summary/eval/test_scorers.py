"""Tests for Flow Judge scorer parsing (no Ollama/MLflow dependency needed)."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from scorers import _parse_score, _parse_feedback, RUBRICS, SCORER_NAMES


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
    def test_all_scorers_have_rubrics(self):
        for name in SCORER_NAMES:
            assert name in RUBRICS
            assert "criteria" in RUBRICS[name]
            assert "rubric" in RUBRICS[name]

    def test_rubrics_have_5_scores(self):
        for name in SCORER_NAMES:
            rubric = RUBRICS[name]["rubric"]
            for i in range(1, 6):
                assert f"Score {i}" in rubric
