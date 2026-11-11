# ADR-0089: Release flow: lockstep 0.6.0, local links during development, user-gated tags

## Status
Accepted

## Date
2026-11-10

## Context

The host-memory-spikes feature spans two repositories. The fugue half replaces
the SheetJS-backed `@fuguejs/xlsx` reader with a streaming reader
(`openWorkbook`, `foldRows`) and updates `@fuguejs/document-source` docs. The
fugue-dags half (lead snapshot, recompute, DAG restructure, leads contract
0.5.0, before/after benchmarks) consumes that work. fugue-dags cannot be
finished, measured or merged against code that only exists in the fugue
working tree, yet it also cannot wait for a release before development starts,
because the acceptance benchmarks must run on the new reader before anyone
decides to ship it.

Several forces constrain how the new packages reach fugue-dags:

- **Lockstep is enforced, not conventional.** `.github/workflows/release.yaml`
  checks that every one of the nine published packages (`adapter-fs`,
  `adapter-ms-graph`, `adapter-oracle`, `adapter-pg`, `document-source`,
  `framework`, `host`, `http-auth`, `xlsx`) carries the tag's version, and it
  inspects each packed tarball and refuses any `@fuguejs/*` dependency that is
  not pinned to the same version. Those pins come from the workspace `version`
  fields in `bun.lock`, so a bump that misses the lockfile fails the release.
- **Tag pushes and contract publishes belong to the user.** FR-060 and AS-036
  reserve pushing the release tag to the user. Publishing leads contract 0.5.0
  through fugue-dags' `publish-contract.yml` is gated the same way, under the
  same feature's leads-contract decision.
- **One framework copy at runtime.** fugue-dags imports `framework`,
  `document-source`, `xlsx`, `fs` (adapter-fs), `host` and `ms-graph`
  (adapter-ms-graph). If some of these resolve to local builds and others to
  npm 0.5.1, two `@fuguejs/framework` instances coexist, and identity-based
  checks (schemas, symbols, class instances) silently diverge.
- **The baseline must be clean.** The before column of the benchmark report
  (AS-038) must be measured against npm 0.5.1, so nothing local may be wired
  into fugue-dags until that baseline is recorded.
- **The end state must be published code.** FR-061 requires fugue-dags to end
  on the published 0.6.0 packages, and FR-062 / AS-037 require every fugue-dags
  and `@fuguejs/xlsx` test to pass there.

## Options Considered

1. **Lockstep 0.6.0 bump, `bun link` of all six consumed packages during
   development, user-gated tag, final pin to published versions** (chosen)
   - Pros: satisfies the existing `release.yaml` lockstep and stale-pin checks
     without changing the workflow; linked packages resolve their own
     `workspace:*` dependencies inside the fugue monorepo, so the development
     build is exactly what will be packed; linking all six packages leaves
     exactly one `@fuguejs/framework`; the user keeps sole control of what
     reaches npm; the final pin re-runs every test and benchmark against the
     real published artifacts.
   - Cons: fugue-dags temporarily carries `link:` specifiers that must never be
     merged; the last task is blocked on a manual user action; benchmarks run
     twice (linked and published).

2. **`file:` dependencies on the fugue package directories**
   - Pros: explicit in `package.json`; no global link registry.
   - Cons: the packages' own `workspace:*` dependencies do not resolve outside
     the fugue monorepo, so installation fails or pulls mismatched copies.
     Rejected.

3. **Publish a 0.6.0 prerelease (for example `0.6.0-rc.1`) to npm and consume
   it**
   - Pros: fugue-dags tests run against real tarballs throughout development.
   - Cons: `release.yaml` publishes only on a tag push, which the user reserves;
     each iteration of the reader would need another user-pushed tag; it puts
     unaccepted code on a public registry. Rejected.

4. **Bump only `@fuguejs/xlsx` (for example to 0.5.2 or 0.6.0) and leave the
   other eight packages at 0.5.1**
   - Pros: smallest diff; only the changed package is republished.
   - Cons: breaks lockstep; the tag-version check and the stale-workspace-pin
     check in `release.yaml` both refuse it, because `document-source` and the
     other packages pin `@fuguejs/*` at the workspace version. Rejected.

## Decision

**All nine published `@fuguejs/*` packages move from 0.5.1 to 0.6.0 in
lockstep; fugue-dags consumes the local fugue workspace through `bun link`
during development, and switches to the published 0.6.0 packages only after the
user pushes the `v0.6.0` tag.**

Concretely:

- **Version bump (the fugue release-prep change).** The `version` field is 0.6.0
  in `packages/{adapter-fs,adapter-ms-graph,adapter-oracle,adapter-pg,document-source,framework,host,http-auth,xlsx}/package.json`,
  and the matching workspace `version` entries in `bun.lock` are 0.6.0. The
  unpublished `packages/examples` package is not part of the release set and
  keeps its own version. `release.yaml` is unchanged: its tag-match step and its
  stale-workspace-pin check are the enforcement point for this invariant.
- **Baseline first.** The baseline benchmark in fugue-dags is recorded against
  npm `@fuguejs` 0.5.1 before any local build is linked. This ordering is a
  hard dependency: the fugue-dags change that first wires in the linked
  packages cannot start until the baseline benchmark has been recorded.
- **Link all six or none.** During development fugue-dags links `framework`,
  `document-source`, `xlsx`, `fs`, `host` and `ms-graph` from the local fugue
  workspace with `bun link`. Linking a subset is not allowed, because it would
  load two `@fuguejs/framework` copies.
- **Linked builds are the acceptance bar.** The after-benchmarks and the xlsx
  real-data differential run on the linked 0.6.0-candidate builds. Any budget
  breach blocks the release; budgets are never raised to make a run pass.
- **No merge with links.** The fugue-dags branch is not merged while its
  `package.json` or `bun.lock` carries any `link:` specifier.
- **User-gated publication.** The user pushes `v0.6.0` in fugue, where
  `release.yaml` validates lockstep and publishes, and runs
  `publish-contract.yml` in fugue-dags for leads contract 0.5.0. No agent pushes
  tags or triggers either publish.
- **Final pin (the closing fugue-dags pin change).** Only after both publishes, and after checking
  each version with `npm view <name>@0.6.0 version`, every `link:` specifier is
  replaced with `0.6.0` and the external contract dependency is set to `0.5.0`
  (the in-repo workspace dependency stays `workspace:*`). Then `bun install`,
  the full `verify:junit`, and the `snapshot-memory.ts` and `parse-memory.ts`
  real-data benchmarks are re-run to fill the "after (0.6.0)" column of
  `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md`.

## Consequences

**Positive:**
- The release is accepted by the existing `release.yaml` with no workflow
  change, and a missed `bun.lock` bump fails before anything is published.
- Development and benchmarking run against the same sources that are packed,
  with a single framework instance, so the linked results are representative.
- The before/after report has a clean baseline (npm 0.5.1), a pre-release
  measurement (linked) and a confirmation run on the published artifacts.
- Nothing reaches npm without an explicit user action.

**Negative:**
- Every package, including ones with no code change (`adapter-oracle`,
  `adapter-pg`, `http-auth`), is republished at 0.6.0; consumers see a minor
  version bump without behavioral change in those packages.
- `bun link` relies on a machine-local link registry. A fresh clone of the
  fugue-dags branch mid-development does not install until the links are
  recreated, and a forgotten `link:` specifier is a merge hazard guarded only by
  review, not by tooling.
- The final task cannot be automated end to end; the feature stays open until
  the user pushes the tag and runs the contract publish.
- If the published 0.6.0 tarballs differ from the linked builds (for example a
  packing or `files` field omission), the difference is found only in the final
  pin task, after the tag is already pushed; the fix is then a 0.6.1 lockstep
  release, since published versions are immutable.
