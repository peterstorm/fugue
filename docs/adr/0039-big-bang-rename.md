# ADR-0039: Big-Bang Rename @ai-summary → @fugue

## Status
Accepted

## Date
2026-05-20

## Context

The monorepo originally used the `@ai-summary` package scope, named after the first DAG (customer summary generation). As the project evolved into a general-purpose DAG hosting platform, the name no longer reflected the product identity. The product name is "Fugue" — a term evoking concurrent, interleaving execution (from music theory: independent voices weaving together).

The rename touches every `package.json` name field, all TypeScript import paths (`@ai-summary/framework` → `@fuguejs/framework`), workspace references, and the root `package.json`. Two approaches exist: gradual migration with dual-name support, or a single atomic rename.

The monorepo is private — published to no external registry, consumed by no external teams. There are zero downstream consumers who would break.

## Options Considered

1. **Gradual migration with package aliases**
   - Pros: Lower risk per-change, can be done across multiple PRs, allows testing each package independently
   - Cons: Dual naming creates confusion ("which import do I use?"), alias machinery adds `package.json` complexity, transition period where both names coexist in code, no external consumers to protect so the caution is unjustified

2. **Keep old name (@ai-summary)**
   - Pros: Zero effort, no risk of breakage
   - Cons: Name is misleading — "ai-summary" implies a specific use case, not a DAG platform. Confusing for new team members and AI agents authoring DAGs. Product identity mismatch.

3. **Big-bang rename in one PR**
   - Pros: Clean break, no transition period, single PR to review, no alias complexity, one `find-and-replace` operation
   - Cons: Large diff in one PR, must verify all imports resolve post-rename

## Decision
**Rename all packages from `@ai-summary/*` to `@fuguejs/*` in a single PR, atomically.**

Changes:
- `packages/framework/package.json` → `name: "@fuguejs/framework"`
- `apps/customer-summary/package.json` → `name: "@fuguejs/customer-summary"`
- Root `package.json` → `name: "fugue"`
- All `.ts` files: `@ai-summary/framework` → `@fuguejs/framework`
- `tsconfig.json` path mappings updated
- New `packages/host/package.json` → `name: "@fuguejs/host"` (created fresh with new name)

The rename is done in the same PR that introduces the host package, since the PR already touches most of the codebase. Verification: `bun run typecheck` and `bun test` pass after rename.

## Consequences

**Positive:**
- Clean product identity from day one of the host feature.
- No confusion about which package scope to use — there is only `@fuguejs/*`.
- No alias machinery, no `exports` map workarounds, no dual-path resolution.
- AI agents authoring DAGs see a coherent namespace that matches the product name.

**Negative:**
- Large diff in one PR — reviewer must trust the mechanical nature of the find-and-replace. Mitigated by running full test suite post-rename.
- Git blame on import lines loses direct history (shows the rename commit). Mitigated by `git log --follow` and the rename being clearly mechanical.
- If external consumers existed, this would be a breaking change. Accepted because the monorepo is private.
