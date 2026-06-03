# PR Remediation Plan (v4)

**Date:** 2026-06-03
**Branch:** feat/extensible-capabilities
**Findings:** 2 critical, 10 advisory (deduplicated from 6 review agents)

## Critical Fixes

### Fix 1: ADR-0051 Migration section contradicts the branch
- **Source:** comment-analyzer
- **File:** docs/adr/0051-extensible-capability-registry.md:88-90
- **Issue:** Claims "No behavioral change. All existing tests pass without modification" — but the branch adds http capability, pg adapter, tracing, host lifecycle, and modifies ~30 existing test files.
- **Fix:** Rewrite Migration section to describe the actual multi-phase delivery (Phase 1 types → Phase 2 host lifecycle → Phase 3 pg adapter → Phase 4 tracing) matching the @satisfies phase tags already in code.

### Fix 2: ADR-0051 Decision item 1 omits `http` from built-in base set
- **Source:** comment-analyzer
- **File:** docs/adr/0051-extensible-capability-registry.md:30-31
- **Issue:** Lists base set as (llm, cache, prompts, judgeLlm); actual CapabilityRegistry (node.ts:128-134) has 5 members including http. CONTEXT.md already lists 5.
- **Fix:** Update item 1 to include http.

## Advisory Fixes

### Fix 3: Failing handle's own pool leaks on aborted boot
- **Source:** silent-failure-hunter
- **File:** packages/host/src/domain/capability-manager.ts (connectAll catch)
- **Issue:** connectAll closes the connected prefix on failure, but the failing handle (whose adapter constructed a Pool at factory time, e.g. pg) is never closed — its pool is orphaned. One leak per restart in a crash loop.
- **Fix:** In connectAll's failure path, best-effort `handle.close?.()` on the failing handle before returning ConnectFailure; log close failure without masking the connect error.

### Fix 4: Null-client handles fail late with misleading diagnostic
- **Source:** silent-failure-hunter, type-design-analyzer
- **File:** packages/host/src/domain/capability-manager.ts (topoSortHandles)
- **Issue:** A handle constructed with null/undefined client is silently dropped from the node context and surfaces at run time as "missing-capability" instead of failing loudly at boot.
- **Fix:** Assert non-null client in topoSortHandles (the boot choke point) → internal-invariant-violated error naming the handle.

### Fix 5: Trust-boundary cast in extractClients undocumented at the site
- **Source:** type-design-analyzer, architecture-tech-lead
- **File:** packages/host/src/domain/capability-manager.ts (extractClients)
- **Issue:** name↔client correlation is erased on widening to CapabilityHandle[] and restored by an unchecked cast. Inherent to a dynamic registry — acceptable only if the trust boundary is explicit and singular.
- **Fix:** Document extractClients as THE single trusted name→client correlation point; note duplicate-handle safety is guaranteed by boot-time topoSortHandles.

### Fix 6: `dependsOn` type admits never-satisfiable built-ins
- **Source:** type-design-analyzer
- **File:** packages/framework/src/types/capability-handle.ts:67
- **Issue:** `dependsOn: readonly Capability[]` admits built-ins (llm, http) that are never handle-backed, so they always fail the boot check.
- **Fix:** JSDoc note that only handle-backed capabilities are valid dependsOn targets (type-narrowing not expressible without registering built-ins as handles).

### Fix 7: checkHealth doc overstates wiring
- **Source:** comment-analyzer
- **File:** packages/host/src/domain/capability-manager.ts:196-202
- **Issue:** "polled by the host" — nothing in the host calls checkHealth.
- **Fix:** Reword to "aggregation only; periodic host polling is a follow-up", matching capability-handle.ts:55-60 phrasing.

### Fix 8: contentType doc implies encoding changes
- **Source:** comment-analyzer
- **File:** packages/framework/src/types/http-capability.ts:30-33
- **Issue:** Body is always JSON.stringify'd regardless of contentType; doc reads as generic override.
- **Fix:** Document that contentType only changes the header; body is always JSON-serialized.

### Fix 9: pg README install omits zod
- **Source:** comment-analyzer
- **File:** packages/adapter-pg/README.md:7-9
- **Issue:** Every example imports zod but install line is `bun add @fugue/pg pg`.
- **Fix:** Add zod to install line.

### Fix 10: queryRaw escape-hatch warning
- **Source:** type-design-analyzer
- **File:** packages/adapter-pg/src/index.ts:86
- **Issue:** queryRaw returns unknown[] bypassing parse-don't-validate; needs steering docs.
- **Fix:** Strengthen JSDoc: prefer `query` with a schema; queryRaw is the escape hatch.

### Fix 11: errors.ts mid-file import
- **Source:** type-design-analyzer
- **File:** packages/framework/src/types/errors.ts:108-111
- **Issue:** Type-only import placed mid-file to dodge a perceived cycle — fragile, stylistically broken.
- **Fix:** Move the import to the top of the file (type-only imports erase; no runtime cycle).

### Fix 12: Test gaps
- **Source:** pr-test-analyzer, type-design-analyzer
- **Files:** packages/framework/src/__tests__/http-capability.test.ts, capability-tracing.test.ts, (new) builtin-capability-keys assertion
- **Fix:**
  - buildUrl join branches: trailing-slash base, missing-leading-slash path (via real capability)
  - createFakeHttpCapability node-crash-on-schema-failure
  - sync-path extractAttributes-throws span event
  - negative-space test: BUILTIN_CAPABILITY_KEYS exactly equals the built-in capability fields of BaseNodeContext

## Deferred

### withTracedCapability this-binding for class-based clients
- **Reason:** Changing `apply(target)` → `apply(receiver)` alters the documented contract (capability-tracing.ts:81-85) and the observable tracing behavior mid-PR; all current adapters are closure-based so no live defect.
- **Recommendation:** Follow-up: bind to receiver so sibling `this.method()` calls re-enter tracing, with tests for class-based clients.

### Namespaced cache `set` always returns ok()
- **Reason:** Deliberate, documented, logged design (cache-write failure must not abort a run). Silent-failure-hunter concluded "no change required."

### Registry-type↔client structural verification
- **Reason:** Inherent to dynamic open registries; runtime shape-checking every custom client is out of scope. Mitigated by Fix 5 (explicit single trust boundary).

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit
cd packages/host && bunx tsc --noEmit   # known pre-existing TS6305/host.ts(145) errors on main
cd packages/adapter-pg && bunx tsc --noEmit
bun test packages/framework packages/host packages/adapter-pg apps/customer-summary
```
