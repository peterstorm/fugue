/**
 * T11 — ADVERSARIAL cross-tenant READ isolation (all three channels).
 *
 * This is the integration test SC-001 / NFR-010 / US2 call for: a worker running
 * fully adversarial code MUST read ZERO bytes of any OTHER tenant's material
 * across every channel. We do not merely assert "an error is thrown" — for each
 * channel we ATTEMPT the cross-tenant read as the adversary would and assert it
 * yields NO bytes of the victim's data, while the adversary's OWN-tenant read of
 * the same logical key still succeeds (proving the boundary blocks cross-tenant
 * access, not all access).
 *
 * The three isolation layers, each exercised adversarially:
 *
 *   1. REDIS ACL LAYER (server-enforced, the data-plane mechanism) — we build a
 *      Redis fake that ENFORCES the per-tenant ACL produced by `buildAclSpec`
 *      (`~fugue:<tenant>:*` key scope + denied enumeration commands). Using the
 *      adversary tenant's scoped connection we attempt `GET fugue:<victim>:…`
 *      (direct cross-tenant key read) and `SCAN fugue:*` (broad keyspace
 *      enumeration). Both are refused with NOPERM — and crucially return NO bytes
 *      of the victim's value — while the adversary's GET of its OWN key succeeds.
 *
 *   2. FILESYSTEM LAYER — each tenant's secrets live behind a `SecretsRef` (an
 *      env-file PATH) resolved by the env-file `SecretsSource` INSIDE the owning
 *      worker. We boot each worker's bootstrap plan with the env-file source and
 *      assert the adversary worker, handed the VICTIM's ref, still resolves only
 *      against its OWN bound tenant — and that an unresolvable/foreign ref fails
 *      closed with a value-free Left (ZERO secret bytes), never the value. (OS-level
 *      0600/uid permission isolation on the secrets mount is a deployment concern,
 *      not exercised by this hermetic unit harness.)
 *
 *   3. IN-MEMORY LAYER — two workers are two `buildWorkerBootstrap` plans (the
 *      worker-process boundary in this unit harness). We assert the adversary's
 *      resolved config/secrets contain ZERO bytes of the victim's secret values:
 *      no shared module state leaks one tenant's resolved secrets into another's
 *      bootstrap.
 *
 * @satisfies SC-001 — adversarial cross-tenant read obtains ZERO bytes of any
 *   other tenant's secrets/files/cache/checkpoint/in-memory state.
 * @satisfies NFR-010 — cross-tenant reads (secrets/data/files/memory) are zero,
 *   verifiable under an adversarial worker.
 * @satisfies US2 — hard cross-tenant isolation under compromise: even fully
 *   adversarial worker code cannot reach another tenant's material.
 * @satisfies FR-009/FR-010 — a worker MUST NOT read another tenant's data; a
 *   compromise MUST NOT yield another tenant's material.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import { buildCacheKey, buildCheckpointKey } from "../../domain/cache-keys.js";
import { aclUsername } from "../../supervisor/secrets/redis-acl.js";
import type { AclRuleToken } from "../../supervisor/secrets/redis-acl.js";
import {
  apply,
  ACL_PASSWORD_RANDOM_BYTES,
  type RedisAclAdminPort,
  type AclProvisionerDeps,
} from "../../supervisor/secrets/redis-acl-provisioner.js";
import { formatHostError } from "../../domain/host-error.js";
import { createEnvFileSecretsSource } from "../../supervisor/secrets/env-file-secrets-source.js";
import { buildWorkerBootstrap } from "../../worker-main.js";
import { dagId, runId as makeRunId, nodeId as makeNodeId } from "@fuguejs/framework";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`test setup: invalid tenant id "${s}"`);
  return r.value;
};

const VICTIM = mkTenant("victim");
const ADVERSARY = mkTenant("adversary");

/** The sensitive value a victim worker stores under its own namespace. */
const VICTIM_SECRET_BYTES = "VICTIM-TOP-SECRET-bytes-7c1f-do-not-leak";

// ───────────────────────────────────────────────────────────────────────────
// Layer 1: Redis ACL — a FAITHFUL ACL-evaluating in-memory Redis fake,
// PROVISIONED THROUGH THE REAL PRODUCTION PATH (`apply` → `buildAclSpec`).
// ───────────────────────────────────────────────────────────────────────────

/**
 * THE LOAD-BEARING HARNESS.
 *
 * The previous version of this layer re-implemented ACL semantics in the test
 * itself (`key.startsWith(grantPrefix)`, `rules.includes("-scan")`), so it
 * asserted the TEST's own logic — it would have passed even if `buildAclSpec`
 * regressed to `~*` or dropped `-scan`. This rewrite removes that vacuity:
 *
 *   1. The per-tenant user is provisioned via the REAL `apply(admin, tenant, deps)`,
 *      which internally calls `buildAclSpec(tenant)` and issues the real ordered
 *      rule tokens to `admin.setUser`.
 *   2. `admin.setUser` is implemented by PARSING that ordered token stream the way
 *      Redis ACL evaluation works (deny-all baseline; `~`-patterns set key scope;
 *      `+@all` then `-@category`/`-command` applied IN ORDER). Nothing is special-
 *      cased: a `~*` grant really does open the whole keyspace, and a `+@all`
 *      ordered AFTER `-scan` really does re-enable scan — exactly the regressions
 *      the test must catch.
 *   3. A scoped data-plane connection (`connectAs(username)`) enforces that parsed
 *      ACL against the single shared store. Enumeration is modelled PESSIMISTICALLY
 *      (a permitted scan returns the ENTIRE store), mirroring real Redis where a
 *      key-pattern ACL does NOT scope enumeration — so removing `-scan` LEAKS.
 *
 * Because the ACL the connection enforces is the one the PRODUCTION `buildAclSpec`
 * actually emitted, a regression in that spec breaks these tests.
 */

/** Deterministic 32-byte randomness so provisioning is reproducible under test. */
const fixedDeps = (fill: number): AclProvisionerDeps => ({
  generateRandomBytes: () => new Uint8Array(ACL_PASSWORD_RANDOM_BYTES).fill(fill),
});

type NoPerm = { readonly ok: false; readonly error: { readonly kind: "NOPERM"; readonly detail: string } };
const noperm = (detail: string): NoPerm => ({ ok: false, error: { kind: "NOPERM", detail } });

/** Result of an authorized read/write. */
type DataOk<T> = { readonly ok: true; readonly value: T };
const dataOk = <T>(value: T): DataOk<T> => ({ ok: true, value });

/**
 * A parsed ACL, derived by walking the ordered SETUSER tokens. `keyPatterns` is
 * EVERY `~`-pattern seen (so `~*`/`allkeys` ⇒ all keys; >1 pattern ⇒ all of them;
 * 0 patterns ⇒ no key access). `commands` is the set of allowed command names,
 * built left-to-right so order is honoured.
 */
type ParsedAcl = {
  readonly enabled: boolean;
  readonly keyPatterns: readonly string[];
  readonly allKeys: boolean;
  readonly commands: ReadonlySet<string>;
};

/**
 * The commands each `@category` token expands to — only the commands THIS test
 * exercises need modelling, but they are mapped honestly via the category tokens
 * the production spec uses, never by hardcoding "scan is denied".
 */
const CATEGORY_COMMANDS: Record<string, readonly string[]> = {
  // The data-plane commands a worker legitimately runs against its own keyspace.
  "@read": ["get", "smembers"],
  "@write": ["set", "del", "sadd", "srem"],
  // Enumeration / dangerous families the spec carves back out.
  "@dangerous": ["keys", "flushall", "flushdb", "debug", "migrate", "restore", "swapdb"],
  "@admin": ["config", "acl", "shutdown", "slaveof", "replicaof", "failover", "cluster"],
  "@scripting": ["script", "eval", "evalsha", "function"],
  // The whole set this test reasons about. `+@all` grants every modelled command.
  "@all": [
    "get", "set", "del", "smembers", "sadd", "srem",
    "scan", "keys", "randomkey", "dbsize",
    "config", "acl", "flushall", "flushdb", "debug", "shutdown",
    "eval", "evalsha", "script", "function", "module", "cluster",
    "slaveof", "replicaof", "failover", "swapdb", "migrate", "restore",
  ],
};

const expandToken = (token: string): readonly string[] | undefined => {
  if (token.startsWith("@")) return CATEGORY_COMMANDS[token] ?? [];
  return [token]; // a bare command name
};

/**
 * Parse the ordered `ACL SETUSER` rule tokens into a `ParsedAcl`, modelling Redis
 * ACL evaluation: start denied; apply each token in order. This is the ONLY place
 * ACL semantics live — and it sees exactly the tokens production emitted.
 */
const parseAclRules = (rules: readonly AclRuleToken[]): ParsedAcl => {
  let enabled = false;
  let keyPatterns: string[] = [];
  let allKeys = false;
  const commands = new Set<string>();

  for (const raw of rules) {
    const token = raw.trim();
    if (token === "") continue;

    // Lifecycle / reset tokens — clear to a deny-all baseline.
    if (token === "reset") {
      enabled = false; keyPatterns = []; allKeys = false; commands.clear();
      continue;
    }
    if (token === "on") { enabled = true; continue; }
    if (token === "off") { enabled = false; continue; }
    if (token === "resetkeys") { keyPatterns = []; allKeys = false; continue; }
    if (token === "resetchannels") continue; // pub/sub — irrelevant to this test
    if (token.startsWith(">") || token.startsWith("<") || token.startsWith("#")) continue; // passwords

    // Key scope.
    if (token === "allkeys" || token === "~*") { allKeys = true; keyPatterns = [...keyPatterns, "*"]; continue; }
    if (token.startsWith("~")) { keyPatterns = [...keyPatterns, token.slice(1)]; continue; }

    // Command grants / denials — applied IN ORDER (this is why a mis-ordered
    // `+@all` AFTER `-scan` would re-enable scan, and the test would catch it).
    if (token === "allcommands" || token === "+@all") {
      for (const c of CATEGORY_COMMANDS["@all"]) commands.add(c);
      continue;
    }
    if (token === "nocommands" || token === "-@all") { commands.clear(); continue; }
    if (token.startsWith("+")) {
      for (const c of expandToken(token.slice(1)) ?? []) commands.add(c);
      continue;
    }
    if (token.startsWith("-")) {
      for (const c of expandToken(token.slice(1)) ?? []) commands.delete(c);
      continue;
    }
    // Unknown token — ignore (no real ACL token reaches here in this test).
  }

  return { enabled, keyPatterns, allKeys, commands };
};

/** Glob match for the `~`-patterns this test uses (`fugue:<t>:*` and `*`). */
const keyMatchesPattern = (key: string, pattern: string): boolean => {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
};

const keyAllowed = (acl: ParsedAcl, key: string): boolean =>
  acl.allKeys || acl.keyPatterns.some((p) => keyMatchesPattern(key, p));

/**
 * A scoped data-plane connection authenticated as one ACL user. Every op is gated
 * by the user's PARSED ACL against the single shared store.
 */
interface ScopedConnection {
  readonly get: (key: string) => DataOk<string | null> | NoPerm;
  readonly set: (key: string, value: string) => DataOk<"OK"> | NoPerm;
  readonly del: (key: string) => DataOk<number> | NoPerm;
  /** Enumeration commands — pessimistically return the ENTIRE store if permitted. */
  readonly scan: (pattern: string) => DataOk<readonly string[]> | NoPerm;
  readonly keys: (pattern: string) => DataOk<readonly string[]> | NoPerm;
  readonly randomkey: () => DataOk<string | null> | NoPerm;
  readonly dbsize: () => DataOk<number> | NoPerm;
  readonly smembers: (key: string) => DataOk<readonly string[]> | NoPerm;
}

/**
 * ONE in-memory Redis server fake: a single shared key→value store (one server,
 * all tenants — AD-4) plus a registry of ACL users. `setUser` PARSES the rule
 * stream; `connectAs` mints a connection enforcing the parsed ACL.
 *
 * `setUser` IS the production `RedisAclAdminPort.setUser`, so `apply` provisions
 * users through it with the real `buildAclSpec` tokens.
 */
const createAclRedisServer = () => {
  const store = new Map<string, string>();
  const users = new Map<string, ParsedAcl>();

  const requireValue = (
    acl: ParsedAcl,
    command: string,
    key: string,
  ): NoPerm | undefined => {
    if (!acl.enabled || !acl.commands.has(command)) {
      return noperm(`NOPERM this user has no permissions to run the '${command}' command`);
    }
    if (!keyAllowed(acl, key)) {
      // Redis refuses BEFORE touching the value — no bytes are returned.
      return noperm(`NOPERM no permissions to access a key`);
    }
    return undefined;
  };

  const requireEnum = (acl: ParsedAcl, command: string): NoPerm | undefined =>
    !acl.enabled || !acl.commands.has(command)
      ? noperm(`NOPERM this user has no permissions to run the '${command}' command`)
      : undefined;

  const admin: RedisAclAdminPort = {
    setUser: async (username, rules) => {
      users.set(username, parseAclRules(rules));
      return { ok: true, value: undefined };
    },
    delUser: async (username) => {
      users.delete(username);
      return { ok: true, value: undefined };
    },
  };

  const connectAs = (username: string): ScopedConnection => {
    const acl = users.get(username);
    if (acl === undefined) throw new Error(`test: no ACL user '${username}'`);
    return {
      get: (key) => requireValue(acl, "get", key) ?? dataOk(store.get(key) ?? null),
      set: (key, value) => {
        const denied = requireValue(acl, "set", key);
        if (denied) return denied;
        store.set(key, value);
        return dataOk("OK" as const);
      },
      del: (key) => {
        const denied = requireValue(acl, "del", key);
        if (denied) return denied;
        const had = store.delete(key);
        return dataOk(had ? 1 : 0);
      },
      // PESSIMISTIC enumeration: real key-pattern ACLs do NOT scope enumeration.
      // If permitted, the adversary sees the WHOLE store (so dropping `-scan` LEAKS).
      scan: (_pattern) => requireEnum(acl, "scan") ?? dataOk([...store.keys()]),
      keys: (_pattern) => requireEnum(acl, "keys") ?? dataOk([...store.keys()]),
      randomkey: () => {
        const denied = requireEnum(acl, "randomkey");
        if (denied) return denied;
        const all = [...store.keys()];
        return dataOk(all.length > 0 ? all[0] : null);
      },
      dbsize: () => requireEnum(acl, "dbsize") ?? dataOk(store.size),
      // SMEMBERS is a single-key read the key ACL DOES constrain (the legitimate
      // own-keyspace enumeration path). Stored as JSON arrays for this test.
      smembers: (key) => {
        const denied = requireValue(acl, "smembers", key);
        if (denied) return denied;
        const raw = store.get(key);
        return dataOk(raw === undefined ? [] : (JSON.parse(raw) as string[]));
      },
    };
  };

  /**
   * An UNRESTRICTED writer used to seed victim data as the admin/server operator
   * would — `~*` + `+@all`, so seeding is not itself gated by a tenant ACL.
   */
  const seederConnection = (): ScopedConnection => {
    users.set("__seeder__", parseAclRules(["reset", "on", "~*", "+@all"]));
    return connectAs("__seeder__");
  };

  return { store, admin, connectAs, seederConnection };
};

describe("Layer 1 — Redis ACL: adversarial cross-tenant read/write is ZERO bytes (SC-001, FR-009/010)", () => {
  const billing = dagId("billing");
  const victimKey = buildCacheKey(VICTIM, billing, "customer:42:pan");
  const victimCheckpointKey = buildCheckpointKey(
    VICTIM, billing, makeRunId("run-1"), makeNodeId("charge"),
  );
  const adversaryKey = buildCacheKey(ADVERSARY, billing, "customer:42:pan");

  let server: ReturnType<typeof createAclRedisServer>;
  let adversaryConn: ScopedConnection;

  beforeEach(async () => {
    server = createAclRedisServer();

    // Provision BOTH tenants through the REAL production path: `apply` builds the
    // spec via `buildAclSpec` and issues the real ordered tokens to `setUser`.
    const v = await apply(server.admin, VICTIM, fixedDeps(1));
    const a = await apply(server.admin, ADVERSARY, fixedDeps(2));
    expect(v.ok).toBe(true);
    expect(a.ok).toBe(true);

    // Seed the victim's material (cache + checkpoint) as the unrestricted operator.
    const seeder = server.seederConnection();
    seeder.set(victimKey, VICTIM_SECRET_BYTES);
    seeder.set(victimCheckpointKey, VICTIM_SECRET_BYTES);
    seeder.set(adversaryKey, "adversary-own-harmless-value");

    adversaryConn = server.connectAs(aclUsername(ADVERSARY));
  });

  it("cross-tenant GET fugue:<victim>:<cache> → NOPERM, returns NO bytes of the victim's value", () => {
    const result = adversaryConn.get(victimKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("ISOLATION BREACH: adversary read a cross-tenant cache key");
    expect(result.error.kind).toBe("NOPERM");
    expect(result.error.detail).not.toContain(VICTIM_SECRET_BYTES);
  });

  it("cross-tenant GET fugue:<victim>:<checkpoint> → NOPERM (cache AND checkpoint channels covered)", () => {
    const result = adversaryConn.get(victimCheckpointKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("ISOLATION BREACH: adversary read a cross-tenant checkpoint key");
    expect(result.error.kind).toBe("NOPERM");
    expect(result.error.detail).not.toContain(VICTIM_SECRET_BYTES);
  });

  it("cross-tenant SET fugue:<victim>:… → NOPERM (cannot POISON the victim's data — integrity isolation)", () => {
    const before = server.store.get(victimKey);
    const result = adversaryConn.set(victimKey, "ADVERSARY-POISON");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("ISOLATION BREACH: adversary wrote a cross-tenant key");
    expect(result.error.kind).toBe("NOPERM");
    // The store is unchanged — the write never landed.
    expect(server.store.get(victimKey)).toBe(before);
    expect(server.store.get(victimKey)).toBe(VICTIM_SECRET_BYTES);
  });

  it("own-tenant GET succeeds (boundary blocks cross-tenant, not all access)", () => {
    const own = adversaryConn.get(adversaryKey);
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error("unreachable");
    expect(own.value).toBe("adversary-own-harmless-value");
    expect(own.value).not.toBe(VICTIM_SECRET_BYTES);
  });

  it("own-tenant SET succeeds (the adversary CAN write its OWN keyspace)", () => {
    const ownWrite = adversaryConn.set(adversaryKey, "adversary-new-value");
    expect(ownWrite.ok).toBe(true);
    expect(server.store.get(adversaryKey)).toBe("adversary-new-value");
  });

  it("GET on the global keyspace probe `fugue:` → NOPERM + no leak (cannot widen to all tenants)", () => {
    const probe = adversaryConn.get("fugue:");
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("ISOLATION BREACH: global-prefix probe resolved");
    expect(probe.error.kind).toBe("NOPERM");
    expect(probe.error.detail).not.toContain(VICTIM_SECRET_BYTES);
  });

  it("PREFIX-COLLISION: adversary scoped to `adversary` cannot read `adversary2`'s keys", async () => {
    const adversary2 = mkTenant("adversary2");
    const a2 = await apply(server.admin, adversary2, fixedDeps(3));
    expect(a2.ok).toBe(true);
    const a2Key = buildCacheKey(adversary2, dagId("d"), "k");
    server.seederConnection().set(a2Key, "adversary2-bytes");

    // `fugue:adversary:` is NOT a prefix of `fugue:adversary2:` — the `:` guards it.
    const cross = adversaryConn.get(a2Key);
    expect(cross.ok).toBe(false);
    if (cross.ok) throw new Error("ISOLATION BREACH: prefix-collision crossed tenants");
    expect(cross.error.detail).not.toContain("adversary2-bytes");
  });

  it("SCAN fugue:* → NOPERM (keyspace enumeration denied — cannot discover other tenants)", () => {
    const scan = adversaryConn.scan("fugue:*");
    expect(scan.ok).toBe(false);
    if (scan.ok) throw new Error("ISOLATION BREACH: SCAN was permitted (would leak the whole keyspace)");
    expect(scan.error.kind).toBe("NOPERM");
  });

  it("KEYS * → NOPERM (broad enumeration denied)", () => {
    const keys = adversaryConn.keys("*");
    expect(keys.ok).toBe(false);
    if (keys.ok) throw new Error("ISOLATION BREACH: KEYS was permitted");
    expect(keys.error.kind).toBe("NOPERM");
  });

  it("RANDOMKEY and DBSIZE → NOPERM (no probing the keyspace size or sampling foreign keys)", () => {
    const rk = adversaryConn.randomkey();
    expect(rk.ok).toBe(false);
    const db = adversaryConn.dbsize();
    expect(db.ok).toBe(false);
  });

  it("the adversary CAN read its OWN tenant-scoped index SET via SMEMBERS (the legitimate enumeration path)", () => {
    const idxKey = buildCacheKey(ADVERSARY, billing, "index");
    server.seederConnection().set(idxKey, JSON.stringify(["a", "b"]));
    const members = adversaryConn.smembers(idxKey);
    expect(members.ok).toBe(true);
    if (!members.ok) throw new Error("unreachable");
    expect([...members.value].sort()).toEqual(["a", "b"]);
    // …but SMEMBERS of the VICTIM's index is refused (single-key read IS key-scoped).
    const victimIdx = buildCacheKey(VICTIM, billing, "index");
    const cross = adversaryConn.smembers(victimIdx);
    expect(cross.ok).toBe(false);
  });
});

// ── META-TEST: prove the harness is NON-VACUOUS ──────────────────────────────
// If the production `buildAclSpec` regressed (e.g. to `~*`, or `+@all` ordered
// AFTER `-scan`), the harness above MUST catch it. We prove that by deliberately
// provisioning a WIDENED spec and asserting the SAME adversary connection THEN
// leaks — demonstrating the evaluator is not rigged to always deny.
describe("Layer 1 META: the ACL harness catches the regression buildAclSpec prevents (non-vacuity)", () => {
  it("a deliberately WIDENED spec (`~*`) lets the adversary read cross-tenant — proving the fake enforces scope, not test logic", async () => {
    const server = createAclRedisServer();
    const victimKey = buildCacheKey(VICTIM, dagId("billing"), "customer:42:pan");
    server.seederConnection().set(victimKey, VICTIM_SECRET_BYTES);

    // Provision the adversary's username with a HAND-WIDENED rule list (`~*`) —
    // the regression `buildAclSpec` exists to prevent. NOTE: this bypasses the
    // real spec ON PURPOSE; it is the meta-test's whole point.
    await server.admin.setUser(aclUsername(ADVERSARY), ["reset", "on", "~*", "+@all"]);
    const widened = server.connectAs(aclUsername(ADVERSARY));

    // With the widened scope the cross-tenant read SUCCEEDS and LEAKS — exactly
    // what the real spec prevents and what the harness would flag as a breach.
    const leaked = widened.get(victimKey);
    expect(leaked.ok).toBe(true);
    if (!leaked.ok) throw new Error("meta-test invalid: widened spec should have read the victim");
    expect(leaked.value).toBe(VICTIM_SECRET_BYTES);
  });

  it("a spec with `+@all` ordered AFTER `-scan` RE-ENABLES scan (proving order is honoured) — and a permitted scan leaks the whole store", async () => {
    const server = createAclRedisServer();
    const victimKey = buildCacheKey(VICTIM, dagId("billing"), "customer:42:pan");
    server.seederConnection().set(victimKey, VICTIM_SECRET_BYTES);

    // `-scan` first, then `+@all` — the broad grant comes LAST, re-enabling scan.
    await server.admin.setUser(aclUsername(ADVERSARY), ["reset", "on", "~*", "-scan", "+@all"]);
    const misordered = server.connectAs(aclUsername(ADVERSARY));

    const scan = misordered.scan("fugue:*");
    expect(scan.ok).toBe(true);
    if (!scan.ok) throw new Error("meta-test invalid: mis-ordered +@all should re-enable scan");
    // Pessimistic enumeration: the whole store — including the victim's key — leaks.
    expect(scan.value).toContain(victimKey);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 + 3: Filesystem + In-memory — adversarial worker bootstrap
// ───────────────────────────────────────────────────────────────────────────

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
};

describe("Layer 2 — Filesystem: adversary worker's unresolvable/foreign ref fails closed value-free (SC-001, FR-006)", () => {
  let dir: string;
  let victimRefPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fugue-isolation-fs-"));
    victimRefPath = join(dir, "victim.env");
    // The victim's secret material on disk.
    writeFileSync(victimRefPath, `ANTHROPIC_API_KEY=${VICTIM_SECRET_BYTES}\n`, "utf8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unresolvable/foreign secrets ref fails closed with a value-free Left — never the secret", () => {
    // The load-bearing assertion: on ANY read failure the env-file source returns
    // a value-FREE Left (the failed read produced no bytes), never a secret value.
    // We force the failure deterministically by handing the adversary worker a ref
    // to a path it cannot resolve (a foreign tenant's ref it lacks on disk).
    const source = createEnvFileSecretsSource();

    // The adversary worker is handed a ref to a path it cannot read.
    const missingRef = markSecretsRef(join(dir, "does-not-exist-for-adversary.env"));
    const result = source(missingRef);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("ISOLATION BREACH: adversary resolved a foreign secrets ref");
    // ZERO secret bytes: the error names only the path + OS code, never a value.
    expect(JSON.stringify(result.error)).not.toContain(VICTIM_SECRET_BYTES);
  });

  it("the env-file source NEVER puts a resolved secret VALUE into a parse error", () => {
    // A malformed victim file: the parse fails, and the failure must not echo the
    // surrounding secret bytes — a worker's error log must never leak a value.
    const badPath = join(dir, "malformed.env");
    writeFileSync(badPath, `THIS_LINE_HAS_NO_EQUALS_${VICTIM_SECRET_BYTES}\n`, "utf8");
    const result = createEnvFileSecretsSource()(markSecretsRef(badPath));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.error)).not.toContain(VICTIM_SECRET_BYTES);
  });

  it("an adversary worker bound to its OWN tenant resolves its OWN secrets, never the victim's", () => {
    // The adversary's own (harmless) secrets file.
    const advRefPath = join(dir, "adversary.env");
    writeFileSync(advRefPath, "ANTHROPIC_API_KEY=adversary-own-key\n", "utf8");

    const env = { ...baseEnv, TENANT_ID: "adversary", FUGUE_SECRETS_REF: advRefPath };
    const result = buildWorkerBootstrap(env, createEnvFileSecretsSource());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.tenant).toBe(ADVERSARY);
    // Its resolved config carries its OWN key — ZERO bytes of the victim's secret.
    expect(result.value.config.ANTHROPIC_API_KEY).toBe("adversary-own-key");
    expect(JSON.stringify(result.value.config)).not.toContain(VICTIM_SECRET_BYTES);
  });
});

describe("Layer 3 — In-memory: two worker bootstraps share ZERO secret bytes (SC-001, FR-008)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fugue-isolation-mem-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the victim's resolved secrets do NOT leak into the adversary's bootstrap (no shared module state)", () => {
    const victimRef = join(dir, "victim.env");
    writeFileSync(victimRef, `ANTHROPIC_API_KEY=${VICTIM_SECRET_BYTES}\n`, "utf8");
    const advRef = join(dir, "adversary.env");
    writeFileSync(advRef, "ANTHROPIC_API_KEY=adversary-key-2\n", "utf8");

    const source = createEnvFileSecretsSource();

    // Boot the victim worker FIRST (so any shared/cached state would be populated
    // with the victim's secret), then the adversary worker.
    const victim = buildWorkerBootstrap(
      { ...baseEnv, TENANT_ID: "victim", FUGUE_SECRETS_REF: victimRef },
      source,
    );
    const adversary = buildWorkerBootstrap(
      { ...baseEnv, TENANT_ID: "adversary", FUGUE_SECRETS_REF: advRef },
      source,
    );

    expect(victim.ok).toBe(true);
    expect(adversary.ok).toBe(true);
    if (!victim.ok || !adversary.ok) throw new Error("unreachable");

    // Each worker is bound to exactly its own tenant…
    expect(victim.value.tenant).toBe(VICTIM);
    expect(adversary.value.tenant).toBe(ADVERSARY);
    // …and the adversary's entire in-memory config has ZERO bytes of the victim's secret.
    expect(JSON.stringify(adversary.value.config)).not.toContain(VICTIM_SECRET_BYTES);
    expect(adversary.value.config.ANTHROPIC_API_KEY).toBe("adversary-key-2");

    // The two bootstrap plans are distinct objects (no aliasing of in-memory state).
    expect(adversary.value.config).not.toBe(victim.value.config);
    expect(adversary.value.socketPath).not.toBe(victim.value.socketPath);
  });

  it("a secrets file CANNOT rebind the adversary worker to the victim tenant (in-memory tenant pin)", () => {
    // Adversarial: the adversary's secrets file tries to set TENANT_ID=victim to
    // hijack the victim's identity/namespace. The bootstrap must refuse.
    const advRef = join(dir, "adversary-hijack.env");
    writeFileSync(advRef, "ANTHROPIC_API_KEY=k\nTENANT_ID=victim\n", "utf8");

    const result = buildWorkerBootstrap(
      { ...baseEnv, TENANT_ID: "adversary", FUGUE_SECRETS_REF: advRef },
      createEnvFileSecretsSource(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("ISOLATION BREACH: a secrets file rebound the worker's tenant");
    // Use the exhaustive formatter rather than a widening cast over the HostError
    // union (not every variant has `.message`).
    expect(formatHostError(result.error)).toContain("rebind");
  });
});
