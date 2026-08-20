# PR Remediation — 2026-08-20

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260820T071638Z-5dce674c-24a5-43c9-b4a0-9acb9a09f8e5`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260820T071638Z-5dce674c-24a5-43c9-b4a0-9acb9a09f8e5/result.json`
- Canonical result digest: `84527524a06cbd6f122e739f3cb40e39948a546bc1ed565e6d16453887ec2f73`
- Exact frozen scope: the 398 literal paths in `result.json.scope`; no review finding, scope path, or adjudication was reconstructed outside the canonical result.
- This plan supersedes the earlier same-day plan authority because the latest standalone run reviewed that remediation's complete dirty state.
- Required support paths outside the frozen scope:
  - `packages/framework/src/__tests__/ids.test.ts`
  - `packages/http-auth/README.md`

## Mandatory surviving critical findings

1. **`code-reviewer-1` — health checks can join an unbounded in-flight mint**
   - Add an uncached, non-deduplicated `TokenProvider.probe(signal)` operation that never reads or populates the request cache.
   - Make `healthCheckWithTimeout` race that probe against an independent hard deadline and abort as best-effort cleanup, so even a fetch that ignores `AbortSignal` settles unhealthy on time.
   - Pin both an already-pending cached mint and a signal-ignoring probe; prove the late probe cannot repopulate or invalidate the request cache.

2. **`silent-failure-hunter-1` — request-body serialization is misclassified as transport failure**
   - Serialize request bodies before entering the fetch/network `try`.
   - Return a secret-free, non-retriable `node-crash` for cyclic, `BigInt`, or throwing serialization inputs; never invoke fetch for malformed payloads.
   - Add behavior tests for cyclic and `BigInt` bodies.

3. **`silent-failure-hunter-2` — token clock failures escape or poison expiry**
   - Introduce one guarded finite epoch-ms clock read returning `Result`.
   - Use it for mint expiry and cached-token freshness; reject throwing/non-finite clocks as secret-free, deterministic, non-retriable token-provider errors.
   - Reject non-finite computed expiry values and add mint-time, cached-read, `NaN`, and `Infinity` regressions.

4. **`type-design-analyzer-1` — Redis freshness decode mints an invalid witness value**
   - Parse persisted witness values as non-empty strings before branding; do not pass untrusted bytes directly to `__brandWitness`.
   - Replace the existing empty-value acceptance test with rejection coverage for empty and non-string values, and pin fail-closed `findConflict` behavior.

5. **`comment-analyzer-1` — digest-addressing comment overclaims collision freedom**
   - Correct the file checkpointer documentation to state SHA-256 collision resistance rather than mathematical injectivity; retain the actual stored-key digest verification behavior without claiming impossible collision freedom.

6. **`comment-analyzer-2` — authenticated client can leak token-provider rejections**
   - Normalize rejected `TokenProvider.get()` calls into a secret-free, non-retriable `node-crash` Result before both initial send and 401 retry.
   - Guard `invalidate()` as part of the same no-exception capability contract.
   - Add plain-fake regressions for first-get rejection, refresh-get rejection, and invalidation throws.

7. **`architecture-tech-lead-1` — `FileJob` is not substitutable for `JobLike`**
   - Restore `FileJob` as a structural extension/alias of the kernel `JobLike` contract so mutable-container state is assignable at the adapter seam.
   - Expose recursive static immutability through a separate file-specific `readFileJobSnapshot` helper and `FileJobSnapshot` type, while keeping the existing deep-frozen runtime getter.
   - Add compile-time substitutability and `job.updateData(job.data)` round-trip pins for nested mutable containers.

## Advisory dispositions

All eight advisories are dispositioned autonomously from the canonical evidence.

1. **`code-reviewer-2` — accepted.** It is the caller-visible half of mandatory `architecture-tech-lead-1`; the separate immutable snapshot helper makes the public round-trip compile without weakening runtime immutability.
2. **`code-reviewer-3` — accepted.** Wrapping each `quit()` call in an async boundary is a complete, low-risk fix that preserves the documented attempt-every-close contract; add a synchronously throwing first-target regression.
3. **`pr-test-analyzer-2` — accepted.** It directly pins mandatory `code-reviewer-1`, including a mint/probe that ignores cancellation.
4. **`type-design-analyzer-2` — accepted.** `__brandDagId` is a validating internal constructor, so it must apply the DagId-specific no-colon grammar rather than the wider generic ID grammar; add direct smart/internal constructor parity tests.
5. **`comment-analyzer-3` — accepted.** Remove review-round identifiers from the three production comments while retaining durable behavioral rationale.
6. **`code-simplifier-1` — accepted.** The timeout cleanup sequence already has two real callers with identical semantics; one private helper improves locality without changing either public interface or error construction.
7. **`code-simplifier-2` — accepted.** Replace the three hand-built `DagMachineContext` values with the existing `testRuntimeContext` fixture and explicit overrides; assertions and behavior remain unchanged.
8. **`code-simplifier-3` — accepted.** Replace the nested ternary with a flat exhaustive `switch`, preserving the injective Mermaid encoding byte-for-byte.

No advisory is deferred or dismissed.

## Refuted critical audit — retain, never fix

### `pr-test-analyzer-1` — declarative bootstrap allegedly lacks behavioral tests

- **Disposition:** refuted; no remediation.
- **Reproduction panel evidence:** `packages/host/src/__tests__/supervisor/bootstrap/run-bootstrap.test.ts` covers mounted-file precedence, fail-closed reads, dual-store reconciliation, rotation, cross-team reuse, unknown teams, and secret-safe errors; `parse-bootstrap.test.ts` covers malformed input, canonicalization, canonical duplicates, and secret-safe parser diagnostics.
- **Security panel evidence:** the same suites directly cover both token stores, rotation, idempotency, unknown teams, duplicate-token fail-closed behavior, file precedence, unreadable files, canonicalization, and secret-free errors.
- **Intent lens:** uncertain only because that lens could not establish tests elsewhere; the two evidence-bearing lenses met the panel threshold for refutation.

## Planned touched paths

- `.claude/plans/2026-08-20-pr-remediation.md`
- `packages/http-auth/README.md` (support path)
- `packages/http-auth/src/auth.ts`
- `packages/http-auth/src/client.ts`
- `packages/http-auth/src/index.ts`
- `packages/http-auth/src/__tests__/auth.test.ts`
- `packages/http-auth/src/__tests__/client.test.ts`
- `packages/http-auth/src/__tests__/index.test.ts`
- `packages/framework/src/checkpoint/redis-freshness-index.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/file/checkpointer.ts`
- `packages/framework/src/file/job.ts`
- `packages/framework/src/file.ts`
- `packages/framework/src/__tests__/file-job.test.ts`
- `packages/framework/src/types/ids.ts`
- `packages/framework/src/__tests__/ids.test.ts` (support path)
- `packages/framework/src/queue-bullmq/event-log.ts`
- `packages/host/src/entrypoint-wiring.ts`
- `packages/host/src/__tests__/entrypoint-wiring.test.ts`
- `packages/host/src/adapters/git-sync.ts`
- `packages/host/src/__tests__/git-sync.test.ts` (validation; no behavior change expected)
- `packages/framework/src/__tests__/pass-2-remediation.test.ts`
- `packages/framework/src/cli/visualize.ts`
- `packages/framework/src/__tests__/cli/visualize.test.ts` (validation; encoding remains byte-identical)

## Validation

The focused baseline was green before remediation: 158 tests across the eight directly affected suites.

Run coherent focused gates after each move, then full repository gates:

```bash
bun test packages/http-auth/src/__tests__/auth.test.ts packages/http-auth/src/__tests__/client.test.ts packages/http-auth/src/__tests__/index.test.ts
bun test packages/framework/src/__tests__/redis-freshness-index.test.ts packages/framework/src/__tests__/file-job.test.ts packages/framework/src/__tests__/ids.test.ts
bun test packages/host/src/__tests__/entrypoint-wiring.test.ts packages/host/src/__tests__/git-sync.test.ts
bun test packages/framework/src/__tests__/pass-2-remediation.test.ts packages/framework/src/__tests__/cli/visualize.test.ts packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts
bun run check:docs
bun run typecheck
bun run test
```

After the implementation is green, run the mandatory `distill` apply-mode pass one move at a time with covering tests, then start registered remediation with both support paths declared above. The orchestration engine—not the parent—must audit, stage, verify, and atomically install the exact index before commit and push.
