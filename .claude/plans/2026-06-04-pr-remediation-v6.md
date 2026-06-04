# PR Remediation Plan — v6

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 1 critical, 9 advisory (6 agents). Net actionable: 8 fixes, 3 deferred.

6-agent review (code, errors, tests, types, comments, architecture) on 106 files / 8410 insertions.
This is the 8th cycle; 5 of 6 agents found nothing critical. The one "critical" is a type-integrity
cleanup (low severity in practice). The highest-value finding is a genuine correctness bug in the
Redis liveness probe that the silent-failure agent surfaced as advisory.

## Critical Fixes

### Fix 1: `missing-capability` error duplicates `missing[0]` as scalar `nodeId`/`capability`
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/errors.ts:111-114`
- **Issue:** The variant carries `nodeId`/`capability` scalars alongside `missing[0]`. The "cannot
  disagree" invariant is enforced only by the two factories, not the type — a direct object literal
  can diverge. Representable illegal state.
- **Fix:** Drop the scalar fields; consumers read `missing[0]`. The non-empty tuple
  `[MissingCapability, ...MissingCapability[]]` already guarantees a first miss exists. Update both
  construction sites (`error-factories.ts`, `shared/capabilities.ts`), the `node.ts` doc comment, and
  the test assertions. `formatFrameworkError` already reads `e.missing` — no change.

## Advisory Fixes

### Fix 2: Redis liveness probe re-invokes `client.connect()` on every tick (correctness bug)
- **Source:** silent-failure-hunter
- **File:** `packages/host/src/main.ts:47-58`
- **Issue:** `RedisConnectivityPort.ping` calls `client.connect()` each call. `redis-probe.ts` calls
  `ping()` on every interval tick. With ioredis + `lazyConnect`, `connect()` rejects once the client
  is already connected — so every tick after the first reports Redis dead and falsely flaps the host
  into `degraded:redis-disconnected`.
- **Fix:** Only connect on the lazy initial state (`client.status === "wait"`); afterwards ioredis
  owns reconnection and `ping()` issues only `client.ping()`.

### Fix 3: Delete dead `CapabilityFields` backward-compat alias
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/node.ts:166-171` (+ re-exports in `types/index.ts`, `index.ts`)
- **Issue:** `CapabilityFields = CapabilityRegistry` is dead weight for unshipped code; two names for
  one type. No consumers outside the three export sites.
- **Fix:** Remove the alias and its two re-exports.

### Fix 4: `createFakeHttpCapability` param `Record<string, FakeHttpRoute | unknown>` collapses to `unknown`
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/http/http-capability.ts:242`
- **Fix:** Simplify to `Readonly<Record<string, unknown>>` (the union conveys no type info; routes are
  discriminated structurally at runtime).

### Fix 5: `parseWorkbook` returns mutable `T[]` but README/immutability standard says `readonly T[]`
- **Source:** comment-analyzer (+ immutability standard)
- **File:** `packages/xlsx/src/index.ts:101`
- **Fix:** Return `readonly T[]` (tighten impl to match the stronger guarantee the docs already claim).

### Fix 6: `extractClients` silently last-writer-wins on duplicate handle names
- **Source:** architecture-tech-lead
- **File:** `packages/host/src/domain/capability-manager.ts:294-302`
- **Issue:** Correctness relies on `topoSortHandles` having rejected duplicates upstream — an untyped
  cross-module invariant. If ever violated, a duplicate silently drops a client.
- **Fix:** Detect a duplicate name and throw loudly (turns a hypothetical silent drop into a loud
  failure; the invariant says it can never fire on the real boot path).

### Fix 7: `frameworkError.transient` `httpStatus` spread not directly asserted
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/__tests__/error-factories.test.ts` (test gap)
- **Fix:** Add direct assertions — one call with `httpStatus`, one without.

### Fix 8: `frameworkError.missingCapability` factory has no direct unit test
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/__tests__/error-factories.test.ts` (test gap)
- **Fix:** Add a direct test pinning the non-empty-tuple head/tail construction and ordering.

## Deferred

### `document-source` smart constructors have no empty-string guards
- **Reason:** Adding validation changes the constructors from returning `FileRef` to
  `Result<FileRef, …>`, rippling through every adapter call site and test for marginal benefit —
  these are opaque provider-supplied addresses validated at the API boundary. Agent marked it
  explicitly optional.
- **Recommendation:** Revisit if a non-opaque ref ever needs structural validation.

### `withTracedCapability` binds `this` to the unwrapped client
- **Reason:** Forward-looking only. The documented contract plus the all-closures reality (every
  current client is a closure-based object literal, not a `this`-dispatching class) means no live code
  path bypasses tracing.
- **Recommendation:** Bind `this` to the proxy if a class-based capability is ever introduced.

### `cache` built-in dual wiring path (top-level field vs capabilities bag)
- **Reason:** No action required — the `_BuiltinKeysComplete` static assertion already makes the
  dangerous failure mode (a built-in treated as custom) a compile error.

## Validation Commands
```bash
bun run typecheck
bun test
```
