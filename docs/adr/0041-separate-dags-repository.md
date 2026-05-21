# ADR-0041: Separate Dags Repository

## Status
Accepted

## Date
2026-05-20

## Context

DAG authors (teams and AI agents) need a way to deploy their DAG code to the host. The deployment mechanism must support: (1) independent team velocity — one team's DAG deploy doesn't require coordinating with host releases, (2) familiar developer workflow — no new tools to learn, (3) version history and rollback, (4) code review before production.

The host needs to discover, validate, and load DAG code at runtime. The mechanism must support hot-reloading (new DAGs appear without host restart) and safe removal (DAGs disappear when deleted from source).

## Options Considered

1. **DAGs in the host monorepo**
   - Pros: Single repo, shared CI, atomic consistency between host and DAG code
   - Cons: Couples DAG authoring to host releases, every DAG change requires full monorepo CI, teams step on each other in PRs, host deploys trigger on DAG changes (unnecessary), merge conflicts across unrelated teams

2. **Package registry (npm publish per DAG)**
   - Pros: Versioned artifacts, familiar npm semantics, could cache packages
   - Cons: Heavy workflow (publish, version bump, wait for registry), not suited for rapid iteration, adds registry infrastructure dependency, overkill for internal DAGs, no natural "list all DAGs" discovery

3. **Separate git repository, host clones at runtime**
   - Pros: Git is the deployment mechanism (push = deploy), familiar workflow, built-in code review (PRs), built-in rollback (git revert), natural discovery (directory scan), teams work independently, host polls for changes without restart
   - Cons: Eventual consistency (poll interval delay), runtime dependency on git remote availability, cross-repo type checking requires shared framework dependency

## Decision
**DAG code lives in a separate git repository. The host clones it at startup and polls for changes. Git is the deployment mechanism.**

Repository structure:
```
fugue-dags/                     # Separate git repo
├── package.json                # depends on @fugue/framework
├── bun.lockb
└── dags/
    └── {team}/
        └── {dag-name}/
            ├── dag.ts          # exports DagRegistration (default export)
            ├── fugue.yaml      # per-DAG config
            └── nodes/          # node implementations
```

Host behavior:
- **Startup:** `git clone --depth=1 --branch={branch} {DAGS_REPO_URL}` into a working directory
- **Poll loop:** Every `DAGS_POLL_INTERVAL_MS` (default 30s), `git fetch` + compare remote HEAD SHA
- **On new commit:** `git pull`, optionally `bun install --frozen-lockfile` if `bun.lockb` changed, re-scan and re-import DAGs
- **Dev mode:** `DAGS_LOCAL_PATH` env var skips git entirely, uses a local directory (for development)
- **Discovery:** Scan `dags/*/*/dag.ts` pattern — one level of team nesting

The host imports DAGs via dynamic `import()` with cache-busting (append `?sha={commitSha}` to force fresh module evaluation).

## Consequences

**Positive:**
- Teams deploy independently — push to main branch, host picks it up within one poll interval.
- Rollback is `git revert` — the host treats HEAD as truth, no version history to manage.
- Code review via PRs — same workflow teams already use for all other code.
- Host never needs redeployment for DAG changes — only for host infrastructure changes.
- AI agents can author DAGs by committing to the dags repo — no special tooling needed.

**Negative:**
- Eventual consistency — up to `DAGS_POLL_INTERVAL_MS` delay between push and live. Acceptable for the use case (not real-time).
- Git remote must be available at startup. If unreachable, host cannot boot (by design — no DAGs = no value). During operation, unreachable remote means existing DAGs continue serving.
- Cross-repo type checking is not atomic — a breaking change in `@fugue/framework` requires updating the dags repo's dependency. Mitigated: framework follows semver, breaking changes are rare.
- `bun install` during sync adds latency when dependencies change. Mitigated: `--frozen-lockfile` is fast when lockfile matches.
