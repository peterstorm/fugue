# PR #45 Remediation — Round 2

**Branch:** `feat/f1-runtime-width-fanout`
**Review HEAD:** `12323eb`
**Review Run:** `.claude/reviews/review-and-fix-runs/standalone-review-20260906T160143Z-pr45-r2`
**Round 1:** `.claude/plans/2026-09-06-pr45-remediation.md` (5 critical / 0 refuted, all closed)

**Adjudication:** 1 critical found, **0 refuted**, 1 surviving. 5 advisory.
The Refutation Panel upheld the critical through all three lenses.

Round 1's three code defects are confirmed closed by four independent reviewers
(code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer),
each having re-run the suite. **No code defects this round** — every finding is
documentation drift or test duplication that round 1's own changes introduced.

**Support path** (outside the frozen scope): `.claude/plans/2026-09-06-pr45-remediation-round2.md`.
Everything else is in scope.

---

## Surviving critical — mandatory

### C1 — the F1 plan still says PR-A is unbuilt, in the PR that builds it
*(comment-analyzer-1, `docs/plans/2026-09-06-f1-runtime-width-fanout.md:4, 67, 151`)*

Three places state PR-A is pending:
- Status: *"Draft — design agreed, not yet implemented"*
- §2's backend table: Redis *"No — no `opts` parameter at all"*, citing
  `redis-checkpointer.ts:250` as `saveNode(runId, state)`
- D3: Redis *"gains the `opts?: SaveNodeOpts` parameter"*, future tense

All three are false at this HEAD: `redis-checkpointer.ts` declares
`saveNode(runId, state, opts?: SaveNodeOpts)` and encodes through
`encodeStoredNodeKey`. ADR-0085 is Accepted and its Related section routes
readers to *"§2, PR-A"* of this very plan — so the ADR recording the shipped
behavior points at text asserting the opposite.

The panel specifically tested and rejected the obvious defence, that §2 is a
frozen snapshot: only §2 carries the "Read on `3845ad9`" qualifier, not the
Status line or D3, and this repo's own convention is that plan Status is a
living field (`2026-08-27-f3-budget-capability.md:3` reads *"complete (PR-A/B/C/D
shipped)"*; `2026-08-26-f4-prompt-caching.md:4` reads *"Implemented"*).

**Impact.** PR-B is the next task, and its implementer reads this document.
Believing Redis composite addressing is unbuilt means re-doing PR-A.

**Fix.** Update Status to record PR-A as shipped and PR-B as what remains;
annotate §2's table rows and D3 as closed by ADR-0085, preserving the original
"as found" text — §2 is the evidence record of why PR-A existed, so it is
annotated, not rewritten.

---

## Advisory dispositions — all five accepted

| ID | Disposition | Reason |
|----|-------------|--------|
| pr-test-analyzer-1 + code-simplifier-3 (same sentence) — ADR-0075:49's trailing clause still claims in-memory composite/malformed saves "remain keyed by bare `nodeId` without logger output" | **accepted** | Round 1 annotated the first half of this sentence and missed the second, so the ADR now supersedes a claim and then restates it. Verified false: `composite-node-key.test.ts` asserts a full-opts save lands on the composite key and a malformed save writes nothing. Same class as round 1's C2/C3 — a false claim in an accepted ADR. |
| comment-analyzer-2 — `docs/adr/README.md:95` says ADR-0075 is "amended 2026-08-14" | **accepted** | Verified incomplete: ADR-0075 carries an `Amendment (2026-08-14)` **and** an `Amendment (2026-08-20 — single node identity)`, plus round 1's 2026-09-06 supersession note. A partial amendment history in the index misleads anyone skimming it. |
| code-simplifier-1 — five tests in `composite-node-key.test.ts`'s in-memory composite block duplicate the shared suite | **accepted** | **Duplication round 1 created.** I rewrote that block to pin honor-behavior AND added the same scenarios to `_checkpointer-suite.ts`, which runs against `InMemoryCheckpointer` via `checkpointerSuite("InMemoryCheckpointer", …)` at `redis-checkpointer.test.ts:23`. Two hand-synced copies of one contract is exactly what ADR-0085 §3 moved these tests to prevent. Delete the five; keep the logger-silence test, which the suite does not cover. |
| code-simplifier-2 — the composite test in `boundary-imports.test.ts` duplicates the suite and is misplaced | **accepted** | Verified: `describe("SC-006 gate integrity pins")` otherwise holds the `__brand*Unchecked` gate test and the `@fuguejs/framework/file` barrel-resolution test. A checkpoint-addressing assertion is off-topic there, and the suite now pins the same scenario for the same backend. |

No advisory is deferred or dismissed this round.

---

## Validation

```
cd packages/framework && bunx tsc --noEmit && bun run test
for pkg in framework document-source xlsx adapter-fs adapter-ms-graph \
           adapter-pg adapter-oracle http-auth host; do
  (cd packages/$pkg && bunx tsc --noEmit && bun run test)
done
bun run check:docs && bun test scripts/
```

Baseline: framework 3550 pass / 0 fail. Deleting six duplicate tests should
leave **3544**, with no loss of covered behavior — each deleted case must have a
named counterpart in `_checkpointer-suite.ts`, verified before deletion.
