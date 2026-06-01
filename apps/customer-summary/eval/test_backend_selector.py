"""Tests for the --backend / EVAL_BACKEND run-time selector (FR-004, FR-005, SC-003).

No live Azure/network. We only exercise argparse precedence and the main()
branch dispatch via monkeypatched, in-process fakes.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

import run
from run import AggregateResult, EvalResult, parse_args


class TestBackendSelector:
    def test_default_is_mlflow(self, monkeypatch):
        monkeypatch.delenv("EVAL_BACKEND", raising=False)
        monkeypatch.setattr(sys, "argv", ["run.py"])
        args = parse_args()
        assert args.backend == "mlflow"

    def test_env_selects_foundry(self, monkeypatch):
        monkeypatch.setenv("EVAL_BACKEND", "foundry")
        monkeypatch.setattr(sys, "argv", ["run.py"])
        args = parse_args()
        assert args.backend == "foundry"

    def test_cli_flag_overrides_env(self, monkeypatch):
        """CLI flag wins over env (FR-004 precedence)."""
        monkeypatch.setenv("EVAL_BACKEND", "foundry")
        monkeypatch.setattr(sys, "argv", ["run.py", "--backend=mlflow"])
        args = parse_args()
        assert args.backend == "mlflow"

    def test_cli_flag_selects_foundry_over_default_env(self, monkeypatch):
        monkeypatch.delenv("EVAL_BACKEND", raising=False)
        monkeypatch.setattr(sys, "argv", ["run.py", "--backend=foundry"])
        args = parse_args()
        assert args.backend == "foundry"

    def test_invalid_backend_rejected(self, monkeypatch):
        monkeypatch.delenv("EVAL_BACKEND", raising=False)
        monkeypatch.setattr(sys, "argv", ["run.py", "--backend=bogus"])
        try:
            parse_args()
            assert False, "expected SystemExit for invalid backend"
        except SystemExit:
            pass

    def test_env_default_bypasses_argparse_choices(self, monkeypatch):
        """C2: argparse `choices` does NOT validate the env-provided default, so
        a typo'd EVAL_BACKEND survives parse_args() — main() must catch it."""
        monkeypatch.setenv("EVAL_BACKEND", "foundryy")
        monkeypatch.setattr(sys, "argv", ["run.py"])
        args = parse_args()
        # argparse accepted the bogus default unchanged (the whole point of C2).
        assert args.backend == "foundryy"


class TestBogusEnvFailsLoud:
    """C2: a bogus EVAL_BACKEND must fail loud in main(), NOT silently run mlflow."""

    def test_bogus_env_exits_nonzero_without_running_mlflow(self, monkeypatch, capsys):
        import scorers
        import foundry_eval

        called = {"foundry": False, "mlflow": False, "collect": False}

        monkeypatch.setattr(run, "load_cases", lambda path: [EvalCase_stub()])
        monkeypatch.setattr(scorers, "validate_fixtures", lambda ids: [])

        def fake_collect(base_url, cs, max_workers=4):
            called["collect"] = True
            return [EvalResult(customer_id="c1", summary="s", reference_summary="r")]

        monkeypatch.setattr(run, "collect_results", fake_collect)
        monkeypatch.setattr(
            run, "run_evaluation",
            lambda results, mode: called.__setitem__("mlflow", True),
        )
        monkeypatch.setattr(
            foundry_eval, "run_evaluation_foundry",
            lambda results, mode: called.__setitem__("foundry", True),
        )

        monkeypatch.setenv("EVAL_BACKEND", "foundryy")  # typo
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=ci"])

        rc = run.main()
        assert rc == 1
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "foundryy" in err
        assert "mlflow|foundry|both" in err
        # MUST fail before ever dispatching to a backend.
        assert called["mlflow"] is False
        assert called["foundry"] is False


class TestMainDispatch:
    """main() must dispatch to the chosen backend and NOT touch the other path."""

    def _stub_pipeline(self, monkeypatch):
        import scorers
        cases = [EvalCase_stub()]
        monkeypatch.setattr(run, "load_cases", lambda path: cases)
        # main() does `from scorers import validate_fixtures` -> patch the source.
        monkeypatch.setattr(scorers, "validate_fixtures", lambda ids: [])
        monkeypatch.setattr(
            run, "collect_results",
            lambda base_url, cs, max_workers=4: [
                EvalResult(customer_id="c1", summary="s", reference_summary="r")
            ],
        )

    def test_foundry_backend_calls_foundry_only(self, monkeypatch):
        self._stub_pipeline(monkeypatch)
        passing = AggregateResult(scorer_means={"grounding": 5.0}, overall_mean=5.0, passed=True)

        called = {"foundry": False, "mlflow": False}

        def fake_foundry(results, mode):
            called["foundry"] = True
            return passing

        def fake_mlflow(results, mode):
            called["mlflow"] = True
            return passing

        # Patch the dispatch SEAM main() actually calls (run_foundry_backend /
        # run_mlflow_backend), not the inner run_evaluation* functions — same
        # boundary the `both` tests patch. This tests the real dispatch and is
        # robust to the wrappers being refactored.
        monkeypatch.setattr(run, "run_foundry_backend", fake_foundry)
        monkeypatch.setattr(run, "run_mlflow_backend", fake_mlflow)
        monkeypatch.setenv("EVAL_BACKEND", "foundry")
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=ci"])

        rc = run.main()
        assert rc == 0
        assert called["foundry"] is True
        assert called["mlflow"] is False

    def test_mlflow_backend_calls_mlflow_only(self, monkeypatch):
        self._stub_pipeline(monkeypatch)
        passing = AggregateResult(scorer_means={"grounding": 5.0}, overall_mean=5.0, passed=True)
        called = {"foundry": False, "mlflow": False}

        def fake_foundry(results, mode):
            called["foundry"] = True
            return passing

        def fake_mlflow(results, mode):
            called["mlflow"] = True
            return passing

        # Patch the dispatch seam. Replacing run_mlflow_backend also removes the
        # need to fake the `mlflow` module (the real wrapper's `import mlflow` +
        # set_experiment never runs), so the test exercises pure dispatch.
        monkeypatch.setattr(run, "run_foundry_backend", fake_foundry)
        monkeypatch.setattr(run, "run_mlflow_backend", fake_mlflow)
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=ci", "--backend=mlflow"])
        monkeypatch.delenv("EVAL_BACKEND", raising=False)

        rc = run.main()
        assert rc == 0
        assert called["mlflow"] is True
        assert called["foundry"] is False


class TestBothBackendDispatch:
    """`--backend=both` (and EVAL_BACKEND=both) runs BOTH paths and enforces
    parity (SC-005). Uses fakes for both backends — no live Azure/network."""

    def _stub_pipeline(self, monkeypatch):
        import scorers
        monkeypatch.setattr(run, "load_cases", lambda path: [EvalCase_stub()])
        monkeypatch.setattr(scorers, "validate_fixtures", lambda ids: [])
        monkeypatch.setattr(
            run, "collect_results",
            lambda base_url, cs, max_workers=4: [
                EvalResult(customer_id="c1", summary="s", reference_summary="r")
            ],
        )

    def _patch_backends(self, monkeypatch, mlflow_agg, foundry_agg, called):
        def fake_mlflow(results, mode):
            called["mlflow"] = True
            return mlflow_agg

        def fake_foundry(results, mode):
            called["foundry"] = True
            return foundry_agg

        monkeypatch.setattr(run, "run_mlflow_backend", fake_mlflow)
        monkeypatch.setattr(run, "run_foundry_backend", fake_foundry)

    def test_both_run_and_in_tolerance_passes(self, monkeypatch):
        self._stub_pipeline(monkeypatch)
        called = {"mlflow": False, "foundry": False}
        mlflow_agg = AggregateResult(
            scorer_means={"relevance": 4.5, "grounding": 4.0},
            overall_mean=4.25, passed=True,
        )
        foundry_agg = AggregateResult(
            scorer_means={"relevance": 4.3, "grounding": 4.4},  # deltas 0.2/0.4
            overall_mean=4.35, passed=True,
        )
        self._patch_backends(monkeypatch, mlflow_agg, foundry_agg, called)
        monkeypatch.setenv("EVAL_BACKEND", "both")
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=full"])

        rc = run.main()
        assert rc == 0
        assert called["mlflow"] is True
        assert called["foundry"] is True

    def test_out_of_tolerance_fails_nonzero(self, monkeypatch, capsys):
        self._stub_pipeline(monkeypatch)
        called = {"mlflow": False, "foundry": False}
        mlflow_agg = AggregateResult(
            scorer_means={"relevance": 4.5, "grounding": 4.0},
            overall_mean=4.25, passed=True,
        )
        foundry_agg = AggregateResult(
            scorer_means={"relevance": 4.5, "grounding": 3.0},  # delta 1.0 > 0.5
            overall_mean=3.75, passed=True,
        )
        self._patch_backends(monkeypatch, mlflow_agg, foundry_agg, called)
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=full", "--backend=both"])
        monkeypatch.delenv("EVAL_BACKEND", raising=False)

        rc = run.main()
        assert rc == 1
        assert called["mlflow"] and called["foundry"]
        err = capsys.readouterr().err
        assert "OUT OF TOLERANCE" in err

    def test_empty_overlap_is_error_not_vacuous_pass(self, monkeypatch, capsys):
        self._stub_pipeline(monkeypatch)
        called = {"mlflow": False, "foundry": False}
        # No shared scorers between the two backends.
        mlflow_agg = AggregateResult(
            scorer_means={"relevance": 4.5}, overall_mean=4.5, passed=True,
        )
        foundry_agg = AggregateResult(
            scorer_means={"grounding": 4.5}, overall_mean=4.5, passed=True,
        )
        self._patch_backends(monkeypatch, mlflow_agg, foundry_agg, called)
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=full", "--backend=both"])
        monkeypatch.delenv("EVAL_BACKEND", raising=False)

        rc = run.main()
        assert rc == 1  # empty overlap MUST NOT vacuous-pass
        assert called["mlflow"] and called["foundry"]
        err = capsys.readouterr().err
        assert "no comparable scorers" in err

    def test_backend_threshold_fail_fails_even_if_parity_ok(self, monkeypatch):
        self._stub_pipeline(monkeypatch)
        called = {"mlflow": False, "foundry": False}
        # Parity is fine but a backend failed its own threshold.
        mlflow_agg = AggregateResult(
            scorer_means={"relevance": 3.0}, overall_mean=3.0, passed=False,
        )
        foundry_agg = AggregateResult(
            scorer_means={"relevance": 3.0}, overall_mean=3.0, passed=False,
        )
        self._patch_backends(monkeypatch, mlflow_agg, foundry_agg, called)
        monkeypatch.setattr(sys, "argv", ["run.py", "--mode=full", "--backend=both"])
        monkeypatch.delenv("EVAL_BACKEND", raising=False)

        rc = run.main()
        assert rc == 1


def EvalCase_stub():
    from run import EvalCase
    return EvalCase(customer_id="c1", reference_summary="r")
