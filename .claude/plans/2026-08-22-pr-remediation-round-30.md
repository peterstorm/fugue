# Adjudicated Review Remediation — Round 30

- **Branch:** `feat/f6-file-durable-runtime`
- **Source standalone review:** `.claude/reviews/review-and-fix-runs/review-20260822T063730Z-22011763`
- **Canonical result:** `result.json`, SHA-256 `6e3b1c5a7c80f2b3d58e005ca1a69b87bde0521e2d6d88f68820f10bb7d79323`
- **Exact frozen review scope:** the 429 ordered paths in the source result's authoritative `scope` array (no additions or exclusions).
- **Support path for remediation installation:** this plan file only.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — BullMQ discards Redis credentials/TLS**
   - Update `packages/framework/src/queue-bullmq/adapter.ts` to parse a URL into complete, typed Redis connection options rather than a host/port tuple. Preserve username, password, database selection, and `rediss:` TLS intent for both the shared ioredis connection and BullMQ.
   - Add adapter tests that assert authenticated and TLS URL connection options are passed through without exposing secrets in diagnostics.

2. **`code-reviewer-2` — HITL wakeup queue is not tenant-isolated**
   - Derive the default HITL BullMQ queue name from the already-validated bound `TenantId`; keep a supplied `queueName` as an explicit deployment override.
   - Make the trigger envelope carry the tenant identity and reject a delivered trigger whose tenant differs from the worker-bound tenant before any run processing or acknowledgement.
   - Add shared-backend two-tenant tests proving queue names and trigger delivery cannot cross tenants.

3. **`code-reviewer-3` — Redis error mapping is not total**
   - Replace unsafe caught-value coercion in `redisErr` with framework `safeErrorMessage`.
   - Add hostile-value coverage proving Redis port calls return `Err(redis-unavailable)` instead of rejecting.

4. **`code-reviewer-4` — PostgreSQL error mapping is not total**
   - Use `safeErrorMessage` and `probeErrorCode` in `mapPgError`; use total rendering for the health-check catch too.
   - Add revoked-proxy/throwing-accessor tests that prove `mapPgError`, Pg client methods, and the health check preserve their Result contracts.

5. **`silent-failure-hunter-1` — a renewal failure can bypass owned-lock release**
   - Narrow `RunQueue`'s Redis dependency to required lease operations and validate it before a worker can acquire a lock.
   - Enter the release-protected region immediately after acquisition; make renewal diagnostics best-effort; record renewal-tail rejection as the primary retry failure only after attempting token-validated release.
   - Add tests for missing renewal capability, rejected renewal, and throwing logger, asserting `compareAndDelete` is always attempted after acquisition.

6. **`type-design-analyzer-1` — status timestamp mutation accepts non-finite clocks**
   - Brand `RunTimestampMs` and parse every store-owned `now()` result before persistence in both in-memory and Redis stores; persist an `internal-invariant-violated` Result rather than corrupting metadata.
   - Make `RunMetaSchema` parse the branded finite timestamp domain and add NaN/Infinity status-transition tests.

7. **`comment-analyzer-1` — CompositeSpanExporter isolation catch path can throw**
   - Replace unsafe caught-value conversion in synchronous export, post-settlement warnings, lifecycle deadline rejection, and lifecycle aggregation with total framework rendering.
   - Add hostile-value tests proving export, forceFlush, and shutdown honor their non-throwing isolation contracts.

8. **`comment-analyzer-2` — capability health aggregation catch path can throw**
   - Use `safeErrorMessage` in `checkHealth` and add a hostile health-check rejection test proving it returns a degraded report.

9. **`architecture-tech-lead-1` — notification can be delivered without a durable pending marker**
   - Change the human-review hook to fail closed on `markPending` failure: log safely, return `pending`, and do not notify an unresolvable review gate.
   - Update the hook contract comment and tests to pin that a notification is sent only after a pending marker is durably created (or confirmed present).

## Advisory dispositions

| ID | Disposition | Reason and action |
|---|---|---|
| `code-reviewer-5` | **deferred** | The claim is sound, but a complete remedy requires a cancellable/fenced `processRun` contract propagated into every DAG node and external side-effect adapter. The current queue seam cannot safely promise cancellation of already-issued effects; this is a dedicated durable-execution/fencing design, not a local remediation. |
| `pr-test-analyzer-1` | **accepted** | Client input reaches a throwing branded-ID constructor. Parse `resume_run_id` with the canonical `tryRunId` predicate at the request boundary and add empty/malformed-ID 400 tests. |
| `type-design-analyzer-2` | **accepted** | This is the type-level completion of critical `silent-failure-hunter-1`: introduce a narrow required HITL lease capability so invalid wiring cannot compile or acquire a lock before failing. |
| `comment-analyzer-3` | **accepted** | Correct the HITL service overview to state that initial enqueue is a wakeup request and reconciliation guarantees eventual delivery after enqueue failure. |
| `architecture-tech-lead-2` | **accepted** | Addressed together with `silent-failure-hunter-1` by requiring the lease capability before worker acquisition; add construction-level regression coverage. |
| `code-simplifier-1` | **accepted** | Collapse the adjacent `completedAt` serialization guards into one equivalent serializability guard, retaining the exact error surface. |
| `code-simplifier-2` | **accepted** | Extract the pure `RunExecOutcome → RunStatus` translation and make the single persistence call once, preserving status outcomes and ordering. |
| `code-simplifier-3` | **accepted** | Extract one local readiness-probe helper that retains each dependency-specific logging message and defaults while removing duplicate catch-to-false control flow. |

## Refuted-critical audit

None. The Refutation Panel published `refuted_critical_findings: []`; all nine critical findings met the two-lens survival threshold. The panel did record a security-lens counterargument for `silent-failure-hunter-1` (TTL bounds the missing-capability leak), but reproduction and intent upheld the release-path defect, so it remains mandatory.

## Validation

1. Focused tests for each changed package/app, including all new hostile-error, tenant-isolation, lease-release, timestamp, and request-ingress regressions.
2. `bun run --filter @fuguejs/framework typecheck && bun run --filter @fuguejs/framework test`
3. `bun run --filter @fuguejs/host typecheck && bun run --filter @fuguejs/host test`
4. `bun run --filter @fuguejs/pg typecheck && bun run --filter @fuguejs/pg test`
5. `bun run --filter customer-summary typecheck && bun run --filter customer-summary test`
6. Repository-wide `bun run typecheck` and `bun run test` before registered remediation installation.
