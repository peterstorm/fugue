# File/+Port Deepening Round — adjudication and implementation plan

- **Branch:** `feat/f6-file-durable-runtime`
- **Date:** 2026-08-18
- **Baseline:** HEAD `53300fb` (round-16 remediation landed; CI-canonical gate green — 2922 pass / 0 fail across the 9-package loop).
- **Candidate set:** the 8 advisories deferred to "the scheduled `file/` + port deepening round"
  across remediation rounds 10–16 (7 unique — round-16 `code-simplifier-3` duplicates
  `architecture-tech-lead-1`). This is the round that was supposed to adjudicate them once
  ("the whole `RunId`/`NodeId`/`DagId` ownership question is adjudicated once" — round-15 deferral).
- **Method:** deepen skill, session mode, candidates pre-selected. Each candidate walked:
  explore → design decision (recorded below with evidence) → test-gated implementation
  (baseline green, one move at a time, covering tests after each).

## Decisions (the adjudication)

### D1 — Checkpointer port re-typed to branded identifiers (arch-2 + arch-3)

`saveNode(runId: RunId, nodeId: string, …)` → `saveNode(runId: RunId, nodeId: NodeId, …)`;
`RunMeta.dagId: string` → `RunMeta.dagId: DagId`. `load`/`setMeta` runId parameters already
branded — unchanged.

**Evidence:**
1. The engine's sibling port is ALREADY branded: `CheckpointWriter.write(runId: RunId,
   nodeId: NodeId, value)` (`types/node.ts:98`, main-barrel export). The Checkpointer's bare
   `nodeId`/`dagId` are the outliers in the checkpoint domain, not the standard.
2. `DagId` is a STRICTER domain (`DAG_ID_REGEX`, no `:`) than `ID_PATTERN` — the colon ban
   exists to prevent Redis key-namespace escape (`types/ids.ts`). Branding
   `RunMeta.dagId: DagId` eliminates that consumer-error class at compile time. A real
   safety gain, not cosmetics.
3. Migration is safe at runtime: every valid `DagDef.id` already passes `dagId(input.id)`
   (`executor/validate-dag.ts:408`) and every node id passes `tryNodeId` (same module) at
   definition time — branding at the checkpoint consumer sites re-validates values that are
   already in-domain (no new runtime rejections possible for honest inputs).
4. In-repo production migration: exactly 2 sites (`apps/customer-summary/src/bootstrap.ts`
   saveNode wrapper — which also becomes honest against the already-branded
   `CheckpointWriter` port it implements; `apps/customer-summary/src/server.ts` setMeta).
5. ADR-0080's hostile-runtime premise is preserved: adapters KEEP their runtime
   re-validation (brand bypass is possible; the file backend re-validates for path safety,
   NFR-010). The brand changes the compile-time contract, not the runtime gates. Zero
   behavior change for any runtime input.
6. Timing: pre-1.0, pre-merge, sole downstream owner — the cheapest moment for a breaking
   type-surface change. FR-042 froze the surface for the F6 feature's duration
   ("main-barrel consumers and the in-memory/Redis backends unchanged"); F6 is complete.

**Consequences / follow-up (tracked, not done this round):**
- `DagDef.id` stays `string` (typed at the validated-value site via `dagId(input.id)` but
  declared `string` in `types/dag.ts`). Re-typing `DagDef.id: DagId` is the same ownership
  answer with a much larger surface (every DAG definition, host registration, CLI templates,
  zod schemas) — tracked as the explicit next step, deliberately NOT folded into this round's
  blast radius. Consumers bridge with `dagId(dag.id)` (a no-op re-validation for honest DAGs).
- The engine's `CheckpointWriter` is already branded — no change.
- Adapters' acceptance domains are UNCHANGED (type-level move only; the per-backend hostile
  totality suites stay byte-identical green).

### D2 — One truthful-branding construction path (arch-1 + cs-3)

New canonical builder in `types/error-factories.ts`:
`buildCheckpointWriteFailed(runIdRaw: unknown, nodeIdRaw: unknown | undefined, message: string):
FrameworkError` — carries the meta-record case (`nodeIdRaw === undefined` →
`META_RECORD_NODE_ID`, no `invalidNodeId` field) and the truthful-branding rule
(valid → branded; invalid → grammar-valid placeholder + additive raw bytes via `stringOf`).

- `META_RECORD_NODE_ID` definition moves to `types/error-factories.ts` (the builder's home;
  it is a `NodeId` brand, same layer as `types/ids.ts`); the codec RE-EXPORTS it so the
  `file.ts` barrel import path and every test import stay unchanged.
- `frameworkError.checkpointWriteFailed` (public, frozen signature) keeps its signature and
  delegates to the builder.
- The codec's `writeFailed` becomes a re-export alias of the builder (internal surface —
  it is not a public barrel export).
- The `setMeta` kind-mapping table (port docblock) STAYS normative and unchanged: the
  per-backend kind divergence (file → `checkpoint-write-failed`; in-memory →
  `cache-error(checkpoint:setMeta)`; Redis → `cache-error(setMeta)`) is a DELIBERATE,
  ADR-0080-mandated surface, pinned per backend — it is documentation of a decision, not a
  mirror to delete. What is deleted is the construction mirror (the identical
  brand/placeholder/additive-diagnostics policy re-encoded in the codec).

Identity check (done): the builder's validity rule (`typeof === "string" && ID_PATTERN`) is
byte-identical to both today's encodings (public factory, codec `isBoundaryId` — which is
itself `typeof === "string" && ID_PATTERN.test`). Every construction site's output for every
input is unchanged; the per-backend hostile corpora are the gate.

### D3 — Composite-key error channels kept, contract made explicit (arch-4)

NO restructure. The three channels each perform their ADR-0080-sanctioned role:
- `parseCompositeNodeKey → … | null` — read-side CLASSIFIER over untrusted stored bytes;
  the corrupt-entry path already composes its own per-site corrupt verdict message (a
  Result would force every read site to unwrap a message it does not use).
- `compositeNodeKey` throws — write-side constructor invariant over validated inputs;
  ADR-0080 explicitly sanctions "low-level pure implementation functions may use local
  exceptions as control flow, but every exported throwing boundary catches and converts
  before they can escape". The single production call site (`file/checkpointer.ts` saveNode)
  wraps to typed `checkpoint-write-failed` — and after D1's boundary parse, the only
  reachable throw there is `assertNoNamespaceAlone` (the codec's own ambiguity rule, which
  `parseSaveNodeBoundary` intentionally does not pre-reject because the rule belongs to the
  codec as the single definition of the composite key).
- Port-level `Result` — the Checkpointer's channel, per the port contract.

The move: the module header gains the error-channel contract paragraph (why throw/null/Result
are each the correct channel, and where the conversion happens), so the next reviewer does not
re-flag an ADR-sanctioned shape. Finding resolved by adjudication + documentation, not churn.

### D4 — Test-owned store seam replaces `__testRawMetas` (arch-5)

`InMemoryCheckpointer` gains a constructor-adopted test store; `__testRawMetas()` is DELETED.

- `export interface InMemoryStoredMeta { readonly meta: RunMeta; readonly createdAt: Date }`
  (the storage shape becomes the public test-surface type; internal `StoredMeta` renamed to it).
- `constructor(opts?: { readonly now?: () => number; readonly testStore?:
  Map<string, InMemoryStoredMeta> })` — the adapter reads/writes through the adopted map when
  one is supplied. Production construction (no `testStore`) is unchanged.
- Structural guarantee replaces the "MUST NOT" comment: the class no longer exposes its
  store through any method. The map is either private-internal or caller-owned from
  construction — aliasing the adapter's internals is unrepresentable.
- The 7 call sites rewire to the adopted store. The shared-suite bypasses become DIRECT
  stored-value writes (the Redis-raw-set analog): `setMissingVersion`/`setExpired` write
  `{ meta, createdAt }` into the test-owned map — no more setMeta-then-rewrite dance, and the
  in-memory leg now mirrors the Redis leg's bypass shape (contract symmetry improves).
- The hostile-totality tests construct `{ testStore }` per test and seed hostile values
  directly (same values, same pins).

### D5 — The serializer-grammar depth ceiling moves to the grammar module; cross-inventory parity pinned (cs-4/simp-4)

- `MAX_SAFE_RECORD_DEPTH` (512) moves from `file/event-record.ts` to
  `state-machine/serialize.ts` — the module that owns the canonical grammar
  (`POLLUTION_KEYS`, `RESERVED_TAG_KEYS`, `validateSerializedValueGrammar`) and already
  receives `maxDepth` as its API parameter. The depth ceiling is a grammar knob; it lives
  with the grammar. `event-record.ts` re-exports it (three test files import it from there);
  `checkpointer-codec.ts` and `resume-proof.ts` import from the canonical source. This also
  removes the codec → event-record dependency for the ceiling (the codec now imports all its
  grammar material from serialize.ts).
- The two write-side losslessness pre-scans (`assertLosslessEventUnchecked`,
  `materializeCanonicalOutput`) are NOT merged: their message corpora are deliberately
  per-module and test-pinned, and each path is already double-checked against its own
  read-side strict parser (serializeNode round-trips through `parseNodeFile`; the event
  codec round-trips through `deserializeValue` + the grammar validator). A shared
  structured-violation seam would move the complexity to a third module while coupling the
  two hostile corpora (a pinned-message change in one module would touch the seam) — the
  deletion test cuts both ways: deleting the seam reappears the two correct, pinned walkers.
- Instead the INVENTORY AGREEMENT becomes a pinned invariant: a new
  `losslessness-parity` test runs ONE shared hostile corpus (bigint, symbol, function,
  non-finite, cycle, over-depth, accessor, sparse array, pollution key, reserved tag,
  subclassed Date, Map-with-own-props, invalid Date, …) through BOTH walkers and asserts
  both reject, plus a shared safe corpus (primitives, plain objects, arrays, Map/Set/Date,
  `-0`) both accept. Drift between the two inventories now fails the build instead of being
  reviewer-verified.

### D6 — The clock-guard two-domain split: one shared predicate + a pinned domain map (simp-5)

The five file/checkpoint clock guards are NOT unified into a shared guard function: the
shared logic is two lines and the five sites differ on three dimensions (domain, channel,
pinned message shape) — the resulting interface would be nearly as complex as the
implementation (a shallow module by construction). The reviewer's own trigger ("no action
until one site's semantics must change") has not fired, and the investigation shows the
differences are DOMAIN-PRECISE, not accidental:

| Domain | Sites | Check | Why |
|---|---|---|---|
| raw-ms | journal `appendEvent`, freshness `recordWrite`/`findConflict` | finiteness-only | the value is STORED as a raw `number` (`recordedAtMs`, `writtenAtMs`) and consumed by arithmetic — no `Date` conversion ever happens, so representability is out of domain |
| ms→Date | file checkpointer `readClock`, codec `serializeMeta`, in-memory `readClock` | finite + representable | the value is converted (`new Date(ms)` → `createdAt.toISOString()`, TTL comparison) — an unrepresentable finite timestamp (e.g. `1e300`) must fail at the guard, not later at `toISOString` |

Moves:
1. One predicate for the ms→Date domain: `isRepresentableTimestampMs(ms: unknown):
   boolean` in a new `types/clock.ts` (`typeof === "number" && Number.isFinite(ms) &&
   !Number.isNaN(new Date(ms).getTime())` — the two conjuncts all three sites encode, in
   their three current spellings, collapse to one encoding). The three sites consume it.
   (The finiteness conjunct is kept explicit inside the predicate so a hostile
   brand-bypassed non-number cannot reach `new Date(string)` coercion — matching today's
   site behavior exactly.)
2. The two-domain split becomes a pinned invariant: a clock-parity test runs a hostile
   clock corpus (throwing, `NaN`, `±Infinity`, `±1e300`, valid) through all five sites and
   pins the domain map — `±1e300` is the discriminator row (raw-ms sites accept it;
   ms→Date sites reject it), so a future semantic drift in either direction fails the build.

### D7 — (none)

No other deferred item remains. cs-3 = arch-1 (D2). All 8 advisories are now either
implemented (D1–D2, D4–D6) or resolved by documented adjudication (D3) — none is deferred
again.

## Implementation steps (each test-gated on the framework suite; full CI gate at the end)

1. **D2** — builder + placeholder move in `types/error-factories.ts`; codec alias + re-export;
   factory delegation; port/codec doc pointers. Gate: `error-factories.test.ts` +
   `file-checkpointer-codec.test.ts` + both checkpointer suites.
2. **D1** — port re-typing (`saveNode` nodeId, `RunMeta.dagId`); port docblock ownership
   note; in-repo migration (customer-summary bootstrap + server; host if touched; test
   fixtures across the framework suite + customer-summary + host suites). Gate: workspace
   typecheck + all three package suites.
3. **D3** — composite-node-key header contract paragraph. No gate needed (comments).
4. **D4** — `InMemoryStoredMeta` + `testStore` adoption + `__testRawMetas` deletion + 7-site
   rewire (suite bypasses + hostile-totality tests). Gate: framework suite (the in-memory
   leg of `checkpointerSuite` + hostile totality).
5. **D5** — `MAX_SAFE_RECORD_DEPTH` → serialize.ts (canonical importers + event-record
   re-export); new `losslessness-parity` test. Gate: framework suite.
6. **D6** — `types/clock.ts` predicate + three site adoptions; new clock-parity test. Gate:
   framework suite (the per-site clock pins must stay byte-green).
7. **CONTEXT.md** — the crystallized decisions (identifier ownership on the checkpoint
   ports; the two clock domains; the composite-channel contract) per the deepen skill's
   "batch no CONTEXT.md updates" rule.
8. **Full CI-canonical gate:** workspace typecheck (12/12), 9-package `tsc + test` loop,
   root `bun test scripts/`, `check:docs`, customer-summary suite.
9. Commit + push (no force).

## Stop rules

- Any pinned message/corpus assertion that changes → stop, re-examine the move (behavior
  must be byte-identical for D2/D4/D5/D6; D1 is type-level only).
- Any consumer site that cannot brand honestly (no in-domain value available) → stop;
  that site's shape may indicate the D1 boundary is wrong.

## Results (2026-08-18)

**All six decisions implemented; none deferred again.** 23 files changed (+436/−297) plus
three new files (this plan, `losslessness-parity.test.ts`, `clock-parity.test.ts`).

### Per-decision outcomes

- **D1 (arch-2 + arch-3)** — Port re-typed: `saveNode(runId: RunId, nodeId: NodeId, …)`,
  `RunMeta.dagId: DagId`. All three adapters (in-memory, Redis, file) re-typed; read-side
  deserialization boundaries brand (`__brandDagIdUnchecked`/`__brandNodeIdUnchecked` or the
  validating `__brandNodeId` after the boundary proof). In-repo migration: exactly the two
  predicted production sites (customer-summary `bootstrap.ts` checkpointWriter — now typed
  honestly against the already-branded `CheckpointWriter` port it implements — and
  `server.ts` setMeta). Test migration: 9 framework test files + customer-summary
  `server.test.ts` (hostile fixtures keep their bypass values via `as NodeId`/`as DagId`
  casts — the brand-bypass premise of those tests is the point). **Stop-rule check passed:**
  every consumer site branded with an in-domain value; zero cast sites in production code.
- **D2 (arch-1 + cs-3)** — `buildCheckpointWriteFailed` + `META_RECORD_NODE_ID` canonical in
  `types/error-factories.ts`; public `frameworkError.checkpointWriteFailed` delegates; codec
  `writeFailed` + `META_RECORD_NODE_ID` are re-exports (all import paths unchanged). Identity
  check held: per-backend hostile corpora byte-identical green.
- **D3 (arch-4)** — Composite-key module header gains the error-channel contract paragraph
  (null = read-side classifier; throw = write-side constructor invariant with the ADR-0080
  citation and the single-production-boundary conversion; Result = the port's own channel).
  No restructure, no behavior change.
- **D4 (arch-5)** — `__testRawMetas` DELETED; `InMemoryStoredMeta` exported; constructor
  adopts `testStore`. Seven call sites rewired (shared-suite bypasses are now DIRECT
  stored-value writes — the in-memory leg mirrors the Redis leg's bypass shape; the
  setMeta-then-rewrite dance is gone). Structural guarantee replaces the comment: the class
  no longer exposes its store through any method. One mid-run flake (1 fail) was
  run-interruption noise — the clean full suite run is 2892/0.
- **D5 (simp-4)** — `MAX_SAFE_RECORD_DEPTH` moved to `state-machine/serialize.ts` (the
  grammar module, next to `POLLUTION_KEYS`/`RESERVED_TAG_KEYS` — the established
  shared-grammar-const pattern); `event-record.ts` re-exports for the two test import
  paths; `checkpointer-codec.ts` and `resume-proof.ts` import canonically. NEW
  `losslessness-parity.test.ts`: 51 tests — a 26-row hostile corpus (BigInt, symbol,
  function, non-finites, cycle, over-ceiling ×2, accessor, sparse array, array/map/date own
  props, non-enumerable, own `__proto__` key, `constructor` key, forged tags ×2,
  subclassed/invalid/own-prop Dates, boxed primitive, WeakSet, RegExp, Promise, typed
  array) and a 24-row safe corpus (primitives incl. `-0` and `MAX_SAFE_INTEGER`, plain
  containers, Map/Set/Date, empty variants, near-ceiling chains built relative to the
  constant) — both boundaries must agree on every row, plus the ceiling pin. Depth rows
  track the knob (`MAX_SAFE_RECORD_DEPTH ± k`), not hardcoded 515/505.
- **D6 (simp-5)** — `isRepresentableTimestampMs` in `types/clock.ts` (public, one-line,
  barrel-exported); adopted by the three ms→Date sites (file `readClock`, in-memory
  `readClock`, codec `serializeMeta`/`serializeNode` — the codec adoption also closes the
  theoretical string-coercion hole, behavior-identical on all reachable inputs). Raw-ms
  sites untouched by design. NEW `clock-parity.test.ts`: 6 tests pinning the domain map —
  the 7-row clock corpus (throwing, NaN, ±Inf, ±1e300, valid) run through file checkpointer
  `setMeta`, in-memory `setMeta`, the codec serializers, journal `appendEvent`, and
  freshness `findConflict` (sinceMs parameter AND internal clock), with `±1e300` as the
  discriminator row (raw-ms accepts, ms→Date rejects), plus the predicate's own verdict
  table (10 rows). Per-site pinned messages stayed byte-green.
- **CONTEXT.md** — three crystallizations: *Checkpoint identifier ownership* (Type Safety
  table), the *Deepening-round decisions* block (file section, D1–D6 with the two parity
  test names), and Key Invariant #9 (*Clock guards follow the storage domain*).

### Validation

See the gate log at the bottom of this section — the CI-canonical gate (workspace
12/12 typecheck, 9-package `tsc + test` loop, root scripts, `check:docs`,
customer-summary) ran after all six moves; per-package results recorded below.

- [x] workspace typecheck 12/12 (TSC_EXIT=0)
- [x] 9-package loop — framework 2949/0 (baseline 2892 + the 57 new parity pins),
      document-source 18/0, xlsx 20/0, adapter-fs 21/0, adapter-ms-graph 61/0,
      adapter-pg 33/0, adapter-oracle 60/0, http-auth 66/0, host 2041+10/0
- [x] root `bun test scripts/` — 7/0
- [x] `check:docs` — 19 shipped doc files, all links resolve
- [x] customer-summary — 203/0
- [x] commit `02f4ac4` + push `53300fb..02f4ac4` (no force)
