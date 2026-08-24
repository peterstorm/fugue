# PR Remediation Plan — Adjudicated Standalone Review (round 40)

**Branch:** `feat/f6-file-durable-runtime`
**Review HEAD (frozen source):** `9acbb111ca1eda714ff80421765a61e12a4d3cbf`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T071615Z-01a032a0`
**Canonical result:** `<run>/result.json` (digest `bb0518a728b677b2f7deb5b562a0f56ee1f7c728accba28af1800a4f55a0e4c8`)
**Frozen scope:** exactly the 481 paths in `result.json.scope`
**Adjudication:** 7 reviewers → 8 critical findings → 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **8 surviving / 0 refuted**; 11 advisories independently dispositioned below.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — checkpoint-resumed freshness gap**
   `packages/framework/src/dag-runtime/wave-execution.ts:261`
   Stop treating checkpoint presence as proof that post-node freshness bookkeeping completed. Re-emit owed read/write bookkeeping for checkpoint-resumed outputs, retain the in-process witnessed set only for completed bookkeeping, and make write retries recognize their own previously committed write so a crash or ambiguous acknowledgement cannot create a self-conflict. Add crash-window and ambiguous-commit regression tests.

2. **`code-reviewer-2` — unfenced tenant purge/revival race**
   `packages/host/src/supervisor/lifecycle/grace-window-purge.ts:264`
   Replace check-then-destruct with an adapter-owned, runtime-proven purge lease acquired against the exact tombstone. Registry mutations are refused while that lease is active; destructive ports run only after acquisition; hard deletion requires the authentic lease and occurs only after every footprint step succeeds; failures retain the tombstone and release the lease for retry. Add lifecycle and registry concurrency regressions proving revival cannot interleave with destructive work.

3. **`silent-failure-hunter-1` — logger escapes persisted state transition**
   `packages/framework/src/state-machine/runner.ts:196`
   Route both `onTrace` diagnostic paths through a non-throwing logger helper. Add a regression where both the trace callback and injected logger throw while the durable transition still succeeds.

4. **`type-design-analyzer-1` — reissuable HITL lease**
   `packages/host/src/hitl/ports.ts:35`
   Remove `ownerToken` from the public lease value, back issuance with module-private WeakMap proof, and make run-store adapters extract tokens only through the internal proof function. Assertion-forged or copied leases fail closed; an aborted holder cannot mint a fresh lease because it cannot recover the token. Update lease tests.

5. **`comment-analyzer-1` — authenticated HTTP option accessors escape**
   `packages/http-auth/src/client.ts:57`
   Fence all request-option reads, including body/content-type extraction, inside the Result boundary and map contract violations to a secret-free non-retriable error. Add hostile-accessor tests for body and common options.

6. **`comment-analyzer-2` — Graph abort accessor escapes**
   `packages/adapter-ms-graph/src/path-resolving.ts:47`
   Read and inspect caller signals only inside guarded code, reuse the captured signal for composition, and ensure both preflight and catch-path abort checks stay inside the Result boundary. Add a hostile signal/accessor regression.

7. **`architecture-tech-lead-1` — global logger in pure response assembly**
   `apps/customer-summary/src/dag/nodes/assemble-response.ts:76`
   Remove logging from the transform; the degraded response is the pure modeled outcome. Add a regression proving degraded assembly is independent of a throwing framework logger.

8. **`code-simplifier-1` — unreachable test-fixture branch**
   `packages/framework/src/__tests__/dag-transition.test.ts:104`
   Delete the always-true ternary and preserve its effective fixture value directly.

## Advisory dispositions

### Accepted

- **`code-reviewer-3`** — own ambiguously committed freshness writes can be reported as conflicts. Fold into critical 1 by identifying the current run/node/new-witness write as already recorded and treating it as completed bookkeeping.
- **`silent-failure-hunter-2`** — `retryAsync` logging can abort retry. Guard the diagnostic and add a throwing-logger retry regression.
- **`silent-failure-hunter-3`** — BullMQ error listeners can throw through diagnostics. Use one non-throwing adapter-local logger helper for Redis, Queue, and Worker listeners and pin it with a throwing-logger connection-error test.
- **`silent-failure-hunter-4`** — `startRun` clock exceptions escape. Catch clock contract violations, map them to `internal-invariant-violated`, and add a service regression.
- **`type-design-analyzer-2`** — structural `ActiveTenantConfig` bypasses parsing. Add a private construction brand minted only by `tenantConfig`; registry transitions continue accepting only the parsed type.
- **`comment-analyzer-3`** — RunLease opacity comments overclaim runtime authority. Resolved by critical 4's WeakMap-backed runtime proof and revised contract text.
- **`code-simplifier-2`** — duplicate retry-config fixture. Move the existing helper above `makeCtx` and reuse it there.

### Deferred

- **`type-design-analyzer-3`** — metadata-scoped checkpoint failures share the `NodeId` arm. Sound, but a truthful fix requires an additive persisted-wire discriminant and ADR/codec migration across all checkpoint backends; this remediation does not change that wire format. The residual is already explicit in `checkpoint-address.ts`.
- **`architecture-tech-lead-2`** — effectful `retryAsync` lives under documented-pure `shared/`. Sound, but relocating the scheduler orchestration seam changes module structure/import policy rather than the accepted safety behavior; defer to a dedicated deepening. The throwing-logger correctness defect is fixed now.
- **`architecture-tech-lead-3`** — `RedisPort` is vendor-wide. Sound, but splitting a port used across roughly 128 host references is a cross-subsystem architecture migration requiring consumer-owned ports and fake parity; defer to a dedicated deepening rather than mix it into critical remediation.

### Dismissed

- **`code-simplifier-3`** — extract a worker-lifecycle test harness factory. The repeated setup is scenario-specific test data with materially different override points; hiding it behind another local abstraction would trade visible arrangements for indirection without reducing production risk or representable states.

## Refuted critical findings audit

None. All eight critical findings survived the registered panel. Seven were upheld by all three lenses; `code-simplifier-1` was upheld by reproduction and intent, with security uncertain. The canonical panel evidence remains in `result.json.panel.outcomes` and `transcripts/refutation-slot:*/attempt-1.raw`.

## Support paths outside the frozen review scope

- `packages/framework/src/__tests__/retry-async.test.ts` — regression pin for accepted advisory `silent-failure-hunter-2`.

Every other changed path, including this plan and the remaining regression suites, is inside the frozen 481-path scope.

## Validation

Focused tests after each move, then:

```bash
bun run typecheck
bun run test
```

The registered remediation run must validate successfully before it atomically installs the verified Git index.
