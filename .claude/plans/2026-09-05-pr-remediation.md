# PR Remediation Plan — Round 15 (`pr41`)

**Branch:** `feat/f3-budget-capability-surface`
**Review HEAD:** `dc90427` (`fix: close the LlmClient variance hole and round-14 advisories`)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-05T23-00-00Z-standalone-review-r15`
**Canonical result:** `<run>/result.json` (all inputs below read from it; nothing hand-built)
**Scope:** `kind: all`, 176 frozen files across `packages/framework`, `packages/host`, `apps/customer-summary`, `docs/`

## Review outcome

| Bucket | Count |
|---|---|
| Reviewers spawned | 7 (one retry on `comment-analyzer` — out-of-scope path) |
| Critical findings raised | 17 |
| Refuted by panel | **0** |
| Surviving criticals (mandatory) | **17** |
| Advisory findings | 57 |
| Advisories accepted | 48 |
| Advisories dismissed | 9 |
| Advisories deferred | 0 |

**Refutation panel:** lenses `reproduction`, `intent`, `security`; threshold 2 upheld.
`reproduction` and `intent` upheld all 17. `security` upheld 5, returned `uncertain`
on 11 (outside a security lens's remit), and returned **`refuted` on
`comment-analyzer-6` alone** — which still survives at 2/3. See "Refuted-finding
audit" below: no finding was refuted by the panel, so none is exempt from fixing.

Every surviving critical is a **comment/doc/test-title accuracy defect** — a
comment, header, or test name that asserts something the code beside it does not
do. None is a behavioural bug. Two of them (`comment-analyzer-12`, `-13`) and one
(`-17`) are tests whose *stated* invariant is not the one their assertions pin;
those are fixed by strengthening the test until the claim is true, not by
weakening the claim.

---

## Surviving critical findings — mandatory fixes

### C1 — `packages/host/src/host.ts:6`
**Claim:** header says "Constructs SharedInfra from config"; `SharedInfra` is only
imported as a type (line 30) and arrives as a field on the injected `HostDeps`
(line 157). Never constructed here.
**Fix:** replace the bullet with "Receives `SharedInfra` from the injected
`HostDeps` (constructed by the entrypoint, not here)".

### C2 — `packages/host/src/host.ts:10`
**Claim:** header states SIGTERM order as *draining state → stop sync → close
server*; `performShutdown` (1313-1385) stops the sync loop and Redis probe
**first** (1331-1341), then calls `beginDrain` (1345), then drains, then stops the
server (1362-1366).
**Fix:** restate the bullet in the real order: *stop sync loop + Redis probe →
draining state → await in-flight drain → close server → stopped → exit*.

### C3 — `packages/host/src/domain/config.ts:301-305`
**Claim:** `TEAMS_WEBHOOK_URL` doc says HITL is off (501) "only when NEITHER
transport is configured". `wireHitlRunEngine` (`host.ts:599`) gates on
`notifier !== undefined && queueBackend !== undefined`, and `host.ts:736-738`
logs "A HITL notifier is configured but no queue backend was wired — HITL is
disabled".
**Fix:** add the second disabling condition to the doc — a configured transport
with no wired `queueBackend` also leaves HITL off.

### C4 — `packages/host/src/adapters/keycloak-broker.ts:353`
**Claim:** "The token cache is held in a single mutable cell in this shell"; lines
393-394 declare two — `saCache` and `appOnlyCache` — and the very next comment
block (358) already says "Two mutable cells".
**Fix:** correct to "two mutable cells" and point at the block below that explains
the split.

### C5 — `packages/framework/src/dag-runtime/executor.ts:88-93`
**Claim:** the JSDoc says the shared human-gate body "…and emit the resulting
response/suspend event". `callHumanReviewHook` (115-180) only returns an
`UnenrichedDagEvent`; `emitHumanIntervention` is called by the caller
`handleHumanGate` (313).
**Fix:** correct the claim, and (this same block is `code-simplifier-1`) move it
from above `HumanReviewHookCall` onto `callHumanReviewHook`, which it describes.

### C6 — `packages/framework/src/dag-runtime/run-node.ts:347-360`
**Claim:** "An unfenced throw would escape to the wave-level catch-all and be
reclassified as a RETRIABLE `node-crash`". The throw sits inside the callback
passed to `withTracedNodeSpan`, whose own `fn()` catch (`node-span.ts:206-226`)
intercepts first and hardcodes `retriability: "retriable"`; the wave-level
`asNodeFrameworkError` is never reached (and classifies non-`FrameworkError`
throws **non**-retriable anyway).
**Fix:** correct the mechanism to name `node-span.ts`'s outer `fn()` catch. The
stated consequence (retriable `node-crash`, re-firing broker egress on retry) is
unchanged and correct. This also reconciles the paragraph with the one directly
below it, which already names `node-span.ts`'s catch.

### C7 — `packages/framework/src/llm/cost.ts:145`
**Claim:** "This is the ONLY producer of budget-facing cost". `spendOfUnknownCall`
(line 184) is a second producer, and `run-spend-authority.ts:377-381` feeds both
into the same `accumulate(meter, runId, call)`.
**Fix:** restate as: `spendOfCall` is the only producer of **priced** cost — the
only path the cache multipliers reach the budget through — and name
`spendOfUnknownCall` as the sibling fail-closed producer for untrustworthy usage.

### C8 — `packages/framework/src/types/dag-internals.ts:37`
**Claim:** "The compile-time guard is retained for edge cases where a hand-rolled
node has `id: string`". That branch (`string extends Nodes[K]["id"] ? Nodes[K]`)
returns `Nodes[K]` **unconditionally**, never reaching the
`Nodes[K] extends { readonly id: K }` guard.
**Fix:** state the truth — a hand-rolled `id: string` node is accepted as-is and
is caught only by the runtime `validateDagShape` check; the compile-time guard
applies to the remaining non-`NodeId`, non-`string` cases.

### C9 — `packages/framework/src/index.ts:42-45`
**Claim:** `runDagStateful` "live[s] on the `@fuguejs/framework/advanced` subpath".
`advanced.ts` exports `runDagAsWorkerJob`, `runResumableDagJob`,
`compileDagToMachine`, `buildDagExecutor`, `dagTransition`, `topoSort`,
persistence helpers — never `runDagStateful`. `dag-runtime/index.ts:32-35`
documents it as "intentionally NOT re-exported".
**Fix:** correct the doc, not the API. Keeping `runDagStateful` off the public
surface is the documented deliberate design (`dag-runtime/index.ts`, and
`run-dag-stateful.ts:694` directs suspendable callers to `runDagStatefulOutcome` /
`runResumableDagJob`). Widening the published surface to make a stale comment true
would be a real API change dressed as a comment fix.

### C10 — `packages/framework/README.md:172`
Same false claim in the Public-surface section. **Fix:** same correction.

### C11 — `packages/framework/src/__tests__/_context-factories.ts:4`
**Claim:** "the full 13-field context object". `DagMachineContextPersisted` =
`DagTopology`(4) + `DagRetryState`(4) + `DagHumanGateConfig`(2) +
`DagRoutingState`(2) + 5 own = **17**.
**Fix:** 17, and name the composition so the number is re-derivable rather than
re-drifting.

### C12 — `packages/framework/src/__tests__/pass-3-remediation.test.ts:297`
**Claim:** the test claims to pin "two transitions sharing prevStateKey and
event-type MUST produce distinct dedup keys", but its synthetic state carries a
monotonic `tag: stepCount`, so `stateKey = JSON.stringify(s)` is already unique
per step and all six keys are distinct under *any* keyer. Worse, its strictly
alternating `x→y→x→y` shape keeps prev-state and post-state keys in lockstep, so
it cannot separate the fixed `(prevStateKey, eventType)` slot from the old
post-`stateKey` slot either.
**Fix (strengthen the test, don't weaken the claim):** drop `tag`, and replace the
alternating shape with a self-loop shape that actually diverges the two keyings —
`x→x, x→y, y→x, x→x, x→z, z→done`. Under the shipped keying all six dedup keys are
distinct (`x|1`, `x|2`, `y|1`, `x|3`, `x|4`, `z|0`); under the old post-`stateKey`
keying transitions 1 and 2 both derive `x|1|step` and collide. The existing
`expect(new Set(captured).size).toBe(captured.length)` then genuinely fails on the
pre-fix implementation.

### C13 — `packages/framework/src/__tests__/pass-3-remediation.test.ts:880`
**Claim:** the test says it "verifies the hook is invoked instead of defaulting to
JSON.stringify", but its only assertion is `job.data.state.kind === "done"`, which
holds under either keyer.
**Fix (strengthen):** record `stateKey` invocations, and assert the emitted
`dedupKey` is exactly `x|0|step` — the custom keyer's `"x"` — rather than the
`JSON.stringify` form `{"kind":"x","seenAt":{}}|0|step`. Both assertions fail if
the hook is ignored.

### C14 — `packages/framework/src/__tests__/route-decided-evidence.test.ts:262-263`
**Claim:** titled "throwing check function records reason: 'threw' and does not
match"; the body asserts the run fails closed with `predicate-malformed` and never
inspects a `route-decided` event.
**Fix:** rename to the behaviour actually verified — "throwing check function
fails the run closed with predicate-malformed". (The in-body comment "A throwing
predicate is now treated as predicate-malformed" is already accurate; kept.)

### C15 — `packages/framework/src/__tests__/predicate-malformed-event-sequence.test.ts:101`
Same stale title, claiming a fall-through to default that the body never asserts.
**Fix:** rename to match the asserted fail-closed `predicate-malformed` outcome.

### C16 — `packages/framework/src/__tests__/node-side-effects-propagation.test.ts:7`
**Claim:** header bullet "OTel span attributes are set correctly"; the file has
zero span-attribute assertions and installs a stub tracer
(`withSpan: (_n,_t,fn) => fn()`) that has no span object to assert on.
**Fix:** drop the bullet. Span-attribute behaviour is pinned by
`span-enrich.test.ts`; adding a real tracer here to make a stale bullet true would
duplicate that coverage in a file about side-effect propagation.

### C17 — `packages/host/src/__tests__/integration/full-lifecycle.test.ts:519`
**Claim:** named "FR-060: graceful shutdown stops sync and server" but asserts only
`phase === "stopped"` plus two log lines. `serverPort` is captured and never used;
neither the server stopping nor the sync loop halting is verified.
**Fix (strengthen):** after `shutdown()`, additionally assert
(a) `host.server === null` — the server handle is released;
(b) a `fetch` to the captured port is refused — it genuinely stopped accepting
connections;
(c) a post-shutdown `host.triggerSync()` drives **no** further `git.pull` /
`currentSha` call, via a call-counting wrapper around the fake `GitPort` — the
sync loop handle is dropped, so the name's "stops sync" half is pinned too.

---

## Advisory dispositions

All 57 dispositioned autonomously. **48 accepted, 9 dismissed, 0 deferred.**

Roll-up: 7 test-coverage + 1 type-design + 23 comment-accuracy + 17
simplification = 48 accepted; 8 duplicate records + 1 refuted-on-implementation
dismissed.

### Dismissed (8) — duplicate records, no separate defect

`pr-test-analyzer-8 … -14` and `type-design-analyzer-2` are the aggregator's
prose-line parses of the same reviewer's structured findings: each carries
`file: null` and a `claim` string that is byte-for-byte the prose restatement of
`pr-test-analyzer-1 … -7` / `type-design-analyzer-1` respectively. Fixing the
structured original resolves them; there is nothing additional to do and no file
to anchor a change to.

| ID | Duplicate of |
|---|---|
| `pr-test-analyzer-8` | `pr-test-analyzer-1` |
| `pr-test-analyzer-9` | `pr-test-analyzer-2` |
| `pr-test-analyzer-10` | `pr-test-analyzer-3` |
| `pr-test-analyzer-11` | `pr-test-analyzer-4` |
| `pr-test-analyzer-12` | `pr-test-analyzer-5` |
| `pr-test-analyzer-13` | `pr-test-analyzer-6` |
| `pr-test-analyzer-14` | `pr-test-analyzer-7` |
| `type-design-analyzer-2` | `type-design-analyzer-1` |

### Dismissed (9th) — `silent-failure-hunter-1`, refuted during implementation

`packages/host/src/adapters/node-context-factory.ts:292,314,324`. The advisory
reads the hardcoded `new Error("Checkpoint persistence failed")` as an
actionability regression and asks for the computed reason (and
`formatHostError(setResult.error)`) to be threaded into the thrown message.

**The genericity is a deliberate, test-pinned disclosure boundary.** The fix was
implemented, then reverted on this evidence:

- `packages/host/src/__tests__/node-context-factory.test.ts:525` — the test
  *"logs full typed Redis diagnostics server-side but throws no key or driver
  detail"* asserts the thrown message contains none of the tenant, dagId, runId,
  nodeId, or the raw driver text. Its fixture's `operation` is
  `` `SET ${sensitiveKey}: NOPERM raw-driver-secret` ``.
- Two sibling tests (`:486`, `:601`) pin the message with the anchored regex
  `/^Checkpoint persistence failed$/`, and `:508`'s threshold-escalation test
  asserts the raw driver text (`"socket reset during checkpoint"`) reaches the
  *log* while the throw stays generic.

`run-node.ts` renders whatever is thrown here into the DAG-visible
`checkpoint-write-failed`, which is rendered into HTTP responses — so the
requested change would publish the full checkpoint key and driver text to any
caller. The actionable detail the advisory wants already exists server-side, with
full structured context, via `report()` / `writeFailures.failed()`.

**What was kept:** a comment at each of the three throw sites recording *why* the
message is generic and pointing at the test that pins it, so the next reviewer
does not re-raise it. The reviewer could not have seen this — the pinning test
lives in a file its own review pass did not open.

### Accepted — test coverage (7)

| ID | Target | Fix |
|---|---|---|
| `pr-test-analyzer-1` | `http/handlers/run-dag.ts:230` | cover the `!deps.hitl` → 501 `hitl-not-configured` branch in `__tests__/handlers/run-dag.test.ts` |
| `pr-test-analyzer-2` | `dag-runtime/run-dag-stateful.ts:157` | drive malformed `InvocationOrigin` shapes (wrong key set per variant, non-string `sub`/`agentClientId`, bad `kind`, non-object) through `snapshotOrigin` |
| `pr-test-analyzer-3` | `http/middleware/error-handler.ts:73` | assert `rawDetailsFor`'s per-kind body fields through real dispatched responses — see the note below, the premise is only half true |
| `pr-test-analyzer-4` | `describe/build-described-dag.ts` | cover the `topoSort` failure path and the output-node-not-found branch |
| `pr-test-analyzer-5` | `host.ts:663` | exercise `reconcileHitlRuns`'s `inFlight` single-flight guard under overlapping concurrent calls |
| `pr-test-analyzer-6` | `types/spend.ts:238` | cover `parseSpend`'s invalid `usage` enum, non-object input, invalid/missing `usd.kind`, missing `usd.micros` |
| `pr-test-analyzer-7` | `http/handlers/run-dag.ts:237` | assert the HITL success path (202 `{runId, status:"queued"}`) |

**Note on `pr-test-analyzer-3`.** Probing the real middleware showed the
advisory's premise holds only for statuses below 500. `dag-disabled` (503),
`circuit-open` (503) and `worker-unavailable` (503) go through the "Path 1b"
generic-body disclosure discipline, which strips `details` entirely — so those
three `rawDetailsFor` arms are unreachable in any client-visible body, and
asserting they render would assert something the middleware deliberately does
not do. The tests therefore split: `<500` kinds (`forbidden` 403, `timeout` 408,
`dag-not-found` 404, `tenant-over-quota` 429, both concurrency 429s,
`tenant-unknown` 404) pin the rendered `details` object exactly; `>=500` kinds
pin the *withholding* plus the `Retry-After` header that is their actual retry
contract.

### Accepted — type design (1)

- **`type-design-analyzer-1`** — `packages/framework/src/types/own-data.ts:56`.
  The docstring asserts no call site distinguishes an absent key from an
  accessor-backed one, but `run-spend-authority.ts:196-200` needs exactly that
  distinction for the optional `thinking` field and hand-rolls the descriptor
  walk the module exists to consolidate. **Fix:** add a
  `readOptionalOwnDataProperty` primitive returning a three-way
  `absent | accessor | value` result, migrate `run-spend-authority.ts` onto it,
  and narrow the docstring so the collapsing rule is scoped to required fields.
  This closes the last un-migrated copy *and* removes the latent trap where a
  future "simplification" would silently stop rejecting a hostile accessor.

### Accepted — comment accuracy (23)

`comment-analyzer-18 … -40`, all corrections in place. Notable ones:

- `-20`, `-38` — ADR-0082 misattributes the `llm.metered` redaction to `pickUsage`
  and omits `usage: UsageKnowledge` from the `Spend` shape.
- `-21` — `computeCostUsd` warns "once"; there is no de-dup, so it warns per call.
- `-22` — `testNodeContext` is a 12-field literal, not 11.
- `-29` — `capability-broker.ts` cites a `db` built-in that is not in
  `BUILTIN_CAPABILITY_KEYS`.
- `-31 … -35` — executor/wave/run-dag-stateful headers understating branches
  (third `node-failed` cause, whole-wave re-invocation, waveless branches,
  positional-not-chronological "first failure", suspended runs that skip
  `emitRunEnd`).
- `-39` — shutdown "clears the owner" for `HITL_RECONCILE_INTERVAL_MS`; it only
  calls `clearInterval`.
- `-40` — `spend-ledger-file.ts` documents none of the atomicity/durability
  semantics its two sibling adapters spell out for the same port.

### Accepted — simplification / consolidation (17)

`code-simplifier-1 … -17`. The load-bearing theme: helpers this repo already
committed to (`testNodeContext`, `testRuntimeContext`, `captureRejection`,
`waitFor`, the table-driven config validators) exist precisely to kill a
hand-rolled pattern, and a dozen sibling files never migrated. Each is a
mechanical migration onto the existing helper, plus:

- `-1`, `-2` — the misplaced/orphaned JSDoc blocks (`-1` is the same block as C5).
- `-3` — `own-data.ts` spelling the same own-data check two ways.
- `-4` — `span-enrich.ts`'s thrice-repeated filter-or-redact ternary.
- `-5` — a `limit ?? 20` fallback for a value Zod's `.default(20)` guarantees.
- `-12`, `-13` — byte-identical duplicated assertions / `it` bodies.
- `-16`, `-17` — `config.ts`'s ~10 hand-written "required when X is set" blocks
  and 3 hand-written paired-field XOR checks, both onto helpers the file already
  applies elsewhere.

---

## Refuted-finding audit

**`refuted_critical_findings`: 0 entries.** No finding was refuted by the panel, so
none is exempt from remediation.

One lens *did* return `refuted` on a single finding, and it is recorded here in
full because the panel's own arithmetic (threshold 2 of 3) overrode it:

> **`comment-analyzer-6`** — `run-node.ts:347` — refuted by the **security** lens:
> "`node-span.ts:206-226` shows the outer catch around `fn()` … hardcodes
> `retriability: "retriable"` directly, without ever calling
> `asNodeFrameworkError` — so an unfenced throw is absorbed into a resolved
> `Result` there and never reaches `wave-execution.ts`'s `asNodeFrameworkError`
> catch-all. The comment's own next paragraph (`run-node.ts:356-363`) already names
> `node-span.ts`'s outer catch as the RETRIABLE-producing mechanism, so the actual
> behavior matches the comment's claim (retriable node-crash) and the finding's
> premise that `asNodeFrameworkError` governs this path is factually wrong."
>
> Upheld by **reproduction** and **intent**, both on the narrower ground that the
> comment names the *wrong interceptor* (wave-level catch-all rather than
> node-span's own catch). Survives at 2/3.

The C6 fix above is written to satisfy both readings: it corrects the named
mechanism (what reproduction/intent upheld) while preserving the retriable
consequence (what the security lens showed is correct), leaving the paragraph
consistent with the one below it.

---

## Support paths (outside the frozen review scope)

Registered in the remediation run's `supportPaths` at start:

- `.claude/plans/2026-09-05-pr-remediation.md` — this plan.

## Validation evidence

Run after every fix above landed:

| Check | Result |
|---|---|
| `bun run --cwd packages/framework typecheck` | clean (`tsc --noEmit` + `tsconfig.bin.json`) |
| `bun run --cwd packages/host typecheck` | clean |
| `bun test packages/framework` | **3455 pass, 0 fail**, 52 skip (Redis-gated), 190 files |
| `bun test` in `packages/host`, per file | **2596 pass, 0 fail** |

Mutation checks — each strengthened test was verified to FAIL against the
pre-fix behaviour it claims to pin, so none is a tautology:

| Test | Mutation applied | Result |
|---|---|---|
| C12 dedup-key walk | `runner.ts` dedupSlot → post-`stateKey` (the pre-fix keying) | **fails** ✅ |
| C13 stateKey hook | `runner.ts` keyer → always `JSON.stringify` (ignore the hook) | **fails** ✅ |
| `pr-test-analyzer-5` single-flight | `host.ts` `if (inFlight !== undefined) return inFlight;` removed | **fails** (3 reads, expected 2) ✅ |

All three mutations were reverted; `git diff` on `runner.ts` and the guard line
in `host.ts` is empty.

Notes:
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts` failed once in
  a whole-suite pass and then passed 3/3 in isolation. It is a timing-sensitive
  file **not touched by this remediation** — a pre-existing flake, not a
  regression.
- The host suite's aggregate run truncates its summary line before and after
  these changes alike (verified by stashing to `dc90427`), which is why the
  per-file counts above are the evidence.
- 52 framework skips and 20 bullmq skips are Redis-gated (`REDIS_URL` unset; no
  local Redis in this environment). The `waitFor` consolidation in
  `queue-bullmq-adapter.test.ts` sits mostly inside those gated blocks, so it is
  typecheck-verified but not executed here.

## Validation commands

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun test packages/framework
bun test packages/host
```

Validation must pass before any staging. Remediation installs only through the
registered remediation run's verified temporary index — no hand-run staging.
