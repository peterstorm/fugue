# 2026-08-19 — PR Remediation, Round 22

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-19-170814-f6-file-durable-runtime`
- **HEAD reviewed:** `52d9d2b2e863c053f33b6540f69c0120b39892a6` (round-21 remediation)
- **Result authority:** `result.json` (digest `941c88f2…`, 370-file scope)

## Adjudication summary

| Outcome | Count |
|---|---|
| Surviving critical findings (mandatory) | 1 |
| Refuted critical findings (report only, never fix) | 2 |
| Advisory findings accepted | 16 |
| Advisory findings deferred | 2 |
| Advisory findings dismissed | 6 |

---

## Phase 2 — Plan

### Surviving critical (mandatory)

**code-simplifier-1** — `packages/framework/src/file/freshness-index.ts:528` (`recordWrite` lock body) + `packages/framework/src/file/atomic.ts:577` (`withFileLock` arbitration)

- **Claim:** `recordWrite`'s lock body signals body failure by RETURNING typed `err(...)` values (corrupt-record permanent rejection at ~:546, clock rejection at ~:530, non-ENOENT fs failure at ~:558) instead of THROWING. `withFileLock` marks the body `succeeded` unless `fn()` throws, so when a returned-err body is followed by a release failure, the release error surfaces as primary and the deterministic PERMANENT verdict is masked — contradicting the journal caller's throw-signaling contract (`journal.ts:332-339`, pinned: "a body failure remains primary if cleanup also fails") and the module's own `surfaceFailure` doc (freshness-index.ts:191, "primary body failure nested inside").
- **Fix:** Convert the three in-lock-body `return err(...)` sites into `throw` of the same typed `FrameworkError`, mirroring the journal. `withFileLock` then preserves primary + failureClass; `surfaceFailure` re-tags only the lock-protocol operation and keeps the inner chain. Add a regression pin: corrupt-record body failure + release failure ⇒ primary is the permanent corrupt verdict (warning must contain "secondary lock-release failure"), symmetric to `file-journal.test.ts:1055`.
- **Evidence:** verified lock body returns `clocked` (`:530`), corrupt-record `err` (`:544-550`), non-ENOENT `err` (`:558`); `withFileLock` `outcome.kind === "succeeded"` on any non-throw.

### Refuted criticals (reported, NOT fixed)

**pr-test-analyzer-1** (`keycloak-broker.ts:346` "zero tests") — REFUTED by all three panel lenses (reproduction/intent/security): `packages/host/src/adapters/__tests__/keycloak-broker.test.ts` exists (~1500 lines) and pins the no-egress gate (`:194`, `egressCount()===0 && wifCount()===0`), the FR-030 subject-token fail-closed refusal (`:658`), and the I2 early-refresh skew (`:457`). The "zero tests in the frozen scope" claim was a changed-path-union enumeration artifact (the test file predates the branch diff).

**pr-test-analyzer-2** (`entra-wif.ts:1` "zero tests") — REFUTED by all three lenses: `packages/host/src/adapters/__tests__/entra-wif.test.ts` exists and pins the SC-011/FR-W4-004 `client_assertion` form construction (`:65`), the `downstream-denied` (FR-X-002, `:206`) and `infra-unreachable` (`:235`) classification, plus tenantId injection validation (`:108`).

These are audited refutations against real test files; per the invariants they are never fixed.

### Advisory dispositions

#### Accepted (16)

1. **code-reviewer-1** — `apps/customer-summary/src/observability-composition.ts:208`: TTL sweep evicts ACTIVE long-running runs (createdAt-based), silently zeroing summaries. Fix: add per-buffer `lastActivity` refreshed on every event; evict on inactivity, not on open time. Also fix the framework twin (`packages/framework/src/observer/buffered.ts:167-176`) with the same inactivity semantics so the production wrapper cannot evict active runs either. Add pins in `observability-composition.test.ts` and `buffered-observer.test.ts` (active run with events past TTL is NOT evicted; idle orphan still is).
2. **code-reviewer-2** — `observability-composition.ts:227`: `observe` reads the clock before checking whether the run buffer already exists, dropping events for already-open buffers when the clock misbehaves. Fix: move the clock read inside the `buffered.get(...) === undefined` branch (BufferedObserver parity, `buffered.ts:184-193`). Pin: open buffer + hostile clock ⇒ event still buffered/forwarded.
3. **silent-failure-hunter-1** — `packages/host/src/hitl/adapters/webhook-notifier.ts:60-62`: `catch { outputPreview = String(notification.output) }` is non-total (`String` can throw on null-prototype/`Symbol.toPrimitive` outputs) and the card build sits OUTSIDE `notify`'s try, so a second throw escapes as a raw rejection → escalates to retriable `node-failed`. Fix: use the framework's total `safeErrorMessage` for the fallback and move the card build inside `notify`'s try so any residual throw maps to `notification-failed`.
4. **silent-failure-hunter-2** — `packages/host/src/hitl/adapters/bot/card.ts:33`: same non-total `String(output)` fallback in `outputPreview`. Fix: route through the same total preview helper (`safeErrorMessage`) shared with the webhook transport; wrap card build inside the notifier's guarded body. Pin in `bot.test.ts` (cyclic/null-prototype output ⇒ no throw, card still builds).
5. **silent-failure-hunter-3** — `packages/framework/src/cache/cache.ts:57-63`: `InMemoryCache.set` runs `JSON.stringify(value)` and `this.now()` unguarded, raw-rejecting on cyclic values or throwing clocks, violating its own `Result<void, FrameworkError>` contract; `get`'s TTL clock read is equally unguarded. Fix: mirror `get`'s guard — wrap serialization in try/catch returning `err({kind:"cache-error", operation:"set", ...})`, and route the clock through a typed check in both `get` and `set`. Pin in `packages/framework/src/__tests__/pass-2-remediation.test.ts` (in-scope host of InMemoryCache tests).
6. **type-design-analyzer-1** — `packages/framework/src/file/journal.ts:414`: keyless filename digest derived from a SECOND `toJson` walk over the caller-owned event — a stateful proxy event could make the writer emit a record whose filename digest disagrees with its persisted content (strict reader fails closed at resume). Fix: derive the keyless digest from the canonicalized bytes — `serializeFileEventRecord` already round-trip verifies and returns `json`; parse the produced record once and compute `eventDigestOf` over the canonical event from the round-trip verification, so the digest is a single observation of the persisted form. Pin: a stateful-proxy event whose second walk differs produces a record the strict reader still accepts (digest matches persisted bytes).
7. **type-design-analyzer-2** — `packages/framework/src/types/freshness.ts:87`: `freshnessMemberKey` types `witnessKind` as `string` instead of the closed `WitnessKind` union, so a misspelled kind compiles into member bytes that can never match a real member. Fix: narrow the parameter to `WitnessKind` (call sites already pass `witness.kind`). Compile-check + existing parity tests cover.
8. **comment-analyzer-1** — `journal.ts:400`: comment says a lock-body failure "carries two" layers, then enumerates three. Fix: "carries three" (inner typed failure + `withFileLock` boundary + outer `appendEvent` layer).
9. **comment-analyzer-2** — `apps/customer-summary/src/bootstrap.ts:380`: claims "the framework no longer touches process.env", but `observer/dispatch.ts:14` reads `process.env.OBSERVER_STRICT` per dispatch. Fix: scope the claim to app config (`ConfigSchema.parse(process.env)` at bootstrap) and note the framework's one test-only OBSERVER_STRICT seam.
10. **comment-analyzer-3** — opaque remediation-round identifiers in production comments (`event-log.ts:187` "round-21 atl-1", `resume.ts:152` "round-21 cs-1", `shared/jitter.ts:11` "round-21 tda-3", `types/clock.ts:61` "deepening round, simp-5", `types/error-factories.ts:62` "deepening-round", `checkpoint/redis-checkpointer.ts:306` "round-17", `file/checkpointer-codec.ts:68` "deepening-round", `checkpoint/checkpointer.ts:197` "deepening-round"). Fix: replace cycle ids with the durable anchors they instantiate (FR/ADR numbers + one-line invariant) so the rationale stays traceable when the round plans recede.
11. **architecture-tech-lead-1** — checkpoint load-gate sequence triplicated across `checkpoint/checkpointer.ts:315-349`, `checkpoint/redis-checkpointer.ts:225-286`, `file/checkpointer.ts:527-560`. Fix: extract `evaluateCheckpointLoadGates({meta, expectedFingerprint, nowMs, createdAt}) → Result<"ok", FrameworkError>` as a pure function in the checkpoint core (`checkpoint/checkpointer.ts`, in-scope), owning gate order (frameworkVersion → fingerprint → TTL) and verdict construction; each adapter keeps its storage read + hostile-boundary handling and delegates. The parity suite (`_checkpointer-suite.ts`) pins observable behavior; add direct unit/property tests in `file-checkpointer.test.ts` for gate order under hostile combos.
12. **architecture-tech-lead-2** — envelope detection duplicated as structural shape-sniffing in `state-machine/replay.ts:39-48,153-162` and `queue-bullmq/event-log.ts:140-152`. Fix (minimum, behavior-preserving): ONE shared `isRecordedEvent` guard with the `synthetic` conjunct, exported from the in-scope `replay.ts` and consumed by the BullMQ reader, so the two encodings cannot drift; document the residual ambiguous-shape limitation. (The full tag-stamping seam redesign is deferred — see Deferred.)
13. **code-simplifier-4** — losslessness round-trip pipeline hand-rolled twice (`file/checkpoint-record.ts:66-130` and `file/event-record.ts:855-930`). Fix: extract one internal `losslessEncode(payload, labels, messageTails)` helper (pre-scan → tryCatch(toJson) → tryFromJson → deepJsonEqual) used by both codecs; pinned message tails become parameters. Behavior-preserving per `losslessness-parity.test.ts` + `file-event-record.test.ts` byte pins.
14. **code-simplifier-5** — `file/freshness-index.ts:665`: `__testCompareRedisMemberSerialization` re-exports the already-public `compareFreshnessMemberKeys`. Fix: delete the alias; import the public comparator in `file-freshness-index.test.ts`.
15. **code-simplifier-6** — event-file listing re-encoded in `journal.ts` (`listEventFiles`, `:263`) and `event-log.ts` (`readStrict`, `:87`). Fix: one raw-throwing `listJsonFileNames(dir)` helper (readdir + `.json` filter + sort) exported from `event-log.ts` (in-scope; journal already imports `readCheckpointFile` from it), each call site keeping its own error mapping (writer `fsFailure("appendEvent",…)`, reader ENOENT→`ok([])`).
16. **code-simplifier-7** — `file/resume.ts:1-65`: shell header re-narrates the ADR-0077 proof steps that `resume-proof.ts`'s header already enumerates. Fix: keep only shell-owned content (acquisition order argument incl. the log-vs-checkpoint monotonicity rationale, FR-014 gate, ADR-0080 re-tag mapping) and point at `resume-proof.ts` for the algorithm.

#### Deferred (2)

1. **pr-test-analyzer-8** — queue-bullmq suite silently skips Redis-backed tests when `REDIS_URL` is unset. Reason: fixing this is a CI/infrastructure decision (provisioning Redis in CI, or deliberately shipping a mock) rather than a code defect; the skip gating is documented at the top of the suite ("All redis-gated tests skip cleanly without REDIS_URL") and making tests fail without Redis would break local workflows. Deferred to a CI/infra owner; not a code remediation.
2. **architecture-tech-lead-2 (tail)** — full `RecordedEvent` tag-stamping at reader seams (replacing duck-typing in the pure fold with a runtime tag, narrowing `replayEvents` to tagged envelopes or pre-unwrapped events). Reason: this is an API-visible seam redesign that touches every reader constructor and fold consumer; the behavior-preserving unification (accepted above) removes the duplication hazard NOW, and the tag redesign was explicitly documented as deferred "→ deepening round" in the round-20 plan. Tracked for the deepening round, not this remediation.

#### Dismissed (6)

1. **pr-test-analyzer-3** (metered-llm "zero tests") — `packages/host/src/__tests__/metered-llm.test.ts` exists and pins pre-call budget refusal (FR-W1-002: "refuses with llm-budget-exceeded … without calling inner"), overshoot-by-one (SC-003), and accumulation; `llm-meter.test.ts` (31 tests) additionally pins `budgetDecision`/`admitWithReservation`. Same changed-path-union artifact the panel refuted for the criticals.
2. **pr-test-analyzer-4** (circuit-breaker "zero tests") — `packages/host/src/__tests__/circuit-breaker.test.ts` (50 tests: closed→open at threshold, half-open→closed heal, open stays open on unexpected success, `consumeTestRequest`) and `circuit-guard.test.ts` (58 tests) exist.
3. **pr-test-analyzer-5** (capability-scope "zero tests") — `packages/host/src/domain/__tests__/capability-scope.test.ts` exists (parse-don't-validate round-trips, malformed-name table, `handleKindForScope` exhaustive mapping, type-level narrowed-handle guarantee).
4. **pr-test-analyzer-6** (dag-diff "zero tests") — `packages/host/src/__tests__/diff.property.test.ts` exists (9 property tests: added/removed/changed partitions, identity, empty cases, `hasChanges` iff non-empty).
5. **pr-test-analyzer-7** (`__parseEntryIdTimestamp` "unused") — exercised by `packages/framework/src/__tests__/pass-3-remediation.test.ts:830-884` (malformed fallback, warning-frequency decay, `__resetEventLogState`).
6. **code-simplifier-3** (`runDirectoryOf` "dead wide boolean overload") — the `create: boolean` declaration at `checkpointer.ts:304` is the TS implementation signature REQUIRED by the two literal overloads (check the verified-directory pattern: the wide overload there is real and documented as the wrapper contract; removing the boolean implementation signature is impossible and the call sites use literals by design). No behavior change available; the claim misreads the implementation signature as an overload.

---

## Phase 3 — Implementation and validation

Files touched (all in the frozen review scope except the two support paths below):

- `packages/framework/src/file/freshness-index.ts` (+ `__tests__/file-freshness-index.test.ts`) — critical + cs-5 alias
- `packages/framework/src/checkpoint/checkpointer.ts`, `checkpoint/redis-checkpointer.ts`, `file/checkpointer.ts`, `__tests__/file-checkpointer.test.ts` — atl-1 extraction
- `packages/framework/src/state-machine/replay.ts`, `queue-bullmq/event-log.ts` — atl-2 unified guard
- `packages/framework/src/file/journal.ts` (+ `__tests__/file-journal.test.ts`) — tda-1, ca-1, cs-6
- `packages/framework/src/file/event-log.ts` — cs-6 helper, ca-3
- `packages/framework/src/file/event-record.ts`, `file/checkpoint-record.ts` — cs-4 helper
- `packages/framework/src/types/freshness.ts` — tda-2
- `packages/framework/src/observer/buffered.ts` (+ `__tests__/buffered-observer.test.ts`) — cr-1 twin
- `packages/framework/src/cache/cache.ts` (+ `__tests__/pass-2-remediation.test.ts`) — sfh-3
- `packages/framework/src/shared/jitter.ts`, `types/clock.ts`, `types/error-factories.ts`, `file/resume.ts`, `checkpoint/redis-checkpointer.ts` (comment), `file/checkpointer-codec.ts` — ca-3
- `apps/customer-summary/src/observability-composition.ts` (+ `__tests__/observability-composition.test.ts`) — cr-1, cr-2
- `apps/customer-summary/src/bootstrap.ts` — ca-2
- `packages/host/src/hitl/adapters/webhook-notifier.ts`, `hitl/adapters/bot/card.ts`, `hitl/adapters/bot/notifier.ts` (+ `__tests__/bot.test.ts`) — sfh-1, sfh-2

Support paths (NOT in the frozen review scope; registered in the remediation start input):
- `.claude/plans/2026-08-19-pr-remediation-round-22.md` (this plan)
- `packages/host/src/hitl/adapters/__tests__/webhook-notifier.test.ts` (regression pins for sfh-1)

Validation:
```bash
bun run --filter framework typecheck
bun run --filter host typecheck
bun run --filter customer-summary typecheck
bun run --filter framework test        # full framework suite (incl. parity + property pins)
bun run --filter host test
bun run --filter customer-summary test
```
Redis-gated suites skip (no REDIS_URL) — unchanged from prior rounds.

## Phase 4 — Registered remediation

- Fresh remediation run over the same runs root, `sourceRun` = the review run above, `supportPaths` = the two paths above. Resume until `done` (engine stages audited paths, verifies repo witness, atomically installs the verified index). Commit with message `fix(f6): round-22 review remediation — 1 critical, 16 accepted advisories` and push unless `--no-push`.
