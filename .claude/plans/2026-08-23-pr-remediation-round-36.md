# PR Remediation — Round 36 (Adjudicated Standalone Review)

**Branch:** `feat/f6-file-durable-runtime`
**Review HEAD:** `cbd28685b63d368ae888ee9a870a78706ef69261`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260823T000001Z-raf`
**Canonical result:** `<run>/result.json` (digest `358fa3afea4cd2faa87a81f507fcb8610e16edab2f6cb4db37cc2115f938df8e`)
**Scope:** `kind: all`, `files: null` — the frozen 453-file branch diff against `main`.

## Adjudication summary

| Bucket | Count |
|---|---|
| Surviving critical findings | 9 entries (7 distinct; 2 are duplicate Machine-Summary parses) |
| Refuted critical findings | 0 |
| Advisory findings | 66 entries (61 distinct; 5 duplicate parses) |
| Advisories accepted | 29 |
| Advisories deferred | 24 |
| Advisories dismissed | 5 (duplicates) + 3 (refuted during implementation) |

The Refutation Panel ran three lenses (`reproduction`, `intent`, `security`) over the
critical set. Every critical was **upheld** by at least two lenses; none was refuted.
The `security` lens returned `uncertain` for the four documentation-accuracy criticals
(no confidentiality/integrity/authz/availability consequence to adjudicate), which is
an abstention, not a refutation — `reproduction` and `intent` both upheld them.

## Surviving critical findings (all mandatory)

### C1 — `packages/framework/src/tracing/capability-tracing.ts:144`
Unguarded `span.setAttribute`/`setStatus`/`end()` in `withTracedCapability`'s async
resolve handler (and in `finalizeThrownSpan`). A throwing `Span` implementation turns a
successful capability call into a rejected promise and discards the real result — the
exact class of bug commit `52351e3` ("isolate telemetry failures from DAG outcomes")
closed in `node-span.ts`/`run-telemetry.ts` but missed here.

**Fix:** introduce a local `bestEffortTelemetry` mirroring `node-span.ts`'s helper and
wrap every span mutation on both the resolve and the throw path, so a telemetry fault is
logged and the modeled capability outcome stays authoritative. `finalizeThrownSpan` must
rethrow the *original* error, never a telemetry exception. Folds in advisory `cs-36`
(the duplicated Result-error span-tagging between the async and sync branches) by routing
both through one `tagErrResult` helper.

### C2 — `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts:269`
`persistRecord` swallows a failed `registry.put` with a `warn`. `reconcileReadopt` rebuilds
worker state *exclusively* from registry records, so a lost write plus a supervisor restart
leaves a live, UDS-bound, credential-holding worker that can neither be readopted nor
evicted — a permanent split-brain between OS reality and Redis-recorded reality.

**Fix:** make `persistRecord` return `Result<void, HostError>` so the failure is in the type,
not a log line. The **spawn/live** call site fails closed: tear the just-spawned worker down
(delete entry, SIGKILL) and return `workerUnavailable`, preserving the invariant *every live
worker has a durable registry record*. The **drain** call site keeps best-effort semantics
(the record is transitional and the exit path removes it) but now does so explicitly.

### C3 — `packages/host/src/supervisor/uds-proxy.ts:83`
`bunUdsTransport`'s `fetch` has no timeout or `AbortSignal`, and `admission.release()` runs
only in the `finally` after that fetch settles. A worker that accepts the UDS connection and
stalls leaks the tenant's concurrency slot permanently; repeated requests exhaust
`maxConcurrentRuns` and lock the tenant out with no log pointing at the cause.

**Fix:** replace the unbounded adapter with `makeBunUdsTransport(timeoutMs)` using
`AbortSignal.timeout`, mapping an abort to a typed transport failure so the proxy maps it to
`worker-unavailable` and the slot is released. The data path is bounded by
`MAX_DAG_TIMEOUT_MS + UDS_PROXY_OVERHEAD_MS` (derived from the worker's own maximum run
budget — no new env knob); the liveness probe gets its own short `PROBE_UDS_TIMEOUT_MS`.

### C4 — `packages/framework/src/dag-runtime/node-span.ts:161` (dup: `comment-analyzer-6`)
JSDoc claims `withTracedNodeSpan` returns `{ result, span }`; the signature and all four
return sites produce `{ result, outcome }`. The same JSDoc also claims it "Does NOT inspect
the result for guardrail semantics" while the body calls `classifyGuardrailOutcome`.

**Fix:** rewrite the JSDoc to the real contract.

### C5 — `packages/framework/src/observer/dispatch.ts:35` (dup: `comment-analyzer-7`)
The catch/rethrow-under-`OBSERVER_STRICT` block comment sits above
`logObserverFailureWithoutThrowing`, a helper that only logs and deliberately never throws.
It describes `dispatchEvent`.

**Fix:** move the comment onto `dispatchEvent`; give the logging helper its own accurate line.

### C6 — `packages/host/src/hitl/adapters/bot/messages-handler.ts:247`
The transient-status gate cites `service.ts recordDecision` as the function that notifies from
inside the slice and folds `suspended` back into the store. Both actually happen in
`processRun` (`makeOnHumanReview` at the `executor.run` call; `setStatus suspended` in the
outcome match). `recordDecision` neither notifies nor sets suspended.

**Fix:** correct the citation to `processRun`.

### C7 — `packages/host/src/domain/config.ts:807`
`credentialEndpointIssue` (rejects non-HTTPS **and** embedded URL credentials) is applied only
to `MSGRAPH_BASE_URL`/`MSGRAPH_TOKEN_URL`. Five other secret-bearing endpoints —
`CDRATOR_AUTH_URL`, `CDRATOR_URL`, `TEAMS_WEBHOOK_URL`, `BOT_TOKEN_URL`, `KEYCLOAK_TOKEN_URL` —
use a hand-rolled `startsWith("https://")` that accepts `https://user:secret@host`. All five are
already `z.string().url()`, so the parse succeeds and the credentials are shipped to (and logged
with) the token/webhook endpoints.

**Fix:** route all seven fields through `credentialEndpointIssue` via one table, preserving each
field's existing bespoke not-https message and adding the embedded-credentials check uniformly.

## Refuted critical findings

**None.** The panel refuted nothing; the full verdict record is in
`<run>/result.json` → `panel`, and every verdict is reproduced in the final report.

## Advisory dispositions

### Accepted (29)

| ID | Fix |
|---|---|
| `code-reviewer-1` | Add an integration regression test driving an `onCommitted`/`onDecisionConsumed` throw through `runDagStateful` to prove the run fails closed end-to-end. |
| `silent-failure-hunter-4` | Replace `String(e)` with hostile-safe `safeErrorMessage` in `redis-checkpointer.ts` / `redis-freshness-index.ts` catch blocks (ADR-0080 boundary, currently closed only for the file backend). |
| `silent-failure-hunter-5` | `decodeMember` must report the actual failure (brand rejection vs JSON parse), not always "JSON parse failed". |
| `silent-failure-hunter-6` | `bun-spawn-adapter.isAlive` logs unexpected `process.kill` error codes instead of silently reading as dead. |
| `silent-failure-hunter-7` | `run-queue` release checks the `compareAndDelete` boolean and logs a lost-ownership release. |
| `silent-failure-hunter-8` | `messages-handler` logs a dropped `conversationUpdate` with an unusable reference. |
| `pr-test-analyzer-1` | `mapFsError` gains hostile-thrown-value tests (non-object, throwing `.code` getter, revoked proxy). |
| `type-design-analyzer-1` | Brand `LockOwnershipToken` so `releaseFileLock(lockPath, token)` cannot be called with swapped strings. |
| `type-design-analyzer-2` | `parseFileFactoryClock` validates the clock's *return* is a finite number, per the feature's FR-040 total-guard convention. |
| `type-design-analyzer-3` | Correct `fileJobBrand`'s doc comment — it is a compile-time nominal exclusion, not a runtime proof. |
| `type-design-analyzer-4` | `parseCompositeNodeKey` returns `NodeId` for `nodeId`/`namespace`, carrying the `ID_PATTERN` proof forward. |
| `comment-analyzer-4` | Document why `node-span` classifies a thrown `fn()` retriable while `run-node` classifies non-retriable. |
| `comment-analyzer-5` | Drop the stale "Slow path" label in `freshness-check.findConflict` (both branches are O(1)). |
| `code-simplifier-2` | `forceReset` calls `initCircuit`. |
| `code-simplifier-3` | Merge the `policy-refusal`/`downstream-denied` arms, matching `classifyRootKind`. |
| `code-simplifier-6` | Name the `global-at-capacity` test once. |
| `code-simplifier-9` | Drop `healthResponse`'s never-passed `timestamp` parameter. |
| `code-simplifier-11` | Delete the `RedisConnectivityPort` compat re-export (CONTEXT.md forbids pre-release compat shims); import from `../ports.js`. |
| `code-simplifier-12` | Delete the zero-consumer `Clock` compat re-export. |
| `code-simplifier-17` | `udsPathOf` collapses five arms via `P.union`, matching the file's own `crash`. |
| `code-simplifier-18` | Remove the duplicate corrupt-record prune log on the throw path. |
| `code-simplifier-19` | Share the undefined-stripping env-copy loop between the two spawn adapters. |
| `code-simplifier-20` | Share one `base64url` encoder. |
| `code-simplifier-25` | Replace `host.ts`'s seven inline `import("...").X` type expressions with static type imports. |
| `code-simplifier-32` | Delete `reroute.ts`'s unreachable disjunct. |
| `code-simplifier-35` | Dedup `state-machine/runner.ts`'s `eventType` extraction. |
| `code-simplifier-36` | Folded into C1. |
| `code-simplifier-37` | Delete the dead `NodeContextForDag` re-export (keep the live `invocationOriginForIdentity` one). |
| `code-simplifier-40` | Move the shared OAuth `error_description`/`error` extraction into `oauth-token-body.ts`. |
| `code-simplifier-44` | One path-segment percent-encoder in `adapter-ms-graph`. |
| `code-simplifier-47` | Dedup `fake-client.ts`'s local `crash` closure. |

### Deferred (24) — with reasons

- `architecture-tech-lead-1` (BotActivitySchema) — sound under Parse-Don't-Validate, but the
  current readers are **total and type-safe** (no `any`, no unsafe casts), so this is a locality
  improvement, not a defect. Redesigning the Teams entry-point parse is feature-sized work that
  wants its own test pass.
- `code-simplifier-4` (`checkHealth` unused) — the doc comment frames it as deliberate future
  work. Wire-it-in vs delete-it is a product decision, not a review fix.
- `code-simplifier-24` (`main.ts`/`worker-main.ts` wiring) — the two entrypoints deliberately
  wire different capability sets; merging needs a design call on the shared surface.
- `code-simplifier-26` (`createHost` 750-line split) — deepen-scale structural refactor.
- `code-simplifier-27` (boot-abort vs `shutdown()`) — the reviewer itself says *recommend deepen*:
  the two paths have **already diverged** (logger-failure guarding, `closeFailures`), so merging
  requires deciding which behavior is correct, not a mechanical merge.
- `code-simplifier-31` (`checkpointer.load` extraction) — a pure extraction, but inside the most
  safety-critical durable-read path; wants its own round with a dedicated test pass.
- `code-simplifier-43` (JWKS cache boilerplate) — the reviewer's own confidence is low and the two
  verifiers are documented as *deliberately* mirroring each other.
- `code-simplifier-5, 7, 8, 13, 14, 15, 16, 21, 22, 23, 28, 30, 33, 34, 38, 39, 41, 42, 45, 46` —
  mechanical dedups whose blast radius spans multiple modules apiece. Batched to a follow-up
  distill round so this commit's diff stays reviewable; none is a correctness defect.

### Re-dispositioned during implementation (3)

Three advisories were accepted in planning and then **refuted by the code itself**
while being applied. Each is recorded here with the evidence that overturned it.

- **`silent-failure-hunter-9` → dismissed.** The advisory argued that
  `getToken`/`invalidateToken` discard the caught exception although "the discarded
  value is an internal `TokenProvider` contract violation, not sensitive response
  data". The codebase disagrees, and pins the disagreement: `client.test.ts`'s
  *"normalizes a rejecting initial token lookup into a secret-free Result"* feeds a
  provider that throws `new Error("provider leaked s3cret")` and asserts the returned
  message does **not** contain it. A token provider mints credentials, so what it
  throws may carry one. Rendering the cause failed that test — correctly. The discard
  stays; the fix kept is the safe half (the failing operation is now named, which is
  a discriminator that cannot leak) plus a comment recording why the cause must not
  be echoed, so the next reviewer does not re-raise it.
- **`code-simplifier-29` → dismissed (does not reproduce).** No hand-rolled
  two-key exact-match check exists in `checkpointer-codec.ts`. The only exact-shape
  key gate there (the node-envelope check) is deliberately *richer* than
  `hasExactKeys`: it distinguishes an unknown field from a missing one and names the
  offending key in the corrupt-entry diagnostic, which a boolean predicate cannot.
  Replacing it would lose diagnostics, not remove duplication.
- **`code-simplifier-37` → accepted, and taken further.** The advisory said to delete
  the dead `NodeContextForDag` re-export but keep the `invocationOriginForIdentity`
  one because it "does have a live consumer". That consumer is a single test. Since
  `CONTEXT.md` forbids pre-release compat shims, both re-exports were removed and the
  test repointed at `domain/run-context.js`, where the contract actually lives.

### Dismissed (5 duplicates + 1 better-as-is)

- `type-design-analyzer-5, 6, 7, 8` and `comment-analyzer-8` — byte-duplicates of
  `type-design-analyzer-1..4` / `comment-analyzer-5`, carrying `file: null` because they were
  parsed from the Machine Summary rather than the `findings` block. Fixing the anchored twin
  resolves them.
- `code-simplifier-10` (`dagIdFor`/`runIdFor`) — the reviewer states merging trades away a
  cast-free type guard for a four-line saving. The current form is better; no change.

Additionally, `type-design-analyzer-4` was accepted but applied **partially, by design**:
`parseCompositeNodeKey` now returns a branded `NodeId` for `nodeId`, carrying the
`ID_PATTERN` proof forward to the codec's nodeKey/entry agreement check. `namespace`
deliberately stays a validated `string`: it passes the same pattern rule but names a
keyspace, not a node, and branding it `NodeId` would make a namespace silently
assignable wherever a node id is expected — trading one type hole for another.

## Validation commands

```bash
bun run typecheck   # all 12 workspace packages
bun run test        # full suite
```

Baseline before edits: typecheck clean; `0 fail` in every package
(framework 3069 pass, host 2206+10 pass, customer-summary 231 pass, others green).

After remediation: typecheck clean; `0 fail` in every package. Net test growth
+6 — framework 3069 → **3071** (the two `onDecisionConsumed` end-to-end cases),
adapter-fs 21 → **25** (the four `mapFsError` hostile-value cases); host holds at
2206 + 10 (one existing prune-log assertion was updated to the consolidated
single-line shape, not removed).

## Remediation run

Support paths registered at remediation start (outside the frozen review scope):

- `.claude/plans/2026-08-23-pr-remediation-round-36.md`
