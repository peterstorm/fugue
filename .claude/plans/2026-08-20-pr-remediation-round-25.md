# PR Remediation — Round 25

- **Date:** 2026-08-20
- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-20-051240-f6-file-durable-runtime`
- **Canonical result:** `result.json`, digest `049536c1d3f361e35a2fd278078551871dceba23b7c56b7738373184687b2001`
- **Exact frozen scope:** the 384 literal paths in `result.json.scope`; that canonical array is the authoritative, immutable path list.
- **Review mode:** `all`; no file filter; not a dry run.

## Surviving critical findings — mandatory

1. **`silent-failure-hunter-1` — host bind-abort server stop failure is swallowed**
   - Files: `packages/host/src/host.ts`, `packages/host/src/__tests__/host-uds-bind.test.ts`.
   - Fix: isolate stop-after-bind-failure cleanup behind a total helper. Capture and safely log a `stop()` failure without aborting later cleanup, and include the sanitized stop diagnostic plus “listener may still be live” in the returned `HostError`.
   - Pin: a throwing server stop and throwing logger cannot hide the cleanup failure or throw from the helper.

2. **`silent-failure-hunter-2` — successful Oracle probe hides connection-release failure**
   - Files: `packages/adapter-oracle/src/index.ts`, `packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts`.
   - Fix: arbitrate probe and release outcomes explicitly. Preserve a sanitized primary probe error when both fail; when the probe succeeds and release fails, reject startup with a sanitized release error.
   - Pin: successful probe + failed close rejects; failed probe + failed close preserves the probe error and emits only a best-effort sanitized secondary diagnostic.

3. **`silent-failure-hunter-3` — inconclusive file-lock ownership check silently leaks a lock**
   - Files: `packages/framework/src/file/atomic.ts`, `packages/framework/src/__tests__/file-atomic.test.ts`.
   - Fix: route ownership-token reads after PID mismatch through the existing typed `readReleaseMetadata` gate. Only proven absence or token mismatch is a no-op; unreadable metadata becomes `cache-error(releaseFileLock)` and leaves the lock in place.
   - Pin: foreign/corrupt PID plus throwing token read fails typed and observably.

4. **`comment-analyzer-1` — Oracle “read-only” contract is not enforced**
   - Files: `packages/adapter-oracle/src/index.ts`, `packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts`.
   - Fix: add a pure read-statement parser/smart constructor that accepts Oracle `SELECT`/`WITH` statement shapes after leading comments and rejects DML, DDL, PL/SQL, empty, and unterminated-comment input before either real or fake execution. Correct documentation to state that database grants remain defense-in-depth.
   - Pin: accepted read shapes execute; non-read shapes return non-retriable typed errors and never reach the queryable.

5. **`comment-analyzer-2` — CircuitPermit comments claim impossible linear type guarantees**
   - File: `packages/host/src/domain/circuit-guard.ts`.
   - Fix: make the contract truthful: the brand proves a successful check before `mark*`, but TypeScript cannot prove eventual or single consumption. Remove false “impossible” and “consume” claims without changing behavior.

6. **`comment-analyzer-3` — graceful shutdown can throw through logger calls**
   - Files: `apps/customer-summary/src/shutdown.ts`, `apps/customer-summary/src/__tests__/shutdown.test.ts`.
   - Fix: route `info`/`warn` calls through a never-throwing logging helper so every teardown operation remains independently attempted even with a hostile logger.
   - Pin: a logger whose methods throw does not reject shutdown and all teardown steps still run.

7. **`comment-analyzer-4` — hosted `/summarize` schema is not the standalone contract it claims**
   - Files: `apps/customer-summary/src/dag-registration.ts`, `apps/customer-summary/src/__tests__/host-migration.test.ts`.
   - Fix: make the host route parse the backward-compatible snake-case wire shape (`customer_id`) and transform it into the DAG’s camel-case domain input (`customerId`). Update the comments to describe the boundary adaptation.
   - Pin: snake-case payload parses to camel-case DAG input; camel-case wire input is rejected.

8. **`architecture-tech-lead-1` — corrupt-checkpoint warning contract diverges across adapters and ADR**
   - Files: `packages/framework/src/checkpoint/checkpointer.ts`, `packages/framework/src/checkpoint/redis-checkpointer.ts`, `packages/framework/src/file/checkpointer.ts`, their tests, `docs/adr/0080-*.md`, and `CONTEXT.md`.
   - Fix: deepen the Checkpointer port with one `reportCorruptCheckpointEntry` policy returning `Result`. Both Redis and file loads must return typed `cache-error(load)` if the required warning transport fails; neither may reject raw or silently claim observability.
   - Pin: equivalent hostile-logger cases on both persisted adapters.

## Advisory dispositions

All sound, practical advisories are accepted in this round.

1. **`code-reviewer-1` — accepted.** `closeHitlQueueBackend`’s no-throw cleanup promise is real shutdown behavior; use the framework total renderer and contain a throwing logger. Add hostile-error/logger pins.
2. **`code-reviewer-2` — accepted.** Oracle secondary release diagnostics must not replace the primary statement failure; the same total, guarded Oracle diagnostic helper used for connect will cover query and late-health paths.
3. **`code-reviewer-3` — accepted (co-remediated with critical 2).** This duplicates the successful-probe release leak and is fixed by explicit outcome arbitration.
4. **`silent-failure-hunter-4` — accepted.** A non-finite cache clock is an invalid dependency result, not expiry. Return typed `cache-error(get)` without deleting the entry; pin recovery after the clock becomes finite.
5. **`type-design-analyzer-1` — accepted.** Replace optional-field soup with a union in which namespace-only options are not constructible, while retaining hostile-runtime validation at the file boundary. Add compile-time assertions to the existing codec suite.
6. **`type-design-analyzer-2` — accepted.** Replace ambiguous `corruptNodeIds: string[]` with a discriminated `CorruptCheckpointAddress` union and `corruptNodeAddresses`; Redis emits `node-key`, file emits either `node-key` or `digest-filename`. Update the shared suite, codecs, consumers, docs, and tests atomically; no compatibility alias (pre-release invariant).
7. **`code-simplifier-1` — accepted.** Consolidate the four copied JSON console loggers (the three reported entrypoints plus the same copy in `main-supervisor.ts`) into one shell wiring helper. Keep serialization fallback and sink behavior behind the small interface; test through injected sinks/time.
8. **`code-simplifier-2` — accepted.** Consolidate host LLM provider wiring from `main.ts` and `worker-main.ts` into the same entrypoint-wiring module, retaining lazy Anthropic import and Azure/OpenAI configuration. Test provider selection without network I/O.

## Refuted critical audit

- **Count: 0.** `result.json.refuted_critical_findings` is empty; no finding is being fixed contrary to panel adjudication.
- Panel outcome: 8 surviving criticals. Seven were upheld by reproduction, intent, and security; `comment-analyzer-4` was upheld by reproduction and intent with security uncertain.

## Planned support paths outside frozen review scope

These must be registered when remediation orchestration starts:

- `.claude/plans/2026-08-20-pr-remediation-round-25.md`
- `apps/customer-summary/src/__tests__/shutdown.test.ts`
- `packages/host/src/entrypoint-wiring.ts`
- `packages/host/src/__tests__/entrypoint-wiring.test.ts`
- `packages/host/src/__tests__/host-uds-bind.test.ts`
- `packages/host/src/main-supervisor.ts`

The initial remediation run `remediation-2026-08-20-054426-f6-file-durable-runtime` registered only the plan and two entrypoint-wiring paths, then blocked on the three omitted test/supervisor paths. It was retained and explicitly abandoned as superseded by `remediation-2026-08-20-054500-f6-file-durable-runtime`, whose complete six-path manifest installed the verified index.

## Validation

Targeted while iterating:

```bash
bun test packages/host/src/__tests__/host-uds-bind.test.ts packages/host/src/hitl/__tests__/queue-backend.test.ts packages/host/src/__tests__/entrypoint-wiring.test.ts
bun test packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts
bun test packages/framework/src/__tests__/file-atomic.test.ts packages/framework/src/__tests__/file-checkpointer.test.ts packages/framework/src/__tests__/redis-checkpointer.test.ts packages/framework/src/__tests__/composite-node-key.test.ts packages/framework/src/__tests__/pass-2-remediation.test.ts
bun test apps/customer-summary/src/__tests__/shutdown.test.ts apps/customer-summary/src/__tests__/host-migration.test.ts
bun run --cwd packages/host typecheck
bun run --cwd packages/adapter-oracle typecheck
bun run --cwd packages/framework typecheck
bun run --cwd apps/customer-summary typecheck
```

Final gates:

```bash
bun run typecheck
bun run test
bun run check:docs
```

After green implementation, run the required `distill` apply-mode pass one behavior-preserving move at a time, rerunning covering tests after each move. Then start registered remediation with the exact support paths above, resume to `done`, commit the engine-installed index, and push without force.
