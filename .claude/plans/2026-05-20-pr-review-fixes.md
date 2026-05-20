# PR Review Fix Plan — 2026-05-20

## Summary

Comprehensive PR review found **0 critical issues** and **8 advisory items**. After re-analysis, 1 advisory was a false positive (tool-dispatch nodeId is actually safe because tool names are validated by `ensureToolNames` before dispatch, and `tool:` + valid tool name always satisfies `ID_REGEX`). That leaves **7 genuine items** to address.

## Correction: False Positive

**DROPPED — tool-dispatch nodeId is safe.** The `nodeId(`tool:${call.name}`)` call in the catch block of `dispatchToolCall` only executes after tool lookup succeeded (the `if (!tool) return errResult(...)` early-return is above the try/catch). Since `ensureToolNames` validates all tool names at loop start (`TOOL_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/`), the composed string `tool:validname` always satisfies `ID_REGEX = /^[A-Za-z0-9_:-]{1,128}$/` (max length 69 < 128, all chars valid).

---

## Fix Sequence

### Wave 1: Architecture Layering (Import Violations)

#### 1.1 Move `NoopObserver` into `types/observer.ts`

**Why:** `shared/defaults.ts` imports a *value* from `observer/observer.ts`, violating the `shared/ → types/ only` layering rule. The `check-imports.ts` has an explicit exemption (`scopeExcludes: ["shared/defaults.ts"]`), but the cleaner fix is to move the trivial `NoopObserver` class (3 lines, zero deps) into `types/observer.ts` where it belongs alongside the `Observer` interface.

**Changes:**
- `packages/framework/src/types/observer.ts` — add `NoopObserver` class
- `packages/framework/src/observer/observer.ts` — re-export `NoopObserver` from types (backwards compat)
- `packages/framework/src/shared/defaults.ts` — change import to `../types/observer.js`
- `packages/framework/src/scripts/check-imports.ts` — remove `"shared/defaults.ts"` from the `scopeExcludes` list for the shared → observer/tracing rule (prove the exemption is no longer needed)

**Test:** Run `bun test` in framework — `boundary-imports.test.ts` verifies no violations.

#### 1.2 Audit `shared/` logger import (no change needed — document decision)

**Why:** `shared/retry-async.ts` and `shared/json-patch.ts` import `fwLogger` from `../logger.js`. The logger is a global singleton seam, not a layer above `shared/`. The `check-imports.ts` rules do NOT forbid this import (only `@opentelemetry/`, `../observer`, `../tracing` are banned for shared). This is intentional — the logger is infrastructure plumbing, not a layer boundary. **No code change**, just documenting the decision here.

---

### Wave 2: Type Design Hardening

#### 2.1 `SideEffectProfile` — tighten "none" variant `resource` type

**Why:** Currently `{ kind: "none"; resource?: undefined }` — allows `resource: undefined` to be set explicitly. Using `readonly resource?: never` prevents accidental assignment while still allowing omission.

**Change:**
- `packages/framework/src/types/side-effects.ts` — change `readonly resource?: undefined` to `readonly resource?: never`

**Risk:** Low. The only valid value for `resource` on a `"none"` node is absence/undefined. Existing code that sets `{ kind: "none" }` (without `resource`) or `{ kind: "none", resource: undefined }` continues to compile. Code that accidentally sets `{ kind: "none", resource: "foo" }` will now correctly error.

**Test:** `bun run typecheck` must pass. If any test creates `{ kind: "none", resource: undefined }` explicitly, it will need the explicit removal.

---

### Wave 3: Code Simplification

#### 3.1 Extract `withAdditionalPropertiesFalse` to `llm/zod-schema.ts`

**Why:** This is a pure recursive schema transform (no client-specific logic). Currently lives in `openai-client.ts` but is schema manipulation that belongs alongside `zodToJsonSchema`. Extraction reduces `openai-client.ts` size and makes the transform testable/reusable.

**Changes:**
- `packages/framework/src/llm/zod-schema.ts` — add `withAdditionalPropertiesFalse` export
- `packages/framework/src/llm/openai-client.ts` — replace inline function with import

**Test:** `bun test` — the `openai-client` tests exercise structured output paths that call this function.

#### 3.2 Simplify `InMemoryFreshnessIndex` eviction (optional — defer if risk)

**Why:** The current implementation uses `resourceOrder[]`, `resourceSet`, `evictCursor`, splice-based compaction, bounded scan with fallback — clever but dense. JavaScript `Map` maintains insertion order; delete + re-set gives LRU. However, the current impl has specific bounded-scan properties that tests may rely on.

**Decision:** **DEFER.** The current implementation is correct (tests pass), bounded (O(1) amortized eviction), and well-documented. Simplification risks subtle behavioral changes in eviction order that tests may assert on. File a follow-up ticket; don't risk it in this fix batch.

---

### Wave 4: Robustness

#### 4.1 Guard `retryAsync` against non-Error throws

**Why:** If `fn()` throws a non-Error value (e.g., `throw "oops"` or `throw undefined`), the current `throw lastError` at exhaustion propagates an untyped value. While unlikely in well-written code, the fix is trivial and defensive.

**Change:**
- `packages/framework/src/shared/retry-async.ts` — wrap the final throw:
  ```ts
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
  ```

**Test:** Add a test case that throws a string, verify the outer catch receives an Error instance.

---

### Wave 5: Test Infrastructure

#### 5.1 Add `describe.skipIf` pattern for Redis-dependent tests

**Why:** 34 tests are skipped — they're Redis/BullMQ integration tests that need infrastructure. Currently they silently skip with no indication in CI of WHY. Adding a shared `skipIf` helper with environment detection improves visibility.

**Decision:** **DEFER for this commit.** The skipped tests already have proper skip annotations. A Testcontainers setup is a separate infrastructure task, not a code fix. Document as a follow-up.

---

### Wave 6: Documentation

#### 6.1 Add wave-execution.ts FR→ADR header comment

**Why:** `executor.ts` has an excellent FR-XXX → ADR-XXXX cross-reference block. `wave-execution.ts` is the de-facto wave engine but lacks similar traceability.

**Change:**
- `packages/framework/src/dag-runtime/wave-execution.ts` — add requirement cross-references to the file header:
  ```
  // FR-005  → ADR-0003 (checkpoint after every transition)
  // FR-021  → ADR-0021 (single-path runtime)
  // FR-025  → ADR-0025 (freshness witness emission after wave)
  // FR-029  → ADR-0029 (routing decisions pre-computed by executor)
  ```

---

## Execution Order

1. **Wave 1.1** — Move NoopObserver (structural, testable via boundary-imports)
2. **Wave 2.1** — SideEffectProfile type tightening (typecheck only)
3. **Wave 3.1** — Extract schema transform (refactor, tests cover)
4. **Wave 4.1** — Guard retryAsync (defensive, add test)
5. **Wave 6.1** — Documentation header (no risk)
6. `bun run typecheck && bun run test` — full validation

## Expected Outcome

- `check-imports.ts` boundary tests pass with one fewer exemption
- Typecheck clean across both packages
- 1253+ framework tests pass, 101 customer-summary tests pass
- No behavioral changes to the runtime
- Cleaner layering, tighter types, more defensive error handling

## Deferred

| Item | Reason |
|------|--------|
| InMemoryFreshnessIndex simplification | Correct + tested; risk of behavioral change |
| Redis test infrastructure (Testcontainers) | Infrastructure task, not code fix |
| fwLogger in shared/ | Intentional design; documented above |
