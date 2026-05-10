# ADR 0001: Single package, layered modules — no new npm package

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** NFR-021 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0002 (`runDag` back-compat shim), ADR 0013 (`onHumanReview` hook-crash retry).

## Context

The durable state-machine runtime introduces several new subsystems: a pure transition function, a stateful executor, an event journal, a queue abstraction with two adapters (BullMQ + in-memory), and a scheduler. The existing framework already ships:

- `executor/` — the legacy one-shot DAG walker.
- `checkpoint/` — JSON snapshot persistence.
- `types/` — shared DAG / node / context types.

We had to choose where the new code lives. Three pressures pulled in different directions:

1. **Isolation.** State-machine + queue + scheduler form a logically distinct runtime. A separate package would advertise the boundary and let it version independently.
2. **Cost of plumbing.** A second npm package adds a workspace, a `package.json`, a `tsconfig.json`, a build wiring, a publish target, a release lane, and cross-package import friction. The repo today is a single package; nothing else is multi-package.
3. **Coupling reality.** The new runtime *must* import the existing `types/` and reuses `checkpoint/` semantics. Splitting packages creates a circular-ish layout where the new package depends on internals the old package never intended to export.

The spec (NFR-021) explicitly puts a separate `@peterstorm/durable-machine` package out of scope. The plan's AD-1 confirmed: keep one package, enforce layering by an import-graph rule rather than by package boundaries.

The risk of a single-package layout is that the BullMQ-specific code leaks into the pure layers. `state-machine/` and `dag-runtime/` are meant to be platform-agnostic — pure functions over events and phases — and importing `bullmq` or `ioredis` from those folders would silently destroy that property. A lint check, not a package boundary, has to enforce it.

## Decision

All new code lives under `packages/framework/src/` in six new sibling folders:

```
packages/framework/src/
  state-machine/    # pure transition function, phase types, event types
  dag-runtime/      # stateful executor, journal, run-dag-stateful entry point
  queue/            # Queue interface + shared types
  queue-bullmq/     # BullMQ adapter (only folder allowed to import bullmq/ioredis)
  queue-memory/     # in-process adapter for tests
  scheduler/        # cron / delayed-job scheduler
  executor/         # (existing) one-shot DAG walker — unchanged
  checkpoint/       # (existing) snapshot persistence — unchanged
  types/            # (existing) shared types — unchanged
```

No new `package.json`. No workspace. The existing `packages/framework` build, test, lint, and semver pipeline covers all new code.

Layering is enforced at lint time by `scripts/check-imports.ts` (T9). The rule:

- `state-machine/**` MUST NOT import `bullmq`, `ioredis`, or `queue-bullmq/**`.
- `dag-runtime/**` MUST NOT import `bullmq`, `ioredis`, or `queue-bullmq/**`.
- Only `queue-bullmq/**` may import `bullmq` or `ioredis`.
- Other folders may import the `queue/` interface but not specific adapters.

The check runs in CI and as a pre-commit step. A violation fails the build.

## Consequences

**Positive:**

- Zero monorepo plumbing. New code shares the existing build, test runner, lint config, type-check, and release lane.
- Pure-layer guarantees survive — `state-machine/` cannot accidentally pull in Redis even though it lives in the same package as `queue-bullmq/`.
- Refactors that span the new runtime and the existing `executor/` (e.g. the `runDag` shim in ADR 0002) are single-package changes — no cross-package version dance.
- The layout is reversible. If a future spec carves the runtime out into its own package, the folder boundaries already match what the package boundaries would be.

**Negative:**

- Layering is enforced by a custom lint script, not by the type system or by `package.json`. A contributor who adds a new top-level folder must remember to add it to `check-imports.ts`. The script is the single source of truth and will go stale if not maintained.
- Anyone scanning `node_modules`/install size sees `bullmq` + `ioredis` as direct deps of the framework package, even for consumers who use only the in-memory queue. The dep is unavoidable here; tree-shaking handles runtime cost but not install cost.
- A single `CHANGELOG.md` mixes runtime-internal changes with public-API changes. Consumers must read carefully.

## Rejected alternatives

1. **Separate `@peterstorm/durable-machine` package.** Rejected: explicitly out of scope per spec NFR-021. Would require workspace tooling not present in this repo, plus a publish lane, plus cross-package version coordination for shared `types/`.

2. **Put everything inside the existing `executor/`.** Rejected: conflates the one-shot DAG walker with the durable state-machine runtime. Two distinct execution models living in one folder makes review, blame, and future deletion of the legacy walker much harder. The folders are siblings precisely so the legacy walker can be retired without disturbing the new runtime.

3. **Enforce layering by TypeScript project references / per-folder `tsconfig.json`.** Rejected: project references add build-graph complexity and don't actually prevent runtime imports — they only scope type-checking. The lint rule is simpler, faster, and catches the case we care about (a stray `import "bullmq"` in pure code).
