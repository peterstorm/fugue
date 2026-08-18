# PR Remediation Plan — Round 16 (standalone review)

- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-18-165243-f6-file-durable-runtime`
  (registered standalone-review, kind `all`, files null, dryRun false)
- **Frozen scope:** 330 files = full branch diff vs `origin/main` (merge-base `6c316cb`), HEAD `0ddcf75`.
  The complete frozen path list is the authoritative `scope` array in the run's `result.json`.
- **result.json:** published atomically by the registered Standalone Review Program,
  digest `7db224810a8c31bbed93cc6a6bf348d4fc3b76224ab413e3b842253823c992df` (35,464 bytes).
- **Reviewers:** 7/7 on attempt 1 (code-reviewer, silent-failure-hunter, pr-test-analyzer,
  type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier).
  All seven transcripts captured into their reserved slots; all seven submits idempotently
  confirmed; the engine aggregated and published `result.json` (no Refutation Panel — empty
  critical set, `panel: null`).

## Surviving critical findings

**None.** `surviving_critical_findings: []`.

## Refuted-finding audit

**None.** `refuted_critical_findings: []` — no criticals were raised, none were routed to a
panel, nothing is carried as refuted evidence.

## Advisory dispositions (20 total: 12 accepted, 8 deferred, 0 dismissed)

Every claim was verified against the frozen source (files read at HEAD) before disposition.

### Accepted — 12

| ID | Finding | Concrete fix |
|----|---------|--------------|
| silent-failure-hunter-1 | `createLogAuditSink`'s empty catch (`audit-sink-log-redis.ts:100`) silently drops the audit record when the injected logger throws — no last-resort channel, so the "resilient floor" sink can lose a record with zero trace exactly when the Redis stream is also unavailable. Verified (the catch is `catch {}` with only a comment). | Keep the never-throw contract; in the catch, emit a last-resort breadcrumb that bypasses the host logger entirely — `process.stderr.write` with action/tenant and the safe-rendered cause, itself wrapped in a guarded try/catch (stderr itself can be unavailable — nothing further is possible). Update the sink's JSDoc ("caught and dropped" → "caught and reported to stderr as a last resort"). Pin in `audit-sink.test.ts` (support path): logger that throws → `record` still resolves AND a stderr breadcrumb containing the action is captured (temporarily replacing `process.stderr.write`). |
| silent-failure-hunter-2 | `path-resolving.ts:172` wraps `config.getAccessToken()` in `catch { return ""; }` — the provider's thrown cause is discarded, and the node gets an undifferentiated `transient: "token acquisition failed for SharePoint path resolution"`; the stock adapter twin (`index.ts:236`) preserves the cause (`token acquisition failed: <msg>`). Verified (no existing test pins this message). | Capture the cause at the catch (`e instanceof Error ? e.message : String(e)`) and include it in the transient message: `token acquisition failed for SharePoint path resolution: <cause>` (suffix only when a cause was captured). Pin in `path-resolving.test.ts`: token provider throws → transient error message contains the provider's cause; provider returns "" → message without a spurious cause suffix. |
| silent-failure-hunter-3 | `adapter-oracle` `healthCheckWithTimeout` (`index.ts:536`) swallows the losing probe's late rejection with `catch(() => {})` — the Oracle root cause (ORA-03113/03135, pool exhaustion) is discarded with no log after the timeout verdict. Verified (swallow is documented and correct for the unhandledRejection class; the gap is the missing diagnostic). | Keep the swallow (the verdict is already decided) but log the late cause, credential-stripped like the rest of this file: `console.warn` with the `stripCredentials`-rendered message, the render itself guarded so diagnostics can never throw. Pin in `oracle-adapter.test.ts` (support path): late rejector → timeout result unchanged AND a warn line containing the stripped late cause is captured; the existing no-unhandledRejection pin stays green. |
| pr-test-analyzer-1 | No consumer-level NFR-020 backend-swap pin for the file Checkpointer: the only production resume consumer (`apps/customer-summary/src/server.ts:110` — `checkpointer.load` + error-kind→HTTP mapping + subject binding + fingerprint gate) is exercised only against `InMemoryCheckpointer`. Verified (`server.test.ts` is hardwired to `InMemoryCheckpointer`; the port contract itself is covered by `checkpointerSuite` for all three backends — the gap is the consumer path against the file backend). | In `server.test.ts` (in scope), parameterize the resume consumer flow over backends: pre-seeded resume → 200 with resumed state; subject (IDOR) mismatch → 404; DAG fingerprint mismatch → 409; checkpoint-expired → 409 — run the whole block against `InMemoryCheckpointer` AND `createFileCheckpointer` on a temp directory. The Redis leg is covered at the port level by the shared `checkpointerSuite` (SC-001); an app-level Redis leg would add a Redis dependency to the app test env and is out of scope for this pin. |
| pr-test-analyzer-2 | The file journal's run-directory symlink policy is undocumented and unpinned, unlike both sibling backends (checkpointer rejects symlinks — pinned; freshness index follows them — documented + pinned in round 15). `createFileJournal` performs no `verifyDirectory`; `listEventFiles`' `statSync` follows symlinks at record names; a symlinked `events/` is written through. Verified (`journal.ts:253` `statSync`, `:240` `readdirSync`). | Add a "Symlink policy" comment at the journal (module header + `listEventFiles`) documenting the deliberate divergence: the caller's run directory is the trust boundary (a writer inside it can already forge record bytes, so symlink strictness buys no security, only divergence), in contrast to the checkpointer's caller-controlled path material. Add two behavior pins in `file-journal.test.ts` (verify actual behavior first, pin what is true): (a) a symlink at a record name is read through on resume/append; (b) the append's atomic rename replaces the symlink itself, not its target. |
| type-design-analyzer-1 | The id-taking `frameworkError` factories declare `string \| RunId` / `string \| NodeId` parameters, but brand through `__brandRunId`/`__brandNodeId`, which throw a raw `Error` for any string outside `ID_PATTERN` — contradicting the module's documented accept-plain-strings contract and making `checkpoint-write-failed`'s documented `invalidRunId`/`invalidNodeId` case (the case those additive fields exist for) unconstructable through the public factory. Verified at runtime. | In `types/error-factories.ts`, make `frameworkError.checkpointWriteFailed` apply truthful branding instead of throwing: raw ids that fail `ID_PATTERN` never inhabit the branded field — they take the documented grammar-valid placeholders while the rejected RAW bytes are preserved additively in `invalidRunId`/`invalidNodeId` through a total (throw-safe) renderer — exactly the contract `types/errors.ts` documents and the file codec's `writeFailed` implements. Valid/branded inputs behave byte-identically to today. In `checkpoint/checkpointer.ts`, the in-memory adapter's private `checkpointWriteFailed` builder then delegates to the public factory (identical semantics: same `typeof`+`ID_PATTERN` gate, same placeholder values, same total renderer), removing one of the manually-mirrored policy sites (a concrete step toward the deferred architecture-tech-lead-1 consolidation; the file codec's `unknown`-domain `writeFailed` with its meta-record branch stays as-is until that round). Pin in `error-factories.test.ts`: invalid raw runId/nodeId → placeholder brands + `invalid*` fields carrying the raw bytes verbatim; valid inputs unchanged; the existing in-memory hostile corpus stays green. |
| comment-analyzer-1 | Host-pod comments cite multi-tenant spec FR numbers (e.g. `@satisfies FR-019/FR-021` in `thin-init.ts:45-46`) that the in-scope F6 spec assigns to different requirements (FR-021 = composite node-key extension in F6); `CONTEXT.md` disambiguates AD-code collisions but not FR-number collisions, so an FR-number grep returns two meanings. Verified (cross-checked both specs' FR assignments; the host citations are all 2026-06-18 multi-tenant spec numbers). | Qualify the host-pod FR citations with the owning spec (`multi-tenant spec FR-019` form) in `thin-init.ts`, `bun-init-process-adapter.ts`, `worker-lifecycle-manager.ts` (in scope) and `audit-port.ts` (support path). Add an FR-number disambiguation note to `CONTEXT.md`'s mapping section, mirroring the existing AD-code note (in scope). |
| comment-analyzer-2 | The EINTR comment at `bun-init-process-adapter.ts:83` claims an early break "merely defers one orphan's reap to the next cycle" — an EINTR landing mid-burst defers every remaining reap of that burst (the drain loop exists precisely because coalesced exits can leave several). Verified (the `drainReap` contract above the comment). | Rewrite the clause: "That defers the rest of that burst's reaps to the next cycle, bounded by the safety-net interval — never a persistent zombie leak." (The load-bearing conclusion is unchanged — it was already correct.) |
| comment-analyzer-3 | The `readClock` doc at `checkpoint/checkpointer.ts:283` ends with "the pair used to be inlined twice here, and the file backend's twin consolidated the same pair in round 12" — a transitional remediation reference no future maintainer can resolve. Verified. | Trim the final clause; keep "ONE encoding for `load` and `setMeta`" plus the NaN/Time-Value-range rationale (the contract content). |
| code-simplifier-1 | `redis-freshness-index.ts:32` re-encodes the 24h TTL locally (`const TTL_SECONDS = 86_400`) instead of importing `FRESHNESS_TTL_SECONDS` from the port module `types/freshness.ts` it already value-imports; the file freshness backend does exactly this, and no test links the adapter's literal to the port constant. Verified. | Import `FRESHNESS_TTL_SECONDS` from `../types/freshness.js` and use it at the two ZADD+EXPIRE script sites; delete the local constant. Behavior-identical (same value today); the existing parity pin (`file-freshness-index.test.ts:388`) stays green. |
| code-simplifier-2 | The journal sequence-domain rule (non-negative safe integer ≤ `MAX_LEXICOGRAPHIC_SEQUENCE`) is encoded at four sites — `parseJournalSequence` (event-record.ts:242), `serializeFileEventRecordUnchecked` (event-record.ts:797), `eventFileNameUnchecked` (layout.ts:218), `eventDigestOfUnchecked` (layout.ts:296) — while the sibling dedupKey rule has one shared encoding (`dedupKeyError`), and the four ceiling messages have already diverged. Verified (all four sites read; no test pins the exact message strings — the only pinned sibling is the meta codec's distinct `nodeCount` rule). | Add ONE `sequenceDomainError(value): verdict \| null` to `layout.ts` (the deeper module — `event-record.ts` already imports from `layout.js` — next to `MAX_LEXICOGRAPHIC_SEQUENCE`, mirroring the `dedupKeyError` discipline): a structured verdict (`not-a-safe-integer` / `exceeds-ceiling`) carrying the hostile-safe rendering of the value (the read-side boundary must not raw-interpolate; the three `*Unchecked` write-side sites today raw-interpolate `number`-typed values, which render identically — strictly safer for hostile bypass inputs, no pinned message affected). All four sites consume the one verdict and keep their per-site message tails byte-identical for every input that could previously reach each clause (the tails intentionally name the consuming layer). |
| code-simplifier-6 | The round-trip-loss argument ("losses are invisible to a round-trip comparison because `serializeValue` strips/drops identically on both sides") is stated three times in `event-record.ts` (module header :24-29, `serializeFileEventRecord` JSDoc :768-774, `serializeFileEventRecordUnchecked` body :792-795) despite the header's own one-canonical-site pointer policy. Verified. | Keep the module header as the canonical statement; reduce the JSDoc and body comment to one-line pointers to the header, per the header's own policy ("copies drift"). Comments only — behavior untouched. |

### Deferred — 8 (tracked to the scheduled `file/` + port deepening round)

| ID | Finding | Deferral reason |
|----|---------|-----------------|
| architecture-tech-lead-1 | The Checkpointer parity policy (truthful-branding error construction + `setMeta` kind-mapping) is manually mirrored in each adapter with the port docblock as the only normative source; a policy change must land in every adapter + per-backend suite simultaneously. | Structural module-boundary change (a new port-owned pure failure-policy module called by three adapters, with the ADR-0080 surface table as data, plus per-backend suite rewiring). The hazard is already documented at the port ("any change to it must land on BOTH sides") and behavior-pinned per backend by the shared `checkpointerSuite`. Belongs to the scheduled deepening round with an ADR-level decision; this round's type-design-analyzer-1 fix removes one of the three mirrors (in-memory now delegates to the public factory), shrinking the surface. |
| architecture-tech-lead-2 | The Checkpointer port mixes branded and bare-string identifiers (`saveNode(runId: RunId, nodeId: string)`, `RunMeta.dagId: string`), forcing each adapter to impose its own identifier discipline. | Requires consciously un-freezing the FR-042-frozen port surface — "a decision, not a distill" (reviewer's words); the `RunId`/`NodeId`/`DagId` ownership question was explicitly deferred across prior rounds and is tracked in the frozen round-10…15 plans. No wrongness rides on it now (every in-scope call site passes validated/branded ids; the one hostile-value site hand-guards). |
| architecture-tech-lead-3 | No Checkpointer adapter validates `RunMeta.dagId` against `DAG_ID_REGEX` (file codec `typeof`-checks only; in-memory never checks) even though the `DagId` brand + smart constructor exist. | Subsumed by architecture-tech-land-2 (re-type as `DagId` — reviewer's own recommendation). Landing the regex gate alone, without the re-typing decision, would change the frozen surface's acceptance domain (malformed dagIds would start failing closed at the port) without the spec/ADR decision — exactly the class deferred in round 15 (that round's type-design-analyzer-1). Rides with arch-2. |
| architecture-tech-lead-4 | `compositeNodeKey` throws a plain `Error` while `parseCompositeNodeKey` returns `null` and the file codec returns `Result`, forcing the only production call site to wrap-and-remap — three error channels in one pure module. | Changes the error channel of an exported frozen-surface module; the single production call site already wraps correctly and is pinned; prior rounds explicitly deferred "the composite-codec error channels" (tracked in the frozen round-13/15 plans; the type-design-analyzer confirms they remain correctly tracked and does not re-emit). The scheduled deepening round's call. |
| architecture-tech-lead-5 | `InMemoryCheckpointer.__testRawMetas()` returns the live mutable internal `Map` through the publicly exported class — the aliasing class `detachStored` exists to prevent, under a "MUST NOT" comment rather than a structural guarantee. | Already consciously deferred in prior rounds (round-15 plan, type-design-analyzer-2 of that round; the type-design-analyzer this round confirms it "remains correctly tracked in the frozen plans" and deliberately did not re-emit it). The complete fix is a shared-`checkpointerSuite` seam redesign (constructor-adopted test-owned map + rewiring the in-memory leg's seven `__testRawMetas` call sites) with zero production correctness impact — the in-memory backend is not a production backend (host wires file/Redis), and the `__test*` convention is a documented project idiom the code-simplifier deliberately did not flag. Rides with the deepening round alongside arch-1 (its policy-mirror sibling). |
| code-simplifier-3 | The `checkpoint-write-failed` construction policy (`stringOf`, `INVALID_RUN_ID`/`INVALID_NODE_ID` placeholders, truthful branding) is manually mirrored in `file/checkpointer-codec.ts:78-140` and `checkpoint/checkpointer.ts:172-238`, acknowledged in comments as "must land on BOTH sides". | Duplicate of architecture-tech-lead-1 (the same mirrored policy, flagged from the distill side); the reviewer itself routes it: "the required move is a module-boundary change, which is **deepen's territory, not distill's**". Same deferral. Note: this round's type-design-analyzer-1 fix delegates the in-memory site to the public factory, reducing the mirror from three implementation sites to two + one delegator. |
| code-simplifier-4 | Two hand-rolled write-side losslessness pre-scans re-encode the same serializer-rejection inventory (`assertLosslessEventUnchecked` in event-record.ts:438 and `materializeCanonicalOutput` in checkpointer-codec.ts:402); unifying them needs a new shared structured-violation seam. | Requires a new shared interface seam across two modules whose message text is deliberately per-module and test-pinned; the two walks are in behavioral agreement today (drift risk, not divergence — verified by both reviewers). The reviewer explicitly recommends `deepen`, not a safe distill move. Scheduled deepening round. |
| code-simplifier-5 | Five file-backend clock-guard sites each re-encode the throwing-or-non-finite clock guard with subtly different semantics (finiteness-only vs finite-plus-representable, throw vs `Result`) and module-specific test-pinned messages. | The reviewer's own trigger for action: "no action needed until one site's semantics must change, at which point the shared guard is the unifying move (deepen)". The five semantic differences are deliberate and test-pinned per module (the freshness-index site's comment marks it "the third of the five" from an earlier deliberate per-module consolidation); unifying now would flatten intentional distinctions for no correctness gain. |

### Dismissed — 0

No claim failed verification; nothing is dismissed.

## Remediation start input

- `sourceRunsRoot`: `.claude/reviews/review-and-fix-runs`
- `sourceRun`: `standalone-2026-08-18-165243-f6-file-durable-runtime`
- `supportPaths`:
  - `.claude/plans/2026-08-18-pr-remediation-round-16.md` (this plan — created after the review run froze its scope)
  - `packages/host/src/__tests__/supervisor/audit/audit-sink.test.ts` (regression pin for silent-failure-hunter-1; not in frozen scope)
  - `packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts` (regression pin for silent-failure-hunter-3; not in frozen scope)
  - `packages/host/src/supervisor/audit/audit-port.ts` (comment-only FR-citation qualification for comment-analyzer-1; not in frozen scope)

## Changed files (planned)

In frozen scope:
1. `packages/host/src/supervisor/audit/audit-sink-log-redis.ts` (sfh-1)
2. `packages/adapter-ms-graph/src/path-resolving.ts` (sfh-2)
3. `packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts` (sfh-2 pin)
4. `packages/adapter-oracle/src/index.ts` (sfh-3)
5. `apps/customer-summary/src/__tests__/server.test.ts` (pta-1 pin)
6. `packages/framework/src/file/journal.ts` (pta-2 comment)
7. `packages/framework/src/__tests__/file-journal.test.ts` (pta-2 pins)
8. `packages/framework/src/types/error-factories.ts` (tda-1)
9. `packages/framework/src/checkpoint/checkpointer.ts` (tda-1 delegation + ca-3 comment trim)
10. `packages/framework/src/__tests__/error-factories.test.ts` (tda-1 pins)
11. `packages/host/src/supervisor/lifecycle/thin-init.ts` (ca-1)
12. `packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts` (ca-1, ca-2)
13. `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` (ca-1)
14. `CONTEXT.md` (ca-1 FR-disambiguation note)
15. `packages/framework/src/checkpoint/redis-freshness-index.ts` (cs-1)
16. `packages/framework/src/file/layout.ts` (cs-2 shared verdict)
17. `packages/framework/src/file/event-record.ts` (cs-2 consumption, cs-6 pointers)

Support paths (see above): the plan file, `audit-sink.test.ts`, `oracle-adapter.test.ts`, `audit-port.ts`.

## Validation commands

- `bun run typecheck` (workspace, 12/12 projects must exit 0)
- `cd packages/framework && bun run typecheck && bun test` (full framework suite — the cs-2/cs-6/tda-1 message-pinning surface)
- `cd packages/host && bun run typecheck && bun run test` (documented two-part script; signals.test.ts isolated)
- `cd apps/customer-summary && bun run typecheck && bun test` (pta-1 consumer pins)
- `cd packages/adapter-ms-graph && bun run typecheck && bun test` (sfh-2 pin)
- `cd packages/adapter-oracle && bun run typecheck && bun test` (sfh-3 pin)
- Stop without staging or committing if any of the above cannot pass.

## Results

### Implementation — all 12 accepted fixes landed

| Fix | Outcome |
|-----|---------|
| sfh-1 | stderr breadcrumb in `createLogAuditSink`'s catch (guarded try/catch around the write itself); JSDoc updated; pin captures `process.stderr.write` — logger throws → record still resolves AND breadcrumb with the action lands on stderr. |
| sfh-2 | Cause captured at the catch and appended (`…path resolution: <cause>`, suffix only when a cause exists). **Adjudication during implementation:** an existing pin from the wrapper's introducing commit (`66b8740`) asserted the OPPOSITE — `not.toContain("AADSTS7000215")`. Before overriding it, I verified the host's standard token provider (`ms-graph-token.ts`) throws only secret-free messages (endpoint host / HTTP status / AADSTS code / "no access_token" — the client secret rides in the request body, never in a message), which is exactly why the stock adapter's twin surfaces the cause. The exclusion was initial-implementation behavior, not a documented decision, and the package's own established standard for this failure class is cause-preserving. The acceptance stands; the superseded pin was replaced by two pins: cause preserved (kind stays `transient`) + empty-token-no-throw → message WITHOUT a spurious cause suffix. |
| sfh-3 | Late probe rejection now logged via `console.warn` with the `stripCredentials`-rendered cause (render guarded — a failing diagnostic cannot throw); docblock updated; pin asserts the verdict unchanged + warn line carries the stripped cause (`***@db:1521/ORCL`, no `scott/tiger@`). The pre-existing no-unhandledRejection pin stays green. |
| pta-1 | The resume consumer describe is parameterized over backends (in-memory + `createFileCheckpointer` on a fresh `mkdtempSync` dir per test, cleaned in `afterEach`) — all 8 backend-dependent tests × 2 backends = 16 pins, broader than the 4-case minimum planned (the whole block is backend-agnostic by construction). `createTestApp` widened to the `Checkpointer` port. The two null-checkpointer 503 tests stay at describe level (backend-irrelevant). The 9th (legacy-meta) test moved into the loop — a duplicate describe-level copy was removed in the same pass (distill: no duplication). All 16 pass, including the file-backend leg against the real F6 checkpointer. |
| pta-2 | Symlink-policy documented at the journal module header + `listEventFiles`. **Redesigned during implementation:** the first draft of pin (b) — "append's rename replaces the symlink, not its target" — could not be configured validly: `append` numbers records `sequence = count(existing)`, so a symlink at the NEXT name is read through on the pre-rename listing (the record counts as existing), making a rename-over-symlink at that name unreachable at journal level. The pin therefore landed at the primitive that actually performs the rename: `atomicWriteFile` in `file-atomic.test.ts` (symlink at the target path → rename replaces the link itself, target file untouched — the same primitive `append` uses). Pin (a) (reader read-through at a record name) + the keyed-dedup no-op pin landed in `file-journal.test.ts` as planned. |
| tda-1 | `checkpointWriteFailed` applies truthful branding: malformed raw ids take the grammar-valid placeholders while the raw bytes survive additively in `invalidRunId`/`invalidNodeId` via a total renderer; `stringOf` + placeholders exported as canonical from `types/error-factories.ts`. The in-memory builder delegates to the public factory (mirror removed); the file codec imports the canonical placeholders/renderer. Pins: invalid raw ids → placeholders + verbatim raw bytes; valid inputs byte-identical; in-memory hostile corpus green. |
| ca-1 | All multi-tenant-spec FR/SC/NFR citations qualified in `thin-init.ts` (2), `bun-init-process-adapter.ts` (3), `worker-lifecycle-manager.ts` (11), `audit-port.ts` (12, support path); `CONTEXT.md` gained the FR-number disambiguation note mirroring the AD-code note. Uniform rule applied: every spec citation in host-pod code carries its owning spec. |
| ca-2 | EINTR clause rewritten: "That defers the rest of that burst's reaps to the next cycle, bounded by the safety-net interval — never a persistent zombie leak." |
| ca-3 | `readClock` doc trimmed — unresolvable transitional reference removed; contract content kept. |
| cs-1 | `FRESHNESS_TTL_SECONDS` imported from the port module at both script sites; local `TTL_SECONDS` deleted. Parity pin green. |
| cs-2 | One `sequenceDomainError(value)` verdict in `layout.ts` (`not-a-safe-integer` / `exceeds-ceiling` + hostile-safe rendered value); all four sites consume it; per-site message tails byte-identical for every previously-reachable input. `event-record.ts`'s now-unused `isNonNegativeSafeInteger` import removed. |
| cs-6 | Round-trip-loss argument canonical in the module header; JSDoc + body comment reduced to one-line pointers per the header's own policy. |

### Final changed-file list (22 modified + 1 new)

```
M  CONTEXT.md
M  apps/customer-summary/src/__tests__/server.test.ts
M  packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts
M  packages/adapter-ms-graph/src/path-resolving.ts
M  packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts
M  packages/adapter-oracle/src/index.ts
M  packages/framework/src/__tests__/error-factories.test.ts
M  packages/framework/src/__tests__/file-atomic.test.ts      (pta-2 pin, moved from file-journal.test.ts — see above)
M  packages/framework/src/__tests__/file-journal.test.ts
M  packages/framework/src/checkpoint/checkpointer.ts
M  packages/framework/src/checkpoint/redis-freshness-index.ts
M  packages/framework/src/file/checkpointer-codec.ts
M  packages/framework/src/file/event-record.ts
M  packages/framework/src/file/journal.ts
M  packages/framework/src/file/layout.ts
M  packages/framework/src/types/error-factories.ts
M  packages/host/src/__tests__/supervisor/audit/audit-sink.test.ts   (support path)
M  packages/host/src/supervisor/audit/audit-port.ts                  (support path)
M  packages/host/src/supervisor/audit/audit-sink-log-redis.ts
M  packages/host/src/supervisor/lifecycle/bun-init-process-adapter.ts
M  packages/host/src/supervisor/lifecycle/thin-init.ts
M  packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts
A  .claude/plans/2026-08-18-pr-remediation-round-16.md               (this plan)
```

### Validation (CI-canonical gate, `.github/workflows/ci.yml`)

- Root: `bun test scripts/` → 7 pass / 0 fail; `bun run check:docs` → 19 shipped doc files, all links resolve (CONTEXT.md edit verified).
- Workspace: `bun run typecheck` → 12/12 projects exit 0.
- Per-package `tsc --noEmit && bun run test` (the CI loop, exact package list):  
  framework 2892/0 · document-source 18/0 · xlsx 20/0 · adapter-fs 21/0 · adapter-ms-graph 61/0 · adapter-pg 33/0 · adapter-oracle 60/0 · http-auth 66/0 · host 2051/0 (two-part script: 2041+10 pass, 11 skip, 0 fail).  **2922 pass / 0 fail total across the gate.**
- `apps/customer-summary` (not in the CI package list, verified anyway): `bun test` → 31 pass / 0 fail (includes the 16 backend-parameterized resume pins).

**All gates green. Remediation complete — committed and pushed (see run summary).**
