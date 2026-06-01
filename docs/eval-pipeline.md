# Evaluation Pipeline

## Overview

The eval pipeline is a **batch post-hoc** quality assessment system. It calls the live customer-summary service, compares generated summaries against human-written reference summaries using MLflow's built-in LLM-as-judge scorers (backed by Azure OpenAI gpt-4o-mini), and logs results to the same MLflow experiment as production traces.

Results are visible in the MLflow UI at `http://localhost:5000/#/experiments/0`.

## Architecture

```
┌─────────────────┐     POST /summarize      ┌──────────────────┐
│  cases.json     │ ──────────────────────►   │  Customer App    │
│  (25 eval cases)│                           │  (Bun, port 3000)│
└────────┬────────┘                           └────────┬─────────┘
         │                                             │
         │  reference_summary                          │ generated summary
         ▼                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    mlflow.evaluate()                              │
│                                                                   │
│  ┌───────────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ answer_correctness │  │ faithfulness │  │    relevance     │  │
│  │ (Azure OpenAI)     │  │(Azure OpenAI)│  │ (Azure OpenAI)   │  │
│  └───────────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ grounding (deterministic — reads fixture JSON files)       │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────┐
                          │  MLflow Server   │
                          │  (port 5000)     │
                          │  Experiment: 0   │
                          │  "Default"       │
                          └─────────────────┘
```

The experiment is selected **by name** via `MLFLOW_EXPERIMENT_NAME` (`mlflow.set_experiment(...)`, default `"Default"`), not by numeric id. In OSS MLflow the `"Default"` experiment is id `0`, which is why the diagram above and the UI URL in the Overview (`.../experiments/0`) show `0` — but if you override `MLFLOW_EXPERIMENT_NAME` the results land in that named experiment (with whatever id MLflow assigns), so don't read the `0` as a hard-coded id.

## Running

```bash
# From apps/customer-summary/
set -a && source ../../.env && set +a
export MLFLOW_TRACKING_URI=http://localhost:5000
export APP_BASE_URL=http://localhost:3000

# Full mode (LLM + deterministic scorers)
python3 eval/run.py --mode=full

# CI mode (deterministic only, no LLM calls)
python3 eval/run.py --mode=ci
```

Exit code is 0 if overall mean score >= 4.0, 1 otherwise.

## Step-by-step Flow

### 1. Load Eval Cases

File: `fixtures/eval/cases.json`

Contains 25 entries, each with a customer ID and a human-written gold-standard summary:

```json
{
  "customer_id": "cust-001",
  "reference_summary": "Customer had billing inquiry about prorated charge and asked about premium features. Generally satisfied."
}
```

The `reference_summary` defines "what good looks like" for each customer.

### 2. Call the Live App

For each case, the script POSTs to the running service:

```
POST http://localhost:3000/summarize
{"customer_id": "cust-001"}
```

The app runs the full production DAG (fetch customer → enrich → synthesize via gpt-4o-mini → guardrail check) and returns the generated summary. No mocking — this is the real path.

4 workers run in parallel (~25 cases in ~15s).

### 3. Build Eval DataFrame

Successful results become a pandas DataFrame passed to `mlflow.evaluate()`:

| Column | Content | Used by |
|--------|---------|---------|
| `inputs` | "Summarize conversation history for customer cust-001." | relevance |
| `predictions` | The generated summary from the app | All scorers |
| `targets` | The human-written reference summary | answer_correctness |
| `context` | Same as targets (reference summary) | faithfulness, relevance |
| `customer_id` | e.g. "cust-001" | grounding scorer |

### 4. Scoring

MLflow runs 4 scorers on every row:

#### answer_correctness (LLM-judged)

MLflow's built-in metric. Sends prediction + target to gpt-4o-mini and asks: "Is this answer correct compared to the ground truth?" Returns 1-5 score.

#### faithfulness (LLM-judged)

MLflow's built-in metric. Sends prediction + context to gpt-4o-mini and asks: "Is every claim in the output supported by the context?" Catches hallucinations.

#### relevance (LLM-judged)

MLflow's built-in metric. Sends prediction + context to gpt-4o-mini and asks: "Is the output relevant and useful for the given input?" Catches off-topic responses.

#### grounding (deterministic, no LLM)

Custom scorer that loads the raw customer fixture JSON (`fixtures/customers/cust-XXX.json`) and runs 4 checks against the actual source conversation data:

1. **Conversation count** — if the summary claims "3 conversations", does the fixture actually have 3?
2. **Customer name** — if mentioned, does it match the fixture?
3. **Topic grounding** — if the summary mentions "billing", do the source messages contain billing keywords?
4. **Sentiment consistency** — if the summary says "frustrated", does the source actually have negative tone?

Penalty-based scoring: starts at 5.0, deducts for each failure, clamps to 1-5.

### 5. Aggregate & Verdict

Computes mean score per scorer across all successful cases, then overall mean across all 4 scorers. Pass threshold: **4.0/5**.

### 6. Log to MLflow

`mlflow.evaluate()` automatically creates a run in the experiment with:
- Per-row scores and justifications (Evaluation tab)
- Aggregate metrics (Metrics tab)
- Input/output data table (Artifacts tab)

## Data Sources

| Data | Location | Purpose |
|------|----------|---------|
| Eval cases | `fixtures/eval/cases.json` | Which customers to test + gold-standard reference summaries |
| Customer fixtures | `fixtures/customers/cust-XXX.json` | Raw conversation data (app input + grounding scorer source) |
| Generated summaries | Live from `POST /summarize` | The actual output being evaluated |
| LLM judge | Azure OpenAI gpt-4o-mini | Scores answer_correctness, faithfulness, relevance |

## Modes

| Mode | Scorers | LLM calls | Cost | Use case |
|------|---------|-----------|------|----------|
| `full` | answer_correctness, faithfulness, relevance, grounding | ~60 gpt-4o-mini calls | ~$0.01 | Local dev, pre-release / nightly |
| `ci` | grounding only | 0 | Free | CI / PR gate (fast feedback) |

## Evaluation Backends (MLflow + Azure AI Foundry)

The eval backend is **selectable at run time — no code changes** (FR-004). The MLflow path is the **default** (FR-005); selecting one backend never alters the other's behavior (FR-016). Both backends score the **same** eval cases (currently 25, SC-002), with the **same** scorer names, reusing the **same** Azure OpenAI judge credentials (`AZURE_OPENAI_*`, FR-015).

| Backend | Selector | Scoring engine | Results land in |
|---|---|---|---|
| `mlflow` (default) | `--backend=mlflow` / `EVAL_BACKEND=mlflow` | `mlflow.evaluate()` | MLflow experiment / Evaluations tab |
| `foundry` | `--backend=foundry` / `EVAL_BACKEND=foundry` | `azure-ai-evaluation` | Foundry Evaluations view |
| `both` | `--backend=both` / `EVAL_BACKEND=both` | both paths + parity check | both + a parity verdict |

### Run-time selector and precedence

The backend is resolved from `--backend` (CLI) or `EVAL_BACKEND` (env), defaulting to `mlflow`. **The CLI flag wins** over the env var (mirroring the `--mode` / `EVAL_MODE` pattern). Because argparse `choices` validate only CLI-passed values — not the env default — the resolved backend is re-validated against the allowed set (`mlflow|foundry|both`) in `main()` before dispatch, so a typo like `EVAL_BACKEND=foundryy` fails loud rather than silently routing to a catch-all. Dispatch is exhaustive (no else-catches-everything).

### The Foundry-native path (`run_evaluation_foundry`)

`foundry_eval.py` mirrors the MLflow path but scores via Microsoft's `azure-ai-evaluation` SDK so per-case **and** aggregate scores land in the Foundry Evaluations view (FR-013/FR-014, SC-002). It **reuses `build_eval_data`** from `run.py` and produces the same `AggregateResult` shape so run.py's `format_results_table` / exit-code logic work unchanged (it defines its own `compute_aggregate_foundry`), and uses the **same** `AZURE_OPENAI_*` judge credentials, then renames columns to the `query`/`response`/`context`/`ground_truth` schema azure-ai-evaluation expects. Only the scoring call and the result-shape adapter differ.

Scorer names are kept identical to the MLflow path so per-scorer means compare 1:1:

| Scorer | MLflow path | Foundry path |
|---|---|---|
| `answer_correctness` | `answer_correctness` genai metric | `SimilarityEvaluator` |
| `faithfulness` | `faithfulness` genai metric | `GroundednessEvaluator` |
| `relevance` | `relevance` genai metric | `RelevanceEvaluator` |
| `grounding` | deterministic `score_grounding` | deterministic `score_grounding` (reused verbatim) |

In `ci` mode only the deterministic `grounding` evaluator is built (no Azure access needed); the three LLM evaluators are constructed only in `full` mode. The result-shape adapter (`compute_aggregate_foundry`) **fails closed** on a shape/contract mismatch: a non-dict return, a missing `metrics` key, or expected scorers absent from the SDK output are surfaced loudly on stderr and yield a FAILED aggregate — never silently read as a genuine low score.

### Parity check (±0.5, SC-005)

`parity.py` provides pure helpers to compare aggregate per-scorer means between the two backends. The contract: across all cases, the mean per-scorer score from the Foundry path must be within **±0.5** (on the 1–5 scale) of the MLflow path for **every** scorer (FR-017, SC-005), demonstrating no systematic divergence.

```python
from parity import compute_parity, parity_within_tolerance, format_parity_table

deltas = compute_parity(mlflow_means, foundry_means)  # {scorer: |delta|}, shared scorers only
parity_within_tolerance(deltas, tol=0.5)              # True iff every |delta| <= 0.5
print(format_parity_table(deltas))
```

`--backend=both` runs **both** paths over the **same** collected results, prints both result tables and the parity table, and computes the exit code:

- `0` — both backends pass their own ≥4.0 threshold **AND** every shared per-scorer mean is within ±0.5;
- `1` — a backend failed its threshold, parity was out of tolerance, **OR** the two backends share no comparable scorer (an empty overlap is an error, never a vacuous pass).

```bash
# Both backends + parity check (SC-005, ±0.5) — non-zero exit if out of tolerance
# Run from apps/customer-summary/ so the default EVAL_CASES_PATH resolves.
python3 eval/run.py --mode=full --backend=both
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_BASE_URL` | `http://host.containers.internal:3000` | Summary service URL |
| `MLFLOW_TRACKING_URI` | — | MLflow server (e.g. `http://localhost:5000`) — mlflow backend |
| `MLFLOW_EXPERIMENT_NAME` | `Default` | Experiment to log results to |
| `EVAL_CASES_PATH` | `fixtures/eval/cases.json` | Path to eval cases |
| `EVAL_MODE` | `full` | Default mode if `--mode` not passed (`full`\|`ci`); `--mode` wins |
| `EVAL_BACKEND` | `mlflow` | Default backend if `--backend` not passed (`mlflow`\|`foundry`\|`both`); `--backend` wins |
| `AZURE_OPENAI_ENDPOINT` | — | Azure OpenAI endpoint (judge creds, reused by both backends) |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key (judge creds) |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o-mini` | Deployment name (judge model) |
| `AZURE_OPENAI_API_VERSION` | `2025-04-01-preview` | API version |
| `EVAL_WORKERS` | `4` | Parallel workers for summarize calls |

## File Structure

```
apps/customer-summary/
├── eval/
│   ├── run.py              # Main entry point (orchestration)
│   ├── scorers.py          # Scorer definitions (built-in + grounding)
│   ├── foundry_eval.py     # Foundry-native eval path (azure-ai-evaluation); same AggregateResult shape as the MLflow path
│   ├── parity.py           # Per-scorer parity check between MLflow and Foundry backends (SC-005, ±0.5 tolerance)
│   ├── requirements.txt    # Python dependencies
│   ├── test_run.py         # Tests for run.py pure functions
│   ├── test_scorers.py     # Tests for scorers
│   ├── test_backend_selector.py  # Tests for the --backend/EVAL_BACKEND selector + parity wiring
│   ├── test_foundry_eval.py      # Tests for the Foundry eval adapter (fake evaluate_fn, contract-error branches)
│   └── test_parity.py            # Tests for the parity delta math and tolerance boundary
├── fixtures/
│   ├── eval/
│   │   └── cases.json      # 25 eval cases with reference summaries
│   └── customers/
│       ├── cust-001.json   # Raw conversation data per customer
│       ├── cust-002.json
│       └── ...
```

## Adding New Eval Cases

1. Create the customer fixture at `fixtures/customers/cust-XXX.json`
2. Add an entry to `fixtures/eval/cases.json` with a human-written reference summary
3. Run `python3 eval/run.py --mode=full` to verify

## Automatic vs Manual Evaluation

This is a **batch/manual** system — you run it explicitly. It does NOT automatically evaluate every incoming trace. MLflow's `scheduled_scorers` (auto-eval on ingest) is Databricks-only and not available in OSS MLflow.

Recommended cadence:
- Run `--mode=ci` on every PR (fast, free)
- Run `--mode=full` before releases or after prompt/model changes

## MLflow Evaluation Datasets

The eval cases in `fixtures/eval/cases.json` can be stored as an **MLflow Evaluation Dataset**, enabling version tracking, UI browsing, and direct integration with `mlflow.genai.evaluate()`.

### Requirements

- Python 3.12 (provided by the project's Nix flake)
- MLflow client >= 3.6 (installed in `.venv` via `nix develop` / `direnv allow`)
- MLflow server with SQL backend (already configured — `sqlite:///mlflow/mlflow.db`)

### Loading Cases into MLflow

```python
import json, os
os.environ["MLFLOW_TRACKING_URI"] = "http://localhost:5000"

from mlflow.genai.datasets import create_dataset

# Create the dataset (attached to experiment 0)
dataset = create_dataset(
    name="customer-summary-eval",
    experiment_id="0",
    tags={"source": "fixtures", "version": "1.0"},
)

# Transform fixture cases into MLflow dataset records
with open("fixtures/eval/cases.json") as f:
    cases = json.load(f)

records = [
    {
        "inputs": {"customer_id": case["customer_id"]},
        "expectations": {"reference_summary": case["reference_summary"]},
    }
    for case in cases
]

dataset.merge_records(records)
print(f"Loaded {len(records)} records into dataset {dataset.dataset_id}")
```

### Using the Dataset in Evaluation

Once loaded, you can pass the dataset directly to `mlflow.genai.evaluate()` instead of building a DataFrame manually:

```python
from mlflow.genai.datasets import get_dataset

dataset = get_dataset(name="customer-summary-eval")
# dataset can be used as input to evaluate(), or converted: dataset.to_df()
```

### Benefits Over File-Based Cases

| Aspect | `cases.json` (current) | MLflow Dataset |
|--------|----------------------|----------------|
| Versioning | Git only | Git + MLflow versioned records |
| UI browsing | None | MLflow Experiments → Datasets tab |
| Trace linking | Manual | Can link traces to dataset records |
| Adding from production | Edit JSON | UI: select traces → "Add to dataset" |
| Expectations/labels | Static | Can add `log_expectation()` per-trace |

### Adding Production Traces to the Dataset

From the MLflow UI (Databricks managed MLflow only — not available in OSS MLflow):
1. Go to Experiments → Traces tab
2. Select interesting traces (failures, edge cases)
3. Actions → "Add to evaluation dataset"

Or programmatically:
```python
import mlflow

traces_df = mlflow.search_traces(
    filter_string="status = 'ERROR'",
    experiment_ids=["0"],
    max_results=20,
)

# Convert DataFrame rows to dataset records
records = [
    {
        "inputs": row["request"],
        "expectations": {},  # add manual labels as needed
    }
    for _, row in traces_df.iterrows()
]
dataset.merge_records(records)
```
