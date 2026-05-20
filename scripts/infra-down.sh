#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../infra"
podman-compose down
