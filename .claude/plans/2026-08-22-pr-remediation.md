# PR Remediation Plan — 2026-08-22

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T171900Z`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T171900Z/result.json`
- Frozen review scope: the exact 435-path `result.json.scope` array.
- Baseline: 182 targeted tests passed, 0 failed.
- Required support paths outside frozen scope: `packages/adapter-ms-graph/src/__tests__/ms-graph.test.ts`, `packages/host/src/hitl/adapters/bot/__tests__/connector.test.ts`, and `packages/host/src/hitl/adapters/bot/ports.ts`.

## Planned remediation scope

- `.claude/plans/2026-08-22-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `packages/adapter-ms-graph/src/index.ts`
- `packages/adapter-ms-graph/src/__tests__/ms-graph.test.ts`
- `packages/host/src/host.ts`
- `packages/host/src/main-supervisor.ts`
- `packages/host/src/http/handlers/run-dag.ts`
- `packages/host/src/http/handlers/runs.ts`
- `packages/host/src/__tests__/handlers/hitl-http.test.ts`
- `packages/host/src/hitl/types.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/human-review-hook.ts`
- `packages/host/src/hitl/__tests__/human-review-hook.test.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/decision-store.ts`
- `packages/host/src/hitl/adapters/bot/notifier.ts`
- `packages/host/src/hitl/adapters/bot/messages-handler.ts`
- `packages/host/src/hitl/adapters/bot/ports.ts`
- `packages/host/src/hitl/adapters/bot/connector.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/adapters/__tests__/webhook-notifier.test.ts`
- `packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts`
- `packages/host/src/hitl/adapters/bot/__tests__/connector.test.ts`

## Surviving critical findings — mandatory

### `code-reviewer-1` — resolved team must never fall back to the default channel

**Finding:** a resolved team's missing conversation reference falls back to the default channel, disclosing its prompt/output to another channel.

**Fix:** persist the immutable owning team on each run and carry it on `ReviewNotification`. The Bot notifier will route only to that team's stored conversation reference; a missing reference returns typed `notification-failed` and sends nothing. Remove the live-registry resolver and default fallback from run notification delivery. Add regressions proving no default send occurs.

### `code-reviewer-2` — historical run authorization must use immutable ownership

**Finding:** HTTP and Bot authorization derive ownership from the mutable live DAG registry, so DAG reassignment changes access to historical runs.

**Fix:** add branded `ownerTeam` to `RunRecord`, capture it from the authorized registered DAG at durable creation, parse it at the Redis boundary, and authorize HTTP/Bot access directly against the persisted resource attribute. Add reassignment/removal regressions proving the original owner retains access and a replacement owner gains none.

### `comment-analyzer-1` — active-count contract overstates pruning

**Finding:** the port comment says stale members never inflate the count even though failed pruning is counted conservatively.

**Fix:** state the exact invariant: successfully pruned missing/terminal members are excluded; unprunable members and other uncertain evidence are counted conservatively.

### `code-simplifier-1` — MS Graph catch rendering is non-total

**Finding:** the local `msg` helper can throw while handling a hostile thrown value.

**Fix:** delete the duplicate and reuse framework `safeErrorMessage` at every stock-adapter catch boundary. Add hostile null-prototype regressions for token acquisition, fetch/body handling, and health checks.

### `code-simplifier-2` — Bot connector catch rendering is non-total

**Finding:** Bot connector catch paths repeat `instanceof Error`/`String`, allowing hostile thrown values to escape the typed Result path.

**Fix:** use `safeErrorMessage` at token fetch, token JSON, and send catches. Add hostile thrown-value regressions for each path.

## Advisory dispositions

### Accepted

1. **`code-reviewer-3` — client-controlled audit actor.** Sound identity-integrity issue. Remove body-controlled `actor`; derive the actor from the authenticated `AuthIdentity` after authorization, and test that forged body values cannot enter the recorded `HumanAction`.
2. **`pr-test-analyzer-1` — throwing logger during run-store compensation.** Sound typed-boundary gap. Make run-store diagnostics total and add a compensation-path regression proving the original `HostError` remains authoritative.
3. **`pr-test-analyzer-2` — throwing logger during corrupt-decision reporting.** Sound typed-boundary gap. Make decision-store diagnostics total and add malformed/invalid-decision regressions proving no logger exception escapes.
4. **`type-design-analyzer-1` — unrestricted `RunStorePort.create`.** Sound and narrow. Introduce `QueuedRunRecord` with `status: { kind: "queued" }`; `create` accepts only this creation state, while `get` continues returning the full lifecycle union.
5. **`comment-analyzer-2` — transitional supervisor comment.** Replace `T8/later waves` with the durable platform-token-store invariant and current ownership rationale.

### Deferred

1. **`architecture-tech-lead-1` — serialized checkpoint strings.** Sound, but a truthful value object must coordinate seed serialization, Redis parsing, `RunExecutionRequest`, `RunStorePort`, and framework checkpoint codec semantics. The current Redis/job construction paths already parse the high-risk stored bytes. Defer to a dedicated checkpoint-codec deepening rather than adding a field-only brand that lies at the physical boundary.
2. **`architecture-tech-lead-2` — mutable `RunStoreJobLike.data`.** Sound contract drift, but fixing only this adapter would create a stronger snapshot promise than shared `JobLike` and the memory/BullMQ adapters expose. Defer to a coordinated JobLike immutable-snapshot contract with adapter-parity tests.

### Dismissed

1. **`type-design-analyzer-2` — raw lease owner token/exported issuer.** Dismiss: this module is not publicly exported, only the queue adapter and tests issue leases, and durable writes independently compare the unpredictable live Redis token atomically. Branding an internally generated UUID would not add runtime authority; the Redis fence is the authority.
2. **`code-simplifier-3` — worker lifecycle fixture factory.** Dismiss: test-only repetition does not affect correctness, and a broad fixture rewrite would add review churn unrelated to surviving or accepted remediation.
3. **`code-simplifier-4` — shared NodeContext test factory.** Dismiss: the existing shared context factories model DAG-machine context, not `NodeContext`; consolidating many unrelated framework suites is a broad test-architecture refactor with no correctness benefit in this remediation.

## Refuted critical audit — retain, never fix

### `silent-failure-hunter-1`

**Claim:** `startRun` hides a lost initial wakeup after durable creation.

**Panel evidence:**

- Intent: durable creation is the acceptance boundary; the active index survives and immediate/periodic lifecycle reconciliation retries wakeups, with restart coverage.
- Security: the wakeup is delayed, not lost; reconciliation enumerates every non-terminal active record and retries enqueue.

No compensation/deletion behavior will be introduced.

### `silent-failure-hunter-2`

**Claim:** `recordDecision` reports success when direct resume enqueue fails.

**Panel evidence:**

- Intent: the accepted decision remains durable and reconciliation specifically re-enqueues suspended runs with stored decisions.
- Security: direct enqueue failure delays rather than loses resume; durable decision state is the authority.

No rollback or false failure response will be introduced.

## Validation

1. Targeted regressions:
   ```bash
   bun test packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/__tests__/human-review-hook.test.ts packages/host/src/hitl/__tests__/run-store-job.test.ts packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/hitl/adapters/bot/__tests__/bot.test.ts packages/host/src/hitl/adapters/bot/__tests__/connector.test.ts packages/host/src/__tests__/handlers/hitl-http.test.ts packages/adapter-ms-graph/src/__tests__/ms-graph.test.ts
   ```
2. Host typecheck: `bun run --filter @fuguejs/host typecheck`
3. MS Graph typecheck/build: `bun run --filter @fuguejs/ms-graph typecheck && bun run --filter @fuguejs/ms-graph build`
4. Full workspace typecheck: `bun run typecheck`
5. Full workspace tests: `bun run test`
6. Documentation links: `bun run check:docs`
