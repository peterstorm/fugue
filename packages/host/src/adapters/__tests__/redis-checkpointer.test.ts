/**
 * The host's tenant-namespaced `Checkpointer` (F1 PR-B, round-24 C3).
 *
 * What these pin, in one sentence each, because the adapter's whole reason to
 * exist is that the framework's own Redis backend cannot be used here:
 *
 *   - the keys it touches stay inside `fugue:<tenant>:…` (the ACL-scoped
 *     namespace the framework backend's global `chkpt:*` would escape);
 *   - a fan's INDEXED entries survive the round trip under distinct composite
 *     addresses, which is the property the whole feature is for;
 *   - every gate verdict is the framework's, not a local re-encoding;
 *   - every hostile seam — driver, clock, bytes, address — settles typed.
 */

import { describe, it, expect } from "bun:test";
import {
  dagId,
  runId as makeRunId,
  nodeId as makeNodeId,
  mapIndex,
  compositeNodeKey,
  FRAMEWORK_VERSION,
  TTL_SECONDS,
  ok,
  err,
} from "@fuguejs/framework";
import type { NodeState, RunMeta } from "@fuguejs/framework";
import type { RedisPort } from "../../ports.js";
import {
  asCheckpointerRedisPort,
  createNamespacedCheckpointer,
} from "../redis-checkpointer.js";
import {
  buildCheckpointMetaKey,
  buildCheckpointNodesKey,
} from "../../domain/cache-keys.js";
import { tenantId } from "../../domain/tenant.js";
import { collectLogs } from "./fixtures/log-capture.js";

/** The canonical constructor is a smart one; a fixture proves the literal once. */
const mkTenant = (id: string) => {
  const parsed = tenantId(id);
  if (!parsed.ok) throw new Error(`bad tenant ${id}`);
  return parsed.value;
};

const TENANT = mkTenant("eng");
const DAG = dagId("test-dag");
const RUN = makeRunId("run-001");
const NODE = makeNodeId("fan");
const META_KEY = buildCheckpointMetaKey(TENANT, DAG, RUN);
const NODES_KEY = buildCheckpointNodesKey(TENANT, DAG, RUN);

interface HashCall {
  readonly key: string;
  readonly field: string;
  readonly expiresInSec: number | undefined;
}

/**
 * An in-memory `RedisPort` with the two hash primitives, recording every key it
 * is asked for. Strings and hashes are separate maps because Redis's are: a
 * `GET` of a hash key is a type error there, and a fake that blurred them would
 * hide an adapter reaching for the wrong one.
 *
 * `behaviour` is the seam a test swaps to inject a hostile driver AFTER writing
 * real entries through the honest one. It is a mutable holder rather than a
 * reassigned port field because `RedisPort`'s members are `readonly` — and that
 * readonly-ness is the point: production code cannot repoint a driver method
 * mid-run either.
 */
const makeRedis = (seed: {
  readonly strings?: Map<string, string>;
  readonly hashes?: Map<string, Map<string, string>>;
} = {}) => {
  const strings = seed.strings ?? new Map<string, string>();
  const hashes = seed.hashes ?? new Map<string, Map<string, string>>();
  const touched: string[] = [];
  const hashCalls: HashCall[] = [];

  const behaviour: {
    hGetAll: NonNullable<RedisPort["hGetAll"]>;
    hSet: NonNullable<RedisPort["hSet"]>;
    get: RedisPort["get"];
  } = {
    get: async (key) => {
      touched.push(key);
      return ok(strings.get(key) ?? null);
    },
    hGetAll: async (key) => {
      touched.push(key);
      return ok(Object.fromEntries(hashes.get(key) ?? new Map()));
    },
    hSet: async (key, field, value, opts) => {
      touched.push(key);
      hashCalls.push({ key, field, expiresInSec: opts?.expiresInSec });
      const hash = hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      hashes.set(key, hash);
      return ok(undefined);
    },
  };

  const port: RedisPort = {
    get: (key) => behaviour.get(key),
    set: async (key, value) => {
      touched.push(key);
      strings.set(key, value);
      return ok(null);
    },
    del: async () => ok(1),
    scan: async () => ok({ cursor: "0", keys: [] }),
    sAdd: async () => ok(1),
    sRem: async () => ok(1),
    sMembers: async () => ok([]),
    setNx: async () => ok(true),
    compareAndDelete: async () => ok(true),
    hGetAll: (key) => behaviour.hGetAll(key),
    hSet: (key, field, value, opts) => behaviour.hSet(key, field, value, opts),
  };
  return { port, behaviour, strings, hashes, touched, hashCalls };
};

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  dagId: DAG,
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
  nodeCount: 3,
  ...over,
});

const nodeState = (over: Partial<NodeState> = {}): NodeState => ({
  nodeId: NODE,
  output: { value: 1 },
  completedAt: new Date("2026-01-01T00:00:01.000Z"),
  ...over,
});

const subject = (
  redis: RedisPort,
  over: { readonly ttl?: number | undefined; readonly now?: () => number } = {},
) => {
  const { logger, logs } = collectLogs();
  const proven = asCheckpointerRedisPort(redis);
  if (proven === null) throw new Error("fixture port must satisfy the checkpointer port");
  const checkpointer = createNamespacedCheckpointer(
    proven,
    TENANT,
    DAG,
    RUN,
    "ttl" in over ? over.ttl : 900,
    logger,
    over.now !== undefined ? { now: over.now } : {},
  );
  return { checkpointer, logs };
};

// ── The port proof ─────────────────────────────────────────────────────────

describe("asCheckpointerRedisPort", () => {
  it("refuses a port missing either hash primitive, so no half-wired capability exists", () => {
    const { port } = makeRedis();
    const { hSet: _hSet, ...noHSet } = port;
    const { hGetAll: _hGetAll, ...noHGetAll } = port;

    expect(asCheckpointerRedisPort(noHSet)).toBeNull();
    expect(asCheckpointerRedisPort(noHGetAll)).toBeNull();
    expect(asCheckpointerRedisPort(port)).not.toBeNull();
  });
});

// ── The namespace ──────────────────────────────────────────────────────────

describe("createNamespacedCheckpointer — the tenant namespace", () => {
  // The reason this adapter exists rather than the framework's own Redis
  // backend: that one keys `chkpt:<runId>`, which a per-tenant ACL user scoped
  // to `~fugue:<tenant>:*` may not touch, and which collides across tenants.
  it("touches only keys beneath fugue:<tenant>:, never a global chkpt: key", async () => {
    const { port, touched } = makeRedis();
    const { checkpointer } = subject(port);

    await checkpointer.setMeta(RUN, meta());
    await checkpointer.saveNode(RUN, nodeState(), { index: mapIndex(0) });
    await checkpointer.load(RUN);

    expect(touched.length).toBeGreaterThan(0);
    for (const key of touched) {
      expect(key.startsWith(`fugue:${TENANT}:`)).toBe(true);
      expect(key.startsWith("chkpt:")).toBe(false);
    }
    expect(new Set(touched)).toEqual(new Set([META_KEY, NODES_KEY]));
  });

  it("scopes itself to one run — another run's id is refused, never silently served", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);
    const other = makeRunId("run-002");

    for (const result of [
      await checkpointer.load(other),
      await checkpointer.saveNode(other, nodeState()),
      await checkpointer.setMeta(other, meta()),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("cache-error");
        if (result.error.kind === "cache-error") {
          expect(result.error.message).toContain("run-002");
        }
      }
    }
  });
});

// ── The round trip ─────────────────────────────────────────────────────────

describe("createNamespacedCheckpointer — save and load", () => {
  it("returns null for a run with no metadata record, so a fresh run is not a failure", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);

    const loaded = await checkpointer.load(RUN);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toBeNull();
  });

  it("round-trips metadata, stamping the writing framework's version", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);

    expect((await checkpointer.setMeta(RUN, meta({ subject: "cust-7" }))).ok).toBe(true);
    const loaded = await checkpointer.load(RUN);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
    expect(loaded.value.meta.dagId).toBe(DAG);
    expect(loaded.value.meta.nodeCount).toBe(3);
    expect(loaded.value.meta.subject).toBe("cust-7");
    expect(loaded.value.meta.frameworkVersion).toBe(FRAMEWORK_VERSION);
    expect(loaded.value.corruptNodeAddresses).toEqual([]);
  });

  // THE feature property: a fan's indices are separately addressable, so a
  // resumed run can tell index 2 from index 5 and re-execute only what is
  // missing. One save overwriting another is the failure ADR-0075 exists for.
  it("keeps each fan index under its own composite address", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta());

    for (const index of [0, 1, 2]) {
      const saved = await checkpointer.saveNode(
        RUN,
        nodeState({ output: { value: index * 10 } }),
        { index: mapIndex(index) },
      );
      expect(saved.ok).toBe(true);
    }

    const loaded = await checkpointer.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");

    const keys = [0, 1, 2].map((i) => compositeNodeKey(NODE, { index: mapIndex(i) }));
    expect(new Set(Object.keys(loaded.value.nodes))).toEqual(new Set(keys));
    expect(loaded.value.nodes[keys[1]!]?.output).toEqual({ value: 10 });
    // The entry's identity is still the real node; the KEY is the address.
    expect(loaded.value.nodes[keys[2]!]?.nodeId).toBe(NODE);
    expect(loaded.value.nodes[keys[2]!]?.completedAt).toEqual(
      new Date("2026-01-01T00:00:01.000Z"),
    );
  });

  it("folds a save with no index onto the bare nodeId, so pre-fan entries keep their address", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta());
    await checkpointer.saveNode(RUN, nodeState());

    const loaded = await checkpointer.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(loaded.value.nodes)).toEqual([NODE as string]);
  });

  it("applies the per-DAG checkpoint TTL to the nodes hash, and the port contract when absent", async () => {
    const withOverride = makeRedis();
    await subject(withOverride.port, { ttl: 900 }).checkpointer.saveNode(RUN, nodeState());
    expect(withOverride.hashCalls[0]?.expiresInSec).toBe(900);

    const withoutOverride = makeRedis();
    await subject(withoutOverride.port, { ttl: undefined }).checkpointer.saveNode(RUN, nodeState());
    // Not "no expiry": an immortal checkpoint key is a retention defect.
    expect(withoutOverride.hashCalls[0]?.expiresInSec).toBe(TTL_SECONDS);
  });
});

// ── The gates, which belong to the framework ───────────────────────────────

describe("createNamespacedCheckpointer — load gates", () => {
  it("refuses a checkpoint written by a different framework version (ADR-0017)", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta({ frameworkVersion: "0.0.0-ancient" }));

    const loaded = await checkpointer.load(RUN);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-version-mismatch");
  });

  it("refuses a re-shaped DAG when a fingerprint is expected (FR-026)", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta({ dagFingerprint: "shape-a" }));

    const loaded = await checkpointer.load(RUN, { expectedDagFingerprint: "shape-b" });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-version-mismatch");
  });

  it("expires a checkpoint older than the port's TTL contract (FR-027)", async () => {
    const { port } = makeRedis();
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const { checkpointer } = subject(port, { now: () => clock });
    await checkpointer.setMeta(RUN, meta());

    clock += (TTL_SECONDS + 1) * 1000;
    const loaded = await checkpointer.load(RUN);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-expired");
  });

  // Failure PRECEDENCE, not just failure: a broken clock must never mask a
  // version mismatch, which is why the gate evaluator takes the clock as a
  // thunk rather than a value.
  it("reports a version mismatch even when the clock is hostile", async () => {
    const { port } = makeRedis();
    const { checkpointer } = subject(port, {
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    await checkpointer.setMeta(RUN, meta({ frameworkVersion: "0.0.0-ancient" }));

    const exploding = subject(port, {
      now: () => { throw new Error("clock exploded"); },
    });
    const loaded = await exploding.checkpointer.load(RUN);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-version-mismatch");
  });

  it("settles a throwing clock as a typed cache-error, never a raw rejection", async () => {
    const { port } = makeRedis();
    await subject(port).checkpointer.setMeta(RUN, meta());

    const { checkpointer } = subject(port, {
      now: () => { throw new Error("clock exploded"); },
    });
    const loaded = await checkpointer.load(RUN);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("cache-error");
  });

  it("settles a non-representable clock closed rather than voiding the expiry check", async () => {
    // A NaN timestamp makes `now - createdAt > TTL` always false, which would
    // silently disable FR-027 rather than fail.
    const { port } = makeRedis();
    const { checkpointer } = subject(port, { now: () => Number.NaN });

    const written = await checkpointer.setMeta(RUN, meta());
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error.kind).toBe("cache-error");
  });
});

// ── Hostile bytes and hostile drivers ──────────────────────────────────────

describe("createNamespacedCheckpointer — totality", () => {
  it("reports unreadable metadata as checkpoint-corrupt", async () => {
    const { port } = makeRedis({ strings: new Map([[META_KEY, "not-json{{{"]]) });
    const loaded = await subject(port).checkpointer.load(RUN);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-corrupt");
  });

  it("rejects metadata whose record grammar drifted, rather than serving it as valid", async () => {
    // A negative nodeCount is JSON-legal and domain-illegal. The framework's
    // shared record parser owns this verdict; the point of the test is that
    // this backend routes through it instead of trusting the bytes.
    const { port } = makeRedis({
      strings: new Map([[META_KEY, JSON.stringify({
        dagId: "test-dag",
        startedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        nodeCount: -1,
        frameworkVersion: FRAMEWORK_VERSION,
      })]]),
    });
    const loaded = await subject(port).checkpointer.load(RUN);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("checkpoint-corrupt");
  });

  it("drops ONE corrupt node entry, names its address, and keeps the rest", async () => {
    const good = compositeNodeKey(NODE, { index: mapIndex(0) });
    const bad = compositeNodeKey(NODE, { index: mapIndex(1) });
    const { port, behaviour } = makeRedis();
    const { checkpointer, logs } = subject(port);
    await checkpointer.setMeta(RUN, meta());
    await checkpointer.saveNode(RUN, nodeState({ output: "kept" }), { index: mapIndex(0) });
    await checkpointer.saveNode(RUN, nodeState(), { index: mapIndex(1) });

    // Corrupt exactly one field after the fact, the way drifted bytes arrive.
    behaviour.hGetAll = async () => ok({ [good]: JSON.stringify({
      nodeId: NODE, output: "kept", completedAt: "2026-01-01T00:00:01.000Z",
    }), [bad]: "not-json{{{" });

    const loaded = await checkpointer.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(loaded.value.nodes)).toEqual([good]);
    expect(loaded.value.corruptNodeAddresses).toEqual([{ kind: "node-key", nodeKey: bad }]);
    // "Never ran" and "ran but unreadable" must be distinguishable to an
    // operator too, not only to the caller.
    expect(logs.some((l) => l.level === "warn" && l.msg.includes(bad))).toBe(true);
  });

  it("defines a __proto__ entry as an own property rather than re-parenting the node map", async () => {
    // `__proto__` matches ID_PATTERN, so it is a legal nodeId and therefore a
    // legal canonical hash field. Plain assignment would hit the prototype
    // SETTER and silently drop the entry.
    const { port, behaviour } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta());
    // Built by parsing JSON TEXT, not from an object literal. `{ __proto__: x }`
    // — and `JSON.stringify` of one — set the prototype instead of defining an
    // own property, so either shortcut hands the adapter an empty hash and the
    // test passes vacuously. `JSON.parse` defines an own property, which is the
    // shape real corrupt-or-hostile bytes arrive in.
    const entry = JSON.stringify({
      nodeId: "__proto__", output: 1, completedAt: "2026-01-01T00:00:01.000Z",
    });
    behaviour.hGetAll = async () =>
      ok(JSON.parse(`{"__proto__": ${JSON.stringify(entry)}}`) as Record<string, string>);

    const loaded = await checkpointer.load(RUN);
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
    expect(Object.hasOwn(loaded.value.nodes, "__proto__")).toBe(true);
    expect(loaded.value.nodes["__proto__"]?.output).toBe(1);
  });

  it("refuses a malformed composite address WITHOUT issuing a write", async () => {
    const { port, hashCalls } = makeRedis();
    const { checkpointer } = subject(port);

    const saved = await checkpointer.saveNode(
      RUN,
      nodeState(),
      // `@` is outside the address grammar, so this cannot be encoded. Folding
      // it to the canonical key would overwrite a sibling index instead.
      { namespace: "not@legal", index: mapIndex(0) },
    );

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.kind).toBe("checkpoint-write-failed");
    expect(hashCalls).toEqual([]);
  });

  it("refuses an unserializable node output WITHOUT issuing a write", async () => {
    const { port, hashCalls } = makeRedis();
    const { checkpointer } = subject(port);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const saved = await checkpointer.saveNode(RUN, nodeState({ output: cyclic }));

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.kind).toBe("cache-error");
    expect(hashCalls).toEqual([]);
  });

  // Both failure SHAPES a driver can present, because the adapter must convert
  // each and only one of them is visible in the port's type. A rejecting driver
  // was a real escape until this pair caught it: `RedisPort` DECLARES a
  // `Result`, so an unguarded `await` looks total and is not.
  const hostileHSet: Record<string, NonNullable<RedisPort["hSet"]>> = {
    "returns an Err": async () => err({ kind: "redis-unavailable", operation: "HSET: down" }),
    "rejects": () => Promise.reject(new Error("socket closed")),
  };

  for (const [label, failing] of Object.entries(hostileHSet)) {
    it(`turns a driver that ${label} into a typed error on saveNode`, async () => {
      const { port, behaviour } = makeRedis();
      behaviour.hSet = failing;
      const { checkpointer } = subject(port);

      // A raw rejection would escape `saveNode`'s `Result` contract — and then
      // the map node's `run`, which has the same one. The catch arm is what
      // distinguishes "returned an Err" from "threw"; without it both spellings
      // of failure would satisfy a bare `.ok === false`.
      const saved = await checkpointer
        .saveNode(RUN, nodeState())
        .catch((error: unknown) => ({ ok: false as const, error, raw: true }));

      expect("raw" in saved).toBe(false);
      expect(saved.ok).toBe(false);
    });
  }

  it("turns a failing metadata read into a typed cache-error", async () => {
    const { port, behaviour } = makeRedis();
    behaviour.get = async () => err({ kind: "redis-unavailable", operation: "GET: down" });
    const loaded = await subject(port).checkpointer.load(RUN);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.kind).toBe("cache-error");
      if (loaded.error.kind === "cache-error") {
        expect(loaded.error.message).toContain("down");
      }
    }
  });

  it("turns a failing nodes read into a typed cache-error", async () => {
    const { port, behaviour } = makeRedis();
    const { checkpointer } = subject(port);
    await checkpointer.setMeta(RUN, meta());
    behaviour.hGetAll = async () => err({ kind: "redis-unavailable", operation: "HGETALL: down" });

    const loaded = await checkpointer.load(RUN);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.kind).toBe("cache-error");
  });
});
