# Fugue Host — Authentication & Authorization

## Overview

Each Fugue Host instance serves one team. Authentication uses bearer tokens with three tiers:

| Tier | Source | Purpose |
|------|--------|---------|
| **Admin** | `ADMIN_TOKEN` env var | Platform ops: team provisioning, monitoring, full access |
| **User (OIDC)** | `fugue-platform` realm JWT (`REALM_JWT_ISSUER` / `REALM_JWT_AUDIENCE`) | Human-initiated runs: the verified user `sub` is threaded into the run so the capability broker can mint downstream authority per hop *as the user* (ADR-0058) |
| **Team** | Generated via `POST /admin/teams` | Application credential: what services use to call DAGs |

This separation ensures applications never hold the admin key. A leaked team token can be revoked without restarting the host.

The user tier is **verifier-gated and fail-closed**: the JWT path is only entered when a JWKS signature verifier is injected alongside the `iss`/`aud` policy and the `authorizeUserRun` user-run authorization policy — the three travel together as one required group (`RealmJwtDeps`), so a half-wired state (verifier without a run policy) is unrepresentable. The group is deliberately unwired today (pending the JWKS wave), so a JWT-shaped token currently 401s — it never degrades to a weaker identity. See ADR-0058 for the full design.

Setting `REALM_JWT_ISSUER` also selects the live Keycloak capability broker for per-hop downstream-scope minting; the broker is gated by `AGENT_CLIENT_SCOPES`, a fail-closed JSON policy mapping each agent client to its allowed `provider:operation` scopes — an absent client or scope mints nothing (a client with no entry has no scopes). For the Teams approval / Bot Framework endpoints (`POST /runs/:runId/approve`, `POST /teams/messages`), see [`hitl-teams.md`](./hitl-teams.md).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Request Flow                                         │
│                                                                             │
│  Application                                                                │
│  Authorization: Bearer fug_...                                              │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Auth Middleware  (order admin → JWT → team is load-bearing)          │   │
│  │                                                                       │   │
│  │  1. Is it ADMIN_TOKEN?  (constant-time comparison)                   │   │
│  │     → identity = admin  → full access                                │   │
│  │                                                                       │   │
│  │  2. JWT-shaped (a.b.c, not fug_) AND verifier configured?            │   │
│  │     → verify signature (injected JWKS verifier)                      │   │
│  │     → validate claims (iss = realm, aud = fugue-host, exp)           │   │
│  │     → identity = { user, sub, azp, canRunDag }                       │   │
│  │     FAIL CLOSED: any failure → 401/503, never falls through          │   │
│  │     (verifier unwired today → JWT-shaped tokens 401)                 │   │
│  │                                                                       │   │
│  │  3. SHA-256(token) → Redis lookup                                    │   │
│  │     → identity = { team, label }  → team-scoped access              │   │
│  │                                                                       │   │
│  │  4. Not found → 401 Unauthorized                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Authorization check (for DAG endpoints)                              │   │
│  │  identity.team === dag.team → allowed                                │   │
│  │  identity.kind === "admin" → always allowed                          │   │
│  │  identity.kind === "user" → gated by the authorizeUserRun policy     │   │
│  │    (required RealmJwtDeps member, decided at the verifier wiring     │   │
│  │    site; may refuse → 403); downstream authorization is              │   │
│  │    additionally enforced per-hop by the capability broker            │   │
│  │  mismatch → 403 Forbidden                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Setup Guide

### 1. Generate and set the admin token

The admin token is the root of trust. Generate it once, store it securely.

```bash
# Generate (any strong random method)
ADMIN_TOKEN=$(openssl rand -base64 32)
echo "Admin token: $ADMIN_TOKEN"
# Store in your secret manager (Vault, 1Password, K8s secrets)
```

Requirements:
- Minimum 16 characters (enforced at startup — host won't boot without it)
- Recommended: 32+ bytes of cryptographic randomness

### 2. Start the host

```bash
ADMIN_TOKEN="$ADMIN_TOKEN" \
REDIS_URL="redis://localhost:6379" \
DAGS_REPO_URL="https://github.com/your-org/team-dags.git" \
LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-proj-team-key \
bun run packages/host/src/main.ts
```

### 3. Provision the team (one-time at deploy)

```bash
curl -X POST http://fugue-host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team": "cx",
    "label": "CX team production"
  }'
```

**Response (201 Created):**
```json
{
  "ok": true,
  "token": "fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef",
  "team": "cx",
  "label": "CX team production"
}
```

> ⚠️ **The token is shown ONCE.** Only the SHA-256 hash is stored in Redis. Save it immediately.

### 4. Configure the team's applications

Store the `fug_...` token wherever the team's services read secrets from:

```bash
# Kubernetes secret
kubectl create secret generic fugue-token \
  --namespace=cx-apps \
  --from-literal=FUGUE_TOKEN="fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef"

# Or in CI/CD variables, 1Password, Vault, etc.
```

### 5. Applications call DAGs

```bash
curl -X POST http://fugue-host:3000/dags/customer-summary/run \
  -H "Authorization: Bearer fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-001"}'
```

---

## Admin API Reference

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

### POST /admin/teams — Create a team token

**Request:**
```json
{
  "team": "cx",
  "label": "CX team production"
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `team` | Yes | Lowercase alphanumeric + hyphens. Start/end with alphanumeric. Regex: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` |
| `label` | No | Free-text. Defaults to `"<team> token"` |

**Valid team names:** `cx`, `team-a`, `ml-platform`, `data-eng-v2`
**Invalid:** `Team-A` (uppercase), `-team` (leading hyphen), `team_a` (underscore)

**Responses:**

| Status | When |
|--------|------|
| 201 | Token created — `{ ok, token, team, label }` |
| 400 | Missing/invalid team name |
| 409 | Team already has a token (revoke first) |
| 403 | Not using admin token |

**Race safety:** Uses Redis `SETNX` for atomic team claim. Concurrent creates for the same team: one wins, other gets 409.

---

### GET /admin/teams — List teams

**Response (200):**
```json
{
  "ok": true,
  "teams": [
    { "team": "cx", "label": "CX team production", "createdAt": 1716393600000 }
  ],
  "count": 1
}
```

No tokens or hashes are returned.

---

### DELETE /admin/teams/:team — Revoke a token

```bash
curl -X DELETE http://fugue-host:3000/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response (200):**
```json
{ "ok": true, "team": "cx", "revoked": true }
```

- **Immediate** — next request with old token gets 401
- **Idempotent** — revoking non-existent team returns 200
- In-flight requests with the old token will complete; new ones are rejected

---

## Token Rotation

No explicit rotate endpoint. Workflow is revoke → re-create:

```bash
# 1. Revoke old token
curl -X DELETE http://fugue-host:3000/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 2. Create new token
curl -X POST http://fugue-host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "cx", "label": "CX team (rotated 2026-06)"}'

# 3. Update team's applications with new token
```

**Downtime window:** Between revoke and app update, requests fail with 401. Minimize by:
- Coordinating during maintenance window
- Having the app retry on 401 and alert for credential refresh

---

## Security Model

### Token anatomy

```
fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef
│    └──────────────────────────────────────────────────────┘
│    43+ chars of base64url-encoded cryptographic randomness (32 bytes = 256 bits)
│
└── "fug_" prefix — makes tokens greppable in logs, .env files, audit trails
```

### What's stored where

| Datum | Location | Notes |
|-------|----------|-------|
| Admin token | `ADMIN_TOKEN` env var (host process memory) | Never persisted to Redis |
| Raw team token (`fug_...`) | Returned once at creation | Never stored server-side |
| Token SHA-256 hash | `fugue:tokens:<hash>` in Redis | Used for lookup on each request |
| Team→hash reverse index | `fugue:teams:<team>` in Redis | Used for revocation and listing |

### Timing attack prevention

- **Admin token:** Constant-time comparison (`constantTimeEqual`) — iterates full max-length regardless of content
- **Team token:** SHA-256 hash then equality check on fixed-length hex strings (inherently constant-time)

### What happens when Redis goes down

- Admin token still works (env var comparison, no Redis)
- Team token resolution fails → 503 "auth-service-unavailable" (not 401)
- Host enters `degraded` state, recovers automatically when Redis returns

---

## DAG Ownership

A DAG's team is determined by (in precedence order):

1. **`fugue.yaml` `team` field** — explicit declaration (recommended)
2. **Path convention** — `dags/{team}/{dag-name}/dag.ts`

Since you deploy one host per team, all DAGs in the repo typically belong to the same team. The `fugue.yaml` makes this explicit:

```yaml
# dags/cx/customer-summary/fugue.yaml
team: cx
```

Authorization check: `identity.team === dag.team` → allowed. Admin always allowed. A `user` identity is gated by the `authorizeUserRun` policy decided at the verifier wiring site (a required member of `RealmJwtDeps`, carried on the identity as `canRunDag`): the policy receives the DAG's team and may refuse — a refused user 403s. A user is not bound to a single host-side team the way a team token is; downstream authorization is additionally enforced per-hop by the capability broker's realm policy (ADR-0058).

---

## API Endpoint Overview

### Unauthenticated (health probes)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness — always `200` if process alive |
| `GET` | `/readiness` | Readiness — `200` with `dagCount` when serving |

### Admin (`ADMIN_TOKEN` required)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/admin/teams` | Create team token |
| `GET` | `/admin/teams` | List teams |
| `DELETE` | `/admin/teams/:team` | Revoke team token |

### DAG endpoints (any valid token)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/dags` | List registered DAGs |
| `GET` | `/dags/:id/manifest` | DAG schema/structure manifest |
| `POST` | `/dags/:id/run` | Execute a DAG |
| `POST` | `/<custom-route>` | Execute via route override |

---

## Operational Runbook

### Team lost their token

```bash
# Revoke (it's gone anyway)
curl -X DELETE http://fugue-host:3000/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Re-create
curl -X POST http://fugue-host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "cx", "label": "CX team (re-issued 2026-06-09)"}'

# Distribute new token to team's apps
```

### Redis wiped / recovered from backup

All team tokens are in Redis. If wiped:
1. Admin token still works (env var)
2. Re-provision the team: `POST /admin/teams`
3. Distribute new token

### Audit who has access

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://fugue-host:3000/admin/teams
```

### Suspect a token is compromised

```bash
# Revoke immediately
curl -X DELETE http://fugue-host:3000/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Issue new token
curl -X POST http://fugue-host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "cx", "label": "CX team (rotated after compromise)"}'
```

The old token stops working immediately on revocation.

---

## FAQ

**Q: Why not just use the admin token for everything?**
Separation of privilege. If an application credential leaks, you revoke just that team token without restarting the host or affecting admin access. The admin token is for ops, the team token is for apps.

**Q: Can the admin token call DAGs?**
Yes. Admin identity bypasses team checks — useful for debugging and monitoring.

**Q: Can one team have multiple tokens?**
Not currently. One token per team name. If you need multiple app credentials (staging service, cron job, etc.), model them as separate teams: `cx-api`, `cx-cron`.

**Q: What's the token entropy?**
32 bytes (256 bits) via `crypto.getRandomValues()`. Computationally infeasible to brute-force.

**Q: Is there rate limiting?**
Not at the auth layer. Per-DAG concurrency limits (`maxConcurrent`) provide backpressure — excess requests get 429 with `Retry-After`.

**Q: What if `ADMIN_TOKEN` isn't set?**
Host refuses to start with a config validation error. It's non-negotiable.

**Q: Can I share the same `ADMIN_TOKEN` across multiple host instances?**
Yes. It's a simple string comparison — no Redis coordination needed. Useful if one ops team manages multiple host instances.
