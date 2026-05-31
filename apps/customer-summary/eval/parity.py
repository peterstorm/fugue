"""
Eval-backend parity (SC-005).

Pure functions to compare aggregate per-scorer means from the MLflow path and
the Foundry path. The contract: across all cases, the mean per-scorer score
from the Foundry path must be within +/-0.5 (on the 1-5 scale) of the MLflow
path for every scorer.

No I/O — functional core only.
"""

PARITY_TOLERANCE = 0.5


def compute_parity(mlflow_means: dict[str, float],
                   foundry_means: dict[str, float]) -> dict[str, float]:
    """Per-scorer absolute deltas between the two backends' aggregate means.

    Only scorers present in BOTH maps are compared (a scorer scored by one
    backend but not the other has no meaningful delta). Keys are scorer names;
    values are abs(mlflow - foundry).
    """
    shared = set(mlflow_means) & set(foundry_means)
    return {
        name: abs(float(mlflow_means[name]) - float(foundry_means[name]))
        for name in sorted(shared)
    }


def max_parity_delta(deltas: dict[str, float]) -> float:
    """Largest per-scorer abs delta (0.0 when there is nothing to compare)."""
    return max(deltas.values(), default=0.0)


def parity_within_tolerance(deltas: dict[str, float],
                            tol: float = PARITY_TOLERANCE) -> bool:
    """True iff every per-scorer abs delta is within tolerance (<= tol)."""
    return all(delta <= tol for delta in deltas.values())


def format_parity_table(deltas: dict[str, float],
                        tol: float = PARITY_TOLERANCE) -> str:
    """Human-readable parity report."""
    lines = ["=" * 50, "EVAL PARITY (MLflow vs Foundry)", "=" * 50, ""]
    lines.append(f"{'Scorer':<22} {'|delta|':<10} {'Status'}")
    lines.append("-" * 50)
    for name, delta in deltas.items():
        status = "OK" if delta <= tol else "OUT-OF-TOLERANCE"
        lines.append(f"{name:<22} {delta:<10.3f} {status}")
    lines.append("-" * 50)
    verdict = "PASS" if parity_within_tolerance(deltas, tol) else "FAIL"
    lines.append(f"max |delta| = {max_parity_delta(deltas):.3f} "
                 f"(tol={tol}) -> {verdict}")
    lines.append("=" * 50)
    return "\n".join(lines)
