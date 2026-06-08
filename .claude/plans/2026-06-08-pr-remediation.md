# PR Remediation Plan

**Date:** 2026-06-08
**Branch:** fix/capability-review-followups
**Findings:** 0 critical, 9 advisory (4 actionable, 5 accepted-design / no-op)

Six review agents (code, errors, tests, types, comments, architecture) ran in
parallel, primed with the project's documented architectural intent. **Zero
critical findings** — the branch is a clean remediation. Advisories below.

## Actionable Fixes

### Fix 1 (A1): ms-graph caller-abort maps to retriable `transient` instead of `aborted`
- **Source:** architecture-tech-lead (85% confidence), corroborated by the fs comment
- **File:** `packages/adapter-ms-graph/src/index.ts` (`graphGet`, ~270)
- **Issue:** The fs adapter's new comment (`adapter-fs/src/index.ts:186-188`)
  claims abort semantics are "consistent with the ms-graph adapter", but
  `graphGet`'s catch maps **every** rejection — including a caller-initiated
  `AbortError` — to `transientErr` (retriable). Per `retry-policy.ts`, only
  `kind: "aborted"` fast-fails, so a caller cancel against Graph is retried
  through the backoff budget, defeating the cancel intent. False comment + real
  latent correctness gap.
- **Fix:** Give `graphGet` the same abort discrimination fs has — an up-front
  `opts?.signal?.aborted` guard and an `opts?.signal?.aborted` check in the catch
  that returns a non-retriable `aborted` error. Crucially gated on the **caller's
  own signal** (not a generic `isAbort`), so the adapter's internal
  `AbortSignal.timeout` still maps to retriable `transient` — a request timeout
  must stay retriable. This makes the fs comment true and closes the gap.
- **Test:** Update the existing abort test (`ms-graph.test.ts:302`) which
  currently asserts the buggy `transient` to assert `aborted`.

### Fix 2 (T1): ms-graph offset-timestamp normalization untested end-to-end
- **Source:** pr-test-analyzer
- **File:** `packages/adapter-ms-graph/src/__tests__/ms-graph.test.ts`
- **Issue:** The actual schema fix (`z.string().datetime({ offset: true })`) that
  accepts offset-form timestamps and normalizes them via `parseIsoUtc` is only
  tested with an already-`Z` fixture, which the old schema already accepted.
- **Fix:** Add a `getMetadata` case feeding `2026-05-30T14:00:00+02:00` and
  asserting `lastModified === "2026-05-30T12:00:00.000Z"`.

### Fix 3 (T2): fs `isAbort` `TimeoutError` branch untested
- **Source:** pr-test-analyzer
- **File:** `packages/adapter-fs/src/__tests__/fs-adapter.test.ts`
- **Issue:** `isAbort` treats both `AbortError` and `TimeoutError` as aborts;
  only the `AbortError` branch of the `||` is covered.
- **Fix:** Add a mid-read case throwing `{ name: "TimeoutError" }`, asserting
  `kind === "aborted"`.

### Fix 4 (C1): `requireNonBlank` doc omits retriable classification
- **Source:** comment-analyzer
- **File:** `packages/document-source/src/index.ts:55-65`
- **Issue:** The doc says a blank field in a node `fetch` "surfaces as a
  `node-crash`" but omits that `run-node.ts:135` classifies a caught throw as
  `retriability: "retriable"`, so a deterministic wiring error is retried before
  failing. Verified against `run-node.ts:133-135`.
- **Fix:** Add a half-sentence noting the caught crash is retriable-classified.

## Accepted Design / No-Op (documented in the diff, judged acceptable by the analyzers)

- **Y1** `requireNonBlank` throws rather than returning `Result` — deliberate,
  documented fail-loud-at-authoring decision; sanctioned by the architecture rules.
- **Y2** `parseIsoUtc` maps a malformed-timestamp boundary fault to `node-crash` —
  architecture agent explicitly cleared it ("appropriate"); caller treats it as
  effectively unreachable post-zod.
- **Y3** `FakeHttpRoute.matchBody` is a `(body) => boolean` predicate — test-fake
  surface only; acceptable.
- **C2** ms-graph "unreachable in practice" guard comment — currently accurate;
  latent stale risk only. No change.

## Validation Commands
```bash
bun run typecheck
bun test packages/adapter-ms-graph packages/adapter-fs packages/document-source
```
