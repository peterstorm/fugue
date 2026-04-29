# Customer Summary Eval

Evaluates the customer-summary service using MLflow GenAI scorers.

## What it does

1. Loads eval cases from `fixtures/eval/cases.json`
2. Calls `/summarize` for each case
3. Scores responses on **factuality**, **completeness**, **conciseness** (1-5 scale)
4. Fails if aggregate mean < 4.0

## Running

```bash
# Via workspace script (uses Podman)
bun run eval

# Or directly
cd apps/customer-summary
python eval/run.py
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://host.containers.internal:3000` | Summary service URL |
| `MLFLOW_TRACKING_URI` | — | MLflow tracking server |
| `ANTHROPIC_API_KEY` | — | API key for Claude judge |
| `EVAL_CASES_PATH` | `fixtures/eval/cases.json` | Path to eval cases |
