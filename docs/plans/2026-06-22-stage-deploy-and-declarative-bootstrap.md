# Fugue stage deploy — state, blocker, and the declarative-bootstrap change

**Date:** 2026-06-22
**Status:** fugue-host + redis are GREEN on the **stage** cluster (dk-secondbrands). The
deployment is blocked at the **last step**: registering the `business-sales` tenant +
minting lead-desk's team token. Both are imperative `POST /admin/*` calls to a
**Route-less** host, and the operator (`hansen142`) has **no `exec`/`port-forward`** RBAC
in the namespace → no way to reach the admin API. **Decision: add a declarative
bootstrap path to the host so tenants + team tokens seed from mounted config/secrets at
supervisor startup (GitOps, no exec).** This doc is the self-contained handoff to resume.

---

## 1. What is deployed and working (stage, cluster `api-stage-nextrel-tre-se`, ns `dk-secondbrands`)

- **redis** — Running. `redis-service:6379`, password in `redis-secret` (sealed, URL-safe hex).
- **fugue-host** — Running, `/readiness` green, **0 tenants** (nothing to serve yet).
  Topology: thin-init (PID1) → supervisor → per-tenant workers (none spawned yet).
- **lead-desk** — NOT up; its ArgoCD app is OutOfSync/degraded because `lead-desk-secret`
  (the `fug_` team token) doesn't exist yet. Expected until provisioning is done.
- Topology is **multi-tenant single-host** (ADR-0064), lead-scoring-only for now
  (no Azure; supervisor + worker boot on a dummy `anthropic` key).

### Images (ALL `linux/amd64`, in Quay `quay.om.tre.se/dk-secondbrands/`)
| Image | Tag | Source |
|-------|-----|--------|
| `fugue-host` | `sha-4883487aa94280df0c65b49869c349126c28502b` | fugue repo HEAD (dagsRoot impl) |
| `fugue-dags-business-sales` | `sha-b233bf70afdd1ff56f361ebc8f90a6653d3d173e` | fugue-dags `main` HEAD, `--build-arg TEAM=business-sales` |
| `fugue-business-sales-data` | `sha-b233bf70afdd1ff56f361ebc8f90a6653d3d173e` | fugue-dags `Dockerfile.data` (workbooks) |
| `lead-desk` | `sha-72068fce9beaa48c31ff484012e7fc02465319a6` | lead-desk `feat/0.2.0-membership-signals` HEAD |

> Built locally on Apple-Silicon, so they were initially arm64 → `Exec format error` on
> amd64 nodes. **Rebuilt with `--platform=linux/amd64` and re-pushed under the same tags.**
> Because the tags were overwritten, stage uses `imagePullPolicy: Always` to defeat the
> node's stale arm64 cache. Long-term: let CI build (amd64 runners → GHCR → Quay mirror).

---

## 2. Branches (all pushed; NOT merged to main/master — open PRs to deploy via ArgoCD)

| Repo | Branch | HEAD | Contents |
|------|--------|------|----------|
| `agentic/fugue` | `feat/multi-tenant-single-host` | `4883487` | per-tenant `dagsRoot` impl + multi-tenant deploy docs/manifest (this is where the bootstrap code change goes) |
| `devops/kube_apps_openshift` | `feature/fugue-host-multi-tenant` | `12876bd` | fugue-host/{stage,prod}, redis/stage, lead-desk/stage, sealed secrets, DEPLOY.md |
| `devops/argocd` | `feature/fugue-host-argocd-stage` | `8ac7892` | dk-secondbrands/values.yaml: fugue-host `[stage]`, lead-desk `[stage]`, redis `[stage,prod]` |
| `devops/stage-cluster` | `feature/fugue-host-redis-netpolicies` | `c6831ca` | netpolicies for fugue-host + redis + lead-desk (Azure FQDN PoliMorphPolicy removed) |

> The argocd repo's working tree may sit on `flexii-boost-mcp` (someone else's WIP +
> a `cm-atlas` change) — my change is on `feature/fugue-host-argocd-stage`, already pushed.

### Sealed secrets (stage cert) already committed in kube_apps
- `redis-secret` → `REDIS_PASSWORD` (URL-safe hex; **redis itself does NOT enforce it** —
  `requirepass` is not set; see Gotcha #6).
- `fugue-host-secret` → `ADMIN_TOKEN` (also saved at `/tmp/fugue-stage-admin-token` —
  ephemeral!) + `SUPERVISOR_HMAC_KEY`.
- `fugue-tenant-business-sales` → `business-sales.env` = `LLM_PROVIDER=anthropic` +
  `ANTHROPIC_API_KEY=sk-ant-dummy-boot-only` (lead-scoring-only; swap to Azure later).
- `lead-desk-secret` → **placeholder** (`FUGUE_TEAM_TOKEN` not sealed — needs the `fug_`).

---

## 3. THE BLOCKER

`business-sales` must be (a) **registered as a tenant** and (b) given a **team token** for
lead-desk. Today both are imperative admin API calls:
```
POST /admin/tenants/business-sales   { team, dagsRoot, secretsRef, fsRoot, keycloakClientMapping, admission, eagerPin }
POST /admin/teams                     { team: "business-sales" }   → returns a fug_ token (shown once)
```
The host has **no Route** (holds admin/team tokens; cluster-internal only), so reaching it
needs in-cluster access. `oc auth can-i` for `hansen142` in `dk-secondbrands`:
`pods/exec=no, pods/portforward=no, delete pods=no, create jobs/secrets/configmaps/routes=no`.
→ **No path to the admin API.** Tenant registration is runtime Redis state, not a manifest,
so there is no GitOps workaround today.

If a cluster-admin / someone WITH `exec` appears, these unblock it immediately (use the
pod's own `$ADMIN_TOKEN` env so nothing leaks):
```bash
POD=$(oc get pods -n dk-secondbrands -l app=fugue-host -o jsonpath='{.items[0].metadata.name}')
oc exec -n dk-secondbrands "$POD" -c fugue-host -- sh -c \
 'wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" --header="Content-Type: application/json" \
   --post-data="{\"team\":\"business-sales\",\"dagsRoot\":\"/dags/business-sales\",\"secretsRef\":\"/run/secrets/fugue-tenants/business-sales.env\",\"fsRoot\":\"/data\",\"keycloakClientMapping\":{\"realm\":\"fugue-platform\",\"clientId\":\"fugue-host-business-sales\",\"agentClientIdsByDag\":{}},\"admission\":{\"maxConcurrentRuns\":10,\"maxQueuedRuns\":20},\"eagerPin\":true}" \
   http://localhost:3000/admin/tenants/business-sales'
oc exec -n dk-secondbrands "$POD" -c fugue-host -- sh -c \
 'wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" --header="Content-Type: application/json" \
   --post-data="{\"team\":\"business-sales\"}" http://localhost:3000/admin/teams'
```
Then seal the returned token into `lead-desk/stage/sealedsecret.yaml` (`FUGUE_TEAM_TOKEN`).

---

## 4. THE FIX — declarative bootstrap at supervisor startup (the code change to build)

Goal: seed tenants + team tokens from **mounted config/secrets** at boot, idempotently, so
a GitOps deploy (ConfigMap + SealedSecret + ArgoCD) needs **no exec**. All in
`agentic/fugue`, branch `feat/multi-tenant-single-host`.

### 4a. Tenant bootstrap
- **New config** (`packages/host/src/domain/config.ts`): `TENANTS_BOOTSTRAP_PATH` (a mounted
  file path; JSON array of tenant configs) — file, not inline env, so it can be a ConfigMap
  and isn't size-bound. (Optional sibling `TENANTS_BOOTSTRAP` inline JSON for tests.)
- **Seam**: `packages/host/src/main-supervisor.ts`, immediately AFTER `registry.hydrate()`
  succeeds (~line 224). Read+parse the file → for each entry build a `TenantConfigBase` and
  call the registry's `register` (idempotent — re-applying identical config is a no-op,
  see `tenant-registry.ts`). Fail-closed: a malformed entry aborts boot (parse-don't-validate).
- The file is **non-secret** (team, dagsRoot, secretsRef *path*, fsRoot, keycloak mapping,
  admission, eagerPin) → ships as a ConfigMap. Per-tenant secrets stay in their sealed
  env-file at `secretsRef` (unchanged).
- Reuse the exact parse already in `http/handlers/admin/tenants.ts` (the body→`TenantConfigBase`
  builder + `tenantConfig` smart constructor) — extract it to a shared pure helper so the
  admin handler and the bootstrap path share one validated parser.

### 4b. Team-token bootstrap (the harder half)
- Today `POST /admin/teams` MINTS a random `fug_` token and stores only its **hash**
  (`domain/auth.ts` `hashToken`/`formatToken`; `adapters/token-store.ts` `store(team, hash, grant)`).
  For GitOps we must instead **accept a pre-provided token** (sealed once, mounted to BOTH
  host and lead-desk) and register its hash at boot — no capture step.
- **New config**: `TEAM_TOKENS_BOOTSTRAP_PATH` → a mounted **secret** file mapping
  `team → token` (e.g. JSON `{"business-sales":"fug_...."}` or `KEY=VALUE`). Sealed secret.
- **Seam**: after the token store is constructed in `main-supervisor.ts`, for each entry:
  `hashToken(token)` → `tokenStore.store(team, hash, grant)`. Make it **idempotent/upsert**
  (today `store` errors `team-already-exists`; bootstrap should treat an identical
  team+hash as a no-op, or upsert). The token store is **per-tenant** (keys
  `fugue:<tenant>:teams:*`) — confirm which tenant's store the team token belongs to and
  bootstrap against that tenant's store (the team→tenant mapping is 1:1).
- The operator generates a token (any high-entropy string, or keep the `fug_` shape), seals
  it once into a secret mounted at `TEAM_TOKENS_BOOTSTRAP_PATH` on the host AND into
  `lead-desk-secret` (`FUGUE_TEAM_TOKEN`) for lead-desk. Both sides agree, no exec.

### 4c. Tests + docs (match repo standard)
- Pure parser tests (bootstrap file → configs; malformed → error). Supervisor wiring test
  (bootstrap registers idempotently; re-run = no-op). Token bootstrap test (provided token
  → hash stored; re-run idempotent). Update `packages/host/docs/multi-tenant-deployment.md`
  + the devops `DEPLOY.md` with the ConfigMap + sealed-secret bootstrap flow (replacing the
  `oc exec` provisioning step).

### 4d. After the code change — redeploy
Rebuild `fugue-host` **amd64** (new commit SHA) → push to Quay → bump the image tag in
`fugue-host/{stage,prod}/deployment.yaml` → add the tenants ConfigMap + team-token sealed
secret + their volume mounts → commit → ArgoCD sync. Tenant + token seed at boot; lead-desk
comes up. No exec ever needed again.

---

## 5. Gotchas already hit + fixed (don't re-discover these)

1. **ResourceQuota**: ns quota requires `requests.cpu/memory` + `limits.memory` on EVERY
   container incl. initContainers → added to stage-dags + stage-workbooks (stage+prod).
2. **Quay pull perms**: the `dk-secondbrands+devpullmaster` robot needs READ on each new
   repo (`fugue-host`, `fugue-dags-business-sales`, `fugue-business-sales-data`, `lead-desk`).
   Manual pushes create repos the robot isn't auto-granted on. (User granted these.)
3. **Image arch**: local Apple-Silicon builds are arm64 → `Exec format error` on amd64
   nodes. Always `--platform=linux/amd64` (or build in CI). All four rebuilt amd64.
4. **imagePullPolicy**: re-pushing the SAME tag (arm64→amd64) leaves a stale node cache →
   stage set to `Always` to force re-pull. (Prod nodes never cached arm64; left IfNotPresent.)
5. **Supervisor LLM config**: `parseHostConfig` requires a provider + matching key even
   though the supervisor never calls an LLM. Set boot-only dummy `LLM_PROVIDER=anthropic` +
   `ANTHROPIC_API_KEY` pod-wide. Workers still override per-tenant via their env-file.
6. **Redis URL-safe password**: `openssl rand -base64` can yield `/`/`+`/`=`, which breaks
   `redis://:$(PASSWORD)@host` URL parsing → use **hex** (`openssl rand -hex 32`).
7. **Redis password not enforced** (open WARN): the `opstree/redis` deployment never sets
   `requirepass` (configmap has only `protected-mode no`), so the supplied password is
   unused → harmless WARN, redis is netpol-isolated. OPEN DECISION: enforce `requirepass`
   via a `command` override (`redis-server /etc/redis/redis.conf --requirepass "$REDIS_PASSWORD"`)
   for defense-in-depth (redis holds the tenant registry + team tokens), or drop the password.

## 6. `seal` helper (stage cert) + RBAC reality
- `seal <plain-secret.yaml> <out-sealedsecret.yaml>` = `kubeseal --controller-namespace=sealed-secrets --format=yaml -o yaml` against the **logged-in** cluster. Fetching the public cert needs no secret-read RBAC, so sealing works even though `get secrets` is forbidden.
- `gh` is logged in as `peterstorm-oi-flex` with `read:packages` → can build lead-desk locally (BuildKit `--secret id=github_token`) and pull/push GHCR/Quay.
- `hansen142` is effectively **read-only** in `dk-secondbrands` (no exec/portforward/delete/create). All cluster changes go through ArgoCD (commit → sync).

## 7. Remaining checklist
- [x] Implement declarative bootstrap (§4) in `agentic/fugue` (+ tests + docs).
      Shipped on `feat/multi-tenant-single-host`:
      - `packages/host/src/supervisor/registry/parse-tenant-config.ts` — the
        body→`ActiveTenantConfig` parser EXTRACTED from `admin/tenants.ts` and now
        SHARED by the admin path + bootstrap (single validated parser).
      - `packages/host/src/supervisor/bootstrap/parse-bootstrap.ts` — pure parsers
        for the tenants array + the `team→fug_token` map (fail-closed; never logs token).
      - `packages/host/src/supervisor/bootstrap/run-bootstrap.ts` — the I/O shell:
        file read (injected, fail-closed) + idempotent apply (`registry.register`;
        token reconcile: no-op / upsert-on-rotation / cross-team-reuse error /
        team-must-own-active-tenant check).
      - Config: `TENANTS_BOOTSTRAP_PATH` / `TEAM_TOKENS_BOOTSTRAP_PATH` (+ inline
        `TENANTS_BOOTSTRAP` / `TEAM_TOKENS_BOOTSTRAP` for tests) in `domain/config.ts`.
      - Wiring: `main-supervisor.ts` runs `runBootstrap` after the platform token
        store is built; a failure exits non-zero (pod restarts).
      - Tests: `__tests__/supervisor/bootstrap/{parse-bootstrap,run-bootstrap}.test.ts`.
        Docs: `packages/host/docs/multi-tenant-deployment.md` §"Declarative bootstrap".
      > NOTE discovered while implementing: the multi-tenant SUPERVISOR has **no
      > `POST /admin/teams` endpoint at all** (only the per-worker Hono router in
      > `http/router.ts` does). So for the stage topology the team-token bootstrap is
      > the ONLY way to create a team token — §3's `oc exec … /admin/teams` would 404
      > on the supervisor. Tenants still have `POST /admin/tenants` (dispatched in
      > `supervisor.ts`), but bootstrap is the GitOps-friendly path for both.
- [ ] Rebuild fugue-host amd64 → Quay; bump tag in deployment.yaml.
- [ ] Add tenants ConfigMap + team-token sealed secret (+ mounts) to `fugue-host/stage`.
- [ ] Seal a chosen team token into BOTH the host bootstrap secret AND `lead-desk-secret`.
- [ ] Merge the 4 PRs (kube_apps, argocd, stage-cluster, + fugue once published/consumed).
- [ ] Verify: worker spawns (`logs | grep "worker is running"`), lead-desk live at
      `lead-desk.onr.oister.dk`.
- [ ] (Optional) redis `requirepass` decision (Gotcha #7); Azure creds later (re-seal
      `business-sales.env` + re-add the FQDN PoliMorphPolicy).
