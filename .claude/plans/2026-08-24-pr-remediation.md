# PR Remediation Plan — Adjudicated Standalone Review (round 49)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `8d125a1a75991c6a69906f4da4fc9cc7857e40a1`

**Exact scope:** the complete canonical `result.json.scope` array (all 500 paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260824T161536Z-01a0348e-review`

**Canonical result:** `<review-run>/result.json` (digest `ab94571708b864426f9a337fb86e035f3122ddca443e54d12389bf918f9df2fe`, 42,970 bytes)

**Adjudication:** 7 reviewers → 6 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **6 surviving / 0 refuted**; 8 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — typed host timeout abort maps to HTTP 500**
   `packages/host/src/http/handlers/run-dag.ts:290`
   Classify a settled framework `aborted` result as the request-owned timeout when the host timeout sentinel fired, mark the circuit failure, and return the same typed HTTP 408 response as the thrown-abort path. Add a regression using the real `Result.err({ kind: "aborted" })` shape.

2. **`code-reviewer-2` — synchronous host timeout is cooperative-only**
   `packages/host/src/http/handlers/run-dag.ts:269`
   Race DAG execution against a hard settlement deadline in the HTTP imperative shell. On deadline, abort cooperatively, return 408, resolve the circuit permit, and release the concurrency token without awaiting an abort-insensitive execution promise. Add a never-settling executor regression proving bounded response and token release.

3. **`code-reviewer-3` — HITL execution slice can wedge its worker**
   `packages/host/src/hitl/adapters/run-executor.ts:157`
   Race the resumable kernel slice against its configured hard deadline, preserving cooperative abort while terminalizing a never-settling slice as a typed failed outcome. Fence the durable `JobLike` and post-checkpoint decision callback once the deadline expires so late kernel continuation cannot advance durable state or consume a decision. Add regressions for bounded settlement and late-write rejection.

4. **`code-reviewer-4` — kernel error conversion is partial over unknown throws**
   `packages/framework/src/dag-runtime/run-dag-stateful.ts:278`
   Replace direct `instanceof`, `cause`, `message`, and coercion operations with total probes plus `safeErrorMessage`. Preserve an attached failed `DagPhase` only when safely recoverable. Add throwing-`cause`, hostile coercion, and revoked-proxy regressions.

5. **`silent-failure-hunter-1` — LLM error classification can throw**
   `packages/framework/src/llm/llm-errors.ts:170`
   Make abort override invocation, abort detection, timeout-cause inspection, HTTP-status probing, message rendering, and stack extraction total over arbitrary provider-thrown values. Reuse the established safe-error helpers and add direct hostile getter/proxy/coercion regressions.

6. **`silent-failure-hunter-2` — duplicate evidence for partial kernel conversion**
   `packages/framework/src/dag-runtime/run-dag-stateful.ts:278`
   Covered by mandatory fix 4. Its dedicated regressions will prove that neither failed-state recovery nor fallback node-crash conversion can throw while handling the original failure.

## Advisory dispositions

### Accepted

- **`code-reviewer-5` — customer-summary timeout is cooperative-only.** Sound availability defect at the same request boundary and a complete in-scope fix is practical. Race `runDag` against the request deadline, abort cooperatively, and return 504 without awaiting an abort-insensitive source. Add a never-settling run regression.
- **`silent-failure-hunter-3` — tool-name validation diagnostics can throw.** Sound total-boundary issue with a local fix. Reuse `safeErrorMessage` and add a hostile thrown-value regression.
- **`pr-test-analyzer-1` — no setMeta-error/throwing-logger regression.** Production already uses `reportWithoutThrowing`; add the missing route regression proving a typed 503 survives logger failure.
- **`pr-test-analyzer-2` — persisted `humanReviewPrompts` blank-value coverage.** The parser already uses `parseNonEmptyString`; add direct empty and whitespace persisted-context cases so the boundary invariant cannot regress.
- **`type-design-analyzer-1` — write freshness extractors can be partially configured.** Sound illegal-state issue. Refine the `writes` side-effect variant into an ADT with either both extractors absent or both required, while retaining runtime validation for untyped/forged callers. Add compile-time rejection fixtures.
- **`type-design-analyzer-2` — freshness-violation resource identity is duplicated.** Sound illegal-state issue. Remove the independently writable `resource` field and derive the identity from `conditionedOnWitness.resource`; update event construction and observer fixtures so drift is unrepresentable.
- **`comment-analyzer-1` — historical “slow path” label contradicts O(1) behavior.** Rename the inline label to the actual `sinceMs` threshold branch.
- **`code-simplifier-1` — nullable node-directory branch needlessly nests the scan.** Return the empty collection early when no node directory exists, leaving the read/parse loop at one altitude.

### Deferred

None.

### Dismissed

None.

## Refuted critical findings audit

None. All six critical entries survived unanimously under reproduction, intent, and security. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0025-freshness-witness-contract.md`
- `docs/features.md`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `packages/framework/src/llm/tool-use-loop.ts`
- `packages/framework/src/__tests__/tool-use-loop.test.ts`
- `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts`
- `packages/framework/src/types/side-effects.ts`
- `packages/framework/src/__tests__/freshness-extraction-types.test.ts`
- `packages/framework/src/types/events.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/__tests__/freshness-file-dag-integration.test.ts`
- `packages/framework/src/__tests__/freshness-full-pipeline.test.ts`
- `packages/framework/src/__tests__/freshness-witness-conflict-detected.test.ts`
- `packages/framework/src/observer/foundry-event-mapping.test.ts`
- `packages/framework/src/__tests__/observer-property.test.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/file/checkpointer.ts`
- `packages/host/src/http/handlers/run-dag.ts`
- `packages/host/src/__tests__/handlers/run-dag.test.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/adapters/settle-before-deadline.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`
- `packages/framework/src/llm/llm-errors.ts`
- `packages/framework/src/__tests__/llm-errors.test.ts`

Three remediation-owned paths are outside the frozen review scope and must be registered as support paths:

- `docs/features.md`
- `packages/framework/src/__tests__/llm-errors.test.ts`
- `packages/host/src/adapters/settle-before-deadline.ts`

Every other planned path, including the plan, is inside the frozen review scope.

## Baseline evidence

Before production edits, the focused 12-file gate passed **375 tests / 0 failures**. After implementation and the distill pass, the expanded 15-file gate passed **397 tests / 0 failures**. Final workspace validation passed **6,171 tests / 0 failures**, all package typechecks, shipped-document link checks, and `git diff --check`.

## Validation

Baseline and focused regression gate:

```bash
bun test \
  apps/customer-summary/src/__tests__/server.test.ts \
  packages/framework/src/__tests__/tool-use-loop.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts \
  packages/framework/src/__tests__/freshness-extraction-types.test.ts \
  packages/framework/src/__tests__/freshness-emission.test.ts \
  packages/framework/src/__tests__/observer-property.test.ts \
  packages/framework/src/observer/foundry-event-mapping.test.ts \
  packages/framework/src/__tests__/freshness-file-dag-integration.test.ts \
  packages/framework/src/__tests__/freshness-full-pipeline.test.ts \
  packages/framework/src/__tests__/freshness-witness-conflict-detected.test.ts \
  packages/framework/src/__tests__/file-checkpointer.test.ts \
  packages/framework/src/__tests__/dag-runtime-stateful.test.ts \
  packages/framework/src/__tests__/llm-errors.test.ts \
  packages/host/src/__tests__/handlers/run-dag.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-executor.test.ts
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
