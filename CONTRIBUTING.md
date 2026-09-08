# Contributing to Fugue

## Canonical verification

From the repository root, install the locked dependency graph and run the one contributor gate:

```bash
bun install --frozen-lockfile
bun run verify
```

Run the frozen install before the gate. `bun run verify` verifies the checkout; it does not install dependencies or rewrite the lockfile.

The gate runs these phases in fail-fast order:

1. verify the exact production Bun runtime and the Redis prerequisites;
2. run every one of the 12 workspace `typecheck` scripts, then the root script compiler tier;
3. check relative links in shipped package documentation;
4. run the root script tests;
5. run every one of the 12 workspace `test` scripts.

Workspace package scripts remain the authority for package-specific behavior. In particular, the framework `typecheck` script checks both `src` and the published `bin/fugue.ts` CLI through `tsconfig.bin.json`.

The root `tsconfig.scripts.json` is deliberately narrower than every file under `scripts/`. It covers the verification implementation, all root script tests, and the existing shipped-doc checker. It does not claim to typecheck the unrelated deployment smoke scripts, which have pre-existing type errors outside this verification change.

## Prerequisites

The local gate fails closed unless all of the following are true:

- **Bun 1.4.2 exactly.** The production source of truth is [`packages/host/Dockerfile`](packages/host/Dockerfile). A different patch, including Bun 1.3.13, is rejected before verification starts.
- **Bash** is available for the thin, sequential verification shell.
- **`redis-server` is in `PATH`.** One host test starts its own isolated Unix-socket Redis process, so a remote Redis URL does not replace the executable.
- **`REDIS_URL` is a valid, non-blank `redis://` or `rediss://` URL pointing to a reachable, ACL-capable disposable test server that authorizes the connection.** Server authentication is an optional Redis policy: credentials are required when the server requires them, while an enabled default user may authorize an uncredentialed URL. The preflight proves connection authorization, `PING`, and `ACL CAT` before any Redis-gated suite can silently skip. The canonical setup below and CI deliberately prove the password-authenticated shape.

Install Bun 1.4.2 with the official installer or your version manager, then confirm `bun --version` prints `1.4.2`. Do not substitute `latest`: runtime drift is the defect this gate prevents.

### Start a disposable local Redis

The real integration suites write fixtures and create/delete ACL users. **Never point `REDIS_URL` at production or at a shared development server.** The verification gate probes the server but does not start, own, reset, or stop it; lifecycle remains the caller's responsibility.

This Bash example binds an authenticated, non-persistent server to loopback and stops only the process it started. It uses isolated test port `6389`; do not use `16379`, which framework failure-path tests reserve as a deliberately dead endpoint. Pick another unused, non-sentinel port if `6389` is occupied.

```bash
redis_dir=$(mktemp -d)
redis_password=$(openssl rand -hex 24)
redis_port=6389

redis-server \
  --bind 127.0.0.1 \
  --protected-mode yes \
  --port "$redis_port" \
  --save "" \
  --appendonly no \
  --dir "$redis_dir" \
  --requirepass "$redis_password" \
  >"$redis_dir/redis.log" 2>&1 &
redis_pid=$!

cleanup_redis() {
  kill "$redis_pid" 2>/dev/null || true
  wait "$redis_pid" 2>/dev/null || true
  rm -rf "$redis_dir"
}
trap cleanup_redis EXIT INT TERM

sleep 0.25
export REDIS_URL="redis://default:${redis_password}@127.0.0.1:${redis_port}"

bun install --frozen-lockfile
bun run verify
```

`bun run infra:up` and package-focused test commands remain useful development tools, but they are not substitutes for this exact-runtime, fail-closed repository gate. With Podman and `redis-cli` available, `bun run test:redis` is a convenient narrower helper: it owns a temporary Redis container on a loopback ephemeral port and runs only the workspace test scripts. It does not run prerequisite, typecheck, documentation, root-script, or production-image Oracle gates, so it is not the canonical parity command.

## Focused development commands

Use focused commands while iterating, then finish with `bun run verify`:

```bash
bun run typecheck:scripts
bun run check:docs
bun run test:scripts

(cd packages/framework && bun run typecheck && bun run test)
(cd packages/host && bun run typecheck && bun run test)
```

Package-only tests are intentionally narrower. Redis-gated suites can skip when `REDIS_URL` is absent, and package commands do not prove all workspaces, root scripts, shipped documentation, or the production-image Oracle control.

## Production-image Oracle control

`bun run verify` alone does **not** prove that the Oracle thin driver loads in the original production base image. CI and release require a second job that runs `scripts/oracle-driver-smoke.ts` in exactly `oven/bun:1.4.2-alpine`. The smoke is secret-free and deliberately connects only to an unreachable loopback target; success proves driver load and network-path entry, not live database connectivity.

To reproduce that one image-specific control manually without changing the host Bun or host `node_modules`, create a source-only snapshot, mount it read-only, copy it into the container's temporary filesystem, and install there:

```bash
snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT

git ls-files --cached --others --exclude-standard -z \
  | tar --null --files-from=- -cf - \
  | tar -C "$snapshot" -xf -

docker run --rm \
  --mount "type=bind,src=$snapshot,dst=/checkout,readonly" \
  oven/bun:1.4.2-alpine \
  sh -eu -c '
    work=$(mktemp -d)
    cp -R /checkout/. "$work/repo"
    cd "$work/repo"
    bun install --frozen-lockfile
    bun scripts/oracle-driver-smoke.ts
  '
```

`podman` can replace `docker` if it supports the same bind-mount syntax. The source mount is read-only, ignored files such as local secrets and `node_modules` are excluded, and the container creates a fresh locked install in its own disposable filesystem.

The real Oracle proof is separate: the OpenShift Argo PostSync Job in [`packages/host/deploy/multi-tenant-openshift.yaml`](packages/host/deploy/multi-tenant-openshift.yaml) runs `SELECT 1 FROM DUAL` from the shipped host image where the SealedSecret and network route exist. GitHub verification has neither and makes no live-connectivity claim.

## CI and release verification

Both [CI](.github/workflows/ci.yml) and [release](.github/workflows/release.yaml) call the same reusable [`verify.yml`](.github/workflows/verify.yml). Its two required jobs are:

- **`workspace-gate`** — frozen install, disposable Redis setup, then exactly `bun run verify`;
- **`original-image-oracle-smoke`** — frozen install and the secret-free Oracle smoke in the original Bun 1.4.2 Alpine image.

A caller succeeds only when both jobs succeed. Release-specific version, tarball, registry, OIDC, and publication logic remains in `release.yaml`; it is not part of the local repository command.

## Release process

Nine public packages release in lockstep and in dependency order:

`framework`, `document-source`, `xlsx`, `adapter-fs`, `adapter-ms-graph`, `adapter-pg`, `adapter-oracle` (`@fuguejs/oracle`), `http-auth`, then `host`.

### Safe workflow dry run

Manual workflow dispatch is structurally **dry-run only**. It runs shared verification, checks the expected version in all nine package manifests, packs and validates all nine tarballs, and reports the publication step as skipped.

```bash
gh workflow run release.yaml --ref <checkout-ref> -f release-tag=v0.5.1
```

`release-tag` supplies the expected version; it is **not** an alternate checkout ref. `--ref` selects the branch or commit whose workflow and source GitHub checks out. Use the version actually present at that checkout.

Do not create or push a release tag merely to test the workflow. Only an authorized `v*` tag push can enter the publication step; manual dispatch cannot publish and has no publish override.

### Version and artifact invariants

Before an authorized release:

1. keep all nine public `package.json` versions identical to the intended `v<version>` tag;
2. update the workspace `version` records in `bun.lock` as well — `bun install` does not reliably refresh those records after a package-version-only bump;
3. run the frozen install and full verification against Bun 1.4.2;
4. use the dry run to validate GitHub's reusable-workflow graph and every tarball.

`bun pm pack` rewrites `workspace:*` dependencies from lockfile workspace metadata. A stale lockfile can therefore produce valid-looking tarballs pinned to an old sibling version; version 0.1.4 was published with that defect. The release workflow extracts every tarball and refuses stale `@fuguejs/*` pins before any package can publish.

All nine public `@fuguejs/*` packages use npm OIDC trusted publishing with provenance; there is no `NPM_TOKEN`. Each package's `repository.url` must exactly match this GitHub repository, and the npm trusted-publisher configuration must name this owner/repository and workflow file `release.yaml`. A mismatch can surface as the misleading `ENEEDAUTH` error (npm/cli#9088).

The release runner uses Node 24 because trusted publishing requires npm 11.5.1 or newer. Do not downgrade that npm surface without revalidating OIDC.

npm allows trusted-publisher configuration only after a package exists. For a brand-new public package, an authorized maintainer must perform the first publication from an authenticated shell, immediately configure its GitHub Actions trusted publisher, add it to the ordered release list, and validate the next release through the dry run. `@fuguejs/oracle` and `@fuguejs/http-auth` historically exposed this footgun when their first version existed but trusted publishing had not yet been configured.

Publication uses already-built, validated tarballs and skips versions already present on npm. That makes a partially published release recoverable by fixing forward to a new patch version; do not overwrite or reuse an existing release version.
