# PR #41 remediation — review-and-fix round 7

Date: 2026-08-30

Branch: `feat/f3-budget-capability-surface`

Reviewed revision: `7664c5c4c883f28c509c365a1f4e9e84633b4cfd`

Review run: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round7`

Authoritative result: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round7/result.json`

Frozen scope: the 85 paths listed in the authoritative result.

Anticipated support paths outside that scope:

- `.claude/plans/2026-08-30-pr41-remediation-round7.md` — this disposition and validation record.
- `packages/host/src/domain/tenant-id.ts` — cycle-free pure TenantId value-object grammar and smart constructor shared by tenant registration and HostError parsing.
- `packages/host/src/domain/tenant.ts` — re-export and consume the extracted TenantId value object while preserving its existing public import path.

## Binding approach

Apply `rules/architecture.md`, `rules/typescript-patterns.md`, `code-implementer`, and `ts-test-engineer`: branded identifiers are parsed through one value-object constructor per grammar; no unchecked cast reconstructs authority-bearing IDs at the HTTP throw boundary. Preserve the existing information-disclosure policy: safe response discriminants remain actionable while operator-controlled 5xx detail remains server-side. Run `distill` in apply mode after a green focused baseline.

## Surviving critical finding — mandatory

1. **`comment-analyzer-1` — executor test claims an obsolete legacy fast path.**
   - Replace the stale comment with the actual invariant: empty retry limits contribute no retry configuration, so the node runs once through the same single stateful runtime path.
   - No behavior change.

## Advisory dispositions

### Accepted

1. **`type-design-analyzer-1` — `parseHostError` reconstructs branded IDs from arbitrary strings.**
   - Parse every `DagId` and `RunId` field with framework smart constructors before accepting a HostError snapshot.
   - Extract the pure `TenantId` grammar/brand constructor to a cycle-free `tenant-id.ts` value-object module; keep `tenant.ts` as the existing public re-export and HostError-producing registration boundary.
   - Parse `tenant-over-quota.tenant` and `worker-unavailable.tenant` through that constructor.
   - Return a fresh deeply frozen HostError carrying the parsed branded values, not the original string-only snapshot cast.
   - Add malformed/reserved identifier regressions for all identifier-bearing variants while retaining valid-variant parity.

2. **`comment-analyzer-2` — transient reviewer/path wording in the `onBackground` test.**
   - Replace review-history terminology with the durable invariant: the hook receives the guarded finalize promise without delaying the caller.

3. **`code-simplifier-1` — unreachable branded-ID pass-through branches.**
   - Revalidate `NodeContextInit` IDs unconditionally through `runId`/`dagId`; update the comment to state branded strings are erased at runtime and therefore revalidated at this boundary.

4. **`code-simplifier-2` — single-use settlement wrapper.**
   - Inline `record → release → persist` in the sole recordable-usage branch, preserving exact ordering and behavior.

5. **`code-simplifier-3` — remediation-history production comment.**
   - Replace diff archaeology around the cache report helper with only the current invariant: all cache diagnostics use one guarded logger binding.

### Deferred

1. **`architecture-tech-lead-1` — typed `createNodeContextForDag` Result seam.**
   - Requires coordinated HostError additions and HTTP/HITL/host caller migration; a partial dual taxonomy is worse than the current explicit throwing setup seam.

2. **`architecture-tech-lead-2` — split the wide Redis port.**
   - Requires a coordinated consumer-owned port migration across cache, checkpoint, HITL, token/index, lease, spend, fakes, and composition wiring.

3. **`architecture-tech-lead-3` — split capability graph from lifecycle I/O.**
   - Requires a dedicated module/import/test migration across boot, health, shutdown, and client extraction.

### Dismissed

1. **`silent-failure-hunter-1` — expose `dag-disabled.reason` in the 503 response.**
   - Dismissed on security evidence. The response already exposes the actionable, stable `dag-disabled` error code and owning `dagId`, so callers can distinguish intentional disablement from generic faults. The free-form `reason` comes from operator-controlled registration status and can contain internal state; the documented 5xx policy intentionally logs it server-side and redacts it client-side. Exposing it would weaken OWASP-aligned information-disclosure controls without adding a stable machine contract.

## Refuted critical audit

No critical finding was refuted. The sole critical comment finding survived reproduction, intent, and test-coverage review.

## Validation

Focused validation:

```bash
bun test \
  packages/framework/src/__tests__/executor.test.ts \
  packages/framework/src/__tests__/make-node-context-merge.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts \
  packages/host/src/__tests__/domain/tenant.test.ts \
  packages/host/src/__tests__/run-spend-authority.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts
bun run typecheck
bun run check:docs
git diff --check
git diff --no-index --check /dev/null .claude/plans/2026-08-30-pr41-remediation-round7.md
```

Then run the full workspace suite:

```bash
bun run test
```

After a green baseline, run the mandatory `distill` apply pass one move at a time and rerun covering tests after each move. Start registered remediation only after all validation is green; register every actual support path. Loom must install the exact verified index before commit and push.
