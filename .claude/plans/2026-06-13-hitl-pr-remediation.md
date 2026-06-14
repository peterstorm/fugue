# PR Remediation Plan — ADR-0060 HITL Teams Approvals

**Date:** 2026-06-13
**Branch:** feat/hitl-teams-approvals (base `a2edc57`)
**Scope:** 49 files, +3,895 lines
**Review:** 7-agent cohort (code, errors, tests, types, comments, architecture, security) + adversarial verification pass.
**Findings:** 25 raw → 24 confirmed, 1 uncertain, 0 dropped (6 critical, 18 advisory). Deduplicated to **14 distinct fixes** (several findings are one defect across lenses).

Baseline (pre-fix, green): framework typecheck ✅ + 1642 tests / 0 fail; host typecheck ✅ + 943 tests / 0 fail.

---

## Critical Fixes

### C1 — Lost-wakeup race in the single-flight lock (run-queue.ts) [findings 1, 4]
On lock contention the worker logs and **returns** (acks the job), discarding the wakeup. With `HITL_WORKER_CONCURRENCY=4` an approval enqueued while a worker holds the lock can be dropped → decided run stays `suspended` forever.
**Fix:** on contention **re-enqueue with a short `delayMs`** (cross-process-correct: decision is durable in Redis; bounded — slice is short, lock self-heals via C2). Focused run-queue test.

### C2 — Non-atomic lock acquire strands a run on crash (run-queue.ts) [findings 2, 5]
`setNx(key,'1')` then separate `set(key,'1',{EX})`. Crash between → lock with no TTL → held forever.
**Fix:** extend `RedisPort.setNx` with `{expiresInSec}`; implement atomically as `SET key val NX EX ttl` (main.ts). Use atomic form in run-queue, decision-store.markPending, run-store.create; drop redundant follow-up `set`.

### C3 — JWKS fetch failure misclassified 401 not 503 (bot/verify.ts) [finding 3]
`createRemoteJWKSet` fetches keys lazily inside `jwtVerify`; a JWKS/network fault throws into the `catch` that returns `invalid` (401), contradicting the file's fail-closed-503 contract.
**Fix:** pure `classifyJoseError(e)` → `unavailable` for JWKS-timeout/fetch faults, `invalid` for signature/claim/structural. Unit-test the classifier.

### C4 — Unvalidated `serviceUrl` → SSRF / connector-token leak (bot) [finding 6]
`captureReference` persists inbound `serviceUrl` verbatim; connector POSTs the card with an app-only bearer to `${serviceUrl}/...`.
**Fix:** pure `bot/trusted-host.ts#isTrustedBotServiceUrl` (https + MS allowlist). Reject at capture AND before send (defense-in-depth). Tests + realistic test fixtures.

---

## Advisory Fixes

- **A1** worker swallows processRun host-infra error → settle-failed returns `ok`; pre-settle transient `runStore.get` failure returns `err` and the worker **re-throws** (lock released in `finally`) so the queue retries; bounded `defaultAttempts`. [7]
- **A2** `setStatus("running")` Result dropped → capture + log, best-effort. [8]
- **A3** `TEAMS_WEBHOOK_URL` must be https (config superRefine). [24]
- **A4** `jwtVerify` gets `algorithms:["RS256"]` + `clockTolerance:"60s"`. [23]
- **A5** Teams button path skips the team-authz the HTTP path enforces. v1 single-default-conversation has no AAD→team mapping; **documented as a hard v1 constraint** (handler + hitl-teams.md + ADR), per-team routing tracked as follow-up. [22]
- **A6** decision-store separator: unify both adapters on `\x1f` (injective unlike `:`, git-text unlike NUL). [17,18,20,21]
- **A7** ADR §4 `runDagStateful`→`runDagStatefulOutcome`; fix the block comment above `runDagStatefulOutcome` to state its real `StatefulOutcome` contract. [19,U1]
- **A8–A15** tests: bearer + jose-classifier; re-park on decision read err; checkpoint-persist-throws; redis torn-record/corrupt-meta/corrupt-decision + separator round-trip; handler malformed/empty-reason + trusted-host; connector token-cache + HTTP mapping; redis conv-store corrupt-ref; elapsed-time semantics. [9–16]

---

## Validation
```
cd packages/framework && bun run typecheck && bun run test
cd packages/host && bun run typecheck && bun run test
git diff --numstat | grep decision-store   # must show numeric +/- (no longer "- -")
```
