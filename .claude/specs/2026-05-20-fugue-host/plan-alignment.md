# Plan Alignment Report

**Spec:** .claude/specs/2026-05-20-fugue-host/spec.md
**Plan:** .claude/plans/2026-05-20-fugue-host.md
**Date:** 2026-05-20

## Summary

9 gaps found.

## Gaps

- **FR-012** — per-DAG model overrides: FugueYamlSchema and DagRegistration have timeout and maxConcurrent overrides but no mechanism for per-DAG model/provider overrides despite spec listing "model overrides" as expected optional config
- **FR-040** — global cache/checkpoint TTL defaults: HostConfigSchema (env vars) has no global TTL defaults for cache or checkpoint entries; per-DAG overrides exist in FugueYamlSchema but the host-level defaults they override are undefined
- **FR-042** — dagFingerprint checkpoint invalidation: plan tracks DAG version by git SHA but does not address dagFingerprint (topology hash) or how checkpoints are rejected when DAG structure changes between commits
- **FR-072** — async execution queue infrastructure: plan defines async-result-store.ts (Redis-backed) for result storage but does not address whether async execution uses the existing BullMQ queue from @fugue/framework/bullmq
- **FR-110** — CLI structured JSON output: plan contains no CLI component — no file structure, no phase, no design
- **FR-111** — CLI fix suggestions: CLI is completely omitted from the architecture plan
- **FR-112** — CLI scaffold command: no fugue new scaffold design exists
- **NFR-020** — structured JSON logging: plan addresses tracing (OTel) but never specifies application logging format
- **NFR-021** — contextual log fields: no logging strategy means no design for ensuring dagId/runId are present in log entries

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| FR-001 | Poll git branch at configurable interval | Covered |
| FR-002 | Discover DAGs via dags/*/*/dag.ts convention | Covered |
| FR-003 | Dynamic import with Bun + SHA cache-busting | Covered |
| FR-004 | Validate imported modules against DagRegistration schema | Covered |
| FR-005 | Run bun install when lockfile changes | Covered |
| FR-006 | Refuse to start if Redis unreachable | Covered |
| FR-007 | Identify DAG version by git SHA | Covered |
| FR-010 | DagRegistration requires dag field with valid DagDef | Covered |
| FR-011 | Optional route override | Covered |
| FR-012 | Optional config (timeout, maxConcurrent, model overrides) | Gap |
| FR-013 | Apply sensible defaults for omitted optional config | Covered |
| FR-020 | POST /dags/:id/run for sync execution | Covered |
| FR-021 | POST /dags/:id/submit for async execution (P2) | Covered |
| FR-022 | GET /runs/:runId/status for async polling (P2) | Covered |
| FR-023 | GET /dags listing registered DAGs with metadata | Covered |
| FR-024 | GET /health liveness probe | Covered |
| FR-025 | GET /readiness (Redis + DAGs check) | Covered |
| FR-026 | Machine-readable JSON error responses | Covered |
| FR-027 | 429 with Retry-After on concurrency limits | Covered |
| FR-028 | Per-DAG timeout with host-level max 120s | Covered |
| FR-030 | NodeContext per request with shared infra | Covered |
| FR-031 | Auto-namespace Redis keys by DAG ID | Covered |
| FR-032 | Context factory avoids re-initializing shared resources | Covered |
| FR-040 | Global TTL defaults for cache and checkpoint | Gap |
| FR-041 | Per-DAG TTL overrides in fugue.yaml | Covered |
| FR-042 | Checkpoint invalidation on DAG structure change | Gap |
| FR-050 | Global max concurrent execution limit (50) | Covered |
| FR-051 | Per-DAG max concurrent limit (10) | Covered |
| FR-060 | On SIGTERM, readiness immediately 503 | Covered |
| FR-061 | In-flight drain up to configurable timeout | Covered |
| FR-062 | Forcibly abort remaining after drain timeout | Covered |
| FR-070 | Async results retained for configurable period | Covered |
| FR-071 | 410 Gone after retention expiry | Covered |
| FR-072 | Async execution uses existing queue infrastructure | Gap |
| FR-080 | invoke(dagId, input) on NodeContext (P2) | Covered |
| FR-081 | invoke returns Result type | Covered |
| FR-082 | invoke fails if target DAG not registered | Covered |
| FR-090 | Track failure count in sliding time window | Covered |
| FR-091 | Auto-disable DAG when failures exceed threshold | Covered |
| FR-092 | Re-enable on new git version | Covered |
| FR-100 | Read fugue.yaml per DAG | Covered |
| FR-101 | Resolve declared env vars from host env | Covered |
| FR-102 | Missing env vars → warning, degraded health | Covered |
| FR-110 | CLI structured JSON output | Gap |
| FR-111 | CLI fix suggestions | Gap |
| FR-112 | CLI scaffold command | Gap |
| NFR-001 | Framework overhead <50ms P99 | Covered |
| NFR-002 | Cold DAG import <3s | Covered |
| NFR-003 | Sync detection within poll interval + 5s | Covered |
| NFR-004 | 50 concurrent executions | Covered |
| NFR-010 | Failing DAG doesn't affect others | Covered |
| NFR-011 | DAG error doesn't crash host | Covered |
| NFR-012 | Git sync failures don't affect serving | Covered |
| NFR-013 | Redis auto-reconnection | Covered |
| NFR-020 | Structured JSON logging to stdout | Gap |
| NFR-021 | dagId/runId in log entries | Gap |
| NFR-022 | Per-DAG execution metrics via endpoint | Covered |
| NFR-030 | Boot and ready within 10s | Covered |
| NFR-031 | Validate all DAGs on startup | Covered |
| SC-001 | Git commit → DAG live within poll + 5s | Covered |
| SC-002 | Framework overhead P99 <50ms under 50 concurrent | Covered |
| SC-003 | Cold import of 10-node DAG <3s | Covered |
| SC-004 | customer-summary migrated, all tests pass | Covered |
| SC-005 | Invalid DAG → structured error parseable by agent | Covered |
| SC-006 | 1000 requests, zero memory leaks | Covered |
| SC-007 | Graceful shutdown drains in-flight | Covered |
| SC-008 | Two DAGs same cache key → isolated | Covered |
