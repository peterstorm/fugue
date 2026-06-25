# PR Remediation Plan

**Date:** 2026-06-25
**Branch:** feat/oracle-discount-pricing
**Findings:** 0 production-critical (2 test-only fakes flagged critical by 1 of 6 agents), 16 advisory
**Scope selected:** Tiers ①+②+③ (config guard + docs, test-fake hardening, test coverage). Tier ④ structural refactors deferred.

## Tier ① — Quick safe wins (guards + docs)

### Fix 1: REALM_JWKS_URL silently ignored when REALM_JWT_ISSUER unset
- **Source:** silent-failure-hunter
- **File:** packages/host/src/domain/config.ts (superRefine), host.ts:497
- **Issue:** Every other paired field is boot-rejected on a half-set pair, but `REALM_JWKS_URL` set alone is silently dropped (host.ts:503 only applies inside the issuer-gated block). Operator believes split-horizon JWKS is wired; it does nothing.
- **Fix:** Add a `superRefine` issue rejecting `REALM_JWKS_URL` present without `REALM_JWT_ISSUER`.

### Fix 2: .env.example mislabeled "CDRATOR-style" comment in Oracle section
- **Source:** comment-analyzer
- **File:** packages/host/.env.example:130
- **Issue:** Comment says "CDRATOR-style easy-connect" inside the Oracle block; it describes Oracle easy-connect (CDRator uses https:// URLs — the opposite).
- **Fix:** Reword to Oracle easy-connect, contrast against CDRATOR_URL.

### Fix 3: REALM_TOKEN_ALGS omits ES512
- **Source:** comment-analyzer, type-design
- **File:** packages/host/src/adapters/realm-jwt-verifier.ts:47
- **Issue:** Allowlist has all RS/PS 256/384/512 but only ES256/ES384 — undocumented asymmetry.
- **Fix:** Add ES512 for symmetry (all asymmetric, all safe against alg-confusion).

## Tier ② — Test-fake hardening (the 2 "criticals", test-only)

### Fix 4: createFakeOracleCapability prefix-match + ignored binds
- **Source:** type-design (CRITICAL), architecture, silent-failure-hunter, pr-test-analyzer
- **File:** packages/adapter-oracle/src/index.ts (~538-592)
- **Issue:** Falls back to `startsWith` longest-prefix matching; binds ignored. A test can pass against a query the real adapter never runs. Invariant is prose-only.
- **Fix:** Default to exact-SQL match; make prefix matching opt-in via explicit route flag. Update affected tests.

### Fix 5: createFakeAuthedHttpCapability "body" in route heuristic
- **Source:** type-design (CRITICAL), silent-failure-hunter, comment-analyzer
- **File:** packages/http-auth/src/index.ts (~302-354)
- **Issue:** `"body" in route` treats any object with top-level `body` as a shaped route — a raw payload containing `body` is silently misread.
- **Fix:** Tagged route ADT (raw vs shaped) so the distinction is explicit. Update affected tests.

## Tier ③ — Test coverage additions

### Fix 6: Production queryable connection-release-on-throw untested
- **Source:** pr-test-analyzer
- **File:** packages/adapter-oracle/src/__tests__/oracle-adapter.test.ts
- **Fix:** Test that `conn.close()` is called after a throwing `conn.execute()` on `client.query()` (pool-leak guard).

### Fix 7: close() happy path (pool.close(0)) untested
- **Source:** pr-test-analyzer
- **Fix:** Test that `close()` after a successful connect drains the pool with `pool.close(0)`.

### Fix 8: cdrator 401 invalidate/re-mint/retry not exercised through real wired provider
- **Source:** pr-test-analyzer
- **File:** packages/host/src/adapters/__tests__/cdrator-capability.test.ts
- **Fix:** Integration-style test: recordingFetch returns 401-then-200; assert the wired provider re-mints.

## Validation Commands
```bash
bun run typecheck
bun test
```

## Deferred (Tier ④ — structural refactors, not in this pass)
- Discriminated config sub-shape to remove `!` assertions (oracle/cdrator-capability)
- Defer require("oracledb") into getPool() to drop the factory test-seam
- Brand Password/ConnectString; discriminate mapTokenError input; markSignatureVerified accept JosePayload
- Shared buildBaseCapabilities helper (main.ts/worker-main.ts duplication)
- Per-capability superRefine extraction
