# PR #41 remediation — review-and-fix round 6

Date: 2026-08-30

Branch: `feat/f3-budget-capability-surface`

Reviewed revision: `837197a12ab20fab3903b0488e861d50458dc418`

Review run: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round6`

Authoritative result: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round6/result.json`

Frozen scope: the 84 paths listed in the authoritative result.

Registered support path outside that scope:

- `.claude/plans/2026-08-30-pr41-remediation-round6.md` — this disposition and validation record.

## Binding approach

Apply `rules/architecture.md`, `rules/typescript-patterns.md`, `code-implementer`, and `ts-test-engineer`: runtime values are parsed at the file boundary, expected failures return `Result`, and diagnostic context names the exact persisted artifact. Apply `deepen` only as advisory triage because the three architectural findings require coordinated seam migrations. Run `distill` in apply mode only after a green focused baseline and preserve public behavior.

## Surviving critical findings — all mandatory

1. **`code-reviewer-1` and `silent-failure-hunter-1` — `FileSpendStore.add` derives paths outside its `Result` fence.**
   - Move runtime `runId` parsing and digest/path derivation inside the guarded store boundary for both `read` and `add`.
   - Ensure malformed or hostile runtime IDs return typed `cache-error` values carrying the relevant spend-store operation rather than rejecting.
   - Add parity regressions proving malformed IDs use the `Result` channel for both operations.

2. **`comment-analyzer-1` — run-node cast comment names only the static capability proof.**
   - Correct the comment to name both valid proofs: run-start validation for static/base capabilities, and dispatch-time mint delivery plus reserved-key merge validation for broker-provided capabilities.
   - No runtime behavior changes; the existing checks remain authoritative.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-2` — file spend-codec errors omit the record path.**
   - Wrap codec failures with `fileOperationError("spendStore:read", recordPath, ...)` so operators receive the exact digest-addressed file.

2. **`pr-test-analyzer-1` — Redis `sMembers` failure is not pinned.**
   - Add focused adapter coverage proving a failed unpriced-model read returns `Err` and never hydrates priced spend.

3. **`comment-analyzer-2` — initial remediation plan describes obsolete transparent subtype preservation.**
   - Amend the historical plan note: direct metering exposes the narrow standard `LlmClient`; augmented APIs are adapter-authored through `composeRunClient`.

4. **`code-simplifier-1` — duplicate available-headroom clone branches.**
   - Keep the distinct `unpriced` branch and collapse all available units into one immutable clone path.

5. **`code-simplifier-2` — duplicated settlement record/release/persist calls.**
   - Derive recordable usage once, use one `recordReleasePersist` branch, and preserve existing error-log and reservation ordering.

6. **`code-simplifier-3` — repeated identical HTTP status mappings.**
   - Group equal-result `ts-pattern` arms while retaining exhaustive matching and exact status behavior.

7. **`code-simplifier-4` — tool-dispatch test duplicates `NodeContext`.**
   - Reuse `testNodeContext` with only the LLM seam overridden; preserve assertions.

### Deferred

1. **`architecture-tech-lead-1` — typed `createNodeContextForDag` setup seam.**
   - Sound but requires coordinated `HostError` additions and migration of HTTP, HITL, host wiring, and their integration/factory tests. A partial dual throw/Result seam would reduce locality rather than improve it.

2. **`architecture-tech-lead-2` — split the wide Redis port.**
   - Sound but requires a consumer-owned port migration across cache, checkpoint, HITL, token/index, lease, and spend adapters plus all fakes and composition wiring. It is not a local F3 correction.

3. **`architecture-tech-lead-3` — split capability graph rules from lifecycle I/O.**
   - Sound but requires moving imports and tests across host boot, health, shutdown, and client extraction. Keep it for a dedicated module migration.

### Dismissed

None.

## Refuted critical audit

No critical finding was refuted. All three critical records survive; two are duplicate reports of the same file-store boundary defect, so implementation has two distinct correction tracks.

## Validation

Focused validation:

```bash
bun test \
  packages/framework/src/__tests__/file-spend-store.test.ts \
  packages/framework/src/__tests__/file-boundary-error.test.ts \
  packages/framework/src/__tests__/tool-dispatch.test.ts \
  packages/framework/src/__tests__/per-node-minting.test.ts \
  packages/framework/src/__tests__/budget-capability.test.ts \
  packages/host/src/__tests__/spend-ledger.test.ts \
  packages/host/src/__tests__/run-spend-authority.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts
bun run typecheck
bun run check:docs
git diff --check
git diff --no-index --check /dev/null .claude/plans/2026-08-30-pr41-remediation-round6.md
```

Then run the full workspace suite:

```bash
bun run test
```

After a green baseline, run the mandatory `distill` apply pass one move at a time and rerun covering tests after each move. Start registered remediation only after all validation is green and register the support path above. Loom must install the exact verified index before commit and push.
