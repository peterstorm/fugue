# ADR-0061: Per-Team DAG Image Scoping

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md) (§2). This ADR is the immutable "why".

## Status
Accepted

## Date
2026-06-15

## Context

ADR-0041 made DAGs live in a separate repo that the host loads at runtime, with
the layout `dags/{team}/.../{dag}/`. PR #13 made the deployment model
**one host per team** — `host = team = trust boundary` (each host has its own
LLM/provider keys, its own `DOCUMENTS_FS_ROOT` data, and its own Entra agent
clients). See `docs/team-security-and-capabilities.md` for the full model.

Two facts about the host create a decision the deployment side must answer:

1. **The host loads every DAG in the root it is given** (`module-loader.ts`
   `discoverDagPaths` scans `dags/**/dag.ts`) and isolates at the **API** layer
   via `canAccessDag` on the `fugue.yaml` `team` field. That governs *who can
   trigger* a DAG — it does **not** protect DAG code, prompts, or embedded data
   *at rest*.
2. **The deploy now bakes DAGs into an image** (`DAGS_LOCAL_PATH` mode: the git
   adapter's clone/pull/install are no-ops; `node_modules` is installed at
   image-build time and an initContainer stages `/dags` into a volume). The
   `fugue-dags` repo is a shared monorepo whose `Dockerfile` did `COPY . .`.

So: if a single image bakes every team's DAGs and is deployed as team A's host,
team B's code + embedded workbooks physically sit inside team A's image even
though A's token cannot run them. Inside a trust boundary, that is a
confidentiality leak — and running two teams on one host is impossible anyway
(one set of keys/data/identity per host).

## Options Considered

1. **One all-teams image; isolate only via `canAccessDag`**
   - Pros: one image to build; simplest CI.
   - Cons: every team's code/prompts/data at rest in every host (leak across the
     trust boundary); also implies multi-team-per-host, which the one-host-per-team
     model forbids (shared keys/data/identity).

2. **One repo per team**
   - Pros: the boundary is structural — an image physically cannot contain another
     team's code.
   - Cons: loses the shared-monorepo ergonomics (shared `lib/`, the workspace
     contract package); more repos to wire CI/governance for.

3. **Shared monorepo + per-team scoped images (chosen)**
   - Pros: keeps the monorepo ergonomics; each *deployed artifact* still contains
     exactly one team's DAGs + data. `image = team = host = trust boundary`.
   - Cons: relies on the build scoping the copy correctly (mitigated below).

## Decision

**The source repo may be a shared monorepo, but the image (or clone) feeding a
team's host MUST contain only that team's DAGs + data.** Build one image per team.

Concretely:
- The **top-level folder under `dags/`** is the team and the image-scope unit
  (`dags/{team}/…`); it must equal the `fugue.yaml` `team` field. Folders below
  it are free-form intra-team grouping (e.g. `dags/business-sales/leads/lead-scoring/`).
- The baked-image `Dockerfile` takes `ARG TEAM` and copies **only**
  `dags/${TEAM}/` (plus shared `lib/`/`packages/` + that team's data image) —
  never `COPY . .`. This makes the scoping explicit and reviewable rather than an
  implicit property of a whole-repo copy.
- **Never** ship a single all-teams image to multiple hosts, and **never** run
  more than one team on one host.

This depends on ADR-0041's discovery being **depth-agnostic** (amended
2026-06-15: glob `dags/**/dag.ts`) so a team's DAGs can nest under domain folders
while the team stays the first path segment.

## Consequences

**Positive:**
- Each deployed artifact lives inside exactly one trust boundary; a host
  compromise cannot expose another team's DAG code/prompts/data at rest.
- The per-team `ARG TEAM` + explicit `COPY dags/${TEAM}/` makes the scoping a
  visible, reviewable line rather than a silent whole-repo copy.

**Negative / watch-outs:**
- CI must build N images (one per team) from the monorepo; the team list is the
  set of top-level folders under `dags/`.
- **Git-sync deployments are not yet scoped.** The host's git-sync path clones the
  **whole** repo (no sparse-checkout/subdir knob; config is only `DAGS_REPO_URL`,
  `DAGS_REPO_BRANCH`, `DAGS_LOCAL_PATH`). For git-sync, either deploy the
  baked-image path, use a repo per team, or add a `DAGS_SUBDIR`/sparse-checkout
  option (not built). This limitation is logged, not silently accepted.
- Deploy-side identifiers keyed on the team (Keycloak agent clients, `fug_` team
  token label, image tag) must track the team folder name.

## Related
- ADR-0041 — separate DAGs repository (amended 2026-06-15: depth-agnostic discovery)
- ADR-0034 — raw git via `Bun.spawn` (git-sync mechanism)
- `docs/team-security-and-capabilities.md` §2 — DAG repo & deployment topology
</content>
