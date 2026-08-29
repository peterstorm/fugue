# Plan: F3 PR-D — Budget capability surface and complete spend metering

**Spec:** `docs/plans/2026-08-27-f3-budget-capability.md`
**Authoritative decisions:** `docs/adr/0082-budgets-are-denominated-in-spend-not-tokens.md`, `docs/adr/0083-spend-durability-lives-in-a-ledger-port.md`, `CONTEXT.md`
**Branch:** `feat/f3-budget-capability-surface`
**Created:** 2026-08-30

## Summary

Complete F3 before F1 by adding the seventh built-in, read-only `budget` capability; routing the main client, `judgeLlm`, and every explicitly LLM-marked boot-scoped capability-bag client through one run-scoped spend authority; and adding a file-durable ledger adapter. The selected architecture extracts the mutable meter/reservation cell from the per-client decorator, exposes settled `spent()` and admission-safe projected `remaining()` from that same authority, and implements file persistence as a high-level `@fuguejs/framework/file` store wrapped by the host's existing `SpendLedgerPort`.

Budget integrity/correctness is the primary optimization axis. Simplicity and settle-path cost are secondary: admission and capability reads remain synchronous and in-process; persistence remains one awaited append after each settled provider call.

---

## Architectural Decisions

### AD-1: One run-scoped spend authority owns all client accounting and budget reads

**Choice:** Construct exactly one `RunSpendAuthority` after ledger hydration in `createNodeContextForDag`. It owns the immutable `LlmMeter` value, reservation state, ledger persistence, budget/refusal logs, and the `BudgetCapability`. Every metered `LlmClient` delegates its call lifecycle to this authority; no decorator owns a private meter.

`llm-meter.ts` remains the functional core. It gains one pure `projectedSpend` query used by both `admit` and `remaining()`, preventing the read model and the enforcement gate from deriving concurrent reservations differently. The authority is the imperative shell holding the two mutable references and sequencing provider I/O followed by ledger I/O.

**Why:** Separate decorator-local meters would let generation and judging each spend a full ceiling and would make `budget.remaining()` ambiguous. A single authority makes the run the consistency boundary and preserves the existing overshoot contract across all clients.

**Rejected:**
- One meter per wrapped client — clients can bypass one another's ceiling and `remaining()` has no truthful aggregate.
- A `Proxy` over `NodeContext` that lazily wraps properties — hides authority creation in property access, complicates identity/debugging, and does not fit the explicit `makeNodeContext` composition seam.
- Moving the meter into the framework executor — couples provider accounting to DAG execution and makes the framework own host persistence policy.

### AD-2: LLM capability handles declare their client kind; metering is not duck-typed

**Choice:** Change `CapabilityHandle` from an interface to a distributive conditional type. A handle whose `CapabilityRegistry[K]` client extends `LlmClient` must carry `clientKind: "llm"`; a non-LLM handle cannot carry it. Extend the existing `extractClients` trust boundary with an optional LLM decorator callback. It wraps marked clients while restoring the already-trusted `name ↔ client` correlation, so no third cast point is introduced.

```ts
export type CapabilityHandle<K extends Capability = Capability> =
  K extends Capability
    ? CapabilityHandleBase<K> &
        (CapabilityRegistry[K] extends LlmClient
          ? { readonly clientKind: "llm" }
          : { readonly clientKind?: never })
    : never;

export type CapabilityClientDecorators = {
  readonly llm?: (name: Capability, client: LlmClient) => LlmClient;
};

export const extractClients = (
  handles: readonly CapabilityHandle[],
  decorators?: CapabilityClientDecorators,
): Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }>;
```

`createNodeContextForDag` meters `shared.llm` explicitly as client key `"llm"` and passes a decorator to `extractClients` for marked bag clients. A `judgeLlm` handle and a custom module-augmented LLM handle therefore share the authority and ledger with the main client.

**Why:** Runtime structural detection can accidentally wrap an unrelated client with similarly named methods and cannot prove adapter intent. Metadata is explicit at the authoring boundary, compile-required for typed LLM handles, and available after generic widening.

**Rejected:**
- Structural detection of `sendStructured` + `sendWithTools` — false-positive/false-negative trust-boundary behavior.
- Meter only the built-in names `llm` and `judgeLlm` — leaves custom capability-bag LLMs as a budget bypass.
- A second registry listing LLM capability names — creates a manually synchronized source of truth beside `CapabilityHandle`.

### AD-3: `remaining()` reports admission-safe projected headroom

**Choice:** `spent()` returns a defensive, deeply immutable snapshot of settled spend. `remaining()` returns headroom against `settled + inFlight × maxObservedCall`, the exact projection used by the next admission decision.

```ts
export type CeilingHeadroom =
  | {
      readonly kind: "available";
      readonly ceiling: Ceiling;
      readonly amount: number; // clamped to >= 0, in the ceiling's unit
    }
  | {
      readonly kind: "unpriced";
      readonly ceiling: UsdCeiling;
      readonly models: UnpricedModels;
      readonly observedAtLeast: MicroUsd;
    };

export type Remaining =
  | { readonly kind: "unbudgeted" }
  | {
      readonly kind: "budgeted";
      readonly basis: "projected";
      readonly headroom: readonly CeilingHeadroom[];
    };

export interface BudgetCapability {
  readonly spent: () => Spend;
  readonly remaining: () => Remaining;
}

export const remainingFor = (
  limits: Ceilings | undefined,
  projected: Spend,
): Remaining;
```

Reached numeric ceilings report `amount: 0`; they never expose negative capacity. An unpriced projected spend under a USD ceiling is a distinct union member rather than a fictional number. An unbudgeted run still exposes settled `spent()` while `remaining()` returns `{ kind: "unbudgeted" }`.

**Why:** Settled-only headroom can be spent simultaneously by multiple nodes even though reservations have already consumed it. The projection is conservative, actionable, and consistent with the pre-call gate. The union preserves ADR-0082's rule that unknown price is not zero.

**Rejected:**
- Settled-only remaining — overstates actionable headroom under concurrency.
- Returning both settled and projected views — expands the settled product surface without a current consumer.
- Throwing from `remaining()` for unpriced spend — a read-only node capability must remain total; unknown price is domain data.

### AD-4: The file ledger is a high-level framework file store with a thin host adapter

**Choice:** Add `createFileSpendStore` under `packages/framework/src/file/`, where it can reuse the existing private F6 `withFileLock`, `atomicWriteFile`, digest, typed file-error, and verified-directory machinery. Its methods return `Result<_, FrameworkError>`. Add `createFileSpendLedger` in the host to translate those errors to `HostError` and satisfy `SpendLedgerPort`.

The on-disk layout is one canonical snapshot and one lock domain per run:

```text
<ledgerRoot>/
  <sha256(runId)>.json
  <sha256(runId)>.lock/          transient owner while add holds the lock
  <sha256(runId)>.lock.fence/    F6 lock protocol metadata
```

Record schema:

```ts
interface FileSpendRecordV1 {
  readonly schemaVersion: 1;
  readonly runId: RunId;              // verifies digest ownership
  readonly tokens: number;
  readonly calls: number;
  readonly micros: number;            // priced total or known lower bound
  readonly unpricedModels: readonly string[];
}
```

`add` acquires the per-run lock, strictly reads the prior record (absence means `NO_SPEND`), folds with `addSpend`, then atomically replaces the complete snapshot. `read` is lock-free because rename exposes either the prior complete record or the next complete record. It strictly verifies schema, finite non-negative integer figures, model names, embedded run ID, and filename digest. Corruption is an error, never zero. Run IDs are digest-addressed and the root/record path uses F6's non-symlink verified-directory policy with identity rechecks around writes.

The host factory is injectable:

```ts
export const createFileSpendLedger = (
  root: string,
): Result<SpendLedgerPort, HostError>;
```

The stock host remains Redis-first and keeps its in-memory fallback. Embedders that operate the F6 file runtime explicitly install the returned adapter as `SharedInfra.spendLedger`; this PR does not invent a host backend selector or derive durable state paths from `DAGS_LOCAL_PATH`.

**Why:** The high-level store keeps crash/security-sensitive F6 internals private and reusable while preserving the host-owned error/persistence port. Whole-record atomic replacement removes Redis's partial-axis append window for the file backend.

**Rejected:**
- Export low-level F6 lock/atomic/verified-directory helpers and compose in host — permanently widens the public subpath with implementation primitives and couples host code to them.
- Reimplement locking and containment in host — duplicates the most security-sensitive F6 machinery.
- Append-only spend journal — creates sequence/idempotency, compaction, retention, and unbounded hydration-cost concerns with no current forensic requirement.
- Separate axis files — preserves Redis's partial-record window without Redis's atomic primitives.

### AD-5: Preserve the settled-call error policy while making file failure explicit

**Choice:** Add a host error member dedicated to this port rather than misusing `fs-purge-failed` or `redis-unavailable`:

```ts
| {
    readonly kind: "spend-ledger-unavailable";
    readonly backend: "file";
    readonly operation: "create" | "read" | "add";
    readonly message: string;
  }
```

Map it exhaustively in `httpStatusFor`/`formatHostError` (500; it is local host infrastructure). Construction and port methods convert typed framework file failures into this value; no raw filesystem exception crosses the host adapter boundary.

The existing ADR-0083 behavior remains authoritative:

- failed hydration + declared ceilings: fail the slice closed before a node runs;
- failed hydration + no ceilings: warn and start from unknown/zero;
- failed append after provider settle: keep the provider result, log `error` for budgeted runs and `warn` for unbudgeted runs;
- crash between provider settle and append: at most one call's spend is lost;
- no retry inside the ledger adapter (automatic retry can double-append an operation whose commit acknowledgement was lost).

**Why:** Call spend cannot be undone after provider settlement. Returning an error instead would discard paid-for output without restoring budget integrity. A dedicated typed error keeps filesystem failures observable without lying about their subsystem.

**Rejected:**
- Fail the LLM call on append failure — wastes paid output and does not undo spend.
- Retry `add` blindly — the port is additive, not idempotent; an ambiguous commit could double count.
- Parse corrupt numeric fields as zero — reintroduces the fail-open residual documented in `spend-record.ts`.

---

## File Structure

### Framework budget capability and capability metadata

```text
packages/framework/src/types/budget-capability.ts                 — BudgetCapability, Remaining, CeilingHeadroom, pure remainingFor/snapshot construction
packages/framework/src/types/node.ts                              — seventh built-in registry/context field and catalogue metadata
packages/framework/src/types/capability-handle.ts                 — conditional clientKind:"llm" handle contract
packages/framework/src/types/index.ts                             — export budget capability types/functions
packages/framework/src/index.ts                                   — public capability exports
packages/framework/src/shared/make-node-context.ts                — merge top-level/bag budget field with existing precedence
packages/framework/src/testing.ts                                 — export fixedBudgetCapability test fake
packages/framework/src/__tests__/budget-capability.test.ts        — fast-check properties and examples for headroom/snapshots
packages/framework/src/__tests__/extensible-capabilities.test.ts  — budget merge/reserved-key behavior
packages/framework/src/__tests__/capability-validation.test.ts    — seventh built-in validation coverage
packages/framework/src/__tests__/cli/cli.test.ts                  — capability catalogue coverage
packages/framework/src/__tests__/make-node-context-merge.test.ts  — budget precedence and scoped-merge protection
```

### Framework file spend store

```text
packages/framework/src/file/spend-store-codec.ts             — strict V1 codec and pure Spend ↔ record conversion
packages/framework/src/file/spend-store.ts                   — locked, verified, digest-addressed file store shell
packages/framework/src/file/boundary-error.ts                — closed create/read/add spend-store operations
packages/framework/src/file.ts                               — export createFileSpendStore and FileSpendStore
packages/framework/src/__tests__/file-spend-store.test.ts    — temp-dir durability, concurrency, corruption, symlink and address tests
packages/framework/src/__tests__/boundary-imports.test.ts    — file-subpath zero-dependency/boundary coverage remains complete
```

### Host run authority, metering, and adapters

```text
packages/host/src/adapters/run-spend-authority.ts             — one run-scoped imperative authority and BudgetCapability view
packages/host/src/adapters/metered-llm.ts                     — thin transparent LlmClient decorator delegating to the authority
packages/host/src/adapters/spend-ledger-file.ts               — FileSpendStore → SpendLedgerPort/HostError adapter
packages/host/src/adapters/node-context-factory.ts            — hydrate once, create authority, meter main + marked bag clients, inject budget
packages/host/src/domain/llm-meter.ts                         — pure projectedSpend query shared by admit and remaining
packages/host/src/domain/capability-manager.ts                — decorate marked LLM clients inside existing correlation boundary
packages/host/src/domain/host-error.ts                        — spend-ledger-unavailable ADT member + exhaustive mappings
packages/host/src/ports.ts                                    — authority/adapter contract documentation; no ledger signature change
packages/host/src/index.ts                                    — export createFileSpendLedger and relevant public types
packages/host/src/__tests__/llm-meter.test.ts                 — projection/admission agreement properties
packages/host/src/__tests__/metered-llm.test.ts               — transparent operation delegation and authority accounting tests
packages/host/src/__tests__/node-context-factory.test.ts      — main/judge/custom bag clients share one meter/ledger and budget view
packages/host/src/__tests__/capability-manager.test.ts        — marked-client decoration and untouched non-LLM clients
packages/host/src/__tests__/spend-ledger.test.ts              — shared memory/Redis/file contract, including concurrent adds
packages/host/src/__tests__/spend-ledger-file.test.ts         — framework-error translation and construction failure tests
```

### Migration and product documentation

```text
CONTEXT.md                                                    — seventh built-in, Budget Capability, Run Spend Authority, file ledger adapter
packages/framework/docs/adapter-authoring.md                 — clientKind:"llm" requirement and migration example
packages/framework/CHANGELOG.md                              — NodeContext/CapabilityHandle source migration and new file subpath export
packages/host/README.md                                       — injectable file ledger construction example
packages/host/docs/deployment.md                              — file root ownership/retention and unchanged Redis-first stock wiring
docs/features.md                                              — spent()/remaining() usage; remove both known-gap statements
docs/adr/0083-spend-durability-lives-in-a-ledger-port.md      — amend adapter set, file layout/atomicity and no-retry consequences
docs/plans/2026-08-27-f3-budget-capability.md                 — record PR-D completion/deviations and close P3/P4/file gaps
docs/spikes/2026-08-02-graph-engineering-findings.md          — ensure F3 superseding/completion note names the shipped capability
```

---

## Component Design

### Budget capability functional core

**Responsibility:** Represent read-only spend/headroom without I/O or mutable references.
**Files:** `packages/framework/src/types/budget-capability.ts`, `packages/framework/src/types/budget.ts`, `packages/framework/src/types/spend.ts`
**Interface:**

```ts
export interface BudgetCapability {
  readonly spent: () => Spend;
  readonly remaining: () => Remaining;
}

export const remainingFor: (
  limits: Ceilings | undefined,
  projected: Spend,
) => Remaining;
```

`remainingFor` preserves canonical ceiling order, emits one headroom entry per ceiling, clamps numeric headroom at zero, and emits `unpriced` only for USD. Returned values are fresh/deeply frozen so a JavaScript consumer cannot mutate the authority through a nominally readonly array/object.

**Depends on:** existing `Spend`, `Ceilings`, `MicroUsd`, and `UnpricedModels` only.

### Seventh built-in capability

**Responsibility:** Make `requires: ["budget"]` narrow `ctx.budget` to a non-null `BudgetCapability` using existing compile/runtime validation.
**Files:** `packages/framework/src/types/node.ts`, `packages/framework/src/shared/make-node-context.ts`, barrels/catalogue tests
**Interface:**

```ts
export interface CapabilityRegistry {
  // existing six...
  readonly budget: BudgetCapability;
}

export interface BaseNodeContext {
  // existing fields...
  readonly budget: BudgetCapability | null;
}

export type NodeContextInit = {
  // existing fields...
  readonly budget?: BudgetCapability | null;
};
```

Append `"budget"` to `BUILTIN_CAPABILITY_KEYS`, add catalogue metadata warning that reads can affect retry-time decisions, and include `budget` in `makeNodeContext` with top-level-over-bag precedence. The existing `_BuiltinKeysComplete` and `satisfies Record<BuiltinCapabilityKey, CapabilityInfo>` assertions remain the compile-time completeness gates.

**Depends on:** Budget capability functional core.

### LLM capability-handle classification

**Responsibility:** Carry typed adapter intent through widened `CapabilityHandle[]` so the host can meter all boot-scoped LLM clients without duck typing.
**Files:** `packages/framework/src/types/capability-handle.ts`, `packages/host/src/domain/capability-manager.ts`
**Interface:** AD-2 signatures.

`extractClients` remains the only boot-time name/client correlation cast. Its decorator is invoked exactly once for each `clientKind: "llm"` handle; lifecycle methods remain on the original handle and are neither wrapped nor duplicated. Non-LLM client identity stays byte-identical.

**Depends on:** existing capability registry and `LlmClient` port.

### Pure LLM meter projection

**Responsibility:** Give admission and budget reads one formula for in-flight spend.
**Files:** `packages/host/src/domain/llm-meter.ts`
**Interface:**

```ts
export const projectedSpend = (
  meter: LlmMeter,
  runId: RunId,
  reservation: ReservationState,
): Spend;
```

Formula: `spendFor(meter, runId) + scaleSpend(maxObservedCall, inFlight)`. Refactor `admit` to call this function; do not alter settled-first breach ordering, reservation learning, release clamping, or first-burst/overshoot documentation.

**Depends on:** existing pure meter and spend algebra.

### Run spend authority

**Responsibility:** Hold one run's mutable shell state and execute every client call through the established accounting protocol.
**Files:** `packages/host/src/adapters/run-spend-authority.ts`, `packages/host/src/adapters/metered-llm.ts`
**Interface:**

```ts
export type MeteredLlmOperation = "sendStructured" | "sendWithTools";

export interface RunSpendAuthority {
  readonly budget: BudgetCapability;
  readonly execute: <O>(args: {
    readonly clientKey: Capability;
    readonly operation: MeteredLlmOperation;
    readonly request: MeteredRequest;
    readonly call: () => Promise<Result<LlmResponse<O>, FrameworkError>>;
  }) => Promise<Result<LlmResponse<O>, FrameworkError>>;
}

export const createRunSpendAuthority = (
  deps: RunSpendAuthorityDeps, // same limits↔known-hydration coupling as current MeteredLlmDeps
): RunSpendAuthority;

export const createMeteredLlm = (
  inner: LlmClient,
  clientKey: Capability,
  authority: RunSpendAuthority,
): LlmClient;
```

Protocol remains one implementation: gate/reserve → invoke provider → price success or partial-error usage → synchronously update meter/estimate → emit `llm.metered`/failure logs with `clientKey` → await ledger append → release in `finally`. A throwing inner client is logged and rethrown as today; unknown usage is never fabricated. `spent()` reads settled meter state; `remaining()` calls `projectedSpend` and `remainingFor` synchronously.

**Depends on:** Budget core, pure projection, `SpendLedgerPort`, existing pricing/error-usage helpers.

### File spend store functional core and shell

**Responsibility:** Persist one atomic canonical spend snapshot per run with F6 containment and lock semantics.
**Files:** `packages/framework/src/file/spend-store-codec.ts`, `packages/framework/src/file/spend-store.ts`
**Interface:**

```ts
export interface FileSpendStore {
  readonly read: (runId: RunId) => Promise<Result<Spend, FrameworkError>>;
  readonly add: (runId: RunId, delta: Spend) => Promise<Result<void, FrameworkError>>;
}

export const createFileSpendStore: (root: string) => FileSpendStore;
```

The codec is pure and strict. The shell maps every constructor/read/add filesystem or codec failure to the closed file `cache-error` operation vocabulary. Unknown run is the only absence case and returns `NO_SPEND`. No background GC, compaction, TTL, or fsync claim is introduced; lifecycle/retention belongs to the embedding file runtime.

**Depends on:** existing F6 atomic/lock/verified-directory modules, `Spend` algebra, framework Result/error types; no external dependency.

### Host file ledger adapter

**Responsibility:** Adapt framework file errors to the host-owned ledger port without leaking framework file errors across the boundary.
**Files:** `packages/host/src/adapters/spend-ledger-file.ts`, `packages/host/src/domain/host-error.ts`
**Interface:** AD-4/AD-5 signatures.

Creation returns `Result`; method failures return `Err(spend-ledger-unavailable)`. It does not log (the authority/context factory already owns severity based on whether a ceiling exists), retry, or reinterpret corruption.

**Depends on:** `FileSpendStore`, `SpendLedgerPort`, `HostError`.

### NodeContext composition

**Responsibility:** Hydrate once, construct one authority, meter every eligible client through it, and inject its budget view.
**Files:** `packages/host/src/adapters/node-context-factory.ts`
**Interface:** Existing `createNodeContextForDag`; no parameter change.

Composition order:

1. Resolve tenant, TTL, and ceilings as today.
2. Select Redis ledger or injected `SharedInfra.spendLedger` as today.
3. Hydrate once; apply current budgeted fail-closed/unbudgeted warn policy.
4. Construct one `RunSpendAuthority` with that ledger and hydration.
5. Wrap `shared.llm` under key `llm`.
6. `extractClients(shared.capabilities, { llm: authority-backed decorator })` to wrap marked `judgeLlm` and custom bag clients.
7. Call `makeNodeContext` with metered `llm`, decorated capability bag, and `budget: authority.budget`.

Top-level fields retain precedence. Therefore a bag entry named `llm` cannot replace the explicitly metered main client, and a bag entry named `budget` cannot replace the runtime-owned budget authority.

**Depends on:** Run authority, capability extraction, existing ledger selection.

---

## Data Flow

```text
execution slice starts
  → resolve ceilings + select SpendLedgerPort
  → ledger.read(runId)
  → createRunSpendAuthority(hydrated spend, ceilings)
  → wrap shared.llm + marked capability-bag LLMs with that authority
  → inject authority.budget into NodeContext

node LLM call
  → authority gate against settled spend, then shared projection
  → provider client
  → spendOfCall(response/error usage)
  → pure accumulate + learnObservedCall
  → structured log (dagId, runId, nodeId, clientKey, operation, call, cumulative)
  → ledger.add(runId, call spend)
  → original Result returned

node budget read
  → spent(): defensive settled snapshot
  → remaining(): settled + current reservations
  → pure remainingFor(ceilings, projection)
```

For an injected file ledger:

```text
ledger.add
  → digest(runId)
  → verify root identity
  → acquire per-run F6 lock
  → strict read prior V1 record (or NO_SPEND)
  → addSpend(prior, delta)
  → atomic tmp + rename complete V1 record
  → verify root identity / release lock
```

---

## Invariants

### INV-1: Every boot-scoped LLM client reaching NodeContext shares one authority

**Tier:** advisory
**Statement:** `shared.llm` and every `CapabilityHandle` whose conditional type requires `clientKind: "llm"` are wrapped with the same `RunSpendAuthority`; no per-client meter or ledger exists. This is enforced by type design, one extraction/composition seam, and integration tests. A regex lint rule cannot prove object identity or generic type relationships without false confidence.

### INV-2: Remaining headroom and admission use the same projection

**Tier:** advisory
**Statement:** Both operations consume `projectedSpend`; a projected breach implies exhausted/unpriced headroom for at least one ceiling, and no projected breach implies positive/evaluable headroom for every ceiling. Fast-check proves the biconditional over generated meter/reservation/ceiling values; a regex rule cannot prove semantic function use through refactors.

### INV-3: A successful file append publishes one complete aggregate

**Tier:** advisory
**Statement:** Per-run adds are serialized and commit all axes plus unpriced-model union in one atomic rename. A fresh store instance reads the exact `addSpend` fold under any concurrent add order. Temp-directory integration and property tests prove this; source regex cannot prove filesystem atomicity.

---

## Implementation Phases

### Phase 1: Framework contracts and pure budget read model (no dependencies)

- Add `BudgetCapability`, `Remaining`, `CeilingHeadroom`, and pure `remainingFor` with defensive immutable snapshots.
- Add `budget` to `CapabilityRegistry`, built-in keys/info, `BaseNodeContext`, `NodeContextInit`, and `makeNodeContext`.
- Add `fixedBudgetCapability` for deterministic node tests.
- Convert `CapabilityHandle` to the conditional `clientKind: "llm"` contract and add compile-time positive/negative fixtures.
- Add fast-check properties for headroom non-negativity, canonical axis correspondence, unpriced USD behavior, and immutable snapshot isolation.
- **Files:** framework budget/capability files and tests listed above.

### Phase 2: Parallel run authority and file persistence foundations (depends on Phase 1)

- Add pure `projectedSpend`; refactor `admit` to consume it without changing breach ordering or overshoot behavior.
- Extract `RunSpendAuthority` from `createMeteredLlm`; make the decorator a thin operation adapter.
- Add the strict V1 file codec and high-level `FileSpendStore` using existing private F6 primitives.
- Extend the closed file operation vocabulary and subpath barrel without adding dependencies.
- Add `spend-ledger-unavailable` and the host `createFileSpendLedger` translation adapter.
- **Files:** `llm-meter.ts`, `run-spend-authority.ts`, `metered-llm.ts`, framework file-store files, host file adapter/error files, focused tests.

### Phase 3: Full client/context composition and contract integration (depends on Phase 2)

- Extend `extractClients` with the typed LLM decorator callback inside the existing trust-boundary cast.
- In `createNodeContextForDag`, construct one authority, wrap main and marked bag clients, and inject `budget`.
- Add `clientKey` to all metering/refusal/failure/durability log lines.
- Add file backend to the shared `SpendLedgerPort` contract suite.
- Prove one main call plus judge/custom-bag calls accumulate into one spent view, one remaining view, one ceiling decision, and one ledger.
- Prove both clients used by the existing `eval-judge` selection (`judgeLlm` and its `llm` fallback) are authority-wrapped at context construction.
- **Files:** capability manager, node-context factory, host barrels and integration/contract tests.

### Phase 4: Migration, ADR amendment, and release verification (depends on Phase 3)

- Document source migration: explicit `NodeContext` literals add `budget: null` or use `makeNodeContext`; custom LLM handles add `clientKind: "llm"`.
- Amend ADR-0083 with the file adapter's locked snapshot, verified root, whole-record atomicity, and no-retry policy. Record the run-authority/capability decision in the next ADR entry if ADR indexing requires a new cross-cutting record.
- Update `CONTEXT.md`, feature docs, host/framework docs, changelog, original F3 plan, and superseding spike note; remove both F3 known-gap statements.
- Run package/root verification and inspect changed exports for accidental dead aliases.
- **Files:** documentation and ADR files listed above.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|---|---|---|---|
| Budget capability core | unbudgeted shape; reached clamp; unpriced USD; defensive snapshots | `makeNodeContext` top-level/bag precedence and `requires:["budget"]` validation | generated ceilings/spend: one headroom per canonical ceiling, non-negative amounts, unpriced iff USD is unevaluable |
| CapabilityHandle metadata | non-LLM handles unchanged; marked LLM decorator invoked once | custom module-augmented LLM handle reaches context wrapped; `judgeLlm` wrapped | compile-time `@ts-expect-error`: LLM handle without marker and non-LLM handle with marker are rejected |
| Pure meter projection | zero/one/many in-flight estimates; settled-first refusal unchanged | authority reads projection during concurrent delayed clients | generated state: `firstBreach(projectedSpend)` iff `remainingFor` has exhausted/unpriced axis; projection monotone in `inFlight` and `maxObservedCall` |
| Run spend authority | success, partial-error usage, thrown client, release in finally, ledger write severity, client-key attribution | main + judge + custom client share ceiling and cumulative; budget reads change immediately on reserve/settle | generated settlement order yields same settled Spend; preserved existing admission soundness/overshoot properties |
| File codec | V1 round trip; absent vs malformed; crossed runId/digest; non-finite/negative rejection | none | valid generated Spend round-trips structurally; malformed numeric/model records never parse as zero |
| File store | unknown run; sequential adds; fresh-instance read | temp directory: `Promise.all` concurrent adds, process-instance restart, atomic prior-or-next reads, symlink root/record refusal, corrupt/torn/tmp record behavior | any permutation of deltas hydrates to `deltas.reduce(addSpend, NO_SPEND)` |
| Host file adapter | constructor/read/add error translation | shared memory/Redis/file `SpendLedgerPort` contract suite | backend order-independence property includes file |
| NodeContext wiring | no-budget still meters and exposes `unbudgeted`; budgeted hydration failure still refuses | park/resume with file adapter; main then judge reaches same ceiling; non-LLM bag client identity unchanged | generated marked-client call orders share one total |

**Verification policy:** every production component receives (a) a regression test preserving current behavior and (b) a new-feature test that fails on `main`. Plain fakes/object literals replace mocks. Business decisions stay in pure functions; only file/provider/ledger boundaries use integration tests.

The existing host test-directory typecheck exclusion remains out of scope (removing it currently surfaces hundreds of unrelated errors). Type-sensitive capability-handle fixtures live in the framework suite, which is included by its TypeScript project, and root runtime tests still execute all host `__tests__` files.

---

## Security & NFR Notes

- **Primary NFR — budget integrity:** unknown price, unreadable budgeted ledger, malformed file record, non-finite figure, and substituted/symlinked ledger path all fail closed. Unbudgeted hydration remains availability-first per ADR-0083.
- **Concurrency:** one JavaScript authority serializes synchronous meter/reservation transitions within a slice. Redis remains distributed/lock-free by field algebra; file adds serialize per run with F6's cross-process lock and publish complete snapshots by rename.
- **Performance:** admission and `spent()`/`remaining()` add no I/O. Each settle keeps one ledger append. The file append adds one lock/read/write/rename sequence; appropriate for F6's single-writer file deployment, not a replacement for Redis throughput.
- **Trust boundary:** `CapabilityHandle.clientKind` is trusted at the same adapter-authoring boundary as `name ↔ client`; no runtime duck typing or new cast point. Broker-minted built-in LLMs remain prohibited by the existing validation contract.
- **Path safety:** raw run IDs never form path components; the digest owns the filename and embedded run ID verification catches crossed files. Verified-directory checks reject pre-existing symlink/non-directory substitution and recheck identity, while honestly not claiming portable Node eliminates concurrent ancestor rename races.
- **Sensitive data:** spend files/logs contain counts, limits, client keys, and unpriced model IDs only—never prompts, outputs, thinking, raw provider responses, credentials, or subject tokens.
- **Observability:** retain `llm.metered`, `llm.call-failed`, budget refusal, hydration failure, ledger-write failure, and TTL diagnostics; add `clientKey`. File adapter itself returns typed errors and does not double-log. No new Observer domain event or metric is required.
- **Retention:** the injectable file root is lifecycle-owned by its embedder, matching F6. No TTL or background GC is added. Deleting a resumable run's durable directory must delete its spend record in the same lifecycle operation; automatic reaping is outside this PR.

### Explicitly out of scope

- F1 concurrency slots, queueing, rate ceilings, or dynamic fan-out.
- Node-callable `spend()` or non-LLM paid-resource metering.
- Cross-run, tenant-wide, or organization-wide budgets.
- Live price feeds and budget-aware retry unification.
- A stock-host file-backend environment selector, implicit `DAGS_LOCAL_PATH` storage, or file-to-Redis migration tooling.
- File compaction, background GC, fsync/power-loss guarantees, or network filesystems whose rename/lock semantics violate the F6 contract.
- Broker minting of built-in `llm`/`judgeLlm`; the existing FR-W2-009 prohibition remains. This PR covers the boot-scoped main client and boot-scoped capability bag described by the F3 plan.
- Repairing the host `tsconfig` test exclusion.

---

## Backwards Compatibility & Migration

1. **Budget configuration and persisted errors:** unchanged. `llmBudgetTokens`, `llmBudget`, `Ceilings`, Redis spend keys/encoding, 429 mapping, and persisted `llm-budget-exceeded` schema retain current behavior.
2. **Existing ledgers:** no data migration. Memory/Redis adapters and `SpendLedgerPort` signatures are unchanged. A new file root starts empty; an embedder must not switch an active resumable run from Redis/memory to file without an explicit one-time copy (tooling is out of scope).
3. **NodeContext source compatibility:** adding the seventh required nullable `BaseNodeContext` field breaks hand-authored `NodeContext` object literals at compile time. Migration: use `makeNodeContext`, or add `budget: null`. `NodeContextInit` remains optional/additive.
4. **CapabilityHandle source compatibility:** custom capability types extending `LlmClient` must add `clientKind: "llm"`. Non-LLM handles are byte-identical. No deprecated alias or permissive fallback is added because that would preserve the bypass.
5. **Runtime rollout:** no feature flag. The capability is always injected by the host, including unbudgeted runs. Existing DAGs that do not require/read `budget` observe only the intended expansion of metering to marked clients.
6. **Deployment:** stock Redis-first selection is unchanged. File-durable embedders explicitly construct and inject the file ledger; root permissions and retention are deployment-owned.

---

## Verification

1. `bun run --filter @fuguejs/framework typecheck`
2. `bun run --filter @fuguejs/host typecheck`
3. `bun test packages/framework/src/__tests__/budget-capability.test.ts packages/framework/src/__tests__/file-spend-store.test.ts packages/framework/src/__tests__/extensible-capabilities.test.ts packages/framework/src/__tests__/capability-validation.test.ts`
4. `bun test packages/host/src/__tests__/llm-meter.test.ts packages/host/src/__tests__/metered-llm.test.ts packages/host/src/__tests__/capability-manager.test.ts packages/host/src/__tests__/spend-ledger.test.ts packages/host/src/__tests__/spend-ledger-file.test.ts packages/host/src/__tests__/node-context-factory.test.ts`
5. `bun run typecheck`
6. `bun run test`
7. `bun run check:docs`
8. Confirm `fugue capabilities` lists exactly seven built-ins and describes `budget` as read-only.
9. Run a temp-directory restart scenario: settle through main and judge/custom clients, create a fresh file ledger/context for the same `runId`, and verify `spent()` rehydrates and the next call is refused at the shared ceiling.
10. Run dead-export/reference checks for the replaced decorator-local dependency types; do not leave compatibility aliases for internal unshipped symbols.
