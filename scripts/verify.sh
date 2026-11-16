#!/usr/bin/env bash
set -euo pipefail

bun run check:verification-prerequisites
bun run lint
bun run typecheck
bun run check:docs
bun run test:scripts
bun run test
