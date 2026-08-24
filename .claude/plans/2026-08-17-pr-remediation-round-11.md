# PR Remediation Plan — Round 11 (standalone review, zero-critical, advisory pass)

- **Branch:** `feat/f6-file-durable-runtime` (HEAD `922537f`, clean tree at plan time)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-185114-f6-file-durable-runtime`
- **Canonical result:** `result.json` (sha256 `f599bd9c655c2889541ab02f8c5e8b722d9d541ac59a80477b37aa9119b74502`, 21075 bytes), published atomically by the registered Standalone Review Program on `resume → done` (checkpoint kind `done`).
- **Reviewers (7/7, attempt 1, all digests verified against frozen scope):** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead (deepen), code-simplifier (distill).

## Scope (exact — the frozen 76-path set from `result.json.scope`)

`docs/adr/0075…0080` + README; `.claude/plans/2026-08-12…2026-08-17` (11 plans);
`.claude/specs/2026-08-12-f6-file-durable-runtime/` (brainstorm, plan-alignment, probe.txt, spec);
`packages/framework/package.json`;
`packages/framework/src/file/*` (16 modules), `src/file.ts` barrel, `src/checkpoint/*`,
`src/state-machine/serialize.ts` + `replay.ts` + `types.ts`, `src/types/*`,
`src/queue-bullmq/*`, `src/llm/fake-client.ts`, `src/scripts/check-imports.ts`,
and the 17 in-scope test files under `src/__tests__/` (see Run Directory `result.json` for the authoritative list).

**Out-of-reviewed-scope support path (registered in remediation start input):**
- `packages/framework/src/__tests__/state-machine-replay.test.ts` — pre-existing repo test, needed for the A3/A4 pins.

## Surviving critical findings

**None.** 0 criticals found by all 7 reviewers; the zero-critical path published
`result.json` directly (no Refutation Panel was routed; `panel: null`).
`surviving_critical_findings: []` — nothing mandatory.

## Refuted-finding audit

**None.** `refuted_critical_findings: []` — nothing to report.

## Advisory dispositions (22 total: 15 accepted, 5 deferred, 2 dismissed)

### Accepted (fix in this round)

| # | id | file:line | fix |
|---|----|-----------|-----|
| A1 | `silent-failure-hunter-1` | `file/layout.ts:314` | `eventDigestOf` wrapper omits `failureClass: "permanent"` for the deterministic sequence-domain rejection that its sibling `eventFileName` pins (layout.ts:237 `fileOperationError(..., "permanent")`). The wrapped inner throw is a plain `Error`, so `fileOperationError`'s inference cannot recover a class — the rejection is an unclassified (default-retriable) `cache-error` instead of fast-fail permanent. **Fix:** pass explicit `"permanent"` with the sibling's deterministic-class comment. Verified: `fileOperationError` (file/boundary-error.ts:84) takes the 4th arg; inference only fires for typed cache-error reasons. |
| A3 | `pr-test-analyzer-1` | `state-machine/replay.ts:166` | The PR-tightened `isRecordedEvent` discriminator (non-boolean `synthetic` ⇒ raw event, not envelope) has no pin — `grep -c synthetic state-machine-replay.test.ts` = 0. **Fix:** dedicated pins in `state-machine-replay.test.ts` (support path): (i) entry with `synthetic: <non-boolean>` is folded as the RAW entry (machine receives the whole object); (ii) `synthetic: true`/absent + `recordedAtMs` + `event` ⇒ unwrapped. Behavior-preserving pins of the current documented discriminator. |
| A4 | `pr-test-analyzer-2` | `state-machine/replay.ts:33` | `foldStep` — the single envelope-unwrap + `as E` cast site shared by `replayEvents` and `proveResumeAgreement`'s prefix scan — has no dedicated pin. **Fix:** in `state-machine-replay.test.ts` (support path): (i) raw-vs-envelope through `replayEvents` on the same machine; (ii) an envelope-shaped RAW payload (structural collision) is unwrapped — pins the documented narrowing contract so a regression in the cast/discriminator is localized to this suite (branding the envelope is the parked ADR-level fix, round-10 A14 — not re-opened here). |
| A7 | `pr-test-analyzer-5` | `file/freshness-index.ts:320` | `selectLatestWrite`'s byte-identical-member equal-score outcome is unpinned: the existing equal-score pin (file-freshness-index.test.ts:310) uses distinct members and the property test explicitly `fc.pre(redisMemberOf(left) !== redisMemberOf(right))`. Verified semantics in `selectLatestWrite`: equal `succeededAtMs` + equal member serialization ⇒ `incomingWins = false` ⇒ winner = current, returned entry = current fields with **refreshed `writtenAtMs`**. **Fix:** pin in `file-freshness-index.test.ts`: seed singleton (now=X), second write with identical member (same runId/nodeId/kind/value) and same `succeededAtMs` at now=Y (unexpired) ⇒ stored singleton keeps the original run/node/witness and `writtenAtMs === Y`. |
| A8 | `type-design-analyzer-1` | `file/resume.ts:205` | `resumeFileJob`/`resumeFileJobUnchecked` perform no boundary re-validation of `runId`, while the same backend's `Checkpointer.load` gates `isBoundaryId(runId)` first (file/checkpointer.ts:453) returning an honest `cache-error` ("there is no checkpoint to call corrupt… `cache-error` is the honest kind"). A brand-bypassed non-string `runId` today inhabits the branded `runId` field of typed `checkpoint-missing`/`checkpoint-corrupt` values the factories only brand-cast — against the backend's documented re-validate-bypassed-brands + truthful-branding discipline. **Fix:** at the top of `resumeFileJobUnchecked`, before any error construction that embeds `runId`: `if (!isBoundaryId(runId)) return err(fileCacheError("resumeFileJob", "resumeFileJob rejected: runId <render> does not match <ID_PATTERN> — refusing to address a path outside <directory>"))` (mirror of the `load` gate; message rendered via the total `safeDiagnosticRender`; constructed through `fileCacheError` — the SC-006-sanctioned bridge that keeps the operation name inside the closed `FileOperation` vocabulary — NOT the public `frameworkError.cacheError` factory, which the boundary gate forbids inside `file/**`). `resume-proof.ts` stays pure. **Pin:** `file-resume.test.ts` — non-string `runId` (bypassed brand) ⇒ `err`, kind `cache-error`, operation `resumeFileJob`, message names the rejection; hostile throwing-`toString` runId ⇒ still typed, never raw. |
| A9 | `type-design-analyzer-2` | `file/checkpoint-record.ts:37` / `src/file.ts` | The barrel exports the nominal `FileCheckpointCommit` type but not its runtime capability predicate `isFileCheckpointCommit` (exported at checkpoint-record.ts:37), so a host cannot verify commit provenance across a boundary. **Fix:** add `isFileCheckpointCommit` to the `file.ts` barrel export block from `./file/checkpoint-record.js`, completing the nominal capability surface. The claim's second half — `FileEventRecord` being structural-only (cast-forgable brands, no predicate) — is the known port-type redesign cluster the project has routed to deepen (round-10 deferrals); **that half is deferred to the deepen round** and explicitly not re-opened here (no public surface trusts caller-supplied records today, so no reachable violation). |
| A10 | `comment-analyzer-1` | `queue-bullmq/adapter.ts:69` | `// FR-082: attach default error listener…` misattributes: FR-082 (2026-05-08 durable-runtime spec:179) is the queue import-isolation rule, not an error-listener requirement (round 10 fixed the same miscitation class in boundary-imports.test.ts; this site was not covered). **Fix:** replace the tag with a self-contained comment: `// default error listener: an unhandled ioredis "error" rejection would crash the process; log it instead`. |
| A11 | `comment-analyzer-2` | `file/checkpointer.ts:263` | The `@throws {FrameworkError} cache-error(createFileCheckpointer)` JSDoc sits on `createFileCheckpointerUnchecked`, whose body throws raw `TypeError` values (directory check, `parseFileCheckpointerClock`); the typed conversion happens in the public `createFileCheckpointer` shell. **Fix:** reword the unchecked doc: configuration rejections are raw `TypeError` diagnostics converted to typed `cache-error(createFileCheckpointer)` by the public shell (which carries the typed `@throws`). |
| A12 | `comment-analyzer-3` | `file/job.ts:124` | `createFileJobUnchecked`'s JSDoc claims "Throws only typed `FrameworkError`… (AD-6)" but the annotated body throws raw strings at factory validation (`throw "createFileJob arguments must be an object"` :129/:135) that only the public `createFileJob` shell wraps. **Fix:** same rewording as A11 — the unchecked body throws raw diagnostics; the public shell is the typed boundary. |
| A13 | `comment-analyzer-4` | `file/atomic.ts:25` | Module header: "A branded lease type may be introduced in a future API revision…" — a forward-looking API prediction in code; the scope decision is owned by ADR-0078. **Fix:** replace with a pointer: the token is an internal ownership check, not a public lease (scope decision: ADR-0078). |
| A14 | `comment-analyzer-5` | `state-machine/replay.ts:48` | `replayEvents` JSDoc calls the raw `E[]` overload "(legacy form, used internally by tests and code that already stripped envelopes)" — reads as deprecated though it is a currently supported exported form. **Fix:** neutral wording: raw events `E[]` (callers that already stripped envelopes) or `RecordedEvent<E>[]` (the shape returned by `EventLogReader.readEvents`). |
| A19 | `architecture-tech-lead-5` | `file/freshness-index.ts:28` | The file freshness adapter imports `TTL_SECONDS` from the Checkpointer port file (`../checkpoint/checkpointer.js`), coupling the FR-032 freshness contract to the FR-027 checkpoint TTL: a future checkpoint-TTL change would silently redefine freshness expiry and break parity with `RedisFreshnessIndex` (own private `86_400` copy, checkpoint/redis-freshness-index.ts:32). **Fix:** (i) `types/freshness.ts` (FreshnessIndex port section) declares the port-owned `FRESHNESS_TTL_SECONDS = 86_400` with the FR-032 24-hour contract in its doc; (ii) `file/freshness-index.ts` imports it from the port type module instead of the checkpoint port file; (iii) `checkpoint/checkpointer.ts` `TTL_SECONDS` doc updated — the freshness file backend consumes the FreshnessIndex port's own constant, not this one; (iv) parity pin in `file-freshness-index.test.ts`: `FRESHNESS_TTL_SECONDS === TTL_SECONDS` while the two ports mean to agree (ADR-0079 target). The 24-hour value and the ADR-0079 parity target are not re-litigated. |
| A20 | `code-simplifier-1` | `file/layout.ts:213,291`; `file/event-record.ts:256,810` | The durable sequence domain (non-negative safe integer ≤ `MAX_LEXICOGRAPHIC_SEQUENCE`) is hand-spelled at four sites although the shared `isNonNegativeSafeInteger` predicate (checkpoint/composite-node-key.ts:85 — `typeof value === "number" && Number.isSafeInteger(value) && value >= 0`) was exported for exactly that domain in round 8 A15. **Fix:** replace the first-conjunct spellings with `!isNonNegativeSafeInteger(x)` at all four sites (`eventFileNameUnchecked`, `eventDigestOfUnchecked`, `parseJournalSequence`, `serializeFileEventRecordUnchecked`), keeping each site's separate ceiling check and its exact message verbatim. De Morgan-identical at every site; no behavior change; framework-core → framework-core imports, boundary rule untouched. |
| A21 | `code-simplifier-2` | `checkpoint/composite-node-key.ts:202` | `parseCompositeNodeKey` hand-counts `@` separators in a loop (early bail at 4), classifies, then splits the same string a second time. **Fix:** single `const parts = key.split("@")`; classify by `parts.length` (1 ⇒ canonical, 4 ⇒ composite, else ⇒ null); destructure from `parts`. Classification is exactly `separators = parts.length - 1` — identical verdict for every input (empty string, trailing `@`, 1/2/4+ separators, non-strings all traced). |
| A22 | `code-simplifier-3` | `checkpoint/composite-node-key.ts:97` | `assertIndexOrAttempt`: `typeof value !== "number" \|\| !isNonNegativeSafeInteger(value)` — the outer clause is subsumed by the predicate's own first conjunct. **Fix:** `if (!isNonNegativeSafeInteger(value))`. Verdict-, message-, and trap-behavior-identical (the predicate short-circuits before any `>= 0`/coercion; the round-9 A2 hostile `valueOf`/`toString` pins assert the codec's typed message, unchanged). |

### Deferred (concrete, evidence-based reasons)

| # | id | reason |
|---|----|--------|
| A5 | `pr-test-analyzer-3` | FR-031 per-resource write serialization is proven in-process (`Promise.all`, file-freshness-index.test.ts:384); the underlying `withFileLock` primitive is already proven cross-process (file-atomic.test.ts, file-journal.test.ts three-child-spawn suites). The freshness singleton adds no locking logic of its own over the primitive — the multi-process witness is parity hardening, not a gap in a load-bearing contract (reviewer's own residual-risk rating: low). Deferred to keep this round's diff to verified, minimal, in-scope fixes; candidate for the next `file/` test-hardening round. |
| A15 | `architecture-tech-lead-1` | Journal append decision-core extraction (`journal-plan.ts`) is a behavior-preserving structural refactor — the project's own tracked deferral (round-10 A12, "the last durable write surface without a pure, directly testable decision core"), scheduled for the next `file/` deepening round. Not a correctness finding (confidence 78%, advisory); mixing a module extraction into an advisory-remediation round blurs the audit trail. |
| A16 | `architecture-tech-lead-2` | Freshness AD-5 decision-core extraction (`freshness-codec.ts`) — tracked deferral (round-7 D2 / round-9 / round-10 A11), scheduled "for the next `file/` deepening round". Same reasoning as A15. |
| A17 | `architecture-tech-lead-3` | Truthful-branding `checkpoint-write-failed` single-owner extraction (new lower module; the port layer cannot import `file/`) — tracked deferral (round-7 D1 / round-9 / round-10 A15+A18, "route through deepen"). The two in-scope copies are verified field-for-field identical at HEAD (code-simplifier cross-check), so the proven drift (round-6 C4) is not currently recurring. |
| A18 | `architecture-tech-lead-4` | FR-009 losslessness-gate concept module extraction (`lossless.ts`) + barrel narrowing — tracked deferral (round-8 / round-10 A13), "next `file/` deepening round". Structural; the two mechanisms are currently aligned and pinned. |

### Dismissed (evidence-based)

| # | id | reason |
|---|----|--------|
| A2 | `silent-failure-hunter-2` | **Not reproducible — the claimed mechanism is unreachable.** Empirically verified on both runtimes (node v24.14.1, bun 1.3.13): the WHATWG URL parser rejects non-canonical ports before `parseInt` ever sees them — `redis://h:6379abc` and `redis://h:70000` both throw `Invalid URL`; `+`/hex/whitespace ports also throw. The only reachable degenerate port is `0` (`redis://h:0` → `url.port === "0"` → `parseInt → 0`), and ioredis performs no port validation (verified in `node_modules/ioredis/built`), so `new Redis(0, host)` fails the TCP connection loudly (port-0 `connect` refuses; the module's own `redis.on("error", …)` listener logs it) — it never silently targets a different port. The claim's stated consequence ("silently target the wrong port") cannot occur; the cited example is refuted by direct reproduction. A fail-fast config-time port gate would be new hardening beyond the claim, not a fix for a demonstrated defect. |
| A6 | `pr-test-analyzer-4` | The `appendEvent` 6-digit-ceiling branch is two lines and its exact error kind/class/message is already pinned through the exported `journalCapacityError` seam (the branch is the seam's construction site; there is no additional behavior between the seam and the throw). An end-to-end 1,000,000-record directory would exercise path length only, at real fs cost, with no new behavioral coverage — the reviewer's own 3/10 rating calls the current state defensible. The waiver comment in the test documents exactly this. |

## Files changed (planned)

In-reviewed-scope:
1. `packages/framework/src/file/layout.ts` — A1 (`"permanent"`), A20 (2 sites)
2. `packages/framework/src/file/event-record.ts` — A20 (2 sites)
3. `packages/framework/src/checkpoint/composite-node-key.ts` — A21, A22
4. `packages/framework/src/file/resume.ts` — A8 (gate + imports)
5. `packages/framework/src/__tests__/file-resume.test.ts` — A8 pins
6. `packages/framework/src/file.ts` — A9 (barrel export)
7. `packages/framework/src/queue-bullmq/adapter.ts` — A10 (comment)
8. `packages/framework/src/file/checkpointer.ts` — A11 (JSDoc)
9. `packages/framework/src/file/job.ts` — A12 (JSDoc)
10. `packages/framework/src/file/atomic.ts` — A13 (header)
11. `packages/framework/src/state-machine/replay.ts` — A14 (JSDoc)
12. `packages/framework/src/types/freshness.ts` — A19 (port-owned TTL constant)
13. `packages/framework/src/file/freshness-index.ts` — A19 (import swap)
14. `packages/framework/src/checkpoint/checkpointer.ts` — A19 (`TTL_SECONDS` doc)
15. `packages/framework/src/__tests__/file-freshness-index.test.ts` — A7 pin, A19 parity pin

Support path (registered):
16. `packages/framework/src/__tests__/state-machine-replay.test.ts` — A3, A4 pins

## Validation commands (must all pass before remediation install)

```bash
bun run typecheck                      # workspace typecheck (SC-004)
cd packages/framework && bun test      # full framework suite (SC-005; includes SC-006 boundary gate via boundary-imports.test.ts)
cd packages/host && bun test           # host suite (no regression across the barrel)
bun test                               # workspace remainder
```

Behavior-preservation checks folded into the new pins: A20/A21/A22 are
verdict/message-identical transforms (existing pinned messages must survive
verbatim); A8 adds a rejection BEFORE any fs I/O (existing resume tests must
pass unchanged); A19 changes no value (86_400 both sides, parity pin proves it).
