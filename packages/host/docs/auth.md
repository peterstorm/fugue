# Fugue Host — Authentication & Authorization Guide

## Overview

Fugue uses a **team-scoped token auth** system. Every HTTP request (except health probes) requires a bearer token. Tokens are scoped to a **team** — a team's token can only invoke DAGs owned by that team.

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────┐
│   Admin      │ ──────► │  POST /admin/teams  │ ──────► │  Redis       │
│  (ADMIN_TOKEN)│         │  → generates token  │         │  (hash stored)│
└──────────────┘         └─────────────────────┘         └──────────────┘
                                   │
                                   │ returns raw token (once)
                                   ▼
                          ┌─────────────────────┐
                          │  Team receives       │
                          │  "fug_a3x8k9m2..."  │
                          └─────────┬───────────┘
                                    │
                                    ▼
                          ┌─────────────────────┐
                          │  POST /dags/:id/run  │
                          │  Auth: Bearer fug_.. │
                          └─────────────────────┘
```

## Quick Start

### 1. Set the admin token

Generate a strong random string and set it as an environment variable before starting the host:

```bash
# Generate a token (any method — just needs to be 16+ chars)
openssl rand -base64 32

# Set it in your environment
export ADMIN_TOKEN="k7Bx9mQ2pL4vR8nT1wF6jH3cY5aD0gE="
```

The `ADMIN_TOKEN` is **required** — the host will refuse to start without it.

### 2. Start the host

```bash
ADMIN_TOKEN="k7Bx9mQ2pL4vR8nT1wF6jH3cY5aD0gE=" \
REDIS_URL="redis://localhost:6379" \
DAGS_REPO_URL="https://github.com/your-org/dags.git" \
bun run packages/host/src/main.ts
```

### 3. Provision a team

Using the admin token, create a team:

```bash
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer k7Bx9mQ2pL4vR8nT1wF6jH3cY5aD0gE=" \
  -H "Content-Type: application/json" \
  -d '{ "team": "team-a", "label": "Team A production" }'
```

Response (201 Created):
```json
{
  "ok": true,
  "token": "fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gE-abc123xyz",
  "team": "team-a",
  "label": "Team A production"
}
```

> ⚠️ **The token is shown ONCE in this response.** Only the SHA-256 hash is stored. If lost, revoke and create a new one.

### 4. Give the token to the team

Distribute via your org's secret management:
- 1Password / Vault / AWS Secrets Manager
- CI/CD secret variables
- Kubernetes secrets

### 5. Team calls their DAGs

```bash
curl -X POST http://localhost:3000/dags/team-a--summarize/run \
  -H "Authorization: Bearer fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gE-abc123xyz" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Summarize this document..." }'
```

### 6. Cross-team access is blocked

If team-a tries to call team-b's DAG:
```bash
curl -X POST http://localhost:3000/dags/team-b--classifier/run \
  -H "Authorization: Bearer fug_<team-a-token>" \
  -d '{...}'
```

Response (403 Forbidden):
```json
{
  "ok": false,
  "error": "forbidden",
  "message": "Token for team 'team-a' cannot access DAG 'team-b--classifier' (owned by 'team-b')",
  "dagId": "team-b--classifier"
}
```

---

## API Reference

### Unauthenticated Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness probe |
| GET | `/readiness` | Readiness probe (includes DAG count) |

### Admin Endpoints (require `ADMIN_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/teams` | Provision a new team token |
| GET | `/admin/teams` | List all provisioned teams |
| DELETE | `/admin/teams/:team` | Revoke a team's token |

### DAG Endpoints (require any valid token — admin or team)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/dags` | List all registered DAGs |
| POST | `/dags/:id/run` | Execute a DAG (team-scoped) |

---

## Admin Operations

### Create a team

```bash
POST /admin/teams
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "team": "team-name",      # required, lowercase alphanumeric + hyphens
  "label": "Human label"    # optional, defaults to "<team> token"
}
```

**Team name rules:**
- Lowercase alphanumeric characters and hyphens only
- Must start and end with alphanumeric
- Examples: `team-a`, `ml-platform`, `data-eng`

### List teams

```bash
GET /admin/teams
Authorization: Bearer <ADMIN_TOKEN>
```

Response:
```json
{
  "ok": true,
  "teams": [
    { "team": "team-a", "label": "Team A production", "createdAt": 1716393600000 },
    { "team": "team-b", "label": "Team B staging", "createdAt": 1716394200000 }
  ],
  "count": 2
}
```

### Revoke a team's token

```bash
DELETE /admin/teams/team-a
Authorization: Bearer <ADMIN_TOKEN>
```

After revocation, the team's token **immediately stops working**. To give them access again, create a new token.

Revocation is idempotent — revoking a non-existent team returns 200.

### Rotate a team's token

There's no explicit "rotate" endpoint. The workflow is:

1. Create a new token for the team (if team already exists, revoke first)
2. Distribute new token
3. Revoke old token (already done in step 1 if using revoke-then-create)

```bash
# Revoke old
curl -X DELETE http://localhost:3000/admin/teams/team-a \
  -H "Authorization: Bearer <ADMIN_TOKEN>"

# Create new
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "team": "team-a", "label": "Team A rotated" }'
```

---

## Security Model

### Token anatomy

```
fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gE-abc123xyz
│    └─────────────────────────────────────────┘
│    43+ chars of base64url-encoded random bytes (32 bytes entropy)
│
└── prefix (identifies as a Fugue token — greppable in logs)
```

### Storage

- **Raw token**: Never stored. Shown once at creation, then discarded server-side.
- **SHA-256 hash**: Stored in Redis (or in-memory for dev). Used for lookup.
- **Admin token**: Lives only in the `ADMIN_TOKEN` env var. Never persisted to Redis.

### Comparison

- Admin token check uses **constant-time comparison** to prevent timing attacks.
- Team token check uses SHA-256 hashing then an exact-match lookup (hash comparison is inherently constant-time via equality check on fixed-length strings).

### Authorization flow

```
Request arrives
  → Extract bearer token
  → Is it the admin token? (constant-time check)
    → Yes: identity = admin (full access)
    → No: hash token → look up in Redis
      → Found: identity = team (scoped access)
      → Not found: 401 Unauthorized
  → For DAG endpoints: check identity.team === dag.team
    → Mismatch: 403 Forbidden
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_TOKEN` | **Yes** | Admin bearer token (min 16 chars). Used to provision teams and has full DAG access. |
| `REDIS_URL` | **Yes** | Redis connection URL. Token hashes are stored here. |
| `DAGS_REPO_URL` | **Yes** | Git URL for DAG definitions repository. |

---

## FAQ

**Q: What happens if I don't set `ADMIN_TOKEN`?**
The host refuses to start. It's a required config field.

**Q: Can the admin token call DAGs?**
Yes. The admin identity has full access to all DAGs regardless of team.

**Q: What if a team loses their token?**
Revoke the old one and create a new one. There's no way to recover a token — only the hash is stored.

**Q: How is the team associated with a DAG?**
Via the `team` field in `fugue.yaml` at the DAG's root directory. The DAG ID convention is `team-name--dag-name`.

**Q: Can one team have multiple tokens?**
Not currently. One token per team. If you need multiple (e.g., staging vs production), model them as separate teams: `team-a-staging`, `team-a-prod`.

**Q: What's the token entropy?**
32 bytes (256 bits) of cryptographic randomness. More than sufficient for API key security.

**Q: Is there rate limiting per team?**
Not at the auth layer, but per-DAG concurrency limits apply. Each DAG has a `maxConcurrency` setting in its config.
