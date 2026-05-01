# Customer Summary Eval

Evaluates the customer-summary service using MLflow GenAI scorers.

## What it does

1. Loads eval cases from `fixtures/eval/cases.json`
2. Calls `/summarize` for each case (in parallel)
3. Scores responses on 4 dimensions (1-5 scale):
   - **factuality** — LLM-judged via Flow Judge (3.8B) on Ollama
   - **completeness** — LLM-judged via Flow Judge
   - **conciseness** — LLM-judged via Flow Judge
   - **grounding** — deterministic checks against fixture data (no LLM needed)
4. Fails if aggregate mean < 4.0

## Modes

| Mode | Scorers | Requires Ollama | Speed | Use case |
|------|---------|-----------------|-------|----------|
| `full` | All 4 (3 LLM + 1 deterministic) | Yes | ~5-15 min (GPU), ~45-75 min (CPU) | Local dev, nightly CI |
| `ci` | Grounding only (deterministic) | No | ~seconds | PR gate |

## Running

```bash
# Full suite via Podman (default)
bun run eval

# CI mode (deterministic only, no Ollama)
bun run eval:ci

# Directly
python eval/run.py --mode=full
python eval/run.py --mode=ci
```

## Prerequisites (full mode only)

Pull the Flow Judge model (~2.3GB, Q4 quantized):
```bash
bun run eval:pull-model
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://host.containers.internal:3000` | Summary service URL |
| `MLFLOW_TRACKING_URI` | — | MLflow tracking server |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API URL (full mode only) |
| `OLLAMA_TIMEOUT_SEC` | `120` | Timeout per Ollama call in seconds |
| `EVAL_CASES_PATH` | `fixtures/eval/cases.json` | Path to eval cases |
| `EVAL_WORKERS` | `4` | Parallel workers for summarize calls |
| `EVAL_MODE` | `full` | Default mode if --mode not passed |
