#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../infra"
podman-compose up -d mlflow redis
echo "MLflow UI: http://localhost:5000"
echo "Redis: localhost:6379"
echo ""
echo "For evals, run Ollama natively for GPU acceleration:"
echo "  ollama serve"
echo "  bun run eval:pull-model"
