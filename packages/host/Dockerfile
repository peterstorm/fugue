# Fugue Host — Production container
# Uses Bun runtime for performance + TypeScript execution without compile step

FROM oven/bun:1.2-alpine

# Git is required for DAG repository sync (AD-5: raw git via Bun.spawn)
RUN apk add --no-cache git

WORKDIR /app

# Copy workspace root files for bun install resolution
COPY package.json bun.lock ./
COPY packages/host/package.json packages/host/package.json
COPY packages/framework/package.json packages/framework/package.json

# Install dependencies with frozen lockfile for reproducibility
RUN bun install --frozen-lockfile --production

# Copy source code
COPY packages/framework/ packages/framework/
COPY packages/host/ packages/host/

# Non-root user for security
RUN adduser -D -g '' fugue
USER fugue

# Default port (overridable via PORT env var)
EXPOSE 3000

# Health check via the /health endpoint
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

# Run the host entry point
CMD ["bun", "run", "packages/host/src/main.ts"]
