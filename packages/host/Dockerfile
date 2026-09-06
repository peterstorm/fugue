# Fugue Host — Production container
# Uses Bun runtime for performance + TypeScript execution without compile step

# Pinned to an exact patch, and ci.yml pins `bun-version` + the oracle-smoke
# container to the SAME version — a CI run is only evidence about production if it
# executed production's runtime. Bump all three together (see ADR-0084).
FROM oven/bun:1.4.2-alpine

# Git is required for DAG repository sync (AD-5: raw git via Bun.spawn).
# openssh-client is required because DAGS_REPO_URL is an ssh:// stash URL
# (ssh://git@stash.tre.se:7999/...) — alpine's git package does NOT bundle ssh,
# so `git clone` over ssh fails without it. The deploy key + known_hosts are
# mounted at runtime and selected via GIT_SSH_COMMAND (inherited by Bun.spawn).
RUN apk add --no-cache git openssh-client

WORKDIR /app

# Copy workspace root files for bun install resolution
COPY package.json bun.lock ./

# --frozen-lockfile validates the resolved workspace graph against the committed
# bun.lock, which records ALL workspace members. Every member's package.json must
# be present or the install fails ("lockfile had changes" / "workspace dependency
# not found"). We copy only the manifests (cheap) here; source for members the
# host never imports is omitted below.
COPY packages/framework/package.json packages/framework/package.json
COPY packages/host/package.json packages/host/package.json
COPY packages/adapter-fs/package.json packages/adapter-fs/package.json
COPY packages/document-source/package.json packages/document-source/package.json
COPY packages/adapter-ms-graph/package.json packages/adapter-ms-graph/package.json
COPY packages/adapter-pg/package.json packages/adapter-pg/package.json
COPY packages/adapter-oracle/package.json packages/adapter-oracle/package.json
COPY packages/http-auth/package.json packages/http-auth/package.json
COPY packages/xlsx/package.json packages/xlsx/package.json
COPY packages/examples/package.json packages/examples/package.json
COPY apps/customer-summary/package.json apps/customer-summary/package.json
COPY examples/hitl-smoke/package.json examples/hitl-smoke/package.json

# Install dependencies with frozen lockfile for reproducibility
RUN bun install --frozen-lockfile --production

# Copy source for the host's runtime closure only. main.ts dynamically imports
# @fuguejs/fs when DOCUMENTS_ADAPTER=fs (which the lead DAGs require); @fuguejs/fs
# pulls in @fuguejs/document-source, and everything depends on @fuguejs/framework.
# @fuguejs/ms-graph is the DOCUMENTS_ADAPTER=ms-graph adapter (dynamically imported
# when configured); @fuguejs/oracle + @fuguejs/http-auth are host runtime deps
# (workspace:*) wired in main.ts/worker-main.ts (the `oracle` / `authedHttp`
# capabilities) — their source MUST be present or the worker import fails when
# those capabilities are configured.
COPY packages/framework/ packages/framework/
COPY packages/host/ packages/host/
COPY packages/adapter-fs/ packages/adapter-fs/
COPY packages/document-source/ packages/document-source/
COPY packages/adapter-ms-graph/ packages/adapter-ms-graph/
COPY packages/adapter-oracle/ packages/adapter-oracle/
COPY packages/http-auth/ packages/http-auth/

# Oracle in-cluster smoke-connect (the real SC-006 check, run by the OpenShift
# Job in packages/host/deploy as an Argo PostSync hook). It imports the oracle
# adapter source copied above by relative path and dials Oracle over the cluster
# network using the SealedSecret-injected ORACLE_* env.
COPY scripts/oracle-smoke-connect.ts scripts/oracle-smoke-connect.ts

# Non-root user for security
RUN adduser -D -g '' fugue
USER fugue

# Default port (overridable via PORT env var)
EXPOSE 3000

# Health check: probes the supervisor's UNAUTHENTICATED /health (it owns the single
# inbound TCP listener on PORT — served before auth, so the probe is not 401'd).
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

# Run the MULTI-TENANT pod entry point: thin-init is PID 1 (AD-2). It spawns +
# supervises the supervisor binary, restarting it across crashes WITHOUT killing
# the per-tenant workers (they re-parent to PID 1 and are reaped there; the next
# supervisor re-adopts them via the Redis registry — SC-006). The SINGLE-tenant
# entrypoint (packages/host/src/main.ts) remains supported as a deployment choice
# and can be selected by overriding this CMD.
CMD ["bun", "run", "packages/host/src/main-thin-init.ts"]
