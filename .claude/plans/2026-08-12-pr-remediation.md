# PR Remediation — 2026-08-12 (standalone docs review)

- **Branch:** `main` (fugue)
- **Scope (frozen by review run):**
  - `docs/spikes/2026-08-02-graph-engineering-findings.md`
  - `docs/spikes/2026-08-12-fugue-loom-convergence-research.md`
  - `docs/spikes/2026-08-12-web-research-addendum.md`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-12-fugue-docs`
- **Authoritative result:** `result.json` (digest `671c1060f6293013370c6dab2617353ced18b609b17cc1683993a8ce4c9047b9`, tally-published)
- **Reviewers:** code-reviewer, comment-analyzer, architecture-tech-lead (3/3 transcripts captured)
- **Adjudication:** 3 critical → 3 surviving, 0 refuted; 11 advisories (4 are duplicates)

## Surviving critical findings (mandatory fixes)

### C1 — `comment-analyzer-1` — F4/F5 label collision (line 117 + throughout)

**Claim:** the 08-12 convergence doc uses F4/F5 for two different roadmap items each
(prompt-caching vs nested-subgraph; bounded-loop vs positioning), both senses
appearing in the single recommended order at line 117 and repeated in the addendum.

**Verified:** 08-02 spike froze F1–F5 with F4 = prompt caching, F5 = positioning.
The 08-12 doc renumbers F4 = nested subgraph (scorecard row 8, C3) and
F5 = bounded loop (row 3, C4) while Part 4/Part 5 keep the old senses; the addendum
repeats the collision (A5 vs A3/A7/A8; M5a undefined).

**Fix — freeze old numbering, renumber new items (append-only IDs):**
new items nested subgraph → **F8**, bounded loop → **F9**, path-dependent
capability scoping (addendum "M5a") → **F10**. Add a one-line numbering note in
Part 2 of the convergence doc. Exact edits:

- convergence doc line 45: `**F5 bounded loop**` → `**F9 bounded loop**`
- convergence doc line 50: `**F4 nested subgraph**` → `**F8 nested subgraph**`
- convergence doc line 70 (C3): `— **F4**` → `— **F8**`
- convergence doc line 73 (C4): `— **F5**` → `— **F9**`
- convergence doc line 112: `F4 subgraph, F5 bounded loop` → `F8 subgraph, F9 bounded loop`
- convergence doc line 117 (Recommended order): `F5 (bounded loop)` → `F9 (bounded loop)`,
  `F4-nested (subgraph)` → `F8 (nested subgraph)` (F4 prompt caching / F5-positioning stay)
- convergence doc line 119 (rationale): `F0/F5/F4-nested` → `F0/F9/F8`
- addendum line 36: `F4 nested subgraph` → `F8 nested subgraph`; `the F4 design` → `the F8 design`
- addendum line 89: `**M5a**` → `**F10**`
- addendum line 90: `for F4` → `for F8`
- **Panel evidence retained:** blast-radius lens refuted this finding's *consequence*
  ("every entry at line 117 is self-describing, so the ordering is executable as printed"),
  but reproduction + intent upheld it; threshold 2 → *survives*. The blast-radius
  reasoning is retained here and in `result.json.panel.outcomes[0]`; its narrower
  residue (cross-section label inconsistency) is exactly the fix above.

### C2 — `comment-analyzer-2` — unqualified "shipped" (line 27, also 10, 28, 143–144)

**Claim:** doc states Loom's refutation panel (L1) and findings identity are
"shipped"/"done" without branch qualification; every cited artifact exists only on
unmerged `feat/architecture-panel-mode-plan`; loom `main` still has regex-scraped
plain-string findings and no panel.

**Verified (2026-08-12):** loom `main` = `eda6423` (1.1.0); PR #17 OPEN, base `main`,
head `feat/architecture-panel-mode-plan`; `core/findings.ts` + `core/panel-kernel.ts`
exist only on the branch; `main:engine/src/types.ts:133` is still
`critical_findings?: string[]`.

**Fix — qualify every shipped/done/resolved claim:**
- line 10: "has already shipped most of its own side of the list" → add
  "(on its unmerged `feat/architecture-panel-mode-plan` branch — PR #17 open as of 2026-08-12 — not on loom `main`)"
- Part 1 table row (line 28): "Loom's refutation panel (**L1**) is shipped" →
  "**L1 built on `feat/architecture-panel-mode-plan` (PR #17, open — not on `main`)**";
  evidence gains branch paths (`README.md` Step 3.5 etc. are branch artifacts);
  implication gains "on the branch; loom `main` still regex-scrapes plain-string findings"
- Part 1 row "Findings identity exists": evidence gains "(branch)" markers;
  implication "**done**" → "**done on the branch**"
- Appendix rows (lines 143–144): "Findings identity shipped" / "Refutation panel (L1) shipped"
  gain branch qualifiers
- C3 (`comment-analyzer-7`, file-less duplicate of C2): resolved by the same edits; no separate action.

## Refuted critical findings (audit — never fixed)

None. `refuted_critical_findings` is empty; no critical reached a refutation
majority. Partial-refutation evidence for C1 (blast-radius) is retained above.

## Accepted advisories (all 11; 4 are duplicates of items above)

| Finding | Doc | Fix |
|---|---|---|
| `code-reviewer-1` (108 vs 107 agents) | 08-02 :28 | Use 107 (1+5+25+75+1) in both prose occurrences; add a note that the video says 108 but the graph's widths sum to 107 |
| `code-reviewer-2` | dup of C1 | — (fixed by renumbering) |
| `comment-analyzer-3` (L5 vs L3) | addendum :29 | Attribute quota-denominated ceiling to L3 budget (per 08-02 L5 revision); same fix at addendum :87 (`Loom L5's quota-denominated ceiling` → L3) |
| `comment-analyzer-4` (M5a undefined) | addendum :89 | Renumbered to F10 (part of C1 fix) |
| `comment-analyzer-5` / `-8` (dup) | convergence :106 | `wave-gate-operations.ts:1-6` → `:20-22` (verified: the "Roster-sized work stays a VALUE…" sentence is at 20–22) |
| `comment-analyzer-6` / `-9` (dup) | 08-02 :514-520 | Update branch anchors (verified on branch): `parseJudgeVerdict` 253–330 → 415–433, `parsePanelManifest` 173 → 301, `selectPanelLenses` 135 → 240; qualify "Findings are unidentified strings" row as true only against loom `main` (branch moved parsing into `core/review-output.ts` + `core/findings.ts`) |
| `architecture-tech-lead-1` | dup of C1 | — (fixed by renumbering) |
| `architecture-tech-lead-2` (checkpoint address space) | convergence Part 5 | Add a short "Open design gap" paragraph: composite key `(namespace, nodeId, index, attempt)`, backend-agnostic addressing with file adapter first, freshness-index semantics; sequence F6 as a backend, not the address-space decision |
| `architecture-tech-lead-3` (A1/A2 certification seam) | addendum A1/A2 | Add one paragraph: deny-by-default; tokens minted only from certified routing outcomes (validated branch data, not raw model output); one-shot spend = compare-and-spend port with atomic consumption; reuse F2/F3 machinery as the gate |

## Validation commands

- `git diff --check` (whitespace)
- Re-read each edited doc; `rg` sweep to prove no stray `F4 nested`/`F5 bounded`/`M5a`/`108 agents`/`L5 concluded`/`:1-6` remnants
- Docs-only change: no build/typecheck applies (no `*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}` in scope; rules/architecture.md globs do not bind markdown)

## Remediation run

- Fresh run: `.claude/reviews/review-and-fix-runs/remediation-2026-08-12-fugue-docs`
- Source run: `standalone-2026-08-12-fugue-docs`
- Support paths: none (all edits within reviewed scope)
- Then commit (message: `docs(spikes): remediate standalone review findings — F-label freeze, L1 branch qualifiers`) and push.
