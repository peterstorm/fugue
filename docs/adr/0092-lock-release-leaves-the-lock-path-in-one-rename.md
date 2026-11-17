# ADR-0092: Lock release leaves the lock path in one rename

## Status
Accepted. Amends the release paragraph of [ADR-0078](0078-journal-single-writer-contract-and-append-serialization.md).

## Date
2026-11-17

## Context

ADR-0078's lock is born atomically: a staged owner directory is renamed onto
`append.lock`. Release verified ownership (pid and token) by path, then
deleted the owner by path with a recursive remove.

A recursive remove is not atomic. It deletes the owner's `pid` and `owner`
files first and the directory last, so for a moment `append.lock` is an
empty directory. `rename(2)` replaces an empty directory, so a contender's
birth could land in that window. The releaser's recursive remove then found
a non-empty directory, re-read it, and deleted the new owner's files and
directory too. The new owner still believed it held the lock, the path was
empty again, and a third contender was born: two processes in the critical
section at once.

It was observed as a one-off failure of the three-process race test under
full-suite load (`ENTER A, ENTER C, EXIT A`). A stress run of ten processes,
each running 150 critical sections under `withFileLock` and checking an
exclusive marker, reproduced it at about 3 overlaps per 9,000 sections.

The defect class is "verify by path, then mutate by path non-atomically". The
stale reaper already avoids it by renaming the victim into a tomb.

## Decision

**Release moves the verified owner directory off the canonical path in one
rename (`append.lock` to a unique `append.lock.released-*` sibling), then
deletes the moved copy.**

- After the move, release reads the moved directory's token. If it is not
  this acquisition's (another owner took the path after the check), release
  renames it back untouched. If that restore fails, release throws a typed
  `releaseFileLock` error naming both paths.
- A failed move (other than the lock already being absent) throws the typed
  `releaseFileLock` failure: the lock is still held, as before.
- A failed delete of the moved copy is warned, not thrown. The lock is free
  the moment it leaves the canonical path, so there is nothing for the caller
  to retry; the litter is a uniquely named sibling that no protocol step scans.

## Consequences

- A contender only ever sees a full owner directory or none, so a birth can no
  longer be deleted by a release. The stress run above shows 0 overlaps in
  15,000 sections after the change.
- The release failure contract narrows: ADR-0078's "a failure to remove a lock
  proven to be owned throws" now applies to the move. A delete failure after
  the move is a warning plus a `append.lock.released-*` sibling to clean up.
- `file-atomic.test.ts` pins the class deterministically: the lock path
  changes owner between the ownership check and the release, and the new
  owner must survive. The test fails against the previous release.
