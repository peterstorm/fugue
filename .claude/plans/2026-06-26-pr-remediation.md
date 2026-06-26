# PR Remediation Plan

**Date:** 2026-06-26
**Branch:** feat/oracle-discount-pricing (both repos)
**Repos:** `fugue` (host + Oracle/CDRator capabilities) and `fugue-dags` (betalinger-rabatter DAG)
**Findings:** 0 critical, 19 advisory (6 review agents). All agents reported zero criticals — the code has earned its prior remediation rounds.

Baseline before fixes: fugue typecheck clean; adapter-oracle 59 / http-auth 65 / host adapters 317 pass; fugue-dags typecheck clean, 67 pass; **live betalinger smoke succeeds end-to-end** against real Oister backends (exact kr savings).

## Fixes to apply

### Fix 1 — Oracle connect-string logged unstripped (security)
- **Source:** silent-failure-hunter
- **File:** `fugue-dags/scripts/betalinger-live.ts:107`
- **Issue:** Logs raw `ORACLE_CONNECT_STRING`; production (`main.ts`/`worker-main.ts`) only ever logs `connectStringHost(...)` to honour the zero-credentials-in-logs invariant (FR-041/SC-008). An operator who embeds `user/pw@host` leaks it.
- **Fix:** Log `connectStringHost(connectString)` instead, reusing the codebase's own stripper.

### Fix 2 — CDRator capability connected but never closed (leak)
- **Source:** code-reviewer (dags)
- **File:** `fugue-dags/scripts/betalinger-live.ts:155-157`
- **Issue:** `finally` closes Oracle only; the CDRator capability's token-refresh/connection resources leak each run.
- **Fix:** `await cdrator.close?.()` in the same `finally`.

### Fix 3 — Smoke script couples to fugue internal file layout
- **Source:** architecture-tech-lead, code-reviewer
- **File:** `fugue-dags/scripts/betalinger-live.ts:69-71` + `fugue/packages/host/src/index.ts`
- **Issue:** Imports `parseHostConfig` / `buildCdratorCapability` by deep path into `fugue`'s internal files; `buildCdratorCapability` isn't on the host's public surface, so there's no package-boundary alternative.
- **Fix:** Export `buildCdratorCapability`, `buildOracleCapability`, `connectStringHost` from `@fuguejs/host`'s `src/index.ts`; repoint the script to import from the public entry (`…/packages/host/src/index.ts`). Coupling drops from "internal layout" to "public entry point".

### Fix 4 — http-auth parse-error branch can leak response body (security)
- **Source:** pr-test-analyzer
- **File:** `fugue/packages/http-auth/src/auth.ts:317,322`
- **Issue:** `mapTokenError("parse", e.message)` interpolates the raw JSON-parse SyntaxError text (V8/Bun echo a snippet of the offending body) and the full zod message into the FrameworkError — a token-endpoint body could carry secrets. The `!response.ok` path already drains-and-discards the body precisely to avoid this.
- **Fix:** Emit a static "malformed JSON response" for the parse failure and only the failing field *paths* (never values) for the schema failure. Add an auth.test.ts case asserting a credential-like token in a malformed body never appears in the error message.

### Fix 5 — fake-Oracle exact match uses bracket access, not own-property
- **Source:** code-reviewer (fugue)
- **File:** `fugue/packages/adapter-oracle/src/index.ts:602`
- **Issue:** Test fixture: a SQL string equal to a prototype key (`"constructor"`, `"toString"`) resolves a phantom route. Test-only, degrades harmlessly to empty, but inconsistent with the own-property guards used deliberately elsewhere.
- **Fix:** `Object.prototype.hasOwnProperty.call(routes, sql)` guard.

### Fix 6 — SQL-truncation test asserts a loose length bound
- **Source:** pr-test-analyzer
- **File:** `fugue/packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts:314`
- **Issue:** Asserts `message.length < longSql.length + 60`; a regression widening truncation to 150 chars still passes.
- **Fix:** Assert the exact `slice(0,100)` boundary — char 101+ of the SQL is absent from the message.

### Fix 7 — keycloak-smoke.sh may abort before the empty-token diagnostic
- **Source:** code-reviewer (fugue)
- **File:** `fugue/scripts/keycloak-smoke.sh:88,119`
- **Issue:** Under `set -euo pipefail`, a failed `curl | jq` inside command substitution aborts before the friendly `[[ -z "$TOKEN" ]]` check.
- **Fix:** Tolerate the substitution failure (`|| true`) so the emptiness check produces the intended diagnostic.

### Fix 8 — next-payment can surface a fabricated "0,00 kr." for an invalid amount
- **Source:** code-reviewer (dags), silent-failure-hunter
- **File:** `fugue-dags/dags/customer-support/summaries/betalinger-rabatter/lib/payment.ts:139-155`
- **Issue:** A future payment whose `amount` is present-but-non-finite/negative is clamped to `0`; with no pass-through string the DAG renders `formatKr(0)` = "0,00 kr." — the exact fabricated 0 the design forbids.
- **Fix:** Fail-closed — omit a future payment whose `amount` is *present* yet non-finite or negative (untrustworthy), mirroring the undateable-payment drop. An *absent* amount keeps its documented 0 fallback (unchanged). Add direct unit tests for `selectNextScheduledPayment`, plus `formatKr` rounding and `computeSaving` raw-vs-formatted desync (none existed — only DAG-level coverage).

## Deferred (documented, not applied this round)

- **Type-only deps to delete capability mirrors** (`dag.ts:156-250`) — type-design + architecture flagged the `OracleCapability`/`AuthedHttpCapability` hand-mirrors (modifier drift merges silently). The real fix adds `@fuguejs/oracle`/`@fuguejs/http-auth` as type-only deps. fugue-dags resolves `@fuguejs/*` from a registry at `^0.2.2`; this needs those packages published at compatible versions + a rewrite of the `declare module` augmentation — cross-package version coordination with real regression surface. Existing compile-time `_Equal` guards + honest in-code comments mitigate today. Belongs in its own change.
- **Branded `Kroner` / subscription-id newtypes** — repo-wide primitive-obsession refactor; legitimate but out of scope for a remediation round.
- **reversion `revertsToKr` ↔ savings catalog-price cross-field refine** — the two are assembled on separate DAG paths; coupling them in types is a design change, not a fix. The DAG already sets `revertsToKr` from `standardPriceKr` correctly.
- **TokenProvider in-flight mint ignores a later `get()`'s AbortSignal** — benign; the in-flight mint is bounded by its own `defaultTimeoutMs`, no hang.
- **prisvarsling narrative shows raw rate-plan KEY not name** — spec-aligned (FR-030 names `newRatePlanKey`); product decision, not a defect.
- **`accountSummary.displayName: null` hard-coded** — intentional (NFR-011, identification only).
- **`as number` casts in `selectNextScheduledPayment`** — guard-correct; cosmetic.

## Validation Commands
```bash
# fugue
cd fugue && bun run typecheck
(cd packages/adapter-oracle && bun test) && (cd packages/http-auth && bun test) \
  && (cd packages/host && bun test src/adapters/__tests__ src/__tests__/config.test.ts)
# fugue-dags
cd fugue-dags && bun run typecheck && bun test tests/
# live end-to-end (VPN + .env.cdrator + .env.betalinger-live)
cd fugue-dags && set -a; source ../fugue/.env.cdrator; source .env.betalinger-live; set +a; bun scripts/betalinger-live.ts
```
