#!/usr/bin/env bash
set -euo pipefail

bun run check:verification-prerequisites
bun run typecheck
bun run check:docs
bun run test:scripts
bun run test
