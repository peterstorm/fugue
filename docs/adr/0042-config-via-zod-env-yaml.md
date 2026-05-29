# ADR-0042: Config via Zod Env + YAML

## Status
Accepted

## Date
2026-05-20

## Context

The host has two distinct configuration audiences:

1. **Infrastructure operators** configure the host process: Redis URL, git repo URL, port, concurrency limits, API keys, OTel endpoint. These are deployment-environment-specific and may contain secrets.

2. **DAG authors** configure their individual DAGs: team ownership, custom routes, timeout overrides, concurrency limits, required env vars. These are version-controlled alongside DAG code and reviewed in PRs.

These two audiences have different needs: operators want environment variables (12-factor, works with Docker/K8s, secrets injection via vault/sealed-secrets); DAG authors want a readable file committed with their code (explicit, reviewable, self-documenting).

Both configuration sources must be validated at startup — invalid config should fail fast with actionable error messages, not surface as runtime surprises.

## Options Considered

1. **All environment variables**
   - Pros: Simple, 12-factor pure, works everywhere
   - Cons: Too many knobs for per-DAG config (dozens of env vars), naming collisions between DAGs, no way to version-control DAG-specific config alongside DAG code, secrets and non-secrets mixed

2. **All YAML (single config file)**
   - Pros: Readable, structured, one place for everything
   - Cons: Infrastructure secrets don't belong in git, doesn't integrate with container orchestrators' secret injection, single file for host + all DAGs gets unwieldy

3. **JSON config files**
   - Pros: Parseable, typed
   - Cons: Less readable than YAML for humans (no comments, verbose syntax), same secret-exposure problem as YAML for host config

4. **Env vars for host config + YAML for per-DAG config, both validated with Zod**
   - Pros: Each audience gets the right tool (operators use env vars, DAG authors use files), secrets stay out of git, per-DAG config is version-controlled with DAG code, Zod provides runtime validation with typed output and actionable error messages, coercion handles string→number for env vars
   - Cons: Two config mechanisms to understand (but they serve different audiences)

## Decision
**Host-level config from Zod-validated environment variables. Per-DAG config from `fugue.yaml` colocated with DAG code, validated with Zod.**

### Host Config (`HostConfigSchema`)

Parsed from `process.env` at startup. Key fields:
- `DAGS_REPO_URL` / `DAGS_REPO_BRANCH` / `DAGS_POLL_INTERVAL_MS` — git sync
- `REDIS_URL` — required, hard dependency
- `PORT` — HTTP listen port (default: 3000)
- `MAX_GLOBAL_CONCURRENCY` / `DEFAULT_DAG_CONCURRENCY` — capacity limits
- `LLM_PROVIDER` + API keys — LLM client configuration
- `OTEL_EXPORTER_OTLP_ENDPOINT` — observability
- `CIRCUIT_BREAKER_THRESHOLD` / `CIRCUIT_BREAKER_WINDOW_MS` — breaker config

All optional fields have sensible defaults. Zod's `.coerce` handles string→number parsing. Validation failure at startup prints each invalid field with its constraint and exits non-zero.

### Per-DAG Config (`FugueYamlSchema`)

Parsed from `fugue.yaml` in each DAG directory during import:
- `team` (required) — ownership for attribution
- `owner` — individual owner
- `env` — list of required environment variable names
- `maxConcurrent` / `timeoutMs` — per-DAG limit overrides
- `route` — custom HTTP route override
- `cacheTtlMs` / `checkpointTtlMs` — TTL overrides

Implementation at `packages/host/src/domain/config.ts`. Both parse functions return `Result<Config, HostError>` — never throw.

## Consequences

**Positive:**
- Fail-fast: invalid config surfaces immediately at startup with structured Zod error messages listing exactly which fields failed and why.
- Secrets never enter git — API keys, Redis URLs stay in environment variables managed by infrastructure.
- Per-DAG config lives with DAG code — reviewable in PRs, versioned with git, self-documenting.
- Type safety: parsed config is a fully-typed TypeScript object — no `process.env["MAYBE_TYPO"]` string access in business logic.
- `Result` return type means config parsing composes cleanly with the host's functional error handling.

**Negative:**
- Two config mechanisms add cognitive overhead for someone new to the project. Mitigated: clear separation of concerns (host vs DAG) makes the split intuitive.
- Environment variables are flat — deeply nested config isn't natural. Accepted: host config is intentionally shallow (limits, URLs, keys).
- YAML parsing adds a runtime dependency (`yaml` library). The cost is negligible.
