# Session Handoff — identity-scoped-capabilities (2026-06-11)

Resume point for the `/loom` run on plan `2026-06-10-identity-scoped-capabilities`.
Structured progress lives in `.claude/state/active_task_graph.json`; this file
captures the rich context that the state file does not.

## Status at handoff

- **`current_wave: 4`** (Waves 1–3 complete & gate-advanced; issue #14 has the wave summaries).
- Completed tasks: **T1, T2, T3, T4 (W1), T5 (W2), T6, T7 (W3)** → all `completed`.
- **Next: Wave 4 = T8 (+ T9).** Not started.
- **Verified green at handoff:** framework **1533** pass / 0 fail; host **674** pass / 0 fail; both `tsc --noEmit` clean.
- **EVERYTHING IS UNCOMMITTED** in the working tree, across **two repos**:
  - `~/dev/agentic/fugue` (framework + host)
  - `~/dev/java/keycloakConfigAsCode` (the `fugueplatform` realm package — untracked; modified `ClientPlanBuilder.java`, `Client.java`, `ClientModelPropertyTest.java`).

## What happened this run

1. **T5 was a PHANTOM** — state said `implemented` but no files existed (CapabilityBroker port, Invocation, ScopedCapabilityHandle, pass-through broker were all absent). Re-implemented from scratch in `@fuguejs/framework` + host wiring, then gated. **Lesson: never trust state `implemented` — verify files exist on disk.**
2. **Wave 2 gate** passed; applied 3 advisory fixes (extract `InvocationOrigin` named type; async-rejection test for `createContext`; corrected a pre-existing `dependsOn` doc).
3. **Wave 3 (T6 + T7)** implemented **in parallel** (disjoint files, no shared barrel — safe). Gated with 11 review agents.
4. **Wave 3 gate found 1 genuine blocking CRITICAL** (T7) → fixed + independently re-reviewed, plus 3 cheap advisories. See "Fixes applied" below.

## ⚠️ Operational gotcha: wave-gate "phantom criticals"

The `store-reviewer-findings` SubagentStop hook parses reviewer output by line:
a reviewer that writes `CRITICAL: none` or `CRITICAL: (none)` gets the literal
word **"none" captured as a critical finding**, which BLOCKS `complete-wave-gate`
with `2 critical … T5: none, (none)`.

**Resolution (used 3× this run):** when the real criticals are 0/resolved, clear
the artifacts via the whitelisted helper (advisories are preserved when stdin has
no `ADVISORY:` lines):
```bash
echo '# override: <reason>' | bun ${LOOM_DIR}/engine/src/cli.ts helper store-review-findings --task T5
```
Then re-run `complete-wave-gate`. Use only after confirming the "criticals" are
genuinely parser artifacts or independently-confirmed-resolved.

(Also: GitHub issue comments via `gh` are blocked by the auto-mode classifier, but
`complete-wave-gate` posts the wave summary itself via StateManager — no action needed.)

## Fixes applied this run (beyond the raw task impls)

**Wave 2 (T5):**
- `packages/framework/src/types/capability-broker.ts` — extracted `export type InvocationOrigin`.
- `packages/host/src/__tests__/handlers/run-dag.test.ts` — added async-rejection test for `createContext` (the new failure mode the async migration introduced).
- `packages/framework/src/types/capability-handle.ts` — corrected `dependsOn` doc (`judgeLlm`/`cache` are built-in `NodeContext` fields, not in `SharedInfra`).

**Wave 3 (T6/T7):**
- **[was the blocking CRITICAL]** User `sub` no longer dead-ends. `createNodeContextForDag` now takes `identity: AuthIdentity` and builds `Invocation.origin` via `invocationOriginForIdentity(identity, dagId)` (`user` → `{kind:"user", sub, agentClientId: azp}`; `team`/`admin` → `{kind:"agent", agentClientId: dagId}`). `host.ts` `createContext` threads the identity through instead of discarding `_identity`. Satisfies FR-W3-007 (sub reaches NodeContext). Test in `node-context-factory.test.ts`.
- `jwt-validation.ts` — `validateRealmJwtClaims` rejects non-finite `now` (`NaN`/`Infinity`) → `err(malformed)` (was a latent fail-open: `exp <= NaN` is false → expired token would read valid).
- `errors.ts` — `policy-refusal.agentClientId` made **optional** (was `""` sentinel = representable illegal state). `formatFrameworkError` renders both forms. `capability-scope.ts` omits the field at parse time.
- `token-cache.ts` — corrected wave mislabel in module doc.

## CRITICAL carry-forward notes for Wave 4 (T8)

T8 = the live Keycloak broker. **Read these before starting:**

1. **`Invocation.origin` is ALREADY built from `AuthIdentity`** (done this run in
   `node-context-factory.ts` via `invocationOriginForIdentity`). T8 does **NOT** need
   to construct the origin — it only needs to (a) **select the broker**
   (pass-through vs keycloak) in `host.ts`, and (b) implement the actual
   minting/exchange/audit. Don't redo origin construction.
2. **`agentClientId` on a user origin is currently `azp`** (placeholder). T8 should
   map the run to the **real agent-type Keycloak client** (`fugue-agent-mail` /
   `fugue-agent-sites` from the `fugueplatform` realm) for the actual mint/exchange.
3. **Pure pieces from T6 are ready to consume**: `token-cache.ts`
   (`cacheKey`/`isFresh`/`lookup`, miss = `undefined` not error),
   `capability-scope.ts` (`parseScope` → `DownstreamScope`, operation-narrowed
   handle types `MailSendHandle`/`SitesReadHandle`/`DynamicsReadHandle` with no
   raw-client/token field), and error variants `infra-unreachable` /
   `policy-refusal` / `downstream-denied` in framework `errors.ts`.
4. **The JWT verifier is INJECTED but not yet wired** (`VerifyRealmJwt` port in
   `http/middleware/auth.ts`; `host.ts` currently leaves it undefined so the JWT
   path fails closed). T8/later must wire a real JWKS-backed verifier + set
   `REALM_JWT_ISSUER`/`REALM_JWT_AUDIENCE` (config keys already added).
5. **Fail-closed BEFORE Entra** is the headline invariant: unassigned scope →
   `policy-refusal` with **zero outbound Entra calls** (SC-006 wants a
   network/no-egress assertion in test). Audit (SC-009) must cover 100% of mints
   AND refusals with `sub,azp,runId,nodeId,scope`.
6. **[kc] side of T8**: `ClientStep.java` in `fugueplatform` must ensure the agent
   clients carry the scopes the host integration test uses. The realm package
   already mints `entra-exchange` (aud `api://AzureADTokenExchange`) and assigns
   downstream scopes — T2 over-delivered, so T8/T9's kc work is mostly
   confirmatory (see kc status below).

## Deferred advisories (revisit in Wave 4, where the auth model solidifies)

From the Wave 3 type-design review (all non-blocking, recorded in task
`advisory_findings` for T6/T7):
- **Brand `Subject`/`AuthorizedParty`** for `sub`/`azp` (currently raw `string`;
  same file already brands `TeamToken`/`TokenHash`). Do it before T8 wires them
  into token exchange — a `sub`/`azp` swap is a security-relevant misattribution.
- **Lift the 401-vs-503 fault class into the type** — `JwtVerifyError` mixes
  `invalid`(401) and `unavailable`(503); the mapping is a runtime
  `if kind==="unavailable"` that **fails open to 401** for any future kind. Use an
  exhaustive map.
- **`VerifyRealmJwt` return-type honesty** — port returns typed `RealmJwtClaims`
  but the validator re-parses from `unknown`; type as raw/unknown to keep
  parse-don't-validate honest. Also consider moving the port to `domain/`/`ports.ts`
  (currently in the `http/middleware` shell — inconsistent with `TokenStorePort`).
- **Test strengthening**: middleware-level wrong-iss + malformed-claims + near-JWT
  fall-through cases; `cacheKey` injectivity property; multi-capability host
  byte-identical threading; a broker-`Err` fail-loud test (natural once a real
  failing broker exists in T8).
- **T6**: `parseScope` double-cast (`as MsGraphOperation`) → replace with a
  `op is MsGraphOperation` type guard; add a clock-skew margin in `cacheToken`
  (`expiresAt = storedAt + ttlMs - skewMs`) at T8 wiring.

## keycloakConfigAsCode status (verified by static inspection this run)

- Repo: `~/dev/java/keycloakConfigAsCode`. **No `mvn`/`mvnw`/`gradle` on PATH** —
  use the nix flake: `cd ~/dev/java/keycloakConfigAsCode && nix develop --command bash -c "cd java-configuration && mvn …"`. (Did not run the Java tests this session — user skipped.)
- The `fugueplatform` package (untracked) is **substantively complete and mirrors
  `toolbox`**: `FuguePlatform{Constants,RealmConfig,Environment,RealmConfiguration}`,
  `steps/{Realm,ClientScopes,Client,Validation,Configuration}Step`,
  `AudienceMapper`, `OptionalClientScope`, golden export JSON +
  `FuguePlatformRealmGoldenTest`.
- Already present (T2 over-delivered into T8/T9 territory): 3 optional downstream
  scopes (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`),
  `entra-exchange` scope with hardcoded `api://AzureADTokenExchange` mapper
  (access-token-only), frontend confidential SSO client + `fugue-agent-mail` /
  `fugue-agent-sites` service-account clients with scope grants. Golden test
  asserts SC-012 (both client types, scope mirror, exact audience, single mapper).
- External live-Keycloak test gated behind `EXTERNAL_INTEGRATION_TESTS=true`.

## How to resume

1. (If chosen) commit Waves 1–3 on a branch in both repos for a clean base.
2. Re-invoke loom execution for Wave 4 — spawn T8 (security-agent, depends T6/T7/T2)
   and T9 (Entra runbook + kc golden assertion; `new_tests_required=false`), then
   `/wave-gate`. T8 and T9 are independent → can run in parallel.
3. Watch for the "phantom critical" parser artifact at the gate (see above).
