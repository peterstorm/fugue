# PR Remediation Plan — Round 10

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-171928-f6-file-durable-runtime`
- **Authoritative result:** `result.json` (digest `e65024d1420efce32464f5c0a5ef4c1222a2744a9a52eeff91e89e374f469ac6`, 22,728 bytes) — published atomically by the registered Refutation Panel tally (3 lenses: reproduction / intent / blast-radius, threshold 2).
- **Exact reviewed scope:** 72 files (committed branch diff vs `main`; see `result.json.scope`). Frozen at review start; unchanged during remediation.
- **Run history note:** one harness recovery occurred during the run: `pr-test-analyzer` attempt 1 was terminally capture-rejected (`no-final-payload`), and the run dead-ended because the standalone façade re-issued the dead attempt-1 request instead of advancing to the frozen attempt-2 authority. The engine gap was fixed in the loom plugin (`engine/src/handlers/helpers/programs/standalone.ts`, Phase A now consults `durableCaptureRejection`, mirroring wave-gate), regression-pinned, and the full engine suite (175 files / 4558 tests) passes. The attempt-2 retry then captured cleanly and the run completed normally. No run-directory state was hand-edited.

## Surviving criticals (mandatory — every one is fixed)

### C1 — `comment-analyzer-1` (panel-upheld 3/3: reproduction, intent, blast-radius)
`packages/framework/src/scripts/check-imports.ts:9` — the header bullet
`- Only queue-bullmq/** may import bullmq and ioredis` is false. Verified facts:
- `checkpoint/redis-checkpointer.ts:1` value-imports `ioredis`;
- `cache/redis-cache.ts:3` and `checkpoint/redis-freshness-index.ts:21` type-import it (the checker's own `IMPORT_RE` counts `import type`);
- the ioredis anti-leak RULES entry (line ~196) is scoped to the barrels/cache/checkpoint with `scopeExcludes` naming exactly those three files, and its own comment says "The Redis adapter files themselves are exempt";
- no rule forbids `ioredis`/`bullmq` repo-wide (e.g. `shared/**`, `types/**` are unconstrained) — so the universal "Only queue-bullmq/**" claim misdescribes both the import graph and the enforced ruleset.

**Fix:** rewrite the `Enforces:` list so each bullet names the rule it documents (scoping, exempt files, and the three-adapter exemptions for ioredis) and add the missing `scheduler/**` bullet (advisory A9, same edit). No rule behavior changes — header documentation only.

## Advisory dispositions (19 total — 6 accepted, 12 deferred, 1 dismissed)

### Accepted (fixed in this round)

- **A0 `silent-failure-hunter-1`** — `llm/fake-client.ts`: hostile `req`/`ctx` field reads outside the guarded seams reject raw, contradicting the file's FR-040 "never a raw rejection" claim: `req.maxIterations`, `req.signal?.aborted` / `ctx.signal?.aborted` (per-turn, outside the per-turn try), `req.toolChoice`, and `req.nodeId`/`req.model` reads — including the `crash()` builders invoked from inside catch blocks (a throwing `nodeId` getter in the catch re-throws raw). **Fix:** snapshot every `req`/`ctx` field the method touches under the existing typed-crash guard (the pattern rounds 8–9 established for turn-field reads); make `crash()` read a pre-snapshotted `nodeId` (total read, placeholder on throw) instead of re-reading the hostile `req` at build time; pin hostile getters at each seam in `llm-fake-client.test.ts` (typed `node-crash`, never raw).
- **A1 `pr-test-analyzer-1`** — `types/errors.ts:421` `usageOfError` has no in-scope test pin; its FR-W0-001 contract (only `node-crash`/`transient`/`aborted` carry `usage`; every other kind reads `undefined`) is covered only indirectly by out-of-scope `tool-use-loop.test.ts`, which never verifies the `aborted` usage arm. **Fix:** table pin in `__tests__/errors.test.ts` mirroring the `retriabilityOf` block — all 25 kinds asserting exact `usage` passthrough/`undefined`.
- **A6 `type-design-analyzer-5`** — `FakeLlmClient.sendStructured` returns `output: raw as O` without parsing against `req.schema`, while the `withTools` final-turn path runs `req.schema.safeParse(...)` (line 332): a fixture violating the declared schema silently passes the `O` cast. **Fix:** validate `raw` against `req.schema` in the guarded FR-040 region; schema failure returns a typed `node-crash` naming the schema failure; pin a violating fixture.
- **A7 `type-design-analyzer-6`** — `file/event-record.ts:1039` catch-all renders `source` through `safeDiagnosticRender`, which truncates strings over 60 chars, while every normal rejection branch interpolates the full path — the defense-in-depth branch loses the full offending file name for long (but legal) run directories. **Fix:** a total escape-only (JSON-stringify, no truncation) string renderer for this branch in `types/safe-error.ts`; escaping alone neutralizes structural injection, truncation only sacrifices diagnosability; pin a >60-char path round-trip.
- **A9 `comment-analyzer-2`** — the `Enforces:` list omits the `scheduler/**` broker ban (rule at line 100) even though the paired SC-006 gate test names `scheduler/**`. **Fix:** folded into the C1 header rewrite (same 10-line edit).
- **A10 `comment-analyzer-3`** — `file/event-log.ts:14-17` parenthetical attributes 7-digit-prefix rejection to "the codec's own ceiling gate in `parseFileEventRecord`", but a 7-digit name whose content sequence is within the ceiling (the only shape a foreign file needs) is rejected by check 1's `parseEventFileName` shape gate (layout.ts:253-255). **Fix:** one-line doc correction naming the shape gate.

### Deferred (concrete reason each)

- **A2 `type-design-analyzer-1`** — `checkpoint-write-failed` types `runId`/`nodeId` as branded IDs while the codecs deliberately place grammar-valid placeholders for invalid raw values; the type cannot express "placeholder unless `invalid*` present". Round 9 deliberately chose the documented inspect-invalid-first JSDoc contract over a type restructure; a discriminated-union redesign of a published error variant is an interface redesign → deepen pass.
- **A3 `type-design-analyzer-2`** — `FileCheckpointCommit` frozen only at top level; nested `state`/`context` mutable. Reviewer concedes no reachable divergence (journal persists immutable `json` bytes; job installs self-minted commits; `data` getter deep-freezes a fresh clone per read). Deep-freezing user payload data changes payload semantics and costs → deepen pass.
- **A4 `type-design-analyzer-3`** — `RunState.nodes` `readonly` in the port, runtime-mutable map from the file backend. Every parse result is fresh per read, so no shared-state divergence is reachable; deep-freezing domain node state risks breaking legitimate mutation patterns → deepen pass (runtime backstop, not a live bug).
- **A5 `type-design-analyzer-4`** — truthful-branding policy for `checkpoint-write-failed` duplicated between the in-memory `checkpointWriteFailed` and the file codec `writeFailed` ("any change must land on both sides"). Unification requires a shared lower module (the port layer cannot import `file/`) → deepen (same cluster as A15/A18).
- **A8 `type-design-analyzer-7`** — stored nodeKeys are unbranded strings across the port although `compositeNodeKey`/`parseCompositeNodeKey` is a strict codec. A branded `StoredNodeKey` changes the public `Checkpointer` port type and every backend → deliberate API pass.
- **A11 `architecture-tech-lead-1`** — freshness-index's pure AD-5 decision core is module-private (testable only through the real-fs factory) unlike the sibling checkpointer's split codec core. Module restructuring → deepen.
- **A12 `architecture-tech-lead-2`** — the journal append decision (keyed dedup, sequence, six-digit ceiling) is inline in `appendEvent`'s lock closure — "the last durable write surface without a pure, directly testable decision core". Module restructuring → deepen.
- **A13 `architecture-tech-lead-3`** — FR-009 write-boundary losslessness enforced by two distinct mechanisms with the shared gate living in a module named for one consumer. Structural consolidation → deepen.
- **A14 `architecture-tech-lead-4`** — `foldStep` discriminates recorded envelopes from raw events by structural shape; a raw event matching `{recordedAtMs, event, synthetic?}` would be silently unwrapped. Latent trap, not a live bug (the strict fail-closed reader already gates every journal input; no persisted raw event carries that shape). A proper fix touches the persisted envelope format or parse contract → deepen/format decision.
- **A15 `architecture-tech-lead-5`** — the truthful-branding policy has three encodings (in-memory port, file codec, out-of-scope Redis adapter). Cross-layer unification → deepen (same cluster as A5/A18).
- **A16 `architecture-tech-lead-6`** — the `{now?}` factory-options grammar has two encodings in the file backend (`parseFileFactoryClock` vs the stricter `parseFileCheckpointerClock`); the divergence is deliberate (strictness differs) and documented only in a module-header comment. Collapsing to one parser is a design judgment → deepen.
- **A18 `code-simplifier-2`** — the truthful-branding policy independently reimplemented in port and file codec, comments state it "must land on BOTH sides"; unification needs a shared lower module (port cannot import `file/`). The finding itself routes it: "route through deepen" → deepen.

### Dismissed (evidence-based)

- **A17 `code-simplifier-1`** — claims `replayEventsUntil`/`replayEventSlice` are exported with "zero in-package consumers and zero tests". The zero-tests half is factually false: in-package `packages/framework/src/__tests__/state-machine-replay.test.ts` carries dedicated `describe` blocks for `replayEventsUntil` (line 133) and `replayEventSlice` (line 187; 10 call sites), green at HEAD (round 8 verified the file present and green; it sits outside the frozen review scope, which is why the reviewer could not see it). The remaining half — "speculative public API, delete it" — is a semver decision on a published barrel export of `@fuguejs/framework`, not a review remediation, and the finding itself routes removal through deepen.

## Refuted-finding audit

None. The Refutation Panel upheld the single critical 3/3 (`refuted_critical_findings` is empty). No refuted findings to report; none were fixed (per invariant, refuted criticals are never fixed).

## Support paths (plan/regression paths outside the reviewed scope)

- `.claude/plans/2026-08-17-pr-remediation-round-10.md` (this plan)
- `packages/framework/src/queue-bullmq/adapter.ts`, `markers.ts`, `event-log.ts` — each carries the SAME false universal claim as the surviving critical ("Only queue-bullmq/** may import bullmq/ioredis") in its own module header; one-line doc correction each, fixed as part of C1's documentation accuracy.

All test files touched (`llm-fake-client.test.ts`, `errors.test.ts`, `file-event-record.test.ts`) are INSIDE the frozen scope (no registration needed).

## Changed files (expected)

- `packages/framework/src/scripts/check-imports.ts` — C1 + A9 (header only)
- `packages/framework/src/llm/fake-client.ts` — A0, A6
- `packages/framework/src/__tests__/llm-fake-client.test.ts` — A0, A6 pins
- `packages/framework/src/__tests__/errors.test.ts` — A1 pin
- `packages/framework/src/file/event-record.ts` — A7 (catch-all renderer use)
- `packages/framework/src/file/event-log.ts` — A10 (doc line)
- `packages/framework/src/types/safe-error.ts` — A7 (new total renderer)
- `packages/framework/src/__tests__/errors.test.ts` — A1 pin + A7 renderer pin (the safe-error test surface lives in this in-scope file)
- `packages/framework/src/__tests__/file-event-record.test.ts` — A7 pin
- `packages/framework/src/queue-bullmq/{adapter,markers,event-log}.ts` — C1 documentation parity *(support paths)*

## Validation

```bash
cd /home/peterstorm/dev/agentic/fugue
bun install --frozen-lockfile
bun --cwd packages/framework run typecheck   # tsc --noEmit (framework package)
bun --cwd packages/framework test            # full framework suite (incl. boundary-imports SC-006, llm-fake-client, errors, file-event-record, safe-error)
```

Gate acceptance: typecheck clean; full framework suite green including the SC-006 boundary gate (proves the header edit changed no rule behavior) and the new hostile-value pins.
