# PR Remediation — 2026-08-23 (round 33)

## Review authority

- Branch: `feat/f6-file-durable-runtime`
- Reviewed HEAD: `0b55a06541dc9e1010d56459e6a5462e0aaf21c3`
- Merge base with `origin/main`: `6c316cb53a9b7dfd88f2908b26108979eddbb04a`
- Review run: `.claude/reviews/review-and-fix-runs/review-20260823T055808Z-ed64599a`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260823T055808Z-ed64599a/result.json`
- Frozen scope: the exact 448 paths in `result.json.scope`.
- Planned support path outside the frozen review scope:
  - `packages/host/src/adapters/oauth-token-body.ts`

## Surviving critical findings — mandatory

### `code-reviewer-1` — initial HITL checkpoint lacks a DAG fingerprint

**Evidence:** `seedCheckpoint` strips the compiled context but does not stamp `__dagFingerprint`; `verifyDagFingerprint` accepts absence as a fresh first write. All three refutation lenses upheld that a registry change before the first worker slice can combine seed-derived topology with the replacement live DAG.

**Fix:**

1. Add one framework-owned pure persistence projection that strips closure fields and stamps the fingerprint of the DAG which produced the context.
2. Reuse that projection both for initial HITL seed serialization and every `wrapDagJobLike.updateData` write so the two durable write paths cannot drift.
3. Add an executor regression that seeds under DAG v1, swaps to a topologically different v2 before the first slice, and proves fingerprint mismatch occurs before node execution.
4. Update persistence comments that currently describe an absent seed fingerprint as expected.

### `silent-failure-hunter-1` — node-output checkpoints use lossy `JSON.stringify`

**Evidence:** nested `undefined`, functions, symbols, Maps/Sets, custom `toJSON`, and non-finite numbers can be silently omitted or coerced without `JSON.stringify` throwing. All three panel lenses upheld the durability-integrity failure.

**Fix:**

1. Pre-scan node output with the framework's canonical losslessness validator and encode it with the framework lossless serializer rather than raw JSON.
2. Keep the imperative Redis shell thin and preserve the existing fail-closed throw contract and diagnostic isolation.
3. Extend checkpoint-writer tests with lossy nested values/non-finite values and a positive Map/Set/undefined round trip.

### `silent-failure-hunter-2` — telemetry faults can replace node outcomes

**Evidence:** input/output serialization, content filtering, `addEvent`, success-path `setStatus`/`setAttribute`, and `end` are outside best-effort guards. All three lenses upheld that tracing failures can prevent execution or replace a successful modeled Result.

**Fix:**

1. Concentrate all telemetry-only serialization/filter/span operations behind a no-throw best-effort helper.
2. Structure the callback so node execution happens once, its Result remains authoritative, and span end is attempted exactly once in a finalizer.
3. Preserve the fail-closed idempotency-key extractor because that is execution safety, not telemetry.
4. Add hostile-span, cyclic payload, throwing-filter, and successful-node regressions proving telemetry cannot replace the node Result.

### `comment-analyzer-1` — customer-summary claims durability without requiring the writer

**Evidence:** `/summarize` rejects a missing `Checkpointer` but still passes an absent `CheckpointWriter`; `run-node.ts` explicitly skips node-output writes when no writer is wired. All three lenses upheld the mismatch.

**Fix:** Require both the read/meta `Checkpointer` and node-output `CheckpointWriter` before accepting traffic, bind the proven writer locally, and add a 503 regression for either missing half. Keep the hard durability comment aligned with the enforced pair.

### `architecture-tech-lead-1` — clear failure can permit stale decision reuse

**Evidence:** decisions are addressed only by `(runId,nodeId)`, reads precede pending preparation, and `makeOnDecisionConsumed` currently swallows `clear` failure. A reroute can revisit the same gate before TTL and reuse the uncleared action. All three lenses upheld the path.

**Fix:**

1. Fail closed when post-commit decision clearing fails: log without throwing from diagnostics, then reject the committed callback so the executor terminalizes the run instead of continuing toward a re-entrant gate.
2. Preserve the read-after-checkpoint ordering which prevents lost approvals; do not clear before durability.
3. Pin hook and service regressions proving a clear failure cannot continue/re-gate and becomes a durable failed outcome.
4. Amend ADR-0060 to replace the obsolete “non-fatal TTL” residual with the fail-closed terminal behavior.

### `architecture-tech-lead-2` — ambiguous Redis create can execute after an error response

**Evidence:** metadata `SET NX` can commit and return `Err`; if compare-and-delete compensation also errors, visible metadata/checkpoint/index remain and reconciliation can execute the run after `startRun` reported failure. All three lenses upheld the publication ambiguity.

**Fix:**

1. Replace the shallow `create(): Result<void>` outcome with a typed creation outcome distinguishing confirmed creation from publication uncertainty.
2. Make compensation return evidence. Return the original error only when exact metadata removal/absence is proven; when publication cannot be disproved, return the accepted-but-uncertain outcome rather than telling the caller the run did not start.
3. Have the service treat both creation outcomes as accepted, log the uncertain case prominently, and issue the normal direct wakeup; any actually published record remains discoverable by reconciliation.
4. Add fault-injection coverage for write-then-error plus failed metadata compensation, proving no runnable record can coexist with an `Err` creation result.
5. Document the conservative acknowledgement rule in ADR-0060.

## Advisory dispositions

### Accepted — `silent-failure-hunter-3`: HumanAction serialization can throw or mutate edits

The claim is sound and shares the mandatory durability rule. Guard serialization, use the framework lossless codec, parse with `fromJson` plus the existing HumanAction schema, and return a typed invariant error for non-lossless actions. Add approve-with-edit regressions for hostile/lossless values.

### Accepted — `type-design-analyzer-1`: lifecycle resurrection is representable

The claim is sound: `setStatus` accepts `queued` and terminal-to-active requests while adapters remove terminal records from the active index and never re-add them. Introduce a non-queued `RunStatusUpdate` command type plus one pure transition parser used by both adapters; permit active progress and idempotent same-terminal settlement, reject terminal resurrection/cross-terminal rewrites, and test index stability.

### Accepted — `comment-analyzer-2`: ContextCache comment conflates cache and checkpointing

Rewrite it to name only NodeContext response caching.

### Accepted — `comment-analyzer-3`: bootstrap cache comment claims a nonexistent writer method

Rewrite it to state that cache `get`/`set` and `CheckpointWriter` are separate ports.

### Accepted — `code-simplifier-1`: duplicated bounded child-process lifecycle

The duplication is real and the current timeout semantics are already aligned. Extract one private bounded-process runner in `git-sync.ts`; retain operation-specific HostError mapping at the callers. Run existing git-sync timeout/stream-drain tests after the behavior-preserving move.

### Accepted — `code-simplifier-2`: duplicated OAuth token-body parser

The validation rule is byte-for-byte the same and is a pure boundary parser. Add `oauth-token-body.ts` as the single pure parser for non-empty `access_token` plus positive finite `expires_in`; reuse it from Keycloak and Entra mappers while preserving each hop's distinct error attribution/message. Cover the shared parser through both existing adapter suites.

## Refuted critical audit

### `pr-test-analyzer-1` — filesystem traversal tests allegedly absent

Refuted by the reproduction and security lenses. `packages/adapter-fs/src/__tests__/fs-adapter.test.ts` already tests `../etc/passwd`, `../../secret`, `/etc/passwd`, and nested traversal and routes them through `resolveWithinRoot`. No remediation will be applied.

## Validation

Targeted gates:

```bash
bun test packages/host/src/hitl/adapters/__tests__/run-executor.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/framework/src/__tests__/node-span-leak.test.ts \
  packages/host/src/hitl/__tests__/human-review-hook.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  apps/customer-summary/src/__tests__/server.test.ts
bun test packages/host/src/__tests__/git-sync.test.ts \
  packages/host/src/adapters/__tests__/entra-wif.test.ts \
  packages/host/src/adapters/__tests__/keycloak-token-endpoint-http.test.ts
bun test packages/framework/src/__tests__/dag-fingerprint-resume.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts
```

Package/full relevant gates:

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun run --cwd apps/customer-summary typecheck
bun run --cwd packages/framework test
bun run --cwd packages/host test
bun run --cwd apps/customer-summary test
bun run check:docs
```

After a green implementation baseline, run the required `distill` apply-mode pass one move at a time and rerun covering tests after every accepted simplification.
