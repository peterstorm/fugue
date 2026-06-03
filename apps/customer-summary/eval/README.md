# Customer Summary Eval

Evaluates the customer-summary service using MLflow GenAI scorers, with an
optional Foundry-native scoring backend (`azure-ai-evaluation`).

## What it does

1. Loads eval cases from `fixtures/eval/cases.json`
2. Calls `/summarize` for each case (in parallel)
3. Scores responses on 4 dimensions (1-5 scale):
   - **answer_correctness** — LLM-judged via Azure OpenAI (gpt-4o-mini)
   - **faithfulness** — LLM-judged via Azure OpenAI (gpt-4o-mini)
   - **relevance** — LLM-judged via Azure OpenAI (gpt-4o-mini)
   - **grounding** — deterministic checks against fixture data (no LLM needed)
4. Fails if aggregate mean < 4.0

(Scorer names are defined in `scorers.py`: `SCORER_NAMES` /
`DETERMINISTIC_SCORER_NAMES`.)

## Modes

| Mode | Scorers | Requires Azure OpenAI | Use case |
|------|---------|-----------------------|----------|
| `full` | All 4 (3 LLM-judged + 1 deterministic) | Yes | Local dev, pre-release / nightly |
| `ci` | `grounding` only (deterministic) | No | CI / PR gate (fast feedback) |

## Backends

The eval backend is selectable at run time — **no code changes**. The MLflow
path is the **default**; selecting one backend never alters the other's
behavior. Both score the SAME eval cases with the SAME scorer names and reuse
the SAME Azure OpenAI judge credentials (`AZURE_OPENAI_*`).

| Backend | Selector | Scoring engine | Results land in |
|---|---|---|---|
| `mlflow` (default) | `--backend=mlflow` / `EVAL_BACKEND=mlflow` | `mlflow.evaluate()` | MLflow experiment / Evaluations tab |
| `foundry` | `--backend=foundry` / `EVAL_BACKEND=foundry` | `azure-ai-evaluation` | Foundry Evaluations view |

**Precedence:** the `--backend` CLI flag wins over the `EVAL_BACKEND` env var,
which defaults to `mlflow`. (Mirrors the `--mode` / `EVAL_MODE` pattern.)

Scorer-name parity between the two paths is intentional so per-scorer means can
be compared 1:1:

| Scorer | MLflow path | Foundry path |
|---|---|---|
| `answer_correctness` | `answer_correctness` genai metric | `SimilarityEvaluator` |
| `faithfulness` | `faithfulness` genai metric | `GroundednessEvaluator` |
| `relevance` | `relevance` genai metric | `RelevanceEvaluator` |
| `grounding` | deterministic `score_grounding` | deterministic `score_grounding` (reused) |

## Parity (±0.5)

The Foundry path must agree with the MLflow path: across all cases, the mean
per-scorer score from Foundry must be within **±0.5** (on the 1–5 scale) of the
MLflow score for **every** scorer. `parity.py` provides the pure helpers:

```python
from parity import compute_parity, parity_within_tolerance, format_parity_table

deltas = compute_parity(mlflow_means, foundry_means)  # {scorer: |delta|}
assert parity_within_tolerance(deltas, tol=0.5)       # SC-005
print(format_parity_table(deltas))
```

## Running

Run the eval directly with `python run.py` (from `apps/customer-summary/eval`),
selecting the mode and backend:

```bash
# MLflow backend (default) — full suite (LLM-judged, requires Azure OpenAI)
python run.py --mode=full
# MLflow backend — CI mode (deterministic grounding only, no LLM)
python run.py --mode=ci

# Foundry-native backend (azure-ai-evaluation)
python run.py --mode=full --backend=foundry
EVAL_BACKEND=foundry python run.py --mode=ci   # env selector; --backend overrides

# Both backends + parity check (SC-005, ±0.5) — non-zero exit if out of tolerance
python run.py --mode=full --backend=both

# Run the eval-app unit tests
python -m pytest -q
```

## Prerequisites (full mode only)

`full` mode (and the LLM scorers under `--backend=foundry`/`both`) needs Azure
OpenAI judge credentials. Set the `AZURE_OPENAI_*` env vars below — there is no
Ollama / local model dependency. `ci` mode (deterministic `grounding` only)
needs no Azure access.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://host.containers.internal:3000` | Summary service URL |
| `MLFLOW_TRACKING_URI` | — | MLflow tracking server (mlflow backend) |
| `MLFLOW_EXPERIMENT_NAME` | `Default` | MLflow experiment for eval results |
| `EVAL_CASES_PATH` | `fixtures/eval/cases.json` | Path to eval cases |
| `EVAL_WORKERS` | `4` | Parallel workers for summarize calls |
| `EVAL_MODE` | `full` | Default mode if --mode not passed |
| `EVAL_BACKEND` | `mlflow` | Default backend if --backend not passed (`mlflow`\|`foundry`\|`both`); --backend wins |
| `AZURE_OPENAI_ENDPOINT` | — | Azure OpenAI endpoint (judge creds, reused by both backends) |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI API key (judge creds) |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o-mini` | Azure OpenAI deployment (judge model) |
| `AZURE_OPENAI_API_VERSION` | `2025-04-01-preview` | Azure OpenAI API version |
