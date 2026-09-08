# ADR-0084: CI runs the exact Bun that production ships

## Status
Accepted

## Date
2026-09-06

## Context

`packages/host/Dockerfile` ran `FROM oven/bun:1.2-alpine` (Bun 1.2.23). `ci.yml`'s `check` job — the merge gate that typechecks and runs every package's suite — ran `oven-sh/setup-bun@v2` with `bun-version: latest`, which by 2026-09-06 resolved to Bun 1.4.2. The two drifted apart silently, because nothing tied them together and `latest` moves on its own.

That made the merge gate evidence about a runtime we do not ship. The gap was found while fixing an unrelated `--frozen-lockfile` failure, by running the suite inside `oven/bun:1.2-alpine` and diffing against the same suite on `oven/bun:alpine`, holding the environment (git present, non-root user, live Redis) constant. Four tests **fail on 1.2.23 and pass on 1.4.2**:

- `host-uds-bind.test.ts` — *"a bind failure is a fail-closed boot ABORT (internal-invariant-violated)"*. A second `createHost` bound to an already-bound UDS path **succeeds** on 1.2.23 (`expect(second.ok).toBe(false)` got `true`). FR-007's fail-closed boot abort did not hold on the runtime in production: two host instances could each believe they owned the same socket.
- `cli/new.test.ts` ×2 and the `fugue prompts sync/check` environment-failure test — a thrown `fs` error folded into the CLI problems envelope arrives **without its stack** on 1.2.23. The tests assert the envelope keeps the stack (`expect(problems[0]).toContain("at ")`); on 1.2 the message is present and the frames are not.

These are all fail-closed / diagnosability paths — precisely the invariants this codebase spends the most effort asserting. Every one of them was green in CI while being broken in production.

Two failures reproduce on **both** versions and are container artifacts rather than skew: the BullMQ queue construction test and the `BunGitAdapter` git-integration test. They pass on GitHub's `ubuntu-latest` runner.

## Decision

**Pin the Bun version, and pin CI and production to the same one.** As of this ADR that is `1.4.2`. The current direct pins are in three files that must be bumped together:

| Where | Setting |
|---|---|
| `packages/host/Dockerfile` | `FROM oven/bun:1.4.2-alpine` — production source of truth |
| `.github/workflows/verify.yml` | workspace `bun-version: 1.4.2` and Oracle `container.image: oven/bun:1.4.2-alpine` |
| `.github/workflows/release.yaml` | packaging `bun-version: 1.4.2`; shared verification is called separately |

An exact patch tag, not a `1.4` or `latest` floating tag: a floating tag reintroduces exactly the drift this ADR exists to remove, and the failure mode is silent.

This moves production **forward** (1.2.23 → 1.4.2) rather than pinning CI back to 1.2.23. Pinning back would have turned the merge gate red against four real defects and left FR-007's bind abort broken in production until they were fixed on an old runtime. Moving forward makes all four pass, and matches `@types/bun`, already pinned at 1.4.1 — the type surface was describing a Bun newer than the one being shipped.

## Consequences

- A green shared repository gate is evidence from production's runtime because the preflight rejects any Bun version that differs from the Dockerfile.
- Bun upgrades remain deliberate: one change updates the Dockerfile, both pins in `verify.yml`, release packaging, and the corresponding tests before it ships.
- Pin equality is now mechanically enforced. The prerequisite parser derives the exact patch from the Dockerfile at runtime, and parsed-workflow tests require every setup/image pin to equal it.
- `@types/bun` (pinned exactly at 1.4.1 across all twelve workspaces, with direct root ownership for verification scripts) should be bumped alongside the runtime so the type surface keeps matching what runs.
- ADR-0034 describes the host container as `oven/bun:1.2-alpine`. That statement was accurate when written; per this repo's convention the historical record stands and this ADR supersedes the version detail, not the git-CLI decision it was making.

## Related

- ADR-0034 — raw git via `Bun.spawn` (describes the container at the older version)
- FR-007 — UDS bind + `chmod 0600`, the fail-closed boot abort this skew defeated
- ADR-0080 — typed failure surfaces, the contract the missing stacks eroded

## Current enforcement note (2026-09-08)

CI and release now call the same reusable `.github/workflows/verify.yml`. Its repository job performs a frozen install, starts disposable Redis, and invokes the root `bun run verify`; that command delegates to all 12 workspace typecheck/test scripts (including the framework CLI compiler tier), the deliberately scoped root-script compiler/tests, and shipped-doc checks. Its second required job preserves the Oracle driver smoke in the original `oven/bun:1.4.2-alpine` image. Local `bun run verify` proves the repository/runtime/Redis gate but does not claim that independent image proof or the credentialed OpenShift PostSync `SELECT 1 FROM DUAL` check.
