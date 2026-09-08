#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <redis-url>\n' "$0" >&2
  exit 64
fi

readonly redis_url=$1
readonly max_attempts=${REDIS_READY_MAX_ATTEMPTS:-40}
readonly delay_seconds=${REDIS_READY_DELAY_SECONDS:-0.1}

if [[ ! $max_attempts =~ ^[1-9][0-9]*$ ]]; then
  printf 'REDIS_READY_MAX_ATTEMPTS must be a positive integer\n' >&2
  exit 64
fi
if [[ ! $delay_seconds =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]]; then
  printf 'REDIS_READY_DELAY_SECONDS must be a non-negative number\n' >&2
  exit 64
fi

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  if response=$(redis-cli --no-auth-warning -u "$redis_url" PING 2>/dev/null) \
    && [[ $response == PONG ]]; then
    exit 0
  fi
  if ((attempt < max_attempts)); then
    sleep "$delay_seconds"
  fi
done

printf 'Redis readiness timed out (URL and credentials withheld)\n' >&2
exit 1
