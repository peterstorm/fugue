# PR Remediation Plan — v4 (second review pass)

**Date:** 2026-05-29
**Branch:** feat/fugue-host
**Scope:** the 3 commits since f553d45 (circuit/FR-051/TTL/probe/type-hardening, docs, fugue.yaml wiring)
**Findings:** 2 critical, ~12 advisory (6 agents)

## Critical

### C1. fugue.yaml validation bypass (introduced by the wiring)
- **Source:** code-reviewer, type-design-analyzer
- **File:** `packages/host/src/domain/config.ts:108-120`
- **Issue:** `FugueYamlSchema.maxConcurrent/cacheTtlMs/checkpointTtlMs/asyncResultTtlMs` are bare
  `z.number().optional()`. `applyFugueYaml` merges them into the now-required `ResolvedDagConfig`.
  `maxConcurrent: 0`/negative → `acquire` always rejects → DAG wedged at 429 forever; negative TTL →
  bad Redis expiry. dag.ts equivalents already use `.int().positive()`.
- **Fix:** `.int().positive()` on those numeric fields; `.min(1)` on `team` (drives authz isolation).
  Add a rejection test.

### C2. Stale "not wired" comment
- **Source:** comment-analyzer
- **File:** `packages/host/src/domain/dag-registration.ts:25-30`
- **Issue:** Says `MAX_DAG_TIMEOUT_MS` is "not wired to constrain this value — future work," but
  `dag-factory.ts:95-98` clamps it and docs advertise the clamp.
- **Fix:** Rewrite the comment to describe the actual clamp.

## Advisory (fixing)

- A. `redisDied`/`redisRecovered` Result discarded with no log — `host.ts:220-235`. Log failed transition (mirror sync-callbacks).
- B. `Bun.YAML` captured at import; undefined-runtime → misreported as "Malformed fugue.yaml" — `module-loader.ts:25,48`. Guard at first use.
- C. (folded into C1) `team` no `.min(1)`.
- D. per-DAG circuit-config merge untested end-to-end — `run-dag.ts:135-152`. Add handler test (per-DAG failureThreshold + cooldown).
- E. redis-probe `inFlight` overlap-suppression untested — `redis-probe.ts:46`. Add slow-ping test.
- F. boot/sync reconcile not asserted e2e — add a `full-lifecycle` assertion that a per-DAG limit lands in the limiter.
- G. No `tryGitSha` Result variant — `ids.ts`. Add it for parse-boundary symmetry.
- H. (arch) pure `applyFugueYaml` in I/O adapter — move to `domain/dag-registration.ts`.
- I. (arch) fail-closed env check is domain policy in the adapter — extract `checkRequiredEnv` to domain.
- J. (arch) `reconcileDagLimits` transient `current > max` on shrink — document.
- K. (comment) `circuitBreaker` JSDoc understates per-subfield fallback / host-only windowMs.
- L. (comment) deployment.md fugue.yaml example `env` block — note it's illustrative.

## Deferred (noted, not fixing)
- LoadResult team/owner as a discriminated `{ team; owner? }` sub-object — the `.min(1)` on team
  addresses the real risk; the both-or-neither nicety isn't worth the ripple.
- ResolvedDagConfig TTLs as a positive-millis newtype — parse-boundary validation (C1) makes the
  values valid; newtype is lower marginal value.
- asyncResultTtlMs "accepted but dropped" — mirrors the unwired host-level ASYNC_RESULT_TTL_MS;
  documented as reserved (now also validated positive by C1).

## Validation
```bash
cd packages/host && bun run test && bun run typecheck
cd packages/framework && bun test <files> && bun run typecheck
bun run typecheck   # root (all packages)
```
