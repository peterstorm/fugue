# PR Remediation Plan (v4)

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Diff:** 102 files, 8086 insertions vs `main`
**Findings:** 1 critical, 15 advisory (across 6 review agents) → 8 actionable fixes, 5 deferred (intentional / out-of-scope)

## Critical Fixes

### Fix 1: Registry-key collision passes validation falsely
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/node.ts:128-141`, `packages/framework/src/shared/capabilities.ts:49-52`
- **Issue:** `Capability = keyof CapabilityRegistry` lets a consumer augment the registry with a name that collides with a reserved `BaseNodeContext` infra field (`logger`, `tracer`, `observer`, `runId`, `dagId`, `checkpointWriter`, `signal`, `contentFilter`). `makeNodeContext` already refuses to *spread* such a capability (RESERVED_CONTEXT_KEYS guard at `make-node-context.ts:78`), so the custom client is never wired — yet `validateCapabilities`'s dynamic `dynamicCtx[cap]` lookup then reads the always-present infra field, sees non-null, and **passes validation** while `TypedNodeContext` mistypes the client. Fail-open + type lie.
- **Fix:** Single source of truth `RESERVED_NON_CAPABILITY_KEYS` in `node.ts`; `make-node-context.ts` consumes it (dedup); `validateCapabilities` treats any required capability whose name is a reserved non-capability key as unsatisfiable (fail-closed → `missing-capability`). Enforcement is runtime because the collision is introduced by *consumer* module augmentation the framework's own compile cannot see. + regression test.

## Advisory Fixes

### Fix 2: `mapPgError` dereferences `code` as string without a runtime check
- **Source:** silent-failure-hunter
- **File:** `packages/adapter-pg/src/index.ts:137-140`
- **Issue:** `"code" in error` + `as { code: string }` is a type lie; a non-string `code` makes `pgCode.startsWith(...)` throw *out of* the client `catch`, escaping the "no exceptions" contract. + test.

### Fix 3: `buildSignal` two-signal composition + caller-abort untested
- **Source:** pr-test-analyzer
- **File:** `packages/adapter-ms-graph/src/index.ts:150-158` → test only.

### Fix 4: explicit non-JSON `contentType` not verified as preserved
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/http/http-capability.ts:84-86` → test only.

### Fix 5: `normalizeCell` nested/object formula-result recursion untested
- **Source:** pr-test-analyzer
- **File:** `packages/xlsx/src/index.ts:73-74` → test only.

### Fix 6: `capability-manager.ts` header claims "Pure domain logic" but holds effectful lifecycle
- **Source:** architecture-tech-lead
- **File:** `packages/host/src/domain/capability-manager.ts:1-12` → header comment honesty fix (no code move; the effectful section is already labelled in-file).

### Fix 7: ADR-0051 doc accuracy
- **Source:** comment-analyzer + architecture-tech-lead
- **File:** `docs/adr/0051-extensible-capability-registry.md` → mark PgCapability example as illustrative subset; soften "each phase tagged" wording; document `CapabilityRegistry` as an intentional shared kernel resolved at runtime.

### Fix 8: doc cross-reference for inline-vs-transform parsing
- **Source:** comment-analyzer
- **File:** `docs/llm-document-source.md:113-114` → cross-reference ADR-0052.

## Deferred (intentional design / out of scope)

- **HTTP all-non-2xx → `transient`** (`http-capability.ts:120-127`): documented + tested contract; nodes branch on `httpStatus` (`fetch-customer-http.ts`). The analyzer itself downgraded to a design decision, not a bug.
- **`healthCheck` returns `Result<void, string>`** (`capability-handle.ts:60`): the reason is a display string aggregated into `CapabilityHealth.reason`; a `FrameworkError` would force sentinel-nodeId ceremony then re-stringify, with no consumer benefit. Health liveness ≠ control-flow error currency.
- **Adapters hand-roll `FrameworkError` literals vs factories**: the literals are explicit about `retriability: "non-retriable"`, whereas `frameworkError.nodeCrash` defaults to `retriable` (using it would be the riskier change); union drift is compile-checked. Low value.
- **`FakeDocRoute` all-fields-optional** (`document-source/src/index.ts:168-173`): test-fake ergonomics, low value.
- **`__brandConfidence` range check** (`confidence.ts:100-115`): `confidence.ts` is NOT in this branch's diff — out of scope for this PR.

## Validation Commands
```bash
bun run typecheck
bun test
```
