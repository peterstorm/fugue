#!/usr/bin/env bash
set -euo pipefail

readonly script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
container_id=''

cleanup() {
  local primary_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM

  if [[ -n $container_id ]]; then
    if podman stop "$container_id" >/dev/null; then
      cleanup_status=0
    else
      cleanup_status=$?
      printf 'Failed to stop the owned temporary Redis container\n' >&2
    fi
  fi

  if ((primary_status != 0)); then
    exit "$primary_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

created_id=$(podman run --rm -d -p 127.0.0.1::6379 redis:7-alpine)
if [[ ! $created_id =~ ^[[:xdigit:]]{12,64}$ ]]; then
  printf 'Podman returned an invalid temporary Redis container ID\n' >&2
  exit 1
fi
container_id=$created_id

port_mapping=$(podman port "$container_id" 6379/tcp)
if [[ ! $port_mapping =~ ^127[.]0[.]0[.]1:([0-9]+)$ ]]; then
  printf 'Podman did not publish Redis on one loopback ephemeral port\n' >&2
  exit 1
fi
readonly redis_port=${BASH_REMATCH[1]}
readonly redis_url="redis://127.0.0.1:${redis_port}"

bash "$script_dir/wait-for-redis.sh" "$redis_url"
REDIS_URL=$redis_url bun run --filter '*' test
