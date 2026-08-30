# PR #41 remediation — review-and-fix round 8

Date: 2026-08-30

Branch: `feat/f3-budget-capability-surface`

Reviewed revision: `9e97a107496d405541534694120944759c740d52`

Review run: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round8`

Authoritative result: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round8/result.json`

Frozen scope: the 88 paths listed in the authoritative result.

Anticipated support path outside that scope:

- `.claude/plans/2026-08-30-pr41-remediation-round8.md` — this disposition and validation record.

## Binding approach

Apply `rules/architecture.md`, `rules/typescript-patterns.md`, `code-implementer`, `ts-test-engineer`, and `security-expert`: parse hostile broker containers at the extension seam, return deterministic contract violations through typed non-retriable `Result` errors, accept only canonical HostError records at the throwing HTTP seam, and establish the verified spend root before any lock protocol write. Preserve functional-core/imperative-shell separation and immutable snapshots. Run `distill` in apply mode only after a green focused baseline.

## Surviving critical findings — mandatory

1. **`code-reviewer-1` — hostile successful broker payload escapes the typed boundary.**
   - Parse the complete `mintFor` success container inside the same local broker fence as the call itself.
   - Accept only a non-array object with ordinary own string data properties; snapshot its capability bindings into a fresh frozen own-property record without invoking accessors.
   - Convert null, primitive, accessor-backed, revoked-proxy, and throwing-trap payloads into a typed non-retriable `node-crash` contract violation; emit `node-error` and never call the node.
   - Preserve opaque client/handle values by reference; only the untrusted outer capability bag is snapshotted.
   - Add retry-budget regressions proving a revoked proxy and hostile property trap cause exactly one mint attempt, zero node executions, and a bare non-retriable contract failure rather than `retry-exhausted`.

2. **`silent-failure-hunter-1` — `parseHostError` accepts and returns extra fields.**
   - Require the exact own string-key set for every HostError variant, allowing only `stack` as the optional field of `import-failed`.
   - Reconstruct every accepted variant from canonical fields rather than spreading the parser snapshot.
   - Preserve deep immutability of Zod issue arrays and invariant contexts, canonical smart-constructor parsing for `DagId`, `RunId`, `TenantId`, and `RetryAfterSeconds`, and total behavior for getters/proxies.
   - Add a table-driven regression that appends an extra `dagId`, `runId`, and neutral field to every valid variant and proves rejection, plus HTTP coverage proving a HostError-like 4xx object with extras takes the logged generic 500 path without leaking extras.

3. **`comment-analyzer-1` — SC-003 is mislabeled as an overshoot-by-one rule.**
   - Split the file-level description: FR-W1-004 permits the sequential crossing call; SC-003 uses learned estimate-based reservation accounting and does not promise a one-call bound for first/larger concurrent bursts.
   - No behavior change.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — spend lock writes precede root identity verification.**
   - Re-prove the verified spend root immediately before invoking `withFileLock`, before the lock/fence protocol can create any artifact.
   - Retain identity checks inside and after the critical section; this matches the documented portable-filesystem policy, which narrows but does not claim to eliminate concurrent rename races without descriptor-relative APIs.
   - Strengthen the replacement-root regression to require the replacement directory to remain completely empty: no JSON, lock owner, staging, intent, or fence artifact.

2. **`comment-analyzer-2` — capability-handle injection wording.**
   - State that non-LLM clients may be injected directly while LLM handles are transformed into run-scoped metered/composed facades.

3. **`comment-analyzer-3` — SharedInfra capability injection wording.**
   - Apply the same boot-scoped handle versus run-scoped LLM-facade distinction at the host port.

4. **`comment-analyzer-4` — file path-gate entry-point list omits spend store.**
   - Add the spend-store entry points or make the wording explicitly non-exhaustive; retain one shared path-string invariant.

5. **`comment-analyzer-5` — “C2 fix” remediation archaeology.**
   - Replace it with the durable diagnostic invariant: durability downgrade is observable through one asserted error log.

6. **`code-simplifier-1` — repeated spend-ledger fixtures.**
   - Introduce one local fixture builder for ledger read/add failure behavior and use it in the hydration tests without weakening assertions.

7. **`code-simplifier-2` — opaque `structuredClone` in test budget snapshots.**
   - Snapshot available headroom explicitly, including a frozen ceiling, matching the visible unpriced branch.

8. **`code-simplifier-3` — Redis ledger correction-history comments.**
   - Keep only the current construction-time downgrade contract and the current two-edit diagnostic/type-narrowing constraint.

### Deferred

1. **`type-design-analyzer-1` — branded token/call headroom.**
   - This changes the exported `CeilingHeadroom` contract and all third-party `BudgetCapability` implementations/fixtures. Branding alone cannot runtime-validate an untrusted implementation, so it should be handled as a coordinated public value-object/API migration with smart constructors and a release note rather than a local cast-heavy patch.

2. **`type-design-analyzer-2` — opaque validated `Spend` at the ledger port.**
   - This changes the central exported `Spend` algebra and every producer, ledger adapter, meter transition, codec, and downstream fixture. Adapter-local parsing would not fix the reported structural port type. Handle as a coordinated opaque-value migration so the type itself proves non-negative safe-integer figures without proliferating assertions.

3. **`architecture-tech-lead-1` — typed `createNodeContextForDag` Result seam.**
   - Requires coordinated HostError taxonomy, HTTP, HITL, host composition, factory, and integration-test migration. A partial dual exception/Result taxonomy would weaken rather than deepen this seam.

## Refuted critical audit

No critical finding was refuted. `silent-failure-hunter-1` was challenged by the intent lens because TypeScript unions are structurally open, but it survived reproduction and security review: the throwing HTTP trust seam must distinguish canonical expected failures from HostError-like bugs and must not let arbitrary extra IDs influence response extraction or suppress 4xx diagnostics.

## Validation

Focused validation:

```bash
bun test \
  packages/framework/src/__tests__/per-node-minting.test.ts \
  packages/framework/src/__tests__/file-spend-store.test.ts \
  packages/framework/src/__tests__/file-boundary-error.test.ts \
  packages/framework/src/__tests__/budget-capability.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts \
  packages/host/src/__tests__/llm-meter.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/spend-ledger.test.ts
bun run typecheck
bun run check:docs
git diff --check
git diff --no-index --check /dev/null .claude/plans/2026-08-30-pr41-remediation-round8.md
```

Then run the full workspace suite:

```bash
bun run test
```

After a green baseline, run mandatory `distill` apply mode one move at a time and rerun each covering suite. Start registered remediation only after all validation is green; register every actual path outside frozen scope. Loom must install the exact verified index before commit and push.
