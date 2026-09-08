# Fugue verification parity implementation plan

## Scope

Unify local, CI, and release correctness verification without changing runtime/domain code, public interfaces, documentation prose, Oracle smoke semantics, or the host-image workflow.

Owned files:

- `package.json` and `bun.lock` only as required for exact root tool/type ownership
- `tsconfig.scripts.json`
- `scripts/verify.sh`
- `scripts/verify-prerequisites.ts`
- `scripts/__tests__/verify-prerequisites.test.ts`
- `scripts/__tests__/verify-shell.test.ts`
- `scripts/__tests__/verification-workflows.test.ts`
- `.github/workflows/verify.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yaml`

## Locked design

1. Preserve the twelve workspace `typecheck` and `test` scripts as the authoritative package gates.
2. Add one root `bun run verify` command with strict sequential order:
   1. prerequisite preflight;
   2. all workspace typechecks plus strict root-script typecheck;
   3. shipped-doc link check;
   4. root script tests;
   5. all workspace tests.
3. Keep `scripts/verify.sh` as a five-command `set -euo pipefail` shell. Do not add a task-runner abstraction.
4. Make `scripts/verify-prerequisites.ts` fail closed unless:
   - runtime equals the exact Bun tag parsed from `packages/host/Dockerfile`;
   - local TypeScript is installed;
   - `redis-server` exists in `PATH`;
   - `REDIS_URL` is non-blank;
   - an owned `Bun.RedisClient` authenticates and completes `PING` and `ACL CAT` inside a whole-probe watchdog.
5. Never use ambient `Bun.redis`, start/stop shared Redis, interpolate credentials into commands, or print Redis URLs/errors that may contain credentials.
6. Add a reusable `verify.yml` with a repository gate on Ubuntu and the unchanged Oracle driver smoke semantics in `oven/bun:1.4.2-alpine`.
7. Reduce `ci.yml` to a local reusable-workflow caller.
8. Make release depend on shared verification, preserve OIDC/version/order/registry behavior, validate all nine tarballs before a separate guarded publish step, and make `workflow_dispatch` structurally non-publishing with a required `release-tag` input passed as data through the environment.
9. Leave `.github/workflows/build-host-image.yml` unchanged.

## Test strategy

- Exercise prerequisite failures and successes through actual Bun subprocesses.
- Use password-protected throwaway Redis instances for authenticated success and wrong-auth failure, plus a real no-ACL server configuration for capability failure.
- Assert diagnostics do not expose credentials and all subprocesses terminate promptly.
- Test shell phase order and each fail-fast exit using a recording fake executable, not a mocking framework.
- Parse all workflow YAML with the repository-owned `yaml` dependency and assert reusable topology, pin parity, release dependency, dry-run guard, and absence of duplicated package verification/skip flags.
- Run focused tests and root-script typecheck locally only as development feedback; Bun 1.3.13 is not parity evidence.
- Run acceptance and negative controls in a disposable copy inside `fugue-pr46-validation:local` with fresh frozen dependencies and disposable Redis. Never mount the source checkout read-write.

## Authenticated Redis parity closure (B1)

1. Fix the shared production worker Redis construction seam, not only the failing test: when a per-tenant ACL credential exists, replace any inherited admin URL userinfo with the scoped username/password in a newly owned Redis URL before constructing ioredis. Do not rely on ioredis options to override URL credentials.
2. Keep the real-server ACL suite's complete positive own-tenant and negative cross-tenant/enumeration/admin assertions unchanged. Construct its scoped client through the same credential-in-URL rule so both credentialed admin URLs and uncredentialed admin URLs genuinely authenticate as the provisioned user.
3. Prove both URL shapes by running that same real-server test file in separate commands against two isolated disposable servers: one password-protected server with explicit `default` URL credentials and one no-password server with no URL userinfo. Do not add helper-owned fixed ports or skip controls.
4. Make reusable CI start an authenticated, loopback-only, non-persistent Redis on a test-only port with a fixed non-secret test password, and export a correctly credentialed quoted `REDIS_URL`. Extend parsed-workflow contract coverage to pin authenticated startup, credentialed URL/runtime parity, canonical `bun run verify`, and absence of expression interpolation in shell source.
5. Correct contributor setup to use isolated port 6389; port 16379 is the framework's deliberate dead-endpoint sentinel. Describe server authentication as an optional deployment policy while making the canonical guide and CI prove the credentialed shape. Keep preflight authorization-based: valid default-user access without URL userinfo remains accepted.
6. Run changed-host strict compilation (the real-server file is excluded by the ordinary host tsconfig), root script compilation/tests, full-tier scoped lint, and fresh frozen full verification under non-root Bun 1.4.2 with the exact documented authenticated port-6389 setup. Preserve the earlier original-image Oracle proof as separately attributed evidence rather than rerunning or folding it into the local gate.
7. Record raw logs, exact counts, candidate inventory/hash (tracked plus non-ignored paths), and the separately ignored plan hash in `/tmp/fugue-verification-parity-auth-closure.md`. Do not mutate the blocked validator report, Git index, run/state authority, or publish/commit/push.

## Final adjudicated remediation (canonical source run)

Authority:

- Branch: `feat/verification-parity`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/2026-09-08-fugue-verification-parity`
- Canonical result: `result.json` SHA-256 `4c1af9f8767a19911b5d47db4b0a25f9ea243f46f4caa354ed07e1665c925973`
- Frozen review scope: the exact 31 paths in canonical `result.json`
- Canonical counts: 2 surviving mandatory findings, 0 refuted critical findings, 9 advisories
- Source result, review evidence, prior positive/negative evidence, blocked independent report, Git index, run/state, publication, commit, and push remain immutable/out of worker authority.

### Mandatory findings

1. **`silent-failure-hunter-1` — fix.** Replace the root `test:redis` command's masked semicolon chain with a tiny `scripts/test-redis.sh` lifecycle shell. It creates an automated temporary Redis container without a fixed name or fixed host port, captures only the successfully created container ID, obtains the loopback ephemeral mapping, waits with a bounded authenticated/readiness probe, delegates the existing all-workspace test command, and preserves the primary non-zero result. EXIT cleanup stops only that owned ID; cleanup failure fails an otherwise-green run but never replaces a test failure. All command execution uses direct argv and quoted data; no `eval` or globally named cleanup. Add fake-executable subprocess coverage for lifecycle, primary exit propagation, failed-start/no-foreign-stop, readiness timeout/cleanup, and a real Podman probe when Podman is present (environment failures are reported, not converted to success). Preserve this legacy helper as a convenient narrower workspace-test command; it is not the canonical whole-repository `verify` contract.
2. **`silent-failure-hunter-2` — fix.** Keep the explicit absent-`REDIS_URL` suite skip, but once a URL is configured make import, authentication, connection, `ACL CAT`, and ACL capability failures fail the test process rather than skip. Preserve every current own-tenant assertion and every destructive/cross-tenant/enumeration/admin `NOPERM` negative assertion. Add actual subprocess controls proving a configured closed endpoint and configured wrong authentication both exit non-zero with no all-skipped green result, while absent configuration remains an explicit deliberate skip. Keep the existing strict changed-host-test compilation and assertion strength.

### Advisory dispositions

- **`code-reviewer-1` — accepted.** Add a bounded authenticated Redis readiness loop in `.github/workflows/verify.yml` before exporting `REDIS_URL`; timeout must fail startup and prevent `bun run verify`. Extract only the reusable readiness shell needed for actual delayed-`PONG` and permanent-error fake tests, and retain parsed-workflow contract coverage.
- **`silent-failure-hunter-3` — accepted.** Replace the undifferentiated Redis preflight failure with a credential-safe discriminated stage (`connect`, `ping`, `acl-cat`, `timeout`) and exhaustive formatter. Diagnostics identify the stage while withholding raw URLs, credentials, and untrusted exception messages.
- **`silent-failure-hunter-4` — deferred.** `process.exit` cleanup behavior is pre-existing and outside the verification contract; correcting live/deployment smoke lifecycle semantics requires a separate fixture-backed deploy-smoke effort. This gate makes no live-Oracle claim.
- **`silent-failure-hunter-5` — deferred.** Original-image Oracle teardown is intentionally best-effort and does not affect the driver-load/network-negative oracle. Production pool lifecycle needs its own live fixtures and must not drift this verification gate.
- **`pr-test-analyzer-1` — accepted.** Add an actual stalled TCP endpoint that accepts a connection but never completes a Redis response, proving the whole-probe 2-second watchdog exits before the external test budget. Include a counterfactual helper without the whole-probe timer that reaches the external bound, discriminate this from `connectionTimeout` by completing enough Redis handshake when needed, and close sockets/server/pending work.
- **`type-design-analyzer-1` — deferred.** The existing Redis URL string surface predates this credential-override fix. Public bootstrap/IPC provenance redesign is outside scope; the real ACL controls prevent this remediation from introducing a new misbinding.
- **`type-design-analyzer-2` — deferred.** The existing ACL credential representation predates this work. Branding supervisor-minted provenance across public bootstrap/IPC boundaries is a broader type redesign, while the accepted real-server controls directly prove correct binding.
- **`architecture-tech-lead-1` — deferred.** Spend-planner/accounting policy is unrelated to credential rebinding and verification parity. Its protected accounting semantics require a separate architecture plan; this change introduces no spend defect.
- **`architecture-tech-lead-2` — dismissed.** Existing pure parse/version helpers already own deterministic policy, while `run` is a short ordered prerequisite I/O shell. An `evaluatePrerequisites` snapshot would duplicate proof data, eagerly couple probe ordering, and add no locality or leverage; boundary-real integration tests are intentional.

### Remediation support paths

These three new paths are necessary outside the frozen 31-path review scope and must be registered by the parent remediation run:

- `scripts/test-redis.sh`
- `scripts/wait-for-redis.sh`
- `scripts/__tests__/redis-shells.test.ts`

The ordinary plan path `.claude/plans/2026-09-08-fugue-verification-parity.md` is already one of the canonical 31 reviewed paths. It is candidate source—not protected run/state—and must remain in the parent inventory and installed index. No other production runtime files are authorized.

### Final validation

- Establish a green focused baseline before implementation, then run Distill in apply mode one move at a time from a green covering suite.
- Run root script strict typecheck, focused root tests, changed-host-test strict compile, all-workspace typecheck, full-tier lint for changed/new TypeScript with predecessor baseline and no waivers, shell syntax/static checks, and `git diff --check`.
- Last code/docs gate: from a fresh source-only disposable copy under non-root Bun 1.4.2 with a fresh frozen install and documented password-authenticated Redis on loopback port 6389, run the exact `bun run verify` contract. Expected workspace authority remains 7,083 passes + 3 skips; new root-test counts are reported separately.
- Write `/tmp/fugue-verification-parity-adjudicated-remediation.md` with the whole 31-path candidate plus support-path inventory, path modes, manifest/hash stability, authority hash, commands/results, and unchanged-evidence hashes.

## Completion discipline

- Start the distill apply pass only from a green focused baseline; apply and report one simplification move at a time.
- Run Bash-driven tests last.
- Record exact scope, commands, new tests, negative controls, and remaining parent-owned whole gates in `/tmp/fugue-verification-parity-implementation.md`.
- Do not stage, commit, push, publish, dispatch workflows, or claim final verification.

## Pre-review verification closure

- Correct the measured workspace result from “7,086 passes” to **7,083 passes + 3 skips = 7,086 executed workspace tests**. `/tmp/fugue-final-full-verify.log` is the authority for that result.
- Historical `/tmp/fugue-pr46-publication-validation/test-summary.json` reported 7,187 passes because its raw workspace log discovered ignored compiled tests in `packages/adapter-pg/dist` and `packages/adapter-ms-graph/dist`: PG was 73 instead of 37 and MS Graph was 142 instead of 74, exactly 104 duplicate/stale passes.
- Keep leaf package scripts authoritative and source-scoped. Every buildable leaf whose `tsc` build emits `src/**/*.test.ts` into `dist` uses `bun test --path-ignore-patterns='dist/**'`; no root package list is introduced.
- Support-scope manifest paths are `packages/adapter-fs/package.json`, `packages/adapter-ms-graph/package.json`, `packages/adapter-oracle/package.json`, `packages/adapter-pg/package.json`, `packages/document-source/package.json`, `packages/http-auth/package.json`, and `packages/xlsx/package.json`. Framework already had the same ignore convention; host and example DAG inclusion remain unchanged.
- Parse `REDIS_URL` into a branded value only for valid `redis://` or `rediss://` URLs, with a typed invalid variant and credential-safe diagnostics. Format the closed prerequisite error union with exhaustive `ts-pattern`, owned directly at the root without changing its resolved version.
- Require `node_modules/.bin/tsc` and the root-owned `node_modules/typescript/bin/tsc` to resolve to the same local compiler before workspace scripts can run; a disposable fixture must prove an executable global `tsc` cannot compensate for a missing local bin link.
- Add derived leaf-scope contract coverage plus an actual disposable mutation proving a failing ignored `dist` test cannot fail the leaf gate while a failing current source test does.
- Current focused closure result: 37 script tests passed; the seven affected leaf suites passed with source-only counts 25, 74, 79, 37, 18, 90, and 20. Full typecheck and scoped architectural lint passed. The parent retains the final whole gate after concurrent workers complete.
