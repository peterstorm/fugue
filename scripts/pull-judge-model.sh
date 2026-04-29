#!/usr/bin/env bash
set -euo pipefail

# Pull the Flow Judge model for local eval via Ollama.
# Prerequisites: ollama must be running (ollama serve)

MODEL="avcodes/flowaicom-flow-judge"
OLLAMA_HOST="${OLLAMA_BASE_URL:-http://localhost:11434}"

echo "Pulling Flow Judge model: $MODEL"
echo "Ollama host: $OLLAMA_HOST"

if ! command -v ollama &> /dev/null; then
  echo "ollama CLI not found. Install: brew install ollama"
  exit 1
fi

ollama pull "$MODEL"
echo "Flow Judge model ready. Size: ~2.3GB (Q4 quantized, 3.8B params)"
