# PR Remediation — 2026-08-23 (round 34)

## Review authority

- Branch: `feat/f6-file-durable-runtime`
- Reviewed HEAD: `397d23b12310b67b47b68d31fd86ca5cf970b367`
- Merge base with `origin/main`: `6c316cb53a9b7dfd88f2908b26108979eddbb04a`
- Review run: `.claude/reviews/review-and-fix-runs/2026-08-23T080936Z-01a02daa-standalone-review`
- Canonical result: `.claude/reviews/review-and-fix-runs/2026-08-23T080936Z-01a02daa-standalone-review/result.json`
- Exact frozen scope: the 453 paths enumerated by `result.json.scope`.
- Planned support paths outside the frozen review scope: none. This plan path is itself in the frozen scope.

## Surviving critical findings — mandatory

### `code-reviewer-1` — root-span telemetry can replace the DAG outcome

**Evidence:** `startRunSpan` invokes `fwTracer().startActiveSpan` and the initial `rootSpan.addEvent` without containment. `closeRootSpan` likewise performs outcome serialization and span mutation without best-effort guards. The reproduction, intent, and security panel lenses all upheld that tracer/span faults can suppress DAG execution or replace its authoritative result.

**Fix:**

1. Make root-span opening fall back to untraced execution when tracing fails before callback invocation, while retaining and returning the callback promise when tracing throws after invocation so the DAG executes exactly once.
2. Make the initial root-span event best-effort and independently contain each close operation, including serialization, status/event mutation, and `end`, so one secondary failure cannot prevent later cleanup attempts.
3. Add hostile tracer/span regressions proving setup, event, status, serialization, and end failures cannot prevent execution or replace completed/failed DAG outcomes.

### `code-reviewer-2` — node-span setup failure suppresses node execution

**Evidence:** `withTracedNodeSpan` guards operations inside the span callback but directly returns `fwTracer().startActiveSpan`. A setup throw before callback invocation therefore runs the node zero times. All three panel lenses upheld the execution and availability failure.

**Fix:** capture the callback promise before returning it, contain `startActiveSpan`, and fall back to the same untraced node-execution path only when no callback was invoked. Preserve the idempotency-key fail-closed gate before tracing and preserve modeled node-crash conversion.

### `pr-test-analyzer-1` — node-span setup fallback lacks a regression

**Evidence:** existing tests cover hostile span methods after callback entry, not `startActiveSpan` throwing before entry. All three panel lenses upheld the gap.

**Fix:** add a focused behavioral regression in `node-span-leak.test.ts` asserting a throwing tracer still executes the node exactly once and returns its modeled `Result` unchanged. Also pin the throw-after-callback case to prevent duplicate execution.

### `comment-analyzer-1` — realm JWT comments misstate jose temporal validation

**Evidence:** `jose.jwtVerify` enforces registered temporal claims including `exp`/`nbf` using the supplied `clockTolerance`, even without issuer/audience options. The adapter repeatedly calls the operation “signature-only” and says expiry is left solely to the pure validator. All three panel lenses upheld the mismatch.

**Fix:** correct the adapter comments and `@satisfies` language to state that issuer/audience policy and defensive claim re-parsing remain in `validateRealmJwtClaims`, while jose also performs its standard temporal validation with 60-second skew tolerance at signature verification time. Do not alter the established fail-closed runtime behavior.

## Advisory dispositions

### Accepted — `pr-test-analyzer-2`: handler-level HITL start failure mapping

The claim is sound, correctness-relevant, and practical within the frozen scope. The live branch already maps `startRun` errors via `httpStatusFor`, but no handler test pins that it returns the typed error response rather than `202` or synchronous execution. Add a HITL-DAG test whose service returns a representative `HostError`, asserting the mapped HTTP status/body, zero synchronous executor calls, and no queued success response.

## Refuted critical audit

None. `result.json.refuted_critical_findings` is empty; the panel upheld all four critical findings through reproduction, intent, and security.

## Validation

Targeted gates:

```bash
bun test packages/framework/src/__tests__/node-span-leak.test.ts \
  packages/framework/src/__tests__/run-telemetry-ordering.test.ts
bun test packages/host/src/__tests__/handlers/run-dag.test.ts
bun run check:docs
```

Package/full relevant gates:

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun run --cwd packages/framework test
bun run --cwd packages/host test
bun run typecheck
bun run test
bun run check:docs
```

After the implementation baseline is green, run the required `distill` apply-mode pass one move at a time; rerun covering tests after every accepted simplification. No interface-changing deepening is planned.
