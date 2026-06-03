"""Tests for eval-backend parity math (SC-005, FR-017). Pure, no I/O."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

import pytest

from parity import (
    compute_parity,
    max_parity_delta,
    parity_within_tolerance,
    format_parity_table,
    PARITY_TOLERANCE,
)


class TestComputeParity:
    def test_per_scorer_abs_deltas(self):
        mlflow = {"relevance": 4.5, "grounding": 4.0}
        foundry = {"relevance": 4.2, "grounding": 4.6}
        deltas = compute_parity(mlflow, foundry)
        assert deltas["relevance"] == pytest.approx(0.3)
        assert deltas["grounding"] == pytest.approx(0.6)

    def test_only_shared_scorers_compared(self):
        mlflow = {"relevance": 4.5, "faithfulness": 4.0}
        foundry = {"relevance": 4.4, "answer_correctness": 3.9}
        deltas = compute_parity(mlflow, foundry)
        assert set(deltas.keys()) == {"relevance"}

    def test_identical_means_zero_delta(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.0})
        assert deltas["relevance"] == 0.0


class TestToleranceBoundary:
    def test_passes_at_exact_tolerance(self):
        """Boundary: delta == 0.5 is within tolerance (<=)."""
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.5})
        assert deltas["relevance"] == pytest.approx(0.5)
        assert parity_within_tolerance(deltas) is True

    def test_passes_just_under_tolerance(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.49})
        assert parity_within_tolerance(deltas) is True

    def test_fails_just_over_tolerance(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.51})
        assert parity_within_tolerance(deltas) is False

    def test_fails_when_any_scorer_out_of_tolerance(self):
        mlflow = {"relevance": 4.5, "grounding": 4.0}
        foundry = {"relevance": 4.5, "grounding": 3.0}  # delta 1.0
        deltas = compute_parity(mlflow, foundry)
        assert parity_within_tolerance(deltas) is False

    def test_custom_tolerance(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.3})
        assert parity_within_tolerance(deltas, tol=0.2) is False
        assert parity_within_tolerance(deltas, tol=0.4) is True

    def test_nan_scorer_mean_fails_closed(self):
        # A NaN mean from one backend yields a NaN delta, and `nan <= tol` is
        # False, so parity FAILS closed rather than vacuously passing. Consistent
        # with the eval pipeline's fail-closed posture elsewhere.
        nan = float("nan")
        deltas = compute_parity({"relevance": 4.0}, {"relevance": nan})
        assert deltas["relevance"] != deltas["relevance"]  # NaN: not equal to itself
        assert parity_within_tolerance(deltas) is False

    def test_default_tolerance_is_half_point(self):
        assert PARITY_TOLERANCE == 0.5


class TestMaxParityDelta:
    def test_returns_largest(self):
        deltas = {"a": 0.1, "b": 0.4, "c": 0.2}
        assert max_parity_delta(deltas) == pytest.approx(0.4)

    def test_empty_is_zero(self):
        assert max_parity_delta({}) == 0.0

    def test_empty_deltas_within_tolerance(self):
        assert parity_within_tolerance({}) is True


class TestFormatParityTable:
    def test_reports_pass(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.2})
        table = format_parity_table(deltas)
        assert "relevance" in table
        assert "PASS" in table

    def test_reports_fail(self):
        deltas = compute_parity({"relevance": 4.0}, {"relevance": 4.9})
        table = format_parity_table(deltas)
        assert "FAIL" in table
        assert "OUT-OF-TOLERANCE" in table
