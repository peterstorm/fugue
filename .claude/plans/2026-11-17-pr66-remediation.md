# PR #66 remediation: lock release leaves the lock path in one rename

- **Branch:** `fix/file-lock-mutual-exclusion` (peterstorm/fugue)
- **Scope:** `all` over the PR diff: `packages/framework/src/file/atomic.ts`, `packages/framework/src/__tests__/file-atomic.test.ts`, `docs/adr/0092-lock-release-leaves-the-lock-path-in-one-rename.md`, `docs/adr/README.md`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr66-review-1` (7 reviewers; 0 surviving critical, 0 refuted, 10 advisory)
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr66-policy-1` (`standalone-disposition-published`)

## Surviving criticals
None. Defect-family accounting: `not-required`.

## Advisory dispositions (all accepted, DECLARED)
| # | Finding | Decision and fix |
|---|---|---|
| 0, 4, 7 | The restore branch briefly displaces a foreign owner; a third birth in that window makes the restore fail | Accepted. ADR-0092 narrows the guarantee to "while the releaser still owns the lock" and states ADR-0078's invariant it rests on. A test pins the typed restore failure. A per-release reap-style fence was considered and not taken, because it would cost every append. |
| 1 | An unreadable moved token was treated as foreign and returned silently | Accepted. Restore the lock, then throw a typed `releaseFileLock` failure, matching the first read. |
| 2 | Untested failure arms | Accepted. New tests: unreadable moved token, restore failure naming both paths, lock absent at the move. |
| 3, 9 | `string \| null` conflates two outcomes; a sentinel string stood in for a read error | Accepted. Discriminated `Vacated` result; the read error reaches the thrown failure. |
| 5, 8 | Stale `warnBeforeRemoval` name | Accepted. Renamed to `warnBeforeRelease`. |
| 6 | Run-on test comment | Accepted. Split into sentences. |

## Refuted findings
None.

## Validation
- `bun test src/__tests__/file-atomic.test.ts`: 55 pass, 0 fail; framework `tsc --noEmit` clean; `bun run lint` clean.
- Stress (10 processes x 150 `withFileLock` sections, exclusive marker): 0 overlaps after the revision.
- The registered remediation runs the project verification itself.
