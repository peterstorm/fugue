# F3 Budget Capability Surface — Adjudicated Review Remediation

## Authority and branch

- **Branch:** `feat/f3-budget-capability-surface`
- **Authoritative run:** `.claude/reviews/review-and-fix-runs/2026-08-30-f3-budget-capability-surface-review/result.json`
- **Run ID:** `2026-08-30-f3-budget-capability-surface-review`
- **Review subject:** `standalone-review`
- **Refuted criticals:** **zero** (`refuted_critical_findings: []`)
- The review run directory is immutable evidence and will not be modified.
- No commit, stage, push, or `.claude/worktrees/` change is permitted.

## Exact frozen review scope

The remediation is grounded in the following exact frozen scope declared by the authoritative run (remediation tests/docs may update paths within this surface as required):

```text
.claude/plans/2026-08-30-f3-budget-capability-surface.md
CONTEXT.md
docs/adr/0083-spend-durability-lives-in-a-ledger-port.md
docs/features.md
docs/plans/2026-08-27-f3-budget-capability.md
docs/spikes/2026-08-02-graph-engineering-findings.md
packages/framework/CHANGELOG.md
packages/framework/docs/adapter-authoring.md
packages/framework/src/__tests__/_context-factories.ts
packages/framework/src/__tests__/budget-capability.test.ts
packages/framework/src/__tests__/capability-validation.test.ts
packages/framework/src/__tests__/cli/cli.test.ts
packages/framework/src/__tests__/conditional-edges-routing.test.ts
packages/framework/src/__tests__/dag-fingerprint-resume.test.ts
packages/framework/src/__tests__/dag-retry-trace-outcome.test.ts
packages/framework/src/__tests__/executor.test.ts
packages/framework/src/__tests__/extensible-capabilities.test.ts
packages/framework/src/__tests__/file-boundary-error.test.ts
packages/framework/src/__tests__/file-spend-store.test.ts
packages/framework/src/__tests__/freshness-witness-conflict-detected.test.ts
packages/framework/src/__tests__/freshness-witness-no-conflict.test.ts
packages/framework/src/__tests__/guardrail.test.ts
packages/framework/src/__tests__/hitl-suspend-resume.test.ts
packages/framework/src/__tests__/llm-fake-client.test.ts
packages/framework/src/__tests__/llm-retry.test.ts
packages/framework/src/__tests__/llm-with-tools-factory.test.ts
packages/framework/src/__tests__/make-node-context-merge.test.ts
packages/framework/src/__tests__/node-side-effects-propagation.test.ts
packages/framework/src/__tests__/observer-crash-isolation.test.ts
packages/framework/src/__tests__/ontrace-run-end-ordering.test.ts
packages/framework/src/__tests__/pass-2-remediation.test.ts
packages/framework/src/__tests__/pass-3-remediation.test.ts
packages/framework/src/__tests__/predicate-malformed-event-sequence.test.ts
packages/framework/src/__tests__/route-decided-evidence.test.ts
packages/framework/src/__tests__/route-emission.test.ts
packages/framework/src/__tests__/run-dag-as-worker-job.test.ts
packages/framework/src/__tests__/run-telemetry-ordering.test.ts
packages/framework/src/__tests__/second-dag.test.ts
packages/framework/src/__tests__/tool-dispatch.test.ts
packages/framework/src/file.ts
packages/framework/src/file/boundary-error.ts
packages/framework/src/file/spend-store-codec.ts
packages/framework/src/file/spend-store.ts
packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts
packages/framework/src/shared/make-node-context.ts
packages/framework/src/testing.ts
packages/framework/src/types/budget-capability.ts
packages/framework/src/types/capability-handle.ts
packages/framework/src/types/index.ts
packages/framework/src/types/node.ts
packages/host/README.md
packages/host/docs/deployment.md
packages/host/src/__tests__/capability-manager.test.ts
packages/host/src/__tests__/llm-meter.test.ts
packages/host/src/__tests__/metered-llm.test.ts
packages/host/src/__tests__/node-context-factory.test.ts
packages/host/src/__tests__/run-spend-authority.test.ts
packages/host/src/__tests__/spend-ledger-file.test.ts
packages/host/src/__tests__/spend-ledger.test.ts
packages/host/src/adapters/metered-llm.ts
packages/host/src/adapters/node-context-factory.ts
packages/host/src/adapters/run-spend-authority.ts
packages/host/src/adapters/spend-ledger-file.ts
packages/host/src/domain/capability-manager.ts
packages/host/src/domain/host-error.ts
packages/host/src/domain/llm-meter.ts
packages/host/src/hitl/__tests__/service.test.ts
packages/host/src/http/middleware/error-handler.ts
packages/host/src/index.ts
packages/host/src/ports.ts
```

## Surviving criticals — all accepted

The eight surviving finding IDs map to seven remediation moves. `code-reviewer-1` and `type-design-analyzer-1` are deliberately deduplicated into one subtype-preserving decorator fix while retaining both IDs.

1. **`code-reviewer-1` + `type-design-analyzer-1` — one fix:** Preserve the complete runtime API of custom `T extends LlmClient` when metering. Intercept only `sendStructured` and `sendWithTools`; delegate all other properties/methods to the original custom client with correct receiver behavior. Ensure both the direct decorator and shared-capability installation retain the augmented subtype. Add a custom-client regression that invokes subtype-only stateful methods.

   **Round-6 historical correction:** this proposed transparent subtype-preservation
   shape was superseded. Direct metering intentionally exposes the narrow standard
   `LlmClient`; augmented APIs are adapter-authored through `composeRunClient`, whose
   aliases delegate through the supplied metered standard surface.
2. **`silent-failure-hunter-1`:** Replace the permissive `{ kind: string }` HostError check with exact discriminant-and-payload recognition for every `HostError` member, so hostile objects cannot reach exhaustive matchers. Add hostile-shape and valid-shape tests.
3. **`silent-failure-hunter-2`:** Guard every error-handler logging attempt. Logger failure must never replace the intended mapped or generic HTTP response. Add regressions for HostError and unknown-error paths with throwing loggers.
4. **`silent-failure-hunter-3`:** Make `mergeScopedCapabilities` fail closed when a broker returns a non-null reserved/built-in capability. Preserve the documented contract that built-ins remain statically authoritative; malformed broker output becomes a typed merge failure rather than a warning-and-continue path. Update merge/context tests.
5. **`silent-failure-hunter-4`:** Make reservation underflow a typed `Result` invariant failure with meter state unchanged. `RunSpendAuthority` must handle and log that failure without granting headroom. Add pure meter tests and shell authority tests.
6. **`comment-analyzer-1`:** Correct the `agentClientMap`/`mintingActive` comment: an empty map fails closed only while minting is active; with minting disabled, unmapped DAGs proceed.
7. **`comment-analyzer-2`:** Correct the HostError no-throw comment to acknowledge that smart-constructor invariants such as `retryAfterSeconds` reject invalid values by throwing.

## Advisory dispositions

### Accepted

| ID | Disposition and reason |
|---|---|
| `code-reviewer-2` | **Accept.** Explicit dependency injection is an authority decision: an explicitly injected file `SpendLedger` must be selectable/authoritative instead of being silently displaced by Redis capability detection. |
| `code-reviewer-3` | **Accept with `code-reviewer-2`.** Carry selected-ledger backend/durability metadata so only the actual in-memory fallback emits “NOT durable.” Preserve stock Redis-first behavior explicitly in stock wiring rather than implicitly overriding injected ledgers. |
| `silent-failure-hunter-5` | **Accept.** `reportWithoutThrowing` remains no-throw but gains a separately guarded stderr fallback so a broken configured logger does not erase degradation evidence. |
| `pr-test-analyzer-1` | **Accept.** Add a file spend-store regression replacing the verified root directory after construction and prove read/add identity rechecks fail closed. |
| `pr-test-analyzer-2` | **Accept.** Prove `remaining()` returns fresh, deeply frozen snapshots and that mutation attempts cannot affect later reads. |
| `type-design-analyzer-2` | **Accept.** Deep-freeze/snapshot nested `Spend` values at the `LlmMeter` owning seam; add a nested `usd`/model mutation regression. |
| `type-design-analyzer-3` | **Accept.** Refine `CeilingHeadroom` into an exhaustive union where USD `amount` is `MicroUsd`, while token/call amounts remain `number`; update all exhaustive consumers, tests, and documentation. |
| `comment-analyzer-3` | **Accept.** Correct `ResolvedTtl` documentation to state that it resolves per-DAG config, not nonexistent host defaults. |
| `code-simplifier-1` | **Accept.** Reuse the standard `testNodeContext` fixture in capability validation tests. |
| `code-simplifier-2` | **Accept.** Share the repeated no-usage failing `LlmClient` fixture in metered-LLM tests. |
| `code-simplifier-3` | **Accept.** Derive `recordPath` from the already-computed `fileName`. |

### Deferred

| ID | Disposition and reason |
|---|---|
| `architecture-tech-lead-1` | **Defer as a dedicated error-boundary deepening.** Typed `HostError` hydration must be carried end-to-end. `createNodeContextForDag` is currently a throwing `Promise<NodeContext>` seam, and a complete correction changes HTTP and HITL callers. Do not fake preservation with a cast and do not introduce a partially typed throw. |

No other advisory is deferred, and no critical is refuted.

## Implementation order and invariants

1. Establish focused green baselines for framework and host files in scope.
2. Apply test-fixture/path comment simplifications that do not alter interfaces; run focused tests after each move.
3. Refine `CeilingHeadroom` unit types and deep snapshot ownership; update exhaustive consumers/docs and run budget/meter tests.
4. Change reservation release to a typed, state-preserving invariant result; adapt the authority shell and run pure + shell tests.
5. Make HostError recognition exact and error logging non-disruptive; run middleware tests.
6. Make reserved broker output fail closed while retaining static built-in authority; run merge/context tests.
7. Deepen the metered-client decorator so its interface preserves `T` and only the two LLM call methods are intercepted; run augmented-client tests.
8. Make ledger choice explicit with backend/durability metadata; preserve Redis-first stock composition and run ledger/context tests.
9. Add file-root identity and snapshot immutability regressions.
10. Run root typecheck, full tests, docs checks, and diff/status checks.
11. Only on a fully green tree, apply the final `distill` pass one move at a time and rerun covering tests after every move; then rerun final validation.

Core invariants:

- Broker output can never replace or ambiguously coexist with statically authoritative built-ins.
- Meter snapshots are immutable values; failed reservation release cannot mutate accounting state or create headroom.
- Expected domain failures use discriminated `Result` values; shell code logs/handles them without failing open.
- Runtime decoration preserves the original subtype API and receiver semantics.
- Error reporting is best-effort and cannot change response semantics.
- The injected ledger selection and durability claim describe the same backend.

## Validation commands

### Focused baselines and per-move tests

```bash
bun test packages/framework/src/__tests__/capability-validation.test.ts packages/framework/src/__tests__/make-node-context-merge.test.ts packages/framework/src/__tests__/budget-capability.test.ts packages/framework/src/__tests__/file-spend-store.test.ts
bun test packages/host/src/__tests__/llm-meter.test.ts packages/host/src/__tests__/run-spend-authority.test.ts packages/host/src/__tests__/metered-llm.test.ts packages/host/src/__tests__/node-context-factory.test.ts
bun test packages/host/src/http/middleware/__tests__/error-handler.test.ts
```

If the middleware test resides under a different existing path, use the discovered authoritative test path while retaining the same focused target. After each individual move, rerun the smallest covering command above before proceeding.

### Root gates

```bash
bun run typecheck
bun test
bun run check:docs
git diff --check
git status --short
git diff --stat
git diff -- . ':(exclude).claude/reviews/review-and-fix-runs/2026-08-30-f3-budget-capability-surface-review/**' ':(exclude).claude/worktrees/**'
```

The final report must include fresh pass markers from the post-distill root test run and enumerate every artifact changed in this remediation generation.
