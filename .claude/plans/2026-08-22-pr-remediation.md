# PR Remediation Plan — 2026-08-22

## Authority and exact scope

- Branch: `feat/f6-file-durable-runtime`
- Review HEAD: `4fd88ea19b6f241adb2c4ba60ff41d612477abac`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T194112Z-01a02afd`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T194112Z-01a02afd/result.json`
- Result digest: `c924fa19e7f4f4c8c635ab8faee249044a44ef46663b2b2dcc60beaaead6505a`
- Frozen review scope: exactly the 442 paths in the immutable canonical `result.json.scope` array; that array is the literal path authority and no path outside it is reviewed scope.
- Planned support path outside frozen scope: `packages/host/src/__tests__/supervisor/lifecycle/grace-window-purge.test.ts`, required to migrate its trusted registry seed through the new `Result` constructor. Every other production/regression path below is a member of `result.json.scope`.

## Surviving critical findings — mandatory

### `code-reviewer-1` — hydration bypasses active-team uniqueness

**Finding:** Redis hydration accepts multiple active tenant IDs claiming the same team, then commits them to the security-critical team-routing registry in scan order.

**Fix:** make the pure registry seed constructor return `Result<TenantRegistry, HostError>` and reject registry-wide duplicate active-team ownership with `config-invalid` before exposing a snapshot. Keep duplicate-ID last-writer semantics and allow a deregistered former owner plus one active owner. Make Redis hydration commit only the parsed successful registry. Add example and fast-check regressions for conflict rejection, order independence, and non-conflicting lifecycle states.

### `pr-test-analyzer-1` — approval authorization lacks a negative side-effect pin

**Finding:** `POST /runs/:runId/approve` has no cross-team test proving denial happens before `recordDecision`.

**Fix:** add a handler-level regression using the persisted immutable `RunRecord.ownerTeam`, submit as another team, assert `403`, and assert `recordDecision` was never called.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — hard delete restores mutable registry state.** The claim is reproduced: the outer record is frozen but its raw `Map` retains mutation methods. Route removal through a pure registry transition that rebuilds the same runtime-read-only facade; strengthen the hard-delete regression to prove mutation methods are absent.
2. **`code-reviewer-3` — diagnostic failure can prevent total fail-closed behavior.** The claim is sound and local. Make Redis exception rendering total, diagnostics and degraded hooks non-throwing, and latch the degraded state before diagnostics. Apply the same helper to every thrown Redis path in the adapter so the documented never-throw contract is uniform; add hostile-error/throwing-diagnostic coverage.
3. **`type-design-analyzer-2` — review prompt widens to `string`.** The framework node model already owns `NonEmptyString`, but the generic callback surface is persistence-compatible `string`. Parse that callback value at the host boundary, reject blanks before notification, and expose only `NonEmptyString` on `ReviewNotification`; typecheck both packages.
4. **`comment-analyzer-1` — spawn-port fallibility overstatement.** Narrow the module comment to distinguish Result-returning spawn/signal operations from the best-effort boolean liveness probe.
5. **`comment-analyzer-2` — Bun adapter I/O conversion overstatement.** Clarify that spawn/signal failures become `HostError`, while `isAlive` intentionally classifies signal-0 failures as liveness.
6. **`comment-analyzer-3` — ms→Date site count drift.** Remove the stale numeric count and describe all consumers without an exhaustive count.
7. **`comment-analyzer-4` — AuditAction overstates emission coverage.** State precisely that the union prevents typoed action values; handler tests and wiring prove operation coverage.
8. **`code-simplifier-1` — duplicated outgoing-degree state.** Remove `outdeg`; derive degree from the existing `outTargets` adjacency map.
9. **`code-simplifier-2` — duplicated direct-wakeup policy.** Extract one named private helper for the intentional durable-acceptance/reconciliation policy while retaining call-site fields and messages. This preserves the refutation panel's acceptance semantics rather than changing them.

### Deferred

1. **`code-reviewer-4` — lease loss cannot fence non-cooperative external effects.** The concern is real, but ADR-0060 deliberately combines cooperative cancellation at capability boundaries with hard fencing on every durable transition. Fencing arbitrary external systems requires idempotency/fencing-token contracts across each side-effect capability and cannot be completed safely as a local queue edit. Defer to a dedicated cross-capability architecture/security design.
2. **`type-design-analyzer-1` — timestamp chronology is not represented in the type.** Finite parsing is enforced, but relational chronology spans two fields and wall-clock advancement. A complete fix requires a validated run-record constructor plus monotonic update transition across both adapters, not a local brand tweak. Defer to a focused HITL record-model deepening rather than install a partial validator.
3. **`type-design-analyzer-3` — `setStatus` admits arbitrary lifecycle targets.** The service currently owns legal orchestration and persistence fencing, but the port shape does not encode commands. A complete remedy is an interface redesign into transition-specific operations/commands with adapter parity and migration of all fakes. Defer to a dedicated RunStorePort deepening; do not add a partial runtime switch that leaves illegal calls representable.

### Dismissed

1. **`silent-failure-hunter-2` — preserve a TokenProvider throw cause.** Dismissed because this is a credential-bearing seam and the provider exception may contain a bearer token or grant secret. Existing tests explicitly require provider failures to be secret-free, and the generic contract error is intentional NFR-010 redaction. Reflecting `safeErrorMessage` would preserve an untrusted cause, not a credential-safe one.
2. **`code-simplifier-3` — table-drive boundary-import fixture tests.** Dismissed because explicit named tests provide better failure locality for architecture rules, while the proposed helper only reduces test setup lines and adds indirection without changing production complexity or coverage.

## Refuted critical audit — retain, never fix

### `silent-failure-hunter-1`

**Claim:** HITL enqueue failures are acknowledged as success, so runs or decisions are never delivered.

**Panel evidence:**

- **Reproduction lens upheld the immediate behavior:** `startRun` and `recordDecision` return success after a direct enqueue error.
- **Intent lens refuted criticality:** durable acceptance, not immediate queue delivery, is the service contract; reconciliation retries eligible durable records on lifecycle ticks and restart.
- **Security lens refuted criticality:** run/decision state is stored before enqueue, and `host.ts` starts and periodically invokes reconciliation, so the operation is delayed rather than silently lost.

No compensation, rollback, or false enqueue-failure response will be introduced. The accepted simplification only names this existing policy once.

## Planned files

- `.claude/plans/2026-08-22-pr-remediation.md`
- `packages/host/src/supervisor/registry/tenant-registry.ts`
- `packages/host/src/supervisor/registry/redis-registry-adapter.ts`
- `packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts`
- `packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/grace-window-purge.test.ts`
- `packages/host/src/__tests__/handlers/hitl-http.test.ts`
- `packages/host/src/hitl/types.ts`
- `packages/host/src/hitl/human-review-hook.ts`
- `packages/host/src/hitl/__tests__/human-review-hook.test.ts`
- `packages/host/src/hitl/adapters/__tests__/webhook-notifier.test.ts`
- `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/supervisor/lifecycle/spawn-port.ts`
- `packages/host/src/supervisor/lifecycle/bun-spawn-adapter.ts`
- `packages/framework/src/types/clock.ts`
- `packages/host/src/supervisor/audit/audit-port.ts`
- `packages/framework/src/cli/lint-checks.ts`

## Validation

1. Focused baseline/regressions:
   ```bash
   bun test packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts packages/host/src/__tests__/supervisor/registry/redis-registry-adapter.test.ts packages/host/src/__tests__/supervisor/lifecycle/grace-window-purge.test.ts packages/host/src/__tests__/handlers/hitl-http.test.ts packages/host/src/hitl/__tests__/human-review-hook.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/framework/src/__tests__/executor.test.ts packages/framework/src/__tests__/hitl-suspend-resume.test.ts
   ```
2. Package typechecks: `bun run --filter @fuguejs/framework typecheck` and `bun run --filter @fuguejs/host typecheck`
3. Full workspace typecheck: `bun run typecheck`
4. Full workspace tests: `bun run test`
5. Documentation links: `bun run check:docs`
