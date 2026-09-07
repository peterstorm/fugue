# PR #46 — round-4 remediation plan

**Branch:** `feat/f1-map-node` (PR #46, *F1 PR-B: the map node — runtime-width fan-out*)
**Review HEAD:** `352563c`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-08T12-00-00Z-standalone-review-r26-pr46`
**Canonical result:** that run's `result.json` — every finding below is read from it, none hand-built.

## Scope (frozen, from the review run)

The `main...HEAD` diff of the branch: `packages/framework/src/{types,nodes,checkpoint,__tests__}`,
`packages/host/src/{adapters,domain,supervisor,ports.ts,main-supervisor.ts}` and their tests,
plus the F1 plan doc and the round-1/2/3 plans.

## Panel outcome

| | count |
|---|---|
| criticals found | 3 |
| refuted | 0 |
| surviving (mandatory) | 3 |
| advisories | 5 |

Refutation panel: 3 lenses (`reproduction`, `intent`, `blast-radius`), model `opus`.
**No finding was refuted.** Verdict detail is recorded per critical below.

---

## Surviving criticals — all mandatory

### C1 — `type-design-analyzer-1` — `packages/framework/src/types/map-width.ts:209`

> `resolveMappedItems`'s `width` (from `field.length`) is never runtime-checked to be a number, so a
> hostile Proxy `length` getter returning an object with a stateful `valueOf` passes the `width > max`
> bound check and then makes the bounded-index copy loop re-coerce a larger value on every iteration,
> reproducibly yielding `items.length` far beyond the declared `maxWidth`.

**Panel:** upheld × 3.
- *reproduction*: `Array.isArray` unwraps a Proxy to its target without invoking traps, so a Proxy over
  `[]` whose `get` trap returns, for `"length"`, an object with a stateful `valueOf` (1 first, then 1e6)
  survives line 187; `width > max` coerces once and reads 1; `for (let i = 0; i < width; i++)` re-invokes
  ToPrimitive every iteration. Array `length` is writable, so no Proxy invariant forces consistency.
- *intent*: the module header states "The bound is enforced against this snapshot" and "A fixed-count
  loop cannot be lengthened by anything the value does afterwards". Nothing documents a decision to
  trust `length` to be numeric — this is a violation of declared intent, not a design choice.
- *blast-radius*: the oversized `items` is consumed by `map.ts:216`, which runs a full child sub-DAG
  (`runDag`) plus a checkpoint write per element — FR-F1-003's spend bound is what is bypassed. The same
  unchecked `width` is written straight into checkpoint meta as `nodeCount` at `map.ts:210`.

This is the **fourth variant of the same defect class** rounds 1–3 each closed once (spread-copy growth,
throwing getters, an unguarded read). Each earlier fix hardened an access that could *throw* or *change*;
none established that the value read is a `number` at all.

**Fix.** Immediately after the `try`/`catch` that reads `field.length`, before any comparison touches it,
add the runtime guard this file's own branded constructors (`asMaxWidth`, `asMapIndex`) already lead with:

```ts
if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 0) {
  return err(frameworkError.mapWidthInvalid(nodeId, from, safeDiagnosticRender(width)));
}
```

Typing the local as `unknown` and narrowing through the guard is what makes the check load-bearing —
a `let width: number` annotation is a compile-time label the guard would be free to elide. After the
guard, `width` is a primitive `number`, so neither `width > max` nor `i < width` can call `valueOf`
again. `mapWidthInvalid` (not `mapWidthExceeded`) is the right refusal: the value is not a width at
all, the same as a non-array field.

**Regression pins** (`packages/framework/src/__tests__/map-width.test.ts`):
1. a `length` getter returning a plain non-number (string, `undefined`, `null`, `{}`) ⇒ `map-width-invalid`;
2. the stateful-`valueOf` exploit verbatim (reports `1`, then `1e6`) ⇒ `map-width-invalid`, and never a
   successful `MappedItems`;
3. a `length` returning a non-safe-integer (`1.5`, `NaN`, `Infinity`, `-1`) ⇒ `map-width-invalid`.

### C2 / C3 — `pr-test-analyzer-1` and `pr-test-analyzer-3` — `packages/host/src/main-supervisor.ts:99`

> `createRedis` wires `attachRedisErrorListener` on both ioredis clients with no test seam to verify it,
> since `createRedis` is unexported and non-injectable.

Both ids carry the identical claim (the reviewer emitted it in the prose body and again in the machine
summary); they are one defect and get one fix.

**Panel:** C2 upheld × 2, uncertain × 1; C3 upheld × 2, uncertain × 1. Neither was refuted, so both
survive and both are mandatory.
- *reproduction*: `createRedis` is a module-private `const` at line 99 that hardcodes
  `await import("ioredis")` and constructs both clients directly — no factory parameter, unlike
  `createRedisConnectivity`'s `createClient?: RedisClientFactory` (`redis-connectivity.ts:449`). No test
  references it, and module-level import is unusable as a seam because the file's last statement is
  `main().catch(...)`, which boots the supervisor and calls `process.exit`.
- *blast-radius*: the two `attachRedisErrorListener` calls guard the process owning the single inbound
  HTTP listener, the admin API, admission, and all three sweep timers for every tenant. An ioredis
  `error` with no listener is thrown by EventEmitter, and this binary registers no `uncaughtException`
  handler — a regression on either line is a host-wide availability event.
- *intent* (the dissenting lens): the file header calls itself a "Side-effecting; never re-exported"
  composition root, which argues the untestable call site is by design; but the same codebase's declared
  pattern is to extract binary wiring into tested seams (`entrypoint-wiring.ts`, `purge-keyspace.ts`,
  `createRedisConnectivity`'s documented "test seam … a unit test injects a fake"). The lens returned
  `uncertain` rather than refuting.

The intent lens's tension is real and the fix resolves it rather than overriding it: a composition root
*should* stay untested — which is precisely the argument for the wiring **not living there**. Building
four ioredis-backed ports is adapter work, and `adapters/redis-connectivity.ts` is where its sibling
already lives.

**Fix.** Extract the bundle into a new exported, factory-injectable adapter module
`packages/host/src/adapters/redis-bundle.ts`, mirroring `createRedisConnectivity`'s shape:

- move `RedisBundle` and `createRedis` (renamed `createRedisBundle` — it builds five ports, not a client)
  out of `main-supervisor.ts`;
- add a trailing `createClient?: RedisClientFactory` parameter defaulting to the dynamic-import ioredis
  factory, so the driver stays out of the module graph for an injecting caller;
- `main-supervisor.ts` keeps only the call, becoming the thin composition root its own header claims.

This satisfies the architecture rule directly: adapters live in `adapters/`, the composition root wires
them, and the port fake is a plain object literal with no mocking framework
(`architecture.md` → *Ports at I/O Boundaries*; `typescript-patterns.md` → *Package Structure*).

**Regression pins** (new `packages/host/src/adapters/__tests__/redis-bundle.test.ts`, an in-memory fake
client — no live Redis), same shape as `redis-connectivity.test.ts`'s "connection-error listener" block:
1. `attachRedisErrorListener` is wired on **both** clients before any command is issued — asserted by
   emitting `error` on each fake and observing the log, with no throw;
2. both clients are constructed with `lazyConnect: true` and `maxRetriesPerRequest: 3`;
3. the `status === "wait"` connect guard fires exactly once per client;
4. `aclAdmin.setUser`/`delUser` issue the exact `ACL SETUSER` / `ACL DELUSER` argv and convert a throw
   into a redacted `HostError`;
5. `auditStream.xAdd` issues `XADD <key> * <field/value…>` and returns the server-assigned id;
6. `pubsub.subscribe` only delivers messages for its own channel;
7. `disconnect` quits both clients.

---

## Advisory dispositions

All five dispositioned autonomously from the evidence, per the skill's default.

### A1 — `pr-test-analyzer-2` — `main-supervisor.ts:144` — **ACCEPTED**

> the pubsub/aclAdmin/auditStream port implementations built inline in the same untestable `createRedis`
> function have no factory-injection seam either.

Same root cause as C2/C3, and the reviewer says so explicitly. Closed by the same extraction — pins 3–7
above cover exactly these three ports. Accepting costs nothing beyond tests already being written.

### A2 — `type-design-analyzer-2` — `redis-checkpointer.ts:257` — **ACCEPTED**

> the meta-deserialize failure path builds a `checkpoint-corrupt` FrameworkError as an inline object
> literal instead of calling the existing `frameworkError.checkpointCorrupt` factory.

Sound and cheap. `frameworkError` is already imported in that file (line 66) and every other error site
in the same function routes through `frameworkError.cacheError`. The literal is type-safe today, but it
is a second construction path for one error kind — a field added to that variant would have one call
site the compiler does not point at. Replace with
`frameworkError.checkpointCorrupt(runId, \`meta deserialize failed: ${safeErrorMessage(e)}\`)`.

### A3 — `code-simplifier-1` — `map-node.test.ts:500` — **ACCEPTED**
### A4 — `code-simplifier-2` — (same claim, no file/line) — **ACCEPTED, duplicate of A3**

> the `createMapNode — D1` describe block duplicates an identical `scope` node and `dag` construction
> verbatim in both tests instead of using the file's own established fixture convention.

True and in-scope: the file already has a `// ── Fixtures ──` section (`childDag`, `ctxWith`, `fanNode`).
Hoist the duplicated `scope` + `dag` into a `scopeThenFan()` fixture beside them. One fix closes both ids.

### A5 — `silent-failure-hunter-1` — `main-supervisor.ts:179` — **DISMISSED**

> `auditStream.xAdd` is the only Redis command in `createRedis`'s factory with no try/catch and no
> `Result` conversion … a thrown ACL denial or dropped connection on XADD becomes an unhandled rejection
> unless the out-of-scope audit-sink wrapper catches it.

Dismissed on evidence, on the condition the reviewer itself named — the wrapper does catch it, and that
is the port's documented contract, not an accident:

1. `AuditStreamPort` (`supervisor/audit/audit-sink-log-redis.ts:35-43`) states it "Returns a plain
   Promise (not a `Result`) because the sink swallows failures internally (never-throw contract) — a
   thrown error here is caught by the sink." The absence of a `Result` here is the contract being
   honoured, not broken; the sibling ports return `Result` because *their* contracts say so.
2. `createRedisStreamAuditSink` wraps the `xAdd` call in `try`/`catch`
   (`audit-sink-log-redis.ts:151-163`), logging via `logAuditFailureWithoutThrowing`, which falls back to
   stderr when the logger is absent or itself throws. The failure is never silent.
3. `auditStream` has exactly one consumer: `main-supervisor.ts:592`,
   `createRedisStreamAuditSink(auditStream, logger)`. There is no path that reaches `xAdd` without that
   catch. (`grep -n "auditStream" packages/host/src/main-supervisor.ts` → lines 95, 179, 194, 223, 592.)

Adding a catch inside the adapter would make it strictly worse: it can only swallow (losing the sink's
audit-failure log) or rethrow (a no-op). The one real residual — a *future* second consumer bypassing
the sink — is already answered by the port's doc comment, which is where that decision belongs.

---

## Validation

There is no `build` script at the workspace root — `typecheck` and `test` are the two gates
(`package.json` scripts: `typecheck`, `test`, `check:docs`, plus infra/eval helpers).

```bash
bun run typecheck   # bun run --filter '*' typecheck
bun run test        # bun run --filter '*' test
```

**Evidence (all after the final edit):**

| gate | result |
|---|---|
| `bun run typecheck` | exit 0, every workspace clean |
| `bun run test` | **exit 0** — `@fuguejs/framework` 3679 tests / 193 files, `@fuguejs/host` 2688 tests / 126 files, all other workspaces green; **0 fail** anywhere |
| `bun test packages/framework/src/__tests__/map-width.test.ts` | 57 pass / 0 fail |
| `bun test packages/host/src/adapters/__tests__/redis-bundle.test.ts` | 16 pass / 0 fail |

**Both new pin sets were proven non-vacuous by reverting their fix:**
- C1 guard removed (width forced back to `number` via casts) ⇒ **11 failures** in `map-width.test.ts`,
  including the stateful-`valueOf` exploit returning `ok` with `items.length` far past `max`.
- one `attachRedisErrorListener(subClient, …)` call removed ⇒ **3 failures** in `redis-bundle.test.ts`.

Both files were restored from backup and re-verified green before proceeding.

## Collateral of the C2/C3 extraction (all inside the frozen scope)

- `main-supervisor.ts` lost `RedisBundle` + `createRedis` (139 lines) and the imports that served only
  them (`RedisAclAdminPort`, `AuditStreamPort`, `attachRedisErrorListener`/`createIoredisRedisPort`,
  `disconnectRedisClients`, `redisOperationFailure`, `redisUrlRedactions`, and the now-unused port types
  on the `./ports.js` import). Required: the workspace `typecheck` runs with `noUnusedLocals`, so a dead
  import is a build failure, not lint noise.
- `redis-connectivity.ts` now **exports** `defaultIoredisFactory`, so the package's two client
  construction sites share one `import("ioredis")` and cannot drift — the same reasoning that already
  made `attachRedisErrorListener` shared rather than repeated.

## Distill pass (apply mode, post-implementation, per the loaded skill)

Green baseline first, one move, re-verified green.

- **Applied — reuse before rewrite** (`redis-bundle.ts`): `aclAdmin.setUser` and `delUser` were two
  eight-line blocks differing only in subcommand and trailing rules. Collapsed onto one `aclCommand`
  path, so the connect guard, the argv shape, and the redacted failure label cannot drift between
  minting a tenant's ACL user and revoking it. Behavior identical; the argv pins above hold it.
- **Skipped — a `dial()` helper for the four `status === "wait"` guards.** The sibling
  `createRedisConnectivity` keeps that guard inline with the comment explaining why re-connecting flaps
  the host to degraded. Extracting it here would hide the invariant behind a name and diverge from the
  sibling — project idiom wins over the line count.
- **Skipped — routing `connectivity.ping` through `redisCall`.** `ping` dials before it commands and
  labels its failure `PING`; folding it in would change the operation label. Behavior-adjacent.
- **Skipped — trimming the C1 guard comment.** It carries the constraint (why `unknown` and not
  `number`, and the exploit shape), and matches this file's established comment density.
- **No wrongness discovered**, and nothing further warranting a `deepen` session: the one interface
  change this round needed was the C2/C3 extraction itself, which the review mandated.

## Support paths (outside the frozen review scope — declared at remediation start)

- `.claude/plans/2026-09-07-pr46-remediation-round4.md` — this plan
- `packages/host/src/adapters/redis-bundle.ts` — the extracted adapter (C2/C3, A1)
- `packages/host/src/adapters/__tests__/redis-bundle.test.ts` — its regression pins
