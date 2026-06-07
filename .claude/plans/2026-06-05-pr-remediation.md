# PR Remediation Plan

**Date:** 2026-06-05
**Branch:** fix/capability-review-followups (off main)
**Findings:** 0 critical, 11 advisory (all actionable, user opted into "everything")

Target: the document-source capability subsystem reviewed on `main` —
document-source port + fs/ms-graph/pg adapters + host capability-manager +
http capability + xlsx parser. 6-agent cohort found 0 critical bugs; these are
quality/consistency advisories.

## Advisory Fixes

### A1 — FileRef smart constructors do no content validation
- **Source:** type-design-analyzer
- **File:** packages/document-source/src/index.ts:54-72
- **Issue:** `sharePointPathRef`/`driveItemRef`/`shareUrlRef`/`localPathRef` are
  identity wrappers; empty/blank strings are representable, so Parse-Don't-Validate
  is only half-met.
- **Fix:** Validate non-blank inputs at construction and throw a descriptive
  `Error` naming the field. Constructors are wiring/authoring helpers called with
  literals; an empty arg is a programmer error that must fail loud. (Result-return
  would wreck ergonomics inside node `fetch` bodies — rejected.)

### A2 — ReadOpts.signal accepted by port but dropped by fs adapter
- **Source:** architecture-tech-lead
- **File:** packages/adapter-fs/src/index.ts:56-60,165-194
- **Issue:** ms-graph honors `opts.signal`; fs silently ignores it. `node:fs`
  readFile supports `{ signal }`.
- **Fix:** Widen `FsLike.readFile` to accept `{ signal }`, thread `opts.signal`
  through, and short-circuit with an `aborted` error when the signal is already
  aborted (stat has no native signal support → checked up front).

### A3 — FileMeta.lastModified ISO-8601-UTC invariant in a comment, not the type
- **Source:** type-design-analyzer
- **File:** packages/document-source/src/index.ts:102
- **Fix:** Introduce a branded `IsoUtcTimestamp` with `isoUtcFromDate` (total) and
  `parseIsoUtc` (Result) constructors; type `FileMeta.lastModified` as the brand.
  fs uses `isoUtcFromDate`; ms-graph normalizes via `parseIsoUtc`. Two test
  literals updated.

### B1 — xlsx "pure / no I/O" doc wording overstated
- **Source:** architecture-tech-lead, comment-analyzer
- **File:** packages/xlsx/src/index.ts:1-8,70
- **Fix:** Reword to "deterministic, side-effect-free transform (no filesystem/
  network I/O)" — the stateful ExcelJS workbook + dynamic import aren't "pure."

### B2 — http-capability docblock omits the `aborted` error kind
- **Source:** comment-analyzer
- **File:** packages/framework/src/http/http-capability.ts:1-9
- **Fix:** Add caller-abort to the mapped-error list.

### B3 — undocumented coupling: timeout via `message === "timeout"`
- **Source:** comment-analyzer
- **File:** packages/framework/src/http/http-capability.ts:104,152
- **Fix:** Inline note explaining the abort-reason/string-match coupling and the
  generic `AbortError` fallback if a runtime doesn't forward the reason.

### B4 — ms-graph re-exports localPathRef but fails closed on it
- **Source:** comment-analyzer
- **File:** packages/adapter-ms-graph/src/index.ts:58-66
- **Fix:** Note the re-export is for port-surface completeness; this adapter
  rejects `localPath` (use `@fuguejs/fs`).

### C1 — extractClients duplicate-name throw branch untested
- **Source:** pr-test-analyzer
- **File:** packages/host/src/__tests__/capability-manager.test.ts
- **Fix:** Add a test asserting the defence-in-depth throw on duplicate names.

### C2 — xlsx dateGroupItem strip-then-retry-still-fails branch untested
- **Source:** pr-test-analyzer
- **File:** packages/xlsx/src/__tests__/date-group-item.test.ts
- **Fix:** Fixture with a self-closing dateGroupItem (stripped) + a surviving
  non-self-closing dateGroupItem element → reload still crashes → `node-crash`.

### C3 — xlsx mixed error-cell + real-value row untested
- **Source:** pr-test-analyzer
- **File:** packages/xlsx/src/__tests__/xlsx.test.ts
- **Fix:** Build a row mixing an error cell with a real value; assert validation
  failure under a non-nullable schema and retention under a nullable one.

### D1 — fake adapter fidelity (pg prefix-match, http ignores body)
- **Source:** architecture-tech-lead, pr-test-analyzer
- **File:** packages/adapter-pg/src/index.ts:348-367,
  packages/framework/src/http/http-capability.ts:236-295
- **Fix:** Document the pg prefix-match foot-gun loudly; add an optional
  `matchBody` predicate to the http fake (additive, non-breaking) so payload
  assertions are possible, threading the request body into `matchRoute`.

## Validation Commands
```bash
bun run typecheck
bun test
```
