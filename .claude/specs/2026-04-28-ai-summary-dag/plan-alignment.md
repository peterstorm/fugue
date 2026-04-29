# Plan Alignment Report

**Spec:** /Users/hansen142/dev/agentic/ai-summary/.claude/specs/2026-04-28-ai-summary-dag/spec.md
**Plan:** /Users/hansen142/dev/agentic/ai-summary/.claude/plans/2026-04-28-ai-summary-dag.md
**Date:** 2026-04-29

## Summary

1 gap found.

## Gaps

- **FR-300** — All LLM calls MUST go through the Claude Agent SDK; the system MUST NOT contain a multi-provider abstraction in v1: Plan AD-2 explicitly substitutes the plain `@anthropic-ai/sdk` for the Claude Agent SDK ("Plain `@anthropic-ai/sdk` over Claude Agent SDK for v1"), citing Python-only auto-tracing. The spec does not permit substitution — FR-300 mandates the Agent SDK as the sole sanctioned path. This is a direct conflict between plan and spec, not a vague omission. Resolution path: amend FR-300 to permit `@anthropic-ai/sdk` + `@mlflow/anthropic` (`tracedAnthropic`) for v1 with Claude Agent SDK migration deferred until tools/sub-agents are needed (post-v1) — matches the decision made in the MLflow research review on 2026-04-28. Alternatively, amend the plan to adopt Claude Agent SDK and accept losing first-party MLflow auto-tracing (Python sidecar workaround instead).

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1 | Support agent fetches customer overview before contact | Covered |
| US2 | Engineer runs the eval set to gate prompt/model changes | Covered |
| US3 | Engineer inspects a single run's trace to debug a bad summary | Covered |
| US4 | Engineer builds a new DAG-based workflow on the framework | Covered |
| US5 | Engineer resumes an interrupted run | Covered |
| US6 | Engineer benefits from prompt/semantic cache hits | Covered |
| FR-001 | Execute DAG in topological order, parallel where possible | Covered |
| FR-002 | Three node kinds: fetch, transform, llm | Covered |
| FR-003 | Validate node input/output via schema with attributable errors | Covered |
| FR-004 | Business-logic errors as values (Result), not exceptions | Covered |
| FR-005 | Declarative DAG independent of execution-time concerns | Covered |
| FR-006 | Linear topological execution, not architecturally preclusive | Covered |
| FR-010 | Structured event per node execution with required fields | Covered |
| FR-011 | LLM event includes prompt/model version, tokens, cost | Covered |
| FR-012 | Pluggable observers + MLflow observer implementation | Covered |
| FR-013 | Run-level trace tagged with runId, dagId, prompt+model versions | Covered |
| FR-020 | LLM nodes declare structured-output schema, validated | Covered |
| FR-021 | Retry once on schema validation failure, then typed error | Covered |
| FR-030 | Versioned prompt files by content hash; version in trace | Covered |
| FR-031 | Refuse to run LLM node if prompt missing/uncomputable | Covered |
| FR-040 | Persist DAG state per node to checkpoint store | Covered |
| FR-041 | Resume by run identifier, skipping completed nodes | Covered |
| FR-042 | Structured error on missing/expired/corrupt checkpoint; 24h TTL | Covered |
| FR-050 | Consult cache before LLM call; cache-hit indicator in trace | Covered |
| FR-051 | Exact-input hash cache key; no semantic caching in v1 | Covered |
| FR-052 | 24-hour cache TTL; no per-node TTL in v1 | Covered |
| FR-060 | Record tokens-in/out + USD cost per LLM call; aggregable | Covered |
| FR-100 | HTTP endpoint accepting customer ID, returning JSON summary | Covered |
| FR-101 | ConversationSource adapter; JSON fixture only in v1 | Covered |
| FR-102 | Summary DAG: fetch -> transform(s) -> llm synthesis -> response | Covered |
| FR-103 | Exactly one LLM call per run on happy path | Covered |
| FR-104 | Token-budget recency selection (~6k) + named extraction shapes | Covered |
| FR-105 | Synthesis output zod schema with exact shape | Covered |
| FR-106 | Stable HTTP 200 discriminated-union response | Covered |
| FR-110 | ~20 curated CRM fixtures with reference summaries | Covered |
| FR-111 | Runnable eval command, end-to-end with LLM-as-judge scoring | Covered |
| FR-112 | Non-zero exit on aggregate mean below 4.0 across 3 dimensions | Covered |
| FR-113 | Judge model is Claude Haiku | Covered |
| FR-120 | `bun run infra:up` separate from `bun run dev`, podman-compose | Covered |
| FR-200 | Conversation data input-only, no mutation | Covered |
| FR-201 | Tolerate missing optional fields; insufficient_data branch | Covered |
| FR-300 | All LLM calls via Claude Agent SDK; no multi-provider | Gap |
| FR-301 | MLflow observability backend running locally | Covered |
| NFR-001 | Cold-path latency budget per SC-001 | Covered |
| NFR-002 | Warm-path latency budget per SC-002 | Covered |
| NFR-003 | Eval set under 5 minutes wall-clock | Covered |
| NFR-010 | Atomic checkpoint visibility (no partial outputs) | Covered |
| NFR-011 | Determinism for fetch/transform given same inputs | Covered |
| NFR-020 | 100% node executions in successful runs appear in trace | Covered |
| NFR-021 | Every LLM call has prompt+model version in trace | Covered |
| NFR-030 | HTTP API may run unauthenticated (deferred) | Covered |
| NFR-031 | No raw API keys/credentials in traces or logs | Covered |
| SC-001 | p95 cold-path latency < 10s | Covered |
| SC-002 | p95 warm-path latency < 500ms | Covered |
| SC-003 | 100% runs emit complete MLflow trace with required attrs | Covered |
| SC-004 | 100% LLM outputs validate against zod schema | Covered |
| SC-005 | At least 20 hand-curated CRM fixtures with reference summaries | Covered |
| SC-006 | LLM-as-judge aggregate mean >= 4.0 across 3 dimensions | Covered |
| SC-007 | Second example DAG runs using public primitives only | Covered |
| SC-008 | Interrupted run resumable with zero re-execution of checkpointed nodes | Covered |
| SC-009 | Eval command runnable in CI, gates merges by exit code | Covered |
| SC-010 | Per-run USD cost visible in every trace, aggregable | Covered |
