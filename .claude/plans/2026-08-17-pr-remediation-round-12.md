# PR Remediation — round 12 (standalone review, zero-critical)

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-200637-f6-file-durable-runtime`
- **Authoritative result:** `result.json` (digest `bcdad843fc7811e1be7c684e26db6a5a3bf1128e250635ff15ddc3e8e5ff704f`, 21194 bytes), published atomically by the registered Standalone Review Program after engine-side aggregation + zero-critical finalization
- **Frozen scope:** 79 files (branch diff vs merge-base, digests re-verified byte-identical by code-reviewer and pr-test-analyzer)
- **Reviewers:** 7/7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead + deepen, code-simplifier + distill)

## Adjudication

- **Found (critical):** 0 — no Refutation Panel was required (the registered program routes only non-empty critical sets)
- **Refuted:** 0 (nothing to audit — no criticals reached the panel)
- **Surviving criticals (mandatory fixes):** 0
- **Advisories:** 21 → **13 accepted / 7 deferred / 1 dismissed** (dispositions below)

## Advisory dispositions

### Accepted (13)

| # | Site | Fix |
|---|------|-----|
| A1 | `queue-bullmq/adapter.ts:94` | Attach the default `"error"` listener to every BullMQ `Queue` at construction (`queue.on("error", …)` with the queue name), mirroring the sibling shared-connection (line 71) and Worker (line 165) listeners, so a Queue-internal connection failure is logged instead of crashing with `ERR_UNHANDLED_ERROR` against the adapter's own stated intent. Pin: each `createQueue` result has a registered `"error"` listener (regression test in `queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` — support path). |
| A2 | `file/freshness-index.ts:482,:547` | Outer catches of `recordWrite`/`findConflict` re-wrap already-typed `FrameworkError`s. Add the established ride-through (`if (isFrameworkError(error)) return err(error)`) matching `atomic.ts` acquireFileLock, `journal.ts`, `job.ts` — typed errors keep their operation, location, and inferred `failureClass` instead of double-nesting and losing classification. |
| A3 | `file/freshness-index.ts` (cross-process) | Add a 3-process `recordWrite` convergence test (mirror of the `file-journal.test.ts` cross-process pattern): three real child processes race writes for one resource in one directory; the surviving singleton must be exactly the deterministic max-score record (unique `succeededAtMs` per child write → unambiguous winner `204`), readable by a fresh instance via `findConflict`. Closes the only direct cross-process gap on the public multi-process surface. |
| A5 | `file/freshness-index.ts:436,:524` | A throwing injected `now()` in `recordWrite`/`findConflict` escapes to the unclassified catch-alls (default-retriable), while the same deterministic clock-failure class is pinned `permanent` at every other file-backend clock site. Add a dedicated `try/catch` around each `now()` returning `cacheFailure(…, "permanent")` (journal "clock failed" guard parity), with `failureClass === "permanent"` + `retriabilityOf === "non-retriable"` pins beside the existing non-finite pins. (Complements A2: ride-through covers typed errors; the guard classifies the raw clock throw.) |
| A6 | `queue-bullmq/event-log.ts:71` | Rewrite the XRANGE bound comment: Redis compares stream entry IDs as numeric uint64 pairs (ms, then seq) — not lexicographically; the max-u64 end bound is correct precisely because ordering is numeric. |
| A7 | `file/event-record.ts:93` | Add `checkpoint/composite-node-key.js (isNonNegativeSafeInteger)` to the "Pure module" header's import enumeration. |
| A8 | `file/layout.ts:177` | Reword the `keyDigest` catch comment: no "unhashable" string input exists (ill-formed UTF-16 is routed to the injective encoding before hashing; `Hash.update(string)` does not throw) — the catch is an engine-level hashing-fault fence, re-run identically on the same key. |
| A9 | `checkpoint/composite-node-key.ts:100,106`; `checkpoint/checkpointer.ts:140`; `file/checkpointer-codec.ts:897` | Replace transient round references with the durable pins they denote: `composite-node-key.test.ts` "rejects a throwing-hook … with the codec's own typed message (never a raw trap)"; `redis-checkpointer.test.ts` "setMeta with unreadable metadata is a typed cache-error(checkpoint:setMeta), never a raw rejection"; `file-checkpointer-codec.test.ts` "returns fresh frozen option objects the caller cannot mutate or re-observe". |
| A10 | `.claude/plans/2026-08-12-f6-file-durable-runtime.md:189,459,461` | One-line supersession notes at the three `docs/adr/0075-file-backend-durable-runtime.md` references: the ADR shipped split as ADR-0075 + ADR-0076…0080 (see `docs/adr/README.md`). |
| A16 | `CONTEXT.md` + in-scope F6 code comments | (a) CONTEXT.md gains a "File-Backed Durable Runtime" ubiquitous-language section (event log, checkpoint projection, append lock, benign lag window, resume agreement proof, digest addressing, composite node address, freshness singleton), a `file/` row in the Architecture Layers table, an `@fuguejs/framework/file` row in the Subpath exports table, and the durable AD-1…AD-6 ↔ ADR-0075…0080 crosswalk. (b) Re-point every F6 `AD-n` reference in in-scope `file/**`, `file.ts`, `checkpoint/checkpointer.ts`, `checkpoint/composite-node-key.ts`, `types/errors.ts`, and the in-scope F6 test files to its ADR (AD-1⇒ADR-0075 … AD-6⇒ADR-0080; "AD-3 step N" ⇒ "ADR-0077 step N" — ADR-0077 carries the numbered enumeration). The two AD-bearing runtime message strings (`event-record.ts` dedupKey rationale "(AD-2)", `freshness-index.ts` "AD-5 singleton fields") were converted to the ADR forms IN LOCKSTEP with their test pins (the message is diagnostic documentation — same resolvability problem — and no consumer outside the framework matches those fragments). **Deliberately untouched:** the queue-feature AD references in `queue-bullmq/*`/`state-machine/*`/`queue/*` (different AD namespace, defined in the persistent `2026-05-08-durable-state-machine-runtime` spec; the two `queue-bullmq/` sites are in-scope files but their AD-3 codes are not F6's) and the F6 plan/spec documents' own AD definitions (they are the definition site). |
| A19 | `file/resume.ts:92` | Delete the dead `import { join } from "node:path"` (unused after the resume-proof extraction); update the INV-1 header to state the shell imports no node built-ins. |
| A20 | `file/freshness-index.ts:28` | Drop the unused `isBoundaryId` from the `layout.js` import (only the guard form `isBoundaryIdString` is used). |
| A21 | `file/checkpointer.ts:328,:536` | Extract the duplicated setMeta/load clock-read + non-representable-timestamp rejection block into one private `readClock(operation, runId): Result<number, FrameworkError>` factory-closure helper; both methods become a one-line guard. Every message byte-identical (operation literal drives the prefix). |

### Deferred (7) — the tracked deepening cluster

| # | Site | Reason (evidence-based) |
|---|------|-------------------------|
| A11 | `file/journal.ts:322` | Journal append decision-core extraction (`planAppend` pure core). Structural interface change (new module + pure test surface); tracked deferral (round-10 A12, round-11 A15), scheduled for the dedicated `file/` deepening round. No current wrongness: FR-002/FR-004/FR-009 are enforced and pinned through the real-fs suites (incl. 3-process). |
| A12 | `file/freshness-index.ts:310` | FR-032 decision-core extraction (`freshness-codec.ts` pure split). Same class as A11; tracked (round-7 D2, round-10 A11, round-11 A16). The sibling checkpointer split executed 2026-08-14 is the template for that round. |
| A13 | `checkpoint/checkpointer.ts:211` | Single-owner truthful-branding `checkpoint-write-failed` policy. Requires a NEW lower module (the port layer cannot import `file/`); copies verified field-for-field identical at HEAD and pinned per backend; tracked since round-7 D1. |
| A14 | `file/event-record.ts:706` | Losslessness walker consolidation (`assertLosslessEvent` vs `materializeCanonicalOutput`). Cross-surface, behavior-sensitive (toJSON gate semantics divergence needs a design decision); deferred twice (round-8, round-10 A13). No current disagreement — shared constants + cross-checking hostile corpora hold. |
| A15 | `state-machine/replay.ts:40` | Branding `RecordedEvent` so `foldStep` is a total two-case function. Public kernel-type redesign (ADR-worthy, touches `state-machine/types.ts` + runner); parked since round-9/10 A14; the current structural-narrowing behavior is documented and pinned (round-11 A3/A4 pins); no in-scope raw-event consumer is affected. |
| A17 | `checkpoint/composite-node-key.ts:85` | Relocate `isNonNegativeSafeInteger` to the `types/` layer. Pure behavior-identical move, but it is the tracked "right-home for shared invariants" residue of the round-11 unification; staged with the deepening cluster so the `file/` → `checkpoint/` import edge is severed together with the decision-core extractions (A11/A12), not piecemeal. |
| A18 | `file/options.ts:15` | Unify the two `{now?}` factory-options parsers. Round-10 A16 judged this a design call (strictness level choice); today the verdicts agree on all inputs and the split is documented + pinned. |

### Dismissed (1)

| # | Site | Reason |
|---|------|--------|
| A4 | `__tests__/redis-checkpointer.test.ts:16` | The file legitimately hosts the Redis-gated `RedisCheckpointer` suite (its primary subject — the name is accurate); the in-memory suite's presence there is a discoverability nit the reviewer rated 2/10. Renaming or splitting the file would churn a correctly-named file for no correctness or structural gain. |

## Support paths (not in reviewed scope — registered in the remediation start input)

- `CONTEXT.md` (A16a)
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` (A1 regression pin)
- `.claude/plans/2026-08-17-pr-remediation-round-12.md` (this plan)

## Validation commands

```bash
cd packages/framework
bun run typecheck          # both tsconfigs (SC-004)
bun test                   # full suite (SC-005), incl. new pins: queue error listener, freshness ride-through/class pins, 3-process convergence, readClock message parity
bun src/scripts/check-imports.ts   # SC-006 boundary gate
```

Host package test run at the end (`cd packages/host && bun test`) as in prior rounds; workspace `0 fail` expected.
