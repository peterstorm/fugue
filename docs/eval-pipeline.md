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
| `full` | answer_correctness, faithfulness, relevance, grounding | ~60 gpt-4o-mini calls | ~$0.01 | Local dev, pre-release |
| `ci` | grounding only | 0 | Free | CI pipeline, fast feedback |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_BASE_URL` | `http://host.containers.internal:3000` | Summary service URL |
| `MLFLOW_TRACKING_URI` | — | MLflow server (e.g. `http://localhost:5000`) |
| `MLFLOW_EXPERIMENT_NAME` | `Default` | Experiment to log results to |
| `EVAL_CASES_PATH` | `fixtures/eval/cases.json` | Path to eval cases |
| `AZURE_OPENAI_ENDPOINT` | — | Azure OpenAI endpoint |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | — | Deployment name (e.g. `gpt-4o-mini`) |
| `AZURE_OPENAI_API_VERSION` | `2025-04-01-preview` | API version |
| `EVAL_WORKERS` | `4` | Parallel workers for summarize calls |

## File Structure

```
apps/customer-summary/
├── eval/
│   ├── run.py              # Main entry point (orchestration)
│   ├── scorers.py          # Scorer definitions (built-in + grounding)
│   ├── requirements.txt    # Python dependencies
│   ├── test_run.py         # Tests for run.py pure functions
│   └── test_scorers.py     # Tests for scorers
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

From the MLflow UI:
1. Go to Experiments → Traces tab
2. Select interesting traces (failures, edge cases)
3. Actions → "Add to evaluation dataset"

Or programmatically:
```python
import mlflow
traces = mlflow.search_traces(
    filter_string="status = 'ERROR'",
    experiment_ids=["0"],
    max_results=20,
)
dataset.merge_records(traces)
```
