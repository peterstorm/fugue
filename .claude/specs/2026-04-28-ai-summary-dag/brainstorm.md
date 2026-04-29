# Brainstorm Summary

**Building:** A reusable DAG-based workflow framework in TypeScript (Bun) and, on top of it, a customer-summary tool that ingests CRM data (latest conversation log, call transcripts, chat logs) for a customer and produces a concise overview a customer service agent reads before the next contact. The framework is the primary architectural deliverable; the summary tool is its first concrete consumer.

**Approach:** Bun-workspaces monorepo with `packages/framework/` (DAG engine, observer interface, node-kind contracts) and `apps/customer-summary/` (HTTP API exposing the customer-summary DAG). The framework borrows good ideas from LangGraph (state graph, conditional edges, checkpointing) but is implemented as a minimal hand-written executor (~300 LOC) for full debuggability — three node kinds (`fetch`, `transform`, `llm`), determinism-maximizing pipeline where deterministic extraction does most of the work and a single Claude synthesis call writes the final overview.

**Key Constraints:**
- TypeScript only, Bun runtime and package manager
- Functional core / imperative shell — pure functions for transform nodes
- Either-based error handling, no thrown exceptions in business logic
- Schema validation at boundaries with zod
- No mocks needed for tests — node-kind separation makes `transform` and `fetch` directly testable; `llm` nodes substitutable
- Minimize LLM calls — one final synthesis call per summary; deterministic extraction does the rest
- Podman for local infra, not Docker
- Claude accessed via the Claude Agent SDK (not the raw Anthropic API)
- MLflow for observability, run locally via podman-compose; not deployed in production yet
- Full state-graph checkpointing (LangGraph-style resume mid-run); Redis used as the checkpoint store and for prompt/semantic LLM caching
- Per-node progress events only (no token-level streaming — this is a batch lookup, not chat)
- Every prompt versioned in git; every MLflow trace tagged with `prompt_version` and `model_version` for drift attribution
- LLM-node outputs validated against a per-node zod schema, using Claude's structured-output feature so LLM steps are parseable and testable

**In Scope:**
- DAG executor with topological scheduling and parallel execution
- Three node kinds (`fetch`, `transform`, `llm`) with typed inputs/outputs (zod-validated)
- Pluggable observer interface with an MLflow observer implementation
- State checkpointing to Redis with resume-mid-run capability
- Redis-backed prompt/semantic cache for LLM calls
- Stub/mock CRM with adapter pattern (`ConversationSource` interface + JSON-fixture adapter)
- Customer-summary DAG: fetch CRM fixture → parse transcript → extract structured features (recency-scored utterances, sentiment markers, topic keywords) → single Claude synthesis call → return overview JSON
- HTTP API endpoint (Hono or similar; framework choice deferred to architecture phase) for a support-agent UI to call
- Local infra via podman-compose (MLflow + Redis)
- Hand-curated golden eval set (~20 CRM fixtures with reference summaries) plus `bun run eval` script using LLM-as-judge rubric, runnable locally and in CI to gate prompt changes
- Per-run cost capture: tokens-in, tokens-out, USD per LLM call recorded as MLflow trace metadata (observer fires on every node, so this is essentially free)
- Prompt registry: system prompts stored as versioned files in `packages/customer-summary/prompts/` (or equivalent), loaded by hash so traces are reproducible

**Out of Scope:**
- Embedding + clustering of chat logs (deferred until recency-only proves insufficient; v1 uses deterministic parsing + recency-based subset selection)
- Real CRM integrations (Salesforce/HubSpot/etc.) — fixtures only
- Token-level LLM streaming
- Production deployment / hosting
- Multiple LLM providers / provider abstraction
- Auth on the HTTP API (assumed run inside trusted internal network)
- UI for the support agent (just the API)
- Multi-tenancy / row-level security (single-tenant internal tool)
- Provider failover / multi-LLM gateway (Claude only; outage tolerated)
- Canary / shadow deploys, feature flags (no deploy yet)
- Kill switch / circuit breakers (batch tool, just stop calling it)
- Tool blast-radius tagging and HITL approvals (no tools in v1; output is read-only advice for an internal employee)
- Indirect prompt-injection mitigation beyond "no tools act on CRM-derived text" (no tool surface in v1)
- PII redaction at MLflow trace boundary (deferred until real CRM data ever enters traces — v1 is fixtures only)

**Open Questions:**
- Exact shape of the `ConversationSource` fixture data (sample size, field schema)
- API request/response shape for the summary endpoint
- Conditional-edges scope: is it needed for the customer-summary DAG, or is the v1 graph fully linear?
- What "intent/mood" features the LLM needs from extraction (so we know what transform nodes to build)
- Cache invalidation strategy for the Redis prompt cache (TTL? key per customer?)
- LLM-as-judge model: same Claude model used for synthesis, or a smaller cheaper one (e.g. Haiku) for eval cost reasons?
- Eval rubric dimensions: factuality vs CRM source, completeness, conciseness, tone — which subset for v1?
- Where do prompts live in the monorepo? `apps/customer-summary/prompts/` or `packages/customer-summary-prompts/`? (Architecture phase decides)
