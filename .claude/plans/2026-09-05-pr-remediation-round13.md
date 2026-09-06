# PR #41 Remediation — Round 13

**Branch:** `feat/f3-budget-capability-surface` → `main` (PR #41, "feat: complete F3 budget capability surface")
**Review HEAD:** `e6fd4821eb621e3bad8ecb650e9f769962ce0e00` (working tree clean at review time)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-05T12-00-00Z-standalone-review-r13`
**Canonical authority:** that run's `result.json` (digest `7372f41fba538e7272836797a6b97ed7906081d57a5904cbce5546a55ea8de21`)

**Scope:** the frozen 167-file review scope — `packages/framework/src/**`, `packages/host/src/**`, their tests,
`docs/` ADRs and plans, `CONTEXT.md`, `.gitignore`, and `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts`.

**Panel outcome:** 8 criticals found → 1 refuted → **7 surviving criticals (all mandatory)**; **21 advisories**.

---

## Refuted-finding audit — reported, never fixed

**`pr-test-analyzer-3`** — *"`parseHostError`, the ~240-line parser wired into `error-handler.ts`'s HostError
recovery, has zero test coverage for any variant or rejection path."*
`packages/host/src/domain/host-error.ts:349`

Refuted by 2 of 3 panel lenses; the third (intent) declined as out-of-remit.

- **reproduction lens:** `packages/host/src/__tests__/middleware/error-handler.test.ts` exercises `parseHostError`
  directly and extensively — a `validVariants` array round-tripping every HostError kind (328-345),
  malformed/rejected-field tests (356-366), per-field identifier rejection (368-394), hostile-input/throwing-getter
  tests (396-415), and issue-shape rejection/acceptance (433-604+).
- **security lens:** same file round-trips every valid variant (289-345), tests rejection of extra/invalid identifier
  fields per variant (356-394), and specifically tests adversarial rejection paths — throwing getters and revoked
  Proxies (396-415) plus getter-snapshot semantics (417-429). *"The claim of 'zero test coverage for any variant or
  rejection path' is factually false."*

**No change will be made for this finding.**

---

## Surviving criticals — all mandatory

### C1 — `packages/framework/src/dag-runtime/wave-execution.ts:146,187,225`

`executeWave`'s three `emit(..., { timestamp: stamp() })` calls evaluate `stamp()` → `nowFn()` as an object-literal
**argument**, so a throwing clock fires before `emit`'s body is entered and before any guard. The reachable one is the
per-node **catch handler** (line 187): it is the function's only safety net for a thrown node defect, and its own
`stamp()` throwing escapes the `.map()` callback, rejecting that slot of the `Promise.all`. `executeWave` then rejects
instead of returning the documented `WaveResult`, discarding already-completed sibling nodes' results and side effects
with no `node-failed`/`node-error` event for them — a retry re-runs them, risking duplicate side effects for nodes
without an idempotency key. Reproduced empirically by the reviewer; upheld by all three panel lenses.

`packages/framework/src/dag-runtime/best-effort.ts` states the rule ("diagnostics… must never propagate", "ONE
encoding of that rule"), and `human-emission.ts` already applies it for exactly this hazard ("a hostile clock throws
before `emit`/`dispatchEvent` is entered"). `wave-execution.ts` calls raw `emit()`.

**Fix:**
1. Import `bestEffort` alongside `bestEffortLog` in `wave-execution.ts` and fence all three `emit(...)` calls as
   `bestEffort("executeWave", "<operation>", () => emit(...))`, matching `human-emission.ts`.
2. Fence the upstream sites in `packages/framework/src/dag-runtime/run-node.ts` that feed the same catch handler and
   execute **before** `withTracedNodeSpan` is entered (so its try/catch cannot protect them): `emitNodeError`'s body
   (line 467) and the `node-skipped`/checkpoint emit (line 499). Both evaluate `stamp()` as an argument.
3. Regression test in `packages/framework/src/__tests__/wave-execution-errors.test.ts`: an always-throwing `nowFn` plus
   a node that fails input validation must still produce a `WaveResult` (not a rejection), and sibling nodes that
   already completed in the same wave must keep their outputs.

### C2 — `packages/host/src/http/handlers/run-dag.ts:210`

`hostErrorResponse` renders `formatHostError(error)` verbatim for **any** `HostError`, including 5xx-class kinds
returned by `deps.hitl.startRun()`. `hitl/service.ts`'s `readRunTimestamp` produces `internal-invariant-violated`
splicing a raw caught-error message; `formatHostError` renders it unredacted; `httpStatusFor` maps it to 500. This
bypasses the disclosure discipline `error-handler.ts`'s `respondWithHostError` documents and enforces
(`SECURITY (information disclosure — OWASP A09/A05)`: 5xx → generic client message, full detail logged server-side).
No test asserts the 5xx body is free of internal detail. Upheld by all three lenses.

**Fix — one encoding of the rule, decided in the pure core (architecture.md: FC/IS, "Parse, don't validate"):**
1. Add a pure, total decision function to `packages/host/src/domain/host-error.ts`:
   ```ts
   export type HostErrorDisclosure =
     | { readonly kind: "client-safe";  readonly status: number; readonly message: string }
     | { readonly kind: "server-fault"; readonly status: number; readonly message: string; readonly detail: string };

   export const discloseHostError = (error: HostError): HostErrorDisclosure => ...
   ```
   `server-fault` (status ≥ 500) carries the generic client `message` plus the `detail` the shell must log and must not
   send; `client-safe` carries the curated 4xx message. The status/Retry-After tables stay the single source they
   already are.
2. `error-handler.ts`'s `respondWithHostError` consumes it via an exhaustive `ts-pattern` match — behaviour unchanged,
   the policy no longer lives inside the middleware.
3. `run-dag.ts`'s `hostErrorResponse` consumes the same function: on `server-fault` it returns the generic message,
   **suppresses `details`**, keeps safe headers (Retry-After), and logs `detail` server-side through the existing
   `logWithoutThrowing` helper using `deps.logger`.
4. Regression tests in `packages/host/src/__tests__/handlers/run-dag.test.ts`: a HITL `startRun` failing with
   `internal-invariant-violated` carrying a distinctive internal string must produce a 500 whose body contains neither
   that string nor `details`, while the server-side log does carry it. Pin the 4xx path unchanged.

### C3 — `packages/host/src/domain/llm-meter.ts:260`

`admitCandidate` — the fail-closed pre-flight gate that refuses an `unpriced` candidate model against a declared USD
ceiling before a call runs — has zero test coverage; it is referenced only by its definition and its production caller
(`run-spend-authority.ts`). A regression silently lets an unpriced model bypass budget enforcement.

**Fix:** direct unit + property tests in `packages/host/src/__tests__/llm-meter.test.ts` covering: unpriced candidate ×
USD ceiling → `refuse` with an `unpriced` breach carrying the candidate model and `basis: "projected"`; unpriced
candidate × no USD ceiling → delegates to `admit`; priced candidate → delegates to `admit`; `limits === undefined` →
admits and reserves. Property: for any ceilings containing a USD ceiling, an unpriced candidate **never** admits.

### C4 — `packages/framework/src/llm/cost.ts:180`

`spendOfUnknownCall` / `isPricedModel` decide whether a failed call's fail-closed spend is `priced NO_MICROS` or
`unpriced`. `isPricedModel` has no test reference anywhere; `spendOfUnknownCall`'s single appearance in
`run-spend-authority.test.ts` computes the expected value by calling the same function, so it is tautological and
would still pass if either were wrong.

**Fix:** direct tests in `packages/framework/src/__tests__/cost.test.ts` — `isPricedModel` true for a price-table model
and false for an unknown one; `spendOfUnknownCall` yields `usage: "unknown"`, `calls: 1`, `tokens: 0`, and
`usd.kind === "priced"` with `NO_MICROS` for a priced model vs `usd.kind === "unpriced"` naming the model for an
unknown one. Property: an unknown model's result always carries that model in `usd.models`.

### C5 — `packages/framework/src/file/spend-store-codec.ts:82`

No test persists and reloads a `Spend` with `usage: "unknown"` through the file spend store — both round-trip
properties hardcode `usage: "known"` — even though `parseRecord` validates `"unknown"` as a distinct meaningful
variant. Losing that absorbing signal across a restart would reopen a ceiling that should stay refusing.

**Fix:** extend `packages/framework/src/__tests__/file-spend-store.test.ts` so the round-trip property generates
`usage` over both values (and `usd` over both `priced` and `unpriced`), plus an explicit case persisting and reloading
an `unknown`/`unpriced` spend through `serializeFileSpendRecord` → `parseFileSpendRecord` and through the file store
itself.

### C6 — `packages/host/src/domain/host-error.ts:812`

The table-driven `retryAfterSecondsFor` policy and the newer `circuit-open` / `spend-ledger-unavailable` kinds are
untested as a table: a copy/paste swap between per-kind entries would silently change an advertised Retry-After.

*Panel nuance:* the reproduction and security lenses noted `circuit-open` **is** exercised end-to-end in
`run-dag.test.ts` (30s / 90s / 1s cases); the finding survived because the compound claim also names
`spend-ledger-unavailable`, which has no coverage on any path, and because nothing pins the table itself. The fix
covers both halves.

**Fix:** an exhaustive pinning test in `packages/host/src/__tests__/domain/tenant-error-taxonomy.test.ts` (support
path) asserting `retryAfterSecondsFor` for **every** `HostErrorKind` — the fixed 5s kinds, the two error-derived
function kinds (`circuit-open`, `tenant-over-quota`), and `undefined` for all the rest — driven off a table that must
enumerate every kind, so a newly added kind fails the test until its policy is pinned.

### C7 — `packages/host/src/adapters/__tests__/redis-connectivity.test.ts:909`

The real-Redis WATCH/MULTI/EXEC suites — the actual proof of this PR's double-spend fix, including optimistic-lock
invalidation against a competing client — are `describe.skipIf(liveRedisUrl === undefined)`. `.github/workflows/ci.yml`
apt-installs `redis-server` but never starts it and never sets `REDIS_URL`, and the only script that does (`test:redis`)
is not invoked by CI. So the merge-gating run skips them.

*Panel nuance:* the intent lens refuted, pointing at the fake-client "transaction serialization" block that always runs.
That block pins commit-behind-append **ordering**; it does not exercise real WATCH invalidation and retry. Two lenses
upheld; the finding is mandatory.

**Fix (support paths):**
1. `.github/workflows/ci.yml` — start the already-installed `redis-server` as a daemon and export
   `REDIS_URL=redis://localhost:6379` for the typecheck+test loop, so the gated suites run on every PR.
2. `packages/framework/src/__tests__/REDIS_TESTS.md` — replace the "When CI infrastructure is established…" section
   with what CI now actually does.

---

## Advisory dispositions

All 21 advisories are **accepted**. Each claim was verified against current source, each fix is complete and in scope
(or on a declared support path), and none conflicts with a documented decision.

### Accepted — test coverage (9)

| ID | Location | Fix |
|----|----------|-----|
| `pr-test-analyzer-8` | `dag-runtime/run-node.ts:196` | Cover `parseScopedBinding`'s `pricingModel.kind === "fixed"` branch incl. malformed-binding and alias-collision refusals (`__tests__/per-node-minting.test.ts`) |
| `pr-test-analyzer-9` | `dag-runtime/run-dag-stateful.ts:462` | Cover a rejecting background promise and an `onBackground` hook throwing post-completion (`__tests__/dag-runtime-stateful.test.ts`) |
| `pr-test-analyzer-10` | `domain/config.ts:1054` | Drive `withLlmPostcondition`'s failure branch so it is proven in sync with the Zod `superRefine` (`__tests__/config.test.ts`) |
| `pr-test-analyzer-11` | `adapters/redis-connectivity.ts:280` | Seed a corrupt hash field ahead of an append; pin `redis-unavailable` on append vs `internal-invariant-violated` on read (`adapters/__tests__/redis-connectivity.test.ts`) |
| `pr-test-analyzer-12` | `__tests__/fixtures/redis-spend-fake.ts:12` | Add an interleaved-application contract test so concurrent appends actually interleave rather than applying synchronously |
| `pr-test-analyzer-13` | `adapters/node-context-factory.ts:296` | Fail the atomic `commitCheckpointAndRetainSpend` with both checkpoint TTLs wired (`__tests__/node-context-factory.test.ts`) |
| `pr-test-analyzer-14` | `adapters/node-context-factory.ts:700` | Read `ctx.prompts.get(...)` across `promptAccess`'s three-way per-dag / `shared.prompts` / null branch |
| `pr-test-analyzer-15` | `adapters/metered-llm.ts:145` | Cover cache-kind gating between `sendStructured`/`sendWithTools` and the request-parameter validation branches (`thinking`, `temperature`, `tracer`, `maxIterations`, `deadlineMs`, `toolChoice`, invalid `nodeId`) |
| `pr-test-analyzer-16` | `host.ts:188` | Cover the `HostDeps.capabilityBroker` override (`__tests__/integration/full-lifecycle.test.ts`) |

### Accepted — comments (4)

| ID | Location | Fix |
|----|----------|-----|
| `comment-analyzer-1` | `adapters/keycloak-broker.ts:109` | `marginFor` does not exist — name `effectiveTtlMs`, where the cap actually lives |
| `comment-analyzer-2` | `adapters/keycloak-broker.ts:114` | Move the orphaned "Effective cache TTL" JSDoc off `viaForOrigin` and onto `effectiveTtlMs` |
| `comment-analyzer-3` | `domain/host-error.ts:797` | Move the `retryAfterSecondsFor` policy doc from `type RetryAfterPolicy` onto the function 43 lines below |
| `comment-analyzer-4` | `adapters/spend-ledger-redis.ts:155` | Replace the "the hand-rolled literal this replaced" archaeology with present-tense behaviour |

### Accepted — simplification (8)

| ID | Location | Fix |
|----|----------|-----|
| `code-simplifier-1` | `dag-runtime/executor.ts:94` | Bundle `callHumanReviewHook`'s 9 positional params into a context record, matching `post-wave-context.ts`'s precedent |
| `code-simplifier-2` | `apps/customer-summary/.../enrich-with-tools.example.ts:20` | Extract the thrice-duplicated deal shape into one named `Deal` type |
| `code-simplifier-3` | `host.ts:41` (+ `domain/capability-manager.ts`, `http/middleware/error-handler.ts`) | Consolidate three hand-rolled "log without throwing" implementations onto the existing `logWithoutThrowing` / `renderDiagnosticData` in `hitl/diagnostic-logging.ts` |
| `code-simplifier-4` | `host.ts:583` | `wireHitlRunEngine`: replace the `if`/`else if` chain over `HitlNotifierSelection` with an exhaustive `ts-pattern` match (typescript-patterns.md) |
| `code-simplifier-5` | `host.ts:27` | `logSafely` sits inside the import block — resolved by the `code-simplifier-3` consolidation that deletes it |
| `code-simplifier-6` | `__tests__/llm-fake-client.test.ts:38` + 8 siblings | Replace hand-rolled `NodeContext` literals with `testNodeContext(overrides)`; all 9 files are inside the frozen scope |
| `code-simplifier-7` | `__tests__/integration/full-lifecycle.test.ts:199` | Reuse the shared `testLogger()` fixture instead of a local `createTestLogger` |
| `code-simplifier-8` | `__tests__/integration/dag-isolation.test.ts:33` (+ `node-context-factory.test.ts`, `spend-ledger.test.ts`) | Import the shared `mkTenant` from `fixtures/host-boot-fakes.ts` |

### Deferred / dismissed

None.

---

## Support paths (outside the frozen review scope)

Registered in the remediation run's start input:

1. `.claude/plans/2026-09-05-pr-remediation-round13.md` — this plan.
2. `.github/workflows/ci.yml` — C7 (provision `REDIS_URL`).
3. `packages/framework/src/__tests__/REDIS_TESTS.md` — C7 (document what CI now runs).
4. `packages/host/src/__tests__/domain/tenant-error-taxonomy.test.ts` — C6 (exhaustive Retry-After pinning).

Every other touched path is inside the frozen review scope.

---

## Validation commands

```bash
# Per-package typecheck + test, exactly as CI runs it
for pkg in framework host; do (cd "packages/$pkg" && bunx tsc --noEmit && bun run test); done

# The Redis-gated suites C7 makes CI run
REDIS_URL=redis://localhost:6379 bun test packages/host/src/adapters/__tests__/redis-connectivity.test.ts
```

Full monorepo `bun run typecheck && bun run test` before staging. Remediation installs only after validation passes.

---

## Validation evidence (recorded after implementation)

`bun run typecheck` — **all 12 workspace packages exit 0.**

`REDIS_URL=redis://localhost:6399 bun run test` — **0 failures across every package:**

| package | pass | fail |
|---|---|---|
| framework | 3456 | 0 |
| host | 2584 (+10) | 0 |
| customer-summary | 243 | 0 |
| ms-graph | 142 | 0 |
| http-auth | 90 | 0 |
| oracle | 79 | 0 |
| pg | 73 | 0 |
| fs | 25 | 0 |
| examples | 23 | 0 |
| xlsx | 20 | 0 |
| document-source | 18 | 0 |
| hitl-smoke | 10 | 0 |

`bun run check:docs` — 19 shipped doc files, all relative links resolve.
`bun test scripts/` — 7 pass, 0 fail.

**Redis provisioning (C7) verified locally**, not merely wired: with `REDIS_URL` set,
framework goes 3382 pass / 52 skip → 3456 pass / 0 skip and host 2532 / 17 skip → 2584 / 1 skip.
Roughly 95 previously-skipped tests now execute, all green — so the CI change surfaces real
coverage rather than new failures.

**Each critical's regression test was verified to FAIL without its fix** (source stashed, test run,
source restored):

- **C1** — `a hostile clock cannot turn a wave into a rejection` fails with the reproduced
  `error: clock failed` escaping `executeWave`; `a failed node-skipped emission still completes the
  wave` fails on `node-failed` vs `wave-done`. 2 of 3 fail pre-fix.
- **C2** — both 5xx-disclosure tests fail pre-fix (the internal detail appears in the body).
- **C6** — swapping one `RETRY_AFTER_POLICY` value fails 3 tests; deleting one kind from the pinned
  table fails the exhaustiveness test.

### Known flake (pre-existing, not introduced here)

`packages/framework/src/__tests__/file-journal.test.ts` →
*"three concurrent processes append a replayable contiguous sequence in scheduler-selected lock
order"* failed **once in nine** full-suite runs (~412 ms, timing-sensitive cross-process file
locking under parallel load). It is untouched by this remediation — `git diff` over
`packages/framework/src/file/` and that test file is empty — and it did not reproduce in 8 isolated
runs. Recorded rather than silently re-run; it is out of this round's scope.
