/**
 * Redis tenant registry adapter tests (FR-022, FR-023, FR-024, AD-5).
 *
 * Uses the in-memory Redis/pub-sub fake (no real Redis). Covers:
 *   - round-trip persist/read of `fugue:tenants:<id>` (secrets reference only),
 *   - pub/sub event emission on each mutation,
 *   - fail-closed behavior when the RedisPort returns `!ok` — surfaces a
 *     redis-disconnected/unavailable HostError, fires the degraded hook, does
 *     NOT throw, and does NOT advance the in-memory view.
 */

import { describe, it, expect } from "bun:test";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { tenantConfig } from "../../../supervisor/registry/tenant-registry.js";
import type {
  ActiveTenantConfig,
  TenantConfigBase,
} from "../../../supervisor/registry/tenant-registry.js";
import {
  createRedisTenantRegistry,
  createInMemoryRedisFake,
  subscribeTenantEvents,
  TENANT_KEY_PREFIX,
  TENANT_EVENTS_CHANNEL,
} from "../../../supervisor/registry/redis-registry-adapter.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error("bad id");
  return r.value;
};

const makeConfig = (id: string, overrides: Partial<TenantConfigBase> = {}): ActiveTenantConfig => {
  const r = tenantConfig({
    id: tid(id),
    team: `${id}-team`,
    keycloakClientMapping: { realm: "fugue", clientId: `${id}-client`, agentClientIdsByDag: { "lead-desk": `${id}-agent` } },
    fsRoot: `/srv/${id}`,
    dagsRoot: `/dags/${id}`,
    secretsRef: markSecretsRef(`vault://${id}/secrets`),
    admission: { maxConcurrentRuns: 4, maxQueuedRuns: 8 },
    eagerPin: false,
    ...overrides,
  });
  if (!r.ok) throw new Error("bad config");
  return r.value;
};

describe("redis tenant registry — round-trip persistence", () => {
  it("persists fugue:tenants:<id> and hydrates it back", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const cfg = makeConfig("acme");

    const res = await reg.register(cfg, 1000);
    expect(res.ok).toBe(true);

    // Key is exactly fugue:tenants:acme
    expect(fake.store.has(`${TENANT_KEY_PREFIX}acme`)).toBe(true);

    // Persisted record carries the secrets REFERENCE, never a value.
    const raw = fake.store.get(`${TENANT_KEY_PREFIX}acme`)!;
    const parsed = JSON.parse(raw);
    expect(parsed.secretsRef).toBe("vault://acme/secrets");
    expect(parsed.id).toBe("acme");
    // dagsRoot is persisted (it is load-bearing config the worker spawns with).
    expect(parsed.dagsRoot).toBe("/dags/acme");

    // Fresh adapter hydrates the same config from Redis.
    const reg2 = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const hydrated = await reg2.hydrate();
    expect(hydrated.ok).toBe(true);
    const look = reg2.lookup(tid("acme"));
    expect(look.ok && look.value.fsRoot).toBe("/srv/acme");
    // dagsRoot survives the round-trip — without it the rehydrated worker would
    // fall back to the inherited pod-wide DAGS_LOCAL_PATH (the whole tree).
    expect(look.ok && look.value.dagsRoot).toBe("/dags/acme");
  });

  it("in-memory lookup is fail-closed for unknown tenant", () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const look = reg.lookup(tid("ghost"));
    expect(look.ok).toBe(false);
    if (!look.ok) expect(look.error.kind).toBe("tenant-unknown");
  });
});

describe("redis tenant registry — pub/sub emission (AD-5)", () => {
  it("publishes a 'registered' event on register", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    expect(fake.published.length).toBe(1);
    expect(fake.published[0].channel).toBe(TENANT_EVENTS_CHANNEL);
    expect(JSON.parse(fake.published[0].message)).toEqual({ kind: "registered", tenant: "acme" });
  });

  it("publishes a 'deregistered' event on deregister", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    fake.published.length = 0;
    await reg.deregister(tid("acme"), 1500);
    expect(fake.published.length).toBe(1);
    expect(JSON.parse(fake.published[0].message)).toEqual({ kind: "deregistered", tenant: "acme" });
    // Deregistered config is RETAINED in Redis with a tombstone (FR-023 grace window).
    const raw = fake.store.get(`${TENANT_KEY_PREFIX}acme`)!;
    expect(JSON.parse(raw).deregisteredAt).toBe(1500);
  });

  it("publishes a 'reconfigured' event on reconfigure", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    fake.published.length = 0;
    const res = await reg.reconfigure(makeConfig("acme", { fsRoot: "/srv/acme2" }), 2000);
    expect(res.ok).toBe(true);
    expect(JSON.parse(fake.published[0].message)).toEqual({ kind: "reconfigured", tenant: "acme" });
  });

  it("deregistering an absent tenant publishes NO event (idempotent no-op)", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const res = await reg.deregister(tid("ghost"), 1500);
    expect(res.ok).toBe(true);
    expect(fake.published.length).toBe(0);
  });

  it("a subscriber observes published events through the bus", async () => {
    const fake = createInMemoryRedisFake();
    const observed: string[] = [];
    const sub = await subscribeTenantEvents(fake.pubsub, (e) => observed.push(`${e.kind}:${e.tenant}`));
    expect(sub.ok).toBe(true);
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    await reg.deregister(tid("acme"), 1500);
    expect(observed).toEqual(["registered:acme", "deregistered:acme"]);
    if (sub.ok) await sub.value.unsubscribe();
  });

  it("a malformed bus message is dropped, not thrown", async () => {
    const fake = createInMemoryRedisFake();
    const observed: string[] = [];
    const sub = await subscribeTenantEvents(fake.pubsub, (e) => observed.push(e.tenant));
    expect(sub.ok).toBe(true);
    // Publish raw garbage directly on the channel.
    await fake.pubsub.publish(TENANT_EVENTS_CHANNEL, "not json");
    await fake.pubsub.publish(TENANT_EVENTS_CHANNEL, JSON.stringify({ kind: "bogus", tenant: "x" }));
    expect(observed).toEqual([]); // both dropped, no throw
  });
});

describe("redis tenant registry — fail-closed (FR-022 / FR-023)", () => {
  it("register surfaces redis-unavailable and fires onRedisDead when Redis is down (no throw)", async () => {
    const fake = createInMemoryRedisFake();
    let dead = 0;
    let alive = 0;
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub, {
      onRedisDead: () => { dead += 1; },
      onRedisAlive: () => { alive += 1; },
    });
    fake.setFail(true);

    const res = await reg.register(makeConfig("acme"), 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    expect(dead).toBe(1);
    expect(alive).toBe(0);
    // In-memory view NOT advanced — memory never diverges from a write that didn't land.
    expect(reg.lookup(tid("acme")).ok).toBe(false);
  });

  it("a publish failure also fails closed (write landed but event did not)", async () => {
    const fake = createInMemoryRedisFake();
    let dead = 0;
    // Make ONLY publish fail by wrapping the fake's pubsub.
    const flakyPubsub = {
      publish: async () => ({ ok: false as const, error: { kind: "redis-unavailable" as const, operation: "publish" } }),
      subscribe: fake.pubsub.subscribe,
    };
    const reg = createRedisTenantRegistry(fake.redis, flakyPubsub, { onRedisDead: () => { dead += 1; } });
    const res = await reg.register(makeConfig("acme"), 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    expect(dead).toBe(1);
    expect(reg.lookup(tid("acme")).ok).toBe(false);
  });

  it("hydrate fails closed when scan/get is down", async () => {
    const fake = createInMemoryRedisFake();
    let dead = 0;
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub, { onRedisDead: () => { dead += 1; } });
    fake.setFail(true);
    const res = await reg.hydrate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    expect(dead).toBe(1);
  });

  it("a Redis client that THROWS is caught and converted to fail-closed (never propagates)", async () => {
    const throwingRedis = {
      get: async () => { throw new Error("ECONNRESET"); },
      set: async () => { throw new Error("ECONNRESET"); },
      del: async () => { throw new Error("x"); },
      scan: async () => { throw new Error("x"); },
      setNx: async () => { throw new Error("x"); },
      sAdd: async () => { throw new Error("x"); },
      sRem: async () => { throw new Error("x"); },
      sMembers: async () => { throw new Error("x"); },
    };
    const fake = createInMemoryRedisFake();
    let dead = 0;
    const reg = createRedisTenantRegistry(throwingRedis, fake.pubsub, { onRedisDead: () => { dead += 1; } });
    // Must not throw — must return a fail-closed Result.
    const res = await reg.register(makeConfig("acme"), 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    expect(dead).toBe(1);
  });

  it("recovers: onRedisAlive fires after a successful op following an outage", async () => {
    const fake = createInMemoryRedisFake();
    let alive = 0;
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub, { onRedisAlive: () => { alive += 1; } });
    const res = await reg.register(makeConfig("acme"), 1000);
    expect(res.ok).toBe(true);
    expect(alive).toBe(1);
  });
});

describe("redis tenant registry — persists the CORE-NORMALIZED entry (CRITICAL 1)", () => {
  it("register persists status:active and NO deregisteredAt", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    const parsed = JSON.parse(fake.store.get(`${TENANT_KEY_PREFIX}acme`)!);
    expect(parsed.status).toBe("active");
    expect("deregisteredAt" in parsed).toBe(false);
  });

  it("reconfigure persists status:active and NO deregisteredAt", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    await reg.reconfigure(makeConfig("acme", { fsRoot: "/srv/acme2" }), 2000);
    const parsed = JSON.parse(fake.store.get(`${TENANT_KEY_PREFIX}acme`)!);
    expect(parsed.status).toBe("active");
    expect(parsed.fsRoot).toBe("/srv/acme2");
    expect("deregisteredAt" in parsed).toBe(false);
  });

  it("deregister persists the committed deregistered (tombstoned) variant", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    await reg.deregister(tid("acme"), 1500);
    const parsed = JSON.parse(fake.store.get(`${TENANT_KEY_PREFIX}acme`)!);
    expect(parsed.status).toBe("deregistered");
    expect(parsed.deregisteredAt).toBe(1500);
  });
});

describe("redis tenant registry — idempotent no-op suppresses re-persist + duplicate event", () => {
  it("re-registering an identical config does NOT re-write or re-publish", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const cfg = makeConfig("acme");
    await reg.register(cfg, 1000);
    expect(fake.published.length).toBe(1);
    // Tamper with the stored record so we can detect any redundant overwrite.
    fake.store.set(`${TENANT_KEY_PREFIX}acme`, "SENTINEL");
    const res = await reg.register(cfg, 2000);
    expect(res.ok).toBe(true);
    // No re-persist (sentinel untouched) and no duplicate event.
    expect(fake.store.get(`${TENANT_KEY_PREFIX}acme`)).toBe("SENTINEL");
    expect(fake.published.length).toBe(1);
  });

  it("reconfiguring with an identical config does NOT re-write or re-publish", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const cfg = makeConfig("acme");
    await reg.register(cfg, 1000);
    fake.published.length = 0;
    fake.store.set(`${TENANT_KEY_PREFIX}acme`, "SENTINEL");
    const res = await reg.reconfigure(cfg, 2000);
    expect(res.ok).toBe(true);
    expect(fake.store.get(`${TENANT_KEY_PREFIX}acme`)).toBe("SENTINEL");
    expect(fake.published.length).toBe(0);
  });
});

describe("redis tenant registry — reconfigure of an unknown tenant fails closed (no persist, no event)", () => {
  it("returns tenant-unknown, writes nothing, publishes nothing", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const res = await reg.reconfigure(makeConfig("ghost"), 2000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("tenant-unknown");
    expect(fake.store.size).toBe(0);
    expect(fake.published.length).toBe(0);
  });
});

describe("redis tenant registry — resolveForNewRun fail-closed seam (FR-022 / FR-023)", () => {
  it("fails closed (redis-unavailable) for NEW runs while degraded, but lookup still serves in-flight", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);

    // Drive the adapter into the degraded edge via a failed write.
    fake.setFail(true);
    const down = await reg.register(makeConfig("acme", { fsRoot: "/srv/acme-x" }), 1100);
    expect(down.ok).toBe(false);

    // NEW-run resolution fails closed…
    const newRun = reg.resolveForNewRun(tid("acme"));
    expect(newRun.ok).toBe(false);
    if (!newRun.ok) expect(newRun.error.kind).toBe("redis-unavailable");

    // …but the IN-FLIGHT / read-only snapshot lookup keeps serving (FR-023).
    const inflight = reg.lookup(tid("acme"));
    expect(inflight.ok).toBe(true);
    if (inflight.ok) expect(inflight.value.fsRoot).toBe("/srv/acme");
  });

  it("resolveForNewRun works again after recovery (a successful op clears degraded)", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);

    fake.setFail(true);
    await reg.register(makeConfig("acme", { fsRoot: "/srv/acme-x" }), 1100);
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(false);

    // Recover: a successful op flips degraded back off.
    fake.setFail(false);
    const ok2 = await reg.reconfigure(makeConfig("acme", { fsRoot: "/srv/acme2" }), 2000);
    expect(ok2.ok).toBe(true);
    const newRun = reg.resolveForNewRun(tid("acme"));
    expect(newRun.ok).toBe(true);
    if (newRun.ok) expect(newRun.value.fsRoot).toBe("/srv/acme2");
  });

  it("a successful hydrate clears degraded so resolveForNewRun works", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);

    fake.setFail(true);
    await reg.register(makeConfig("acme", { fsRoot: "/srv/acme-x" }), 1100);
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(false);

    fake.setFail(false);
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(true);
  });
});

describe("redis tenant registry — hydrate skips corrupt records (deserialize fail-closed)", () => {
  it("loads a valid record and skips a garbage one without throwing or going degraded", async () => {
    const fake = createInMemoryRedisFake();
    // Seed one valid record (round-tripped through a real register) + garbage.
    const seedReg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await seedReg.register(makeConfig("good"), 1000);
    fake.store.set(`${TENANT_KEY_PREFIX}bad`, "{not json");

    let dead = 0;
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub, { onRedisDead: () => { dead += 1; } });
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(dead).toBe(0); // corrupt record is a skip, NOT a Redis outage
    expect(reg.lookup(tid("good")).ok).toBe(true);
    expect(reg.lookup(tid("bad")).ok).toBe(false);
  });

  it("skips a record with an unknown/missing status discriminant (fail-closed)", async () => {
    const fake = createInMemoryRedisFake();
    const seedReg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await seedReg.register(makeConfig("good"), 1000);
    // Structurally valid config but with a bogus status — must be treated as corrupt.
    fake.store.set(
      `${TENANT_KEY_PREFIX}weird`,
      JSON.stringify({
        status: "frobnicated",
        id: "weird",
        team: "t",
        keycloakClientMapping: { realm: "fugue", clientId: "c", agentClientIdsByDag: {} },
        fsRoot: "/srv/weird",
        dagsRoot: "/dags/weird",
        secretsRef: "vault://weird",
        admission: { maxConcurrentRuns: 1, maxQueuedRuns: 1 },
        eagerPin: false,
      }),
    );
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(reg.lookup(tid("good")).ok).toBe(true);
    expect(reg.snapshot().entries.has(tid("weird"))).toBe(false);
  });

  it("round-trips a deregistered record through hydrate (status:deregistered + tombstone)", async () => {
    const fake = createInMemoryRedisFake();
    const seedReg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await seedReg.register(makeConfig("acme"), 1000);
    await seedReg.deregister(tid("acme"), 1500);

    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    // Deregistered tenant is retained but resolves fail-closed.
    expect(reg.lookup(tid("acme")).ok).toBe(false);
    const entry = reg.snapshot().entries.get(tid("acme"));
    expect(entry?.status).toBe("deregistered");
    if (entry?.status === "deregistered") expect(entry.deregisteredAt).toBe(1500);
  });

  // ── per-field corrupt-record skip branches (parse-don't-validate boundary) ──
  // Each persisted field that is the wrong shape must make the WHOLE record a
  // skip (not a 500, not a coerced round-trip). A structurally-valid sibling must
  // still hydrate, and no Redis-outage hook may fire — corruption is not an outage.
  const validRaw = (id: string): Record<string, unknown> => ({
    status: "active",
    id,
    team: `${id}-team`,
    keycloakClientMapping: { realm: "fugue", clientId: `${id}-client`, agentClientIdsByDag: { "lead-desk": `${id}-agent` } },
    fsRoot: `/srv/${id}`,
    dagsRoot: `/dags/${id}`,
    secretsRef: `vault://${id}/secrets`,
    admission: { maxConcurrentRuns: 4, maxQueuedRuns: 8 },
    eagerPin: false,
  });

  const expectSkipped = async (key: string, raw: unknown): Promise<void> => {
    const fake = createInMemoryRedisFake();
    const seedReg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await seedReg.register(makeConfig("good"), 1000);
    fake.store.set(`${TENANT_KEY_PREFIX}${key}`, JSON.stringify(raw));

    let dead = 0;
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub, { onRedisDead: () => { dead += 1; } });
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(dead).toBe(0); // corrupt record is a skip, NOT a Redis outage
    expect(reg.lookup(tid("good")).ok).toBe(true); // valid sibling still loads
    expect(reg.snapshot().entries.has(tid(key))).toBe(false); // corrupt one skipped
  };

  it("skips a record whose secretsRef is blank or non-string", async () => {
    await expectSkipped("blank-ref", { ...validRaw("blank-ref"), secretsRef: "   " });
    await expectSkipped("num-ref", { ...validRaw("num-ref"), secretsRef: 42 });
  });

  it("skips a deregistered record missing its numeric deregisteredAt tombstone", async () => {
    // status:deregistered with no `deregisteredAt` (or a non-numeric one) is corrupt.
    await expectSkipped("no-tomb", { ...validRaw("no-tomb"), status: "deregistered" });
    await expectSkipped("str-tomb", { ...validRaw("str-tomb"), status: "deregistered", deregisteredAt: "soon" });
  });

  it("skips a record with a non-string value in agentClientIdsByDag", async () => {
    await expectSkipped("bad-agent", {
      ...validRaw("bad-agent"),
      keycloakClientMapping: { realm: "fugue", clientId: "c", agentClientIdsByDag: { "lead-desk": 99 } },
    });
  });

  it("skips a record that coerces a non-string team / realm / clientId / fsRoot", async () => {
    // Guards the boundary against `String(42)` → "42" silently round-tripping a
    // malformed scalar as a valid-looking field.
    await expectSkipped("num-team", { ...validRaw("num-team"), team: 7 });
    await expectSkipped("num-realm", {
      ...validRaw("num-realm"),
      keycloakClientMapping: { realm: 7, clientId: "c", agentClientIdsByDag: {} },
    });
    await expectSkipped("num-client", {
      ...validRaw("num-client"),
      keycloakClientMapping: { realm: "fugue", clientId: 7, agentClientIdsByDag: {} },
    });
    await expectSkipped("num-root", { ...validRaw("num-root"), fsRoot: 7 });
    await expectSkipped("num-dags-root", { ...validRaw("num-dags-root"), dagsRoot: 7 });
  });

  it("skips a record whose admission limits are non-numbers (never coerce via Number(...))", async () => {
    // A non-number admission limit must skip-as-corrupt, NOT coerce: `Number("5")`
    // → 5, `Number(true)` → 1, `Number(null)` → 0 would silently round-trip a
    // malformed value as a valid-looking ceiling. Parity with the string-field
    // guards above (parse-don't-validate boundary).
    await expectSkipped("str-conc", { ...validRaw("str-conc"), admission: { maxConcurrentRuns: "5", maxQueuedRuns: 8 } });
    await expectSkipped("bool-conc", { ...validRaw("bool-conc"), admission: { maxConcurrentRuns: true, maxQueuedRuns: 8 } });
    await expectSkipped("null-queue", { ...validRaw("null-queue"), admission: { maxConcurrentRuns: 4, maxQueuedRuns: null } });
    await expectSkipped("arr-queue", { ...validRaw("arr-queue"), admission: { maxConcurrentRuns: 4, maxQueuedRuns: [] } });
    await expectSkipped("missing-queue", { ...validRaw("missing-queue"), admission: { maxConcurrentRuns: 4 } });
  });

  it("skips a record whose eagerPin is a non-boolean (never truthy-coerce)", async () => {
    // eagerPin is the authoritative pin source (AD-7): idleEvict/isIdleEvictable
    // consume it TRUTHILY, so a coercion like `Boolean(o.eagerPin)` would turn the
    // string "false" into a pinned-forever worker. The guard must skip-as-corrupt,
    // not coerce. The "false" case specifically pins the dangerous Boolean("false")
    // → true regression.
    await expectSkipped("str-pin", { ...validRaw("str-pin"), eagerPin: "false" });
    await expectSkipped("num-pin", { ...validRaw("num-pin"), eagerPin: 1 });
  });
});

describe("redis tenant registry — probe-recovery clears the write-leg latch (FR-022 regression)", () => {
  it("markRedisDegraded(false) re-opens resolveForNewRun even with NO intervening successful write", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    // Healthy baseline: a NEW run resolves.
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(true);

    // Force a WRITE failure → latches `writeDegraded` (the write leg of the gate).
    fake.setFail(true);
    const down = await reg.register(makeConfig("acme", { fsRoot: "/srv/acme-x" }), 1100);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.kind).toBe("redis-unavailable");
    // The write-leg latch now fails NEW-run resolution closed.
    const stillDown = reg.resolveForNewRun(tid("acme"));
    expect(stillDown.ok).toBe(false);
    if (!stillDown.ok) expect(stillDown.error.kind).toBe("redis-unavailable");

    // SIMULATE PROBE RECOVERY with NO successful write in between — the fake is
    // still failing, so no write can have cleared `writeDegraded`. Against the old
    // code (where a probe-recovery did NOT touch the write leg) this would STAY err
    // forever; the fix clears BOTH legs on a probe-confirmed recovery.
    reg.markRedisDegraded(false);
    const recovered = reg.resolveForNewRun(tid("acme"));
    expect(recovered.ok).toBe(true);
    // It still serves the last-known in-memory config (the write that failed never
    // advanced memory, so fsRoot is the original).
    if (recovered.ok) expect(recovered.value.fsRoot).toBe("/srv/acme");
  });

  it("markRedisDegraded(true) re-closes the new-run gate", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(true);

    // A probe-asserted outage closes the gate without any registry write.
    reg.markRedisDegraded(true);
    const closed = reg.resolveForNewRun(tid("acme"));
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.kind).toBe("redis-unavailable");

    // …and a probe-confirmed recovery re-opens it.
    reg.markRedisDegraded(false);
    expect(reg.resolveForNewRun(tid("acme")).ok).toBe(true);
  });
});

describe("redis tenant registry — concurrent cross-tenant register both survive (RMW race fix)", () => {
  it("two concurrent register() for DIFFERENT tenants both land in the snapshot", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);

    // Fire both registers concurrently. Each register is a read-modify-write of the
    // shared in-memory `registry`; the `serializeMutation` chain must make the second
    // commit read the FIRST's committed map so neither tenant is dropped. The fake's
    // `set`/`publish` are async (microtask boundaries at each `await` in
    // `persistAndAnnounce`), so without serialization both would snapshot the same
    // empty base and the second commit would clobber the first.
    const [a, b] = await Promise.all([
      reg.register(makeConfig("acme"), 1000),
      reg.register(makeConfig("globex"), 1000),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // BOTH tenants survive in the in-memory view and resolve.
    const snap = reg.snapshot();
    expect(snap.entries.has(tid("acme"))).toBe(true);
    expect(snap.entries.has(tid("globex"))).toBe(true);
    expect(reg.lookup(tid("acme")).ok).toBe(true);
    expect(reg.lookup(tid("globex")).ok).toBe(true);

    // …and both were persisted + announced.
    expect(fake.store.has(`${TENANT_KEY_PREFIX}acme`)).toBe(true);
    expect(fake.store.has(`${TENANT_KEY_PREFIX}globex`)).toBe(true);
    expect(fake.published.length).toBe(2);
  });
});

describe("redis tenant registry — hardDelete (grace-window purge, FR-030)", () => {
  it("(a) hardDelete on an ABSENT tenant is an idempotent no-op (no del/publish)", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    const res = await reg.hardDelete(tid("ghost"));
    expect(res.ok).toBe(true);
    // Nothing written, nothing announced — the early-return short-circuits all I/O.
    expect(fake.store.size).toBe(0);
    expect(fake.published.length).toBe(0);
    expect(reg.snapshot().entries.has(tid("ghost"))).toBe(false);
  });

  it("(b) hardDelete on a PRESENT tenant removes the key, publishes deregistered, drops it from memory", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);
    expect(fake.store.has(`${TENANT_KEY_PREFIX}acme`)).toBe(true);
    fake.published.length = 0;

    const res = await reg.hardDelete(tid("acme"));
    expect(res.ok).toBe(true);
    // The fugue:tenants:<id> key is removed from the backing store.
    expect(fake.store.has(`${TENANT_KEY_PREFIX}acme`)).toBe(false);
    // A `deregistered` event is announced so subscribers re-read and observe absence.
    expect(fake.published.length).toBe(1);
    expect(fake.published[0].channel).toBe(TENANT_EVENTS_CHANNEL);
    expect(JSON.parse(fake.published[0].message)).toEqual({ kind: "deregistered", tenant: "acme" });
    // Gone from the in-memory view entirely (NOT a tombstone — hard delete).
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(false);
    expect(reg.lookup(tid("acme")).ok).toBe(false);
    // The post-hardDelete registry is FROZEN — runtime-immutability parity with the
    // other producers (register/deregister/reconfigure), so no caller can mutate the
    // shared in-memory view out from under a concurrent reader.
    expect(Object.isFrozen(reg.snapshot())).toBe(true);
  });

  it("(c) a del failure fails closed and does NOT advance the in-memory view", async () => {
    const fake = createInMemoryRedisFake();
    const reg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await reg.register(makeConfig("acme"), 1000);

    // Force Redis down AFTER a successful register; the del now fails.
    fake.setFail(true);
    const res = await reg.hardDelete(tid("acme"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    // Memory NOT advanced — the tenant is still present (mirrors the register/
    // deregister "in-memory view NOT advanced on failure" assertions).
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(true);
    expect(reg.lookup(tid("acme")).ok).toBe(true);
  });

  it("(c') a publish failure (del landed, event did not) also fails closed, memory NOT advanced", async () => {
    const fake = createInMemoryRedisFake();
    // Seed a PRESENT tenant through a working registry first (so register's own
    // publish succeeds), then build the registry-under-test with a pubsub whose
    // publish ALWAYS fails — and hydrate it from the seeded store so the tenant is
    // present in memory. This isolates the hardDelete publish-failure leg (del lands
    // against the shared fake store, the announce does not). Mirrors the register
    // publish-failure test's flaky-pubsub wrapper.
    const seedReg = createRedisTenantRegistry(fake.redis, fake.pubsub);
    await seedReg.register(makeConfig("acme"), 1000);

    const flakyPubsub = {
      publish: async () => ({ ok: false as const, error: { kind: "redis-unavailable" as const, operation: "publish" } }),
      subscribe: fake.pubsub.subscribe,
    };
    const reg = createRedisTenantRegistry(fake.redis, flakyPubsub);
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(true);

    const res = await reg.hardDelete(tid("acme"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    // The in-memory view is NOT advanced even though the del landed — fail-closed
    // keeps memory consistent with a delete that didn't fully announce.
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(true);
    expect(reg.lookup(tid("acme")).ok).toBe(true);
  });

  it("(d) a Redis client that THROWS on del is caught and converted to fail-closed (never propagates)", async () => {
    // A backing fake to seed a present tenant, then a throwing del to drive the
    // catch branch (mirrors the throwing-client pattern used for register).
    const seedFake = createInMemoryRedisFake();
    const seedReg = createRedisTenantRegistry(seedFake.redis, seedFake.pubsub);
    await seedReg.register(makeConfig("acme"), 1000);

    const throwingRedis = {
      get: seedFake.redis.get,
      set: seedFake.redis.set,
      del: async () => { throw new Error("ECONNRESET"); },
      scan: seedFake.redis.scan,
      setNx: seedFake.redis.setNx,
      sAdd: seedFake.redis.sAdd,
      sRem: seedFake.redis.sRem,
      sMembers: seedFake.redis.sMembers,
    };
    let dead = 0;
    // Re-hydrate a registry from the seeded store so the tenant is PRESENT in memory,
    // then point its del at the throwing client.
    const reg = createRedisTenantRegistry(throwingRedis, seedFake.pubsub, { onRedisDead: () => { dead += 1; } });
    const hydrated = await reg.hydrate();
    expect(hydrated.ok).toBe(true);
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(true);

    const res = await reg.hardDelete(tid("acme"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
    expect(dead).toBe(1);
    // Memory NOT advanced — the throw is caught, converted, and the tenant remains.
    expect(reg.snapshot().entries.has(tid("acme"))).toBe(true);
  });
});
