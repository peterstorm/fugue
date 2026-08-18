/**
 * Integration and boundary tests for the ADR-0079 digest-addressed latest-write
 * singleton (FR-030..FR-032/FR-040, SC-007).
 */

import { afterEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import {
  __testCompareRedisMemberSerialization,
  __testSerializeRedisFreshnessMember,
  createFileFreshnessIndex,
} from "../file/freshness-index.js";
import { createFileFreshnessIndex as barrelCreateFileFreshnessIndex } from "../file.js";
import { TTL_SECONDS } from "../checkpoint/checkpointer.js";
import { keyDigest } from "../file/layout.js";
import { __testEncodeMember as encodeRedisMember } from "../checkpoint/redis-freshness-index.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import type {
  FreshnessIndex,
  Witness,
  WitnessKind,
  WriteEntry,
} from "../types/freshness.js";
import { resourceName, witness, FRESHNESS_TTL_SECONDS } from "../types/freshness.js";
import { D, N, R } from "./_id-helpers.js";
import { isFrameworkError, retriabilityOf } from "../types/errors.js";

const cleanup: string[] = [];
afterEach(() => {
  __resetFrameworkLogger();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const tempDirectory = (): string => {
  const parent = mkdtempSync(join(tmpdir(), "file-freshness-"));
  cleanup.push(parent);
  return join(parent, "index");
};

const W = (
  resource: string,
  value: string,
  kind: WitnessKind = "version",
): Witness => witness(kind, resourceName(resource), value);

const writeEvent = (
  resource: string,
  value: string,
  succeededAtMs: number,
  ids: {
    readonly runId?: string;
    readonly nodeId?: string;
    readonly kind?: WitnessKind;
  } = {},
): WriteAttemptedEvent => ({
  type: "write-attempted",
  runId: R(ids.runId ?? "run-1"),
  dagId: D("dag-1"),
  nodeId: N(ids.nodeId ?? "writer"),
  conditionedOn: W(resource, "conditioned", ids.kind),
  newWitness: W(resource, value, ids.kind),
  succeededAtMs,
  timestamp: new Date(succeededAtMs),
});

const unwrap = <T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const comparable = (entry: WriteEntry | null): unknown =>
  entry === null
    ? null
    : {
        runId: entry.runId,
        nodeId: entry.nodeId,
        newWitness: {
          kind: entry.newWitness.kind,
          resource: entry.newWitness.resource,
          value: entry.newWitness.value,
        },
        succeededAtMs: entry.succeededAtMs,
      };

type PersistedSingleton = Readonly<{
  writtenAtMs: number;
  runId: string;
  nodeId: string;
  newWitness: Readonly<{
    kind: WitnessKind;
    resource: string;
    value: string;
  }>;
  succeededAtMs: number;
}>;

const readSingleton = (path: string): PersistedSingleton =>
  JSON.parse(readFileSync(path, "utf-8")) as PersistedSingleton;

const expectedSingleton = (
  writtenAtMs: number,
  event: WriteAttemptedEvent,
): PersistedSingleton => ({
  writtenAtMs,
  runId: event.runId,
  nodeId: event.nodeId,
  newWitness: {
    kind: event.newWitness.kind,
    resource: event.newWitness.resource,
    value: event.newWitness.value,
  },
  succeededAtMs: event.succeededAtMs,
});

type TieWrite = Readonly<{
  runId: string;
  nodeId: string;
  kind: WitnessKind;
  value: string;
}>;

const redisMemberOf = (write: TieWrite): string =>
  encodeRedisMember(R(write.runId), N(write.nodeId), write.kind, write.value);

const redisTieWinner = (left: TieWrite, right: TieWrite): TieWrite =>
  __testCompareRedisMemberSerialization(redisMemberOf(left), redisMemberOf(right)) >= 0
    ? left
    : right;

const tieEvent = (
  resource: string,
  write: TieWrite,
  succeededAtMs = 900,
): WriteAttemptedEvent =>
  writeEvent(resource, write.value, succeededAtMs, {
    runId: write.runId,
    nodeId: write.nodeId,
    kind: write.kind,
  });

const defineGetter = (
  target: object,
  property: string,
  get: () => unknown,
): void => {
  Object.defineProperty(target, property, { enumerable: true, configurable: true, get });
};

describe("createFileFreshnessIndex — public surface and durable singleton", () => {
  it("throws typed cache-error(createFileFreshnessIndex) for invalid factory configuration", () => {
    for (const [directory, options] of [
      ["", {}],
      ["bad\u0000path", {}],
      [tempDirectory(), null],
      [tempDirectory(), { now: 7 }],
      [tempDirectory(), { typo: true }],
      [tempDirectory(), new (class OptionsInstance {})()],
    ] as const) {
      let failure: unknown;
      try {
        createFileFreshnessIndex(
          directory,
          options as unknown as Parameters<typeof createFileFreshnessIndex>[1],
        );
      } catch (error) {
        failure = error;
      }
      expect(isFrameworkError(failure)).toBe(true);
      if (!isFrameworkError(failure) || failure.kind !== "cache-error") {
        throw new Error("expected typed freshness factory failure");
      }
      expect(failure.kind).toBe("cache-error");
      expect(failure.operation).toBe("createFileFreshnessIndex");
      expect(failure.message).toContain("factory configuration");
    }
  });

  it("rejects a class-instance options bag on the PROTOTYPE branch (pinned by exact message)", () => {
    class OptionsInstance {}
    let failure: unknown;
    try {
      createFileFreshnessIndex(
        tempDirectory(),
        new OptionsInstance() as unknown as Parameters<typeof createFileFreshnessIndex>[1],
      );
    } catch (error) {
      failure = error;
    }
    // The exact message isolates the prototype branch of
    // `parseFileFactoryClock`: `null` takes the first-check message ("options
    // must be a plain object, got …"), a class instance the bare branch
    // message — the identical branch the stricter sibling parser pins in
    // `file-checkpointer.test.ts`.
    expect(isFrameworkError(failure)).toBe(true);
    if (!isFrameworkError(failure) || failure.kind !== "cache-error") {
      throw new Error("expected typed freshness factory failure");
    }
    expect(failure.message).toBe(
      "createFileFreshnessIndex failed at factory configuration: options must be a plain object",
    );
  });
  it("is exported from the public file barrel", () => {
    expect(barrelCreateFileFreshnessIndex).toBe(createFileFreshnessIndex);
  });

  it("returns ok(null) for an absent record without creating the directory", async () => {
    const directory = tempDirectory();
    expect(
      await createFileFreshnessIndex(directory).findConflict(W("pg:orders", "1"), 0),
    ).toEqual({ ok: true, value: null });
    expect(existsSync(directory)).toBe(false);
  });

  it("persists exactly one canonical ADR-0079 singleton and survives a fresh instance", async () => {
    const directory = tempDirectory();
    const resource = "postgres:orders:42";
    const event = writeEvent(resource, "v2", 1_900, {
      runId: "run-a",
      nodeId: "update-order",
    });

    expect(
      await createFileFreshnessIndex(directory, { now: () => 2_000 }).recordWrite(event),
    ).toEqual({ ok: true, value: undefined });

    const path = join(directory, `${keyDigest(resource)}.json`);
    expect(readSingleton(path)).toEqual(expectedSingleton(2_000, event));
    expect(Object.keys(readSingleton(path))).toEqual([
      "writtenAtMs",
      "runId",
      "nodeId",
      "newWitness",
      "succeededAtMs",
    ]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toEqual([
      `${keyDigest(resource)}.json`,
    ]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".lock.fence"))).toEqual([
      `${keyDigest(resource)}.lock.fence`,
    ]);

    const conflict = unwrap(
      await createFileFreshnessIndex(directory, { now: () => 2_001 }).findConflict(
        W(resource, "v1"),
        1_900,
      ),
    );
    expect(comparable(conflict)).toEqual({
      runId: "run-a",
      nodeId: "update-order",
      newWitness: { kind: "version", resource, value: "v2" },
      succeededAtMs: 1_900,
    });
  });

  it("keeps a newer singleton when an older write arrives later and refreshes TTL", async () => {
    const directory = tempDirectory();
    const resource = "postgres:orders:out-of-order";
    const newer = writeEvent(resource, "newest", 1_900, {
      runId: "run-newest",
      nodeId: "writer-newest",
    });
    const older = writeEvent(resource, "older", 1_800, {
      runId: "run-older",
      nodeId: "writer-older",
    });

    expect(
      await createFileFreshnessIndex(directory, { now: () => 2_000 }).recordWrite(newer),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await createFileFreshnessIndex(directory, { now: () => 3_000 }).recordWrite(older),
    ).toEqual({ ok: true, value: undefined });

    expect(readSingleton(join(directory, `${keyDigest(resource)}.json`))).toEqual(
      expectedSingleton(3_000, newer),
    );
    expect(
      comparable(
        unwrap(
          await createFileFreshnessIndex(directory, { now: () => 3_001 }).findConflict(
            W(resource, "initial"),
            0,
          ),
        ),
      ),
    ).toMatchObject({
      runId: "run-newest",
      newWitness: { value: "newest" },
      succeededAtMs: 1_900,
    });
  });

  it("uses Redis-compatible reverse binary member ordering for equal scores in both arrival orders", async () => {
    const resource = "postgres:orders:equal-score";
    const left: TieWrite = {
      runId: "run-zeta",
      nodeId: "writer-a",
      kind: "version",
      value: "\uE000",
    };
    const right: TieWrite = {
      runId: "run-alpha",
      nodeId: "writer-z",
      kind: "etag",
      value: "\u{10000}",
    };
    const winner = redisTieWinner(left, right);

    for (const order of [[left, right], [right, left]] as const) {
      const directory = tempDirectory();
      expect(
        await createFileFreshnessIndex(directory, { now: () => 1_000 }).recordWrite(
          tieEvent(resource, order[0]),
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(
        await createFileFreshnessIndex(directory, { now: () => 1_001 }).recordWrite(
          tieEvent(resource, order[1]),
        ),
      ).toEqual({ ok: true, value: undefined });

      expect(readSingleton(join(directory, `${keyDigest(resource)}.json`))).toEqual({
        writtenAtMs: 1_001,
        runId: winner.runId,
        nodeId: winner.nodeId,
        newWitness: {
          kind: winner.kind,
          resource,
          value: winner.value,
        },
        succeededAtMs: 900,
      });
    }
  });

  it("retains the current singleton and refreshes writtenAtMs when an equal-score write carries a byte-identical member", async () => {
    // The equal-score pins above use DISTINCT members (the property test
    // pre-excludes equality); this closes the remaining cell: equal
    // succeededAtMs AND byte-identical member serialization ⇒ the incoming
    // write loses the tie — the current singleton is retained and only
    // `writtenAtMs` is refreshed (Redis EXPIRE parity on a no-op write).
    const directory = tempDirectory();
    const resource = "postgres:orders:identical-member";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const tie = { runId: "run-tie", nodeId: "writer-tie", kind: "version" as const, value: "v1" };
    expect(
      await createFileFreshnessIndex(directory, { now: () => 1_000 }).recordWrite(
        tieEvent(resource, tie),
      ),
    ).toEqual({ ok: true, value: undefined });
    // Same member bytes (same runId/nodeId/kind/value) + same succeededAtMs.
    expect(
      await createFileFreshnessIndex(directory, { now: () => 1_500 }).recordWrite(
        tieEvent(resource, tie),
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(readSingleton(path)).toEqual({
      writtenAtMs: 1_500,
      runId: "run-tie",
      nodeId: "writer-tie",
      newWitness: { kind: "version", resource, value: "v1" },
      succeededAtMs: 900,
    });
  });

  it("FRESHNESS_TTL_SECONDS stays in lockstep with the Checkpointer port TTL while ADR-0079 parity holds", () => {
    // The file freshness adapter consumes the FreshnessIndex port's own
    // 24-hour constant (`types/freshness.ts`), not the Checkpointer port's
    // `TTL_SECONDS` — so a future FR-027 change cannot silently redefine
    // freshness expiry. While ADR-0079's parity target holds, the two ports
    // MUST agree; this pin is the tripwire.
    expect(FRESHNESS_TTL_SECONDS).toBe(86_400);
    expect(FRESHNESS_TTL_SECONDS).toBe(TTL_SECONDS);
  });

  it("property: equal-score singleton selection is arrival-independent", async () => {
    const tieWrite = fc.record<TieWrite>({
      runId: fc.constantFrom("run-a", "run-z", "run-10", "run_underscore"),
      nodeId: fc.constantFrom("node-a", "node-z", "node-10", "node_underscore"),
      kind: fc.constantFrom<WitnessKind>("version", "etag", "timestamp", "custom"),
      value: fc.constantFrom("alpha", "zeta", "quote\"slash\\", "日本語", "\uE000", "\u{10000}"),
    });

    await fc.assert(
      fc.asyncProperty(tieWrite, tieWrite, async (left, right) => {
        fc.pre(redisMemberOf(left) !== redisMemberOf(right));
        const winner = redisTieWinner(left, right);
        for (const order of [[left, right], [right, left]] as const) {
          const directory = tempDirectory();
          await createFileFreshnessIndex(directory, { now: () => 10_000 }).recordWrite(
            tieEvent("property:tie", order[0]),
          );
          await createFileFreshnessIndex(directory, { now: () => 10_001 }).recordWrite(
            tieEvent("property:tie", order[1]),
          );
          const stored = readSingleton(join(directory, `${keyDigest("property:tie")}.json`));
          expect(stored.runId).toBe(winner.runId);
          expect(stored.nodeId).toBe(winner.nodeId);
          expect(stored.newWitness.kind).toBe(winner.kind);
          expect(stored.newWitness.value).toBe(winner.value);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("serializes concurrent writers to one deterministic singleton with no stale overwrite", async () => {
    const directory = tempDirectory();
    const resource = "postgres:orders:concurrent";
    const writes = [100, 700, 300, 1_000, 500, 900, 200, 800, 600, 50] as const;

    const results = await Promise.all(
      writes.map((succeededAtMs, index) =>
        createFileFreshnessIndex(directory, { now: () => 10_000 + index }).recordWrite(
          writeEvent(resource, `value-${succeededAtMs}`, succeededAtMs, {
            runId: `run-${succeededAtMs}`,
            nodeId: `writer-${succeededAtMs}`,
          }),
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);

    const stored = readSingleton(join(directory, `${keyDigest(resource)}.json`));
    expect(stored).toMatchObject({
      runId: "run-1000",
      nodeId: "writer-1000",
      newWitness: { value: "value-1000" },
      succeededAtMs: 1_000,
    });
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toEqual([
      `${keyDigest(resource)}.json`,
    ]);
    expect(existsSync(join(directory, `${keyDigest(resource)}.lock`))).toBe(false);
  });

  it("atomically replaces the singleton and ignores interrupted tmp litter", async () => {
    const directory = tempDirectory();
    const resource = "stripe:charge:ch_123";
    const path = join(directory, `${keyDigest(resource)}.json`);
    let nowMs = 10;
    const index = createFileFreshnessIndex(directory, { now: () => nowMs });
    const oldEvent = writeEvent(resource, "old", 9, { runId: "run-old" });
    const newEvent = writeEvent(resource, "new", 19, { runId: "run-new" });

    expect(await index.recordWrite(oldEvent)).toEqual({ ok: true, value: undefined });
    writeFileSync(`${path}.tmp.interrupted`, '{"writtenAtMs":');
    expect(comparable(unwrap(await index.findConflict(W(resource, "initial"), 0)))).toMatchObject({
      runId: "run-old",
      newWitness: { value: "old" },
    });

    nowMs = 20;
    expect(await index.recordWrite(newEvent)).toEqual({ ok: true, value: undefined });
    expect(readSingleton(path)).toEqual(expectedSingleton(20, newEvent));
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toEqual([
      `${keyDigest(resource)}.json`,
    ]);
  });
});

describe("createFileFreshnessIndex — conflict semantics and TTL", () => {
  const scenarios: readonly {
    readonly name: string;
    readonly writes: readonly { readonly value: string; readonly succeededAtMs: number }[];
    readonly conditionedValue: string;
    readonly sinceMs: number;
  }[] = [
    { name: "since equality is inclusive", writes: [{ value: "2", succeededAtMs: 100 }], conditionedValue: "1", sinceMs: 100 },
    { name: "before since is ignored", writes: [{ value: "2", succeededAtMs: 100 }], conditionedValue: "1", sinceMs: 101 },
    { name: "same value is clean", writes: [{ value: "2", succeededAtMs: 100 }], conditionedValue: "2", sinceMs: 0 },
    { name: "newer value wins", writes: [{ value: "2", succeededAtMs: 100 }, { value: "3", succeededAtMs: 200 }], conditionedValue: "1", sinceMs: 0 },
    { name: "newer same value suppresses old difference", writes: [{ value: "2", succeededAtMs: 100 }, { value: "1", succeededAtMs: 200 }], conditionedValue: "1", sinceMs: 0 },
  ];

  for (const scenario of scenarios) {
    it(`matches in-memory semantics: ${scenario.name}`, async () => {
      const resource = `parity:${scenario.name}`;
      const file: FreshnessIndex = createFileFreshnessIndex(tempDirectory(), { now: () => 1_000 });
      const memory: FreshnessIndex = new InMemoryFreshnessIndex();
      for (const [index, spec] of scenario.writes.entries()) {
        const event = writeEvent(resource, spec.value, spec.succeededAtMs, {
          runId: `run-${index}`,
          nodeId: `writer-${index}`,
        });
        expect((await file.recordWrite(event)).ok).toBe(true);
        expect((await memory.recordWrite(event)).ok).toBe(true);
      }
      const conditionedOn = W(resource, scenario.conditionedValue);
      expect(comparable(unwrap(await file.findConflict(conditionedOn, scenario.sinceMs)))).toEqual(
        comparable(unwrap(await memory.findConflict(conditionedOn, scenario.sinceMs))),
      );
    });
  }

  it("isolates resources and preserves witness kind", async () => {
    const directory = tempDirectory();
    const index = createFileFreshnessIndex(directory, { now: () => 500 });
    await index.recordWrite(writeEvent("api:invoice:a", "etag-2", 400, { kind: "etag" }));

    expect(unwrap(await index.findConflict(W("api:invoice:b", "etag-1", "etag"), 0))).toBeNull();
    expect(
      unwrap(await index.findConflict(W("api:invoice:a", "etag-1", "etag"), 0))?.newWitness.kind,
    ).toBe("etag");
  });

  it("is live at exactly 24h, absent one millisecond later, and refreshes TTL on a losing older write", async () => {
    const directory = tempDirectory();
    const resource = "ttl:resource";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const ttlMs = TTL_SECONDS * 1_000;
    const winner = writeEvent(resource, "winner", 900, {
      runId: "run-winner",
      nodeId: "node-winner",
    });
    const loser = writeEvent(resource, "older", 100, {
      runId: "run-older",
      nodeId: "node-older",
    });

    await createFileFreshnessIndex(directory, { now: () => 1_000 }).recordWrite(winner);
    await createFileFreshnessIndex(directory, { now: () => 1_000 + ttlMs }).recordWrite(loser);
    expect(readSingleton(path)).toEqual(expectedSingleton(1_000 + ttlMs, winner));

    expect(
      unwrap(
        await createFileFreshnessIndex(directory, { now: () => 1_000 + 2 * ttlMs }).findConflict(
          W(resource, "conditioned"),
          0,
        ),
      ),
    ).not.toBeNull();
    expect(
      unwrap(
        await createFileFreshnessIndex(directory, { now: () => 1_000 + 2 * ttlMs + 1 }).findConflict(
          W(resource, "conditioned"),
          0,
        ),
      ),
    ).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("lets a lower score replace an expired singleton without resurrecting history", async () => {
    const directory = tempDirectory();
    const resource = "ttl:expired";
    const ttlMs = TTL_SECONDS * 1_000;
    const expired = writeEvent(resource, "expired-high", 900, { runId: "run-expired" });
    const replacement = writeEvent(resource, "new-low", 100, { runId: "run-new" });
    const replacementNow = 1_000 + ttlMs + 1;

    await createFileFreshnessIndex(directory, { now: () => 1_000 }).recordWrite(expired);
    await createFileFreshnessIndex(directory, { now: () => replacementNow }).recordWrite(replacement);
    expect(readSingleton(join(directory, `${keyDigest(resource)}.json`))).toEqual(
      expectedSingleton(replacementNow, replacement),
    );
  });
});

describe("createFileFreshnessIndex — one-read runtime boundary snapshots", () => {
  it("recordWrite reads every used top-level and nested accessor exactly once", async () => {
    const directory = tempDirectory();
    const resource = "snapshot:record";
    const valid = writeEvent(resource, "persisted", 900, {
      runId: "run-snapshot",
      nodeId: "node-snapshot",
      kind: "etag",
    });
    const reads = new Map<string, number>();
    const once = <T>(name: string, first: T, later: unknown): (() => unknown) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };

    const nested: Record<string, unknown> = {};
    defineGetter(nested, "kind", once("kind", valid.newWitness.kind, "invalid-kind"));
    defineGetter(nested, "resource", once("resource", resource, "snapshot:wrong-resource"));
    defineGetter(nested, "value", once("value", valid.newWitness.value, "wrong-value"));

    const runtimeEvent: Record<string, unknown> = {};
    defineGetter(runtimeEvent, "type", once("type", "write-attempted", "wrong-type"));
    defineGetter(runtimeEvent, "runId", once("runId", valid.runId, "../wrong"));
    defineGetter(runtimeEvent, "nodeId", once("nodeId", valid.nodeId, "../wrong"));
    defineGetter(runtimeEvent, "newWitness", once("newWitness", nested, null));
    defineGetter(runtimeEvent, "succeededAtMs", once("succeededAtMs", 900, Number.NaN));

    let clockReads = 0;
    const result = await createFileFreshnessIndex(directory, {
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? 1_000 : Number.NaN;
      },
    }).recordWrite(runtimeEvent as unknown as WriteAttemptedEvent);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(Object.fromEntries(reads)).toEqual({
      type: 1,
      runId: 1,
      nodeId: 1,
      newWitness: 1,
      succeededAtMs: 1,
      kind: 1,
      resource: 1,
      value: 1,
    });
    expect(clockReads).toBe(1);
    expect(readSingleton(join(directory, `${keyDigest(resource)}.json`))).toEqual({
      writtenAtMs: 1_000,
      runId: "run-snapshot",
      nodeId: "node-snapshot",
      newWitness: { kind: "etag", resource, value: "persisted" },
      succeededAtMs: 900,
    });
    expect(existsSync(join(directory, `${keyDigest("snapshot:wrong-resource")}.json`))).toBe(false);
  });

  it("findConflict reads conditionedOn accessors once and cannot switch resource or value after validation", async () => {
    const directory = tempDirectory();
    const intended = "snapshot:find:intended";
    const wrong = "snapshot:find:wrong";
    const index = createFileFreshnessIndex(directory, { now: () => 2_000 });
    await index.recordWrite(writeEvent(intended, "intended-current", 1_900, { runId: "run-intended" }));
    await index.recordWrite(writeEvent(wrong, "wrong-current", 1_900, { runId: "run-wrong" }));

    const reads = new Map<string, number>();
    const stateful = <T>(name: string, first: T, later: unknown): (() => unknown) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };
    const firstValues: Readonly<Record<string, unknown>> = {
      kind: "version",
      resource: intended,
      value: "conditioned-old",
    };
    const laterValues: Readonly<Record<string, unknown>> = {
      kind: "invalid-kind",
      resource: wrong,
      value: "intended-current",
    };
    const conditioned = new Proxy(firstValues, {
      get(target, property, receiver) {
        if (typeof property !== "string" || !(property in firstValues)) {
          return Reflect.get(target, property, receiver);
        }
        return stateful(property, firstValues[property], laterValues[property])();
      },
    });

    const result = await index.findConflict(conditioned as unknown as Witness, 1_900);
    expect(comparable(unwrap(result))).toMatchObject({
      runId: "run-intended",
      newWitness: { resource: intended, value: "intended-current" },
    });
    expect(Object.fromEntries(reads)).toEqual({ kind: 1, resource: 1, value: 1 });
  });

  it("turns throwing getters and revoked proxies into typed errors without persistence or raw throws", async () => {
    const recordDirectory = tempDirectory();
    const event = writeEvent("snapshot:throw", "value", 100);
    const hostileWitness = { ...event.newWitness } as Record<string, unknown>;
    defineGetter(hostileWitness, "resource", () => { throw new Error("resource getter exploded"); });
    const hostileEvent = { ...event, newWitness: hostileWitness };

    const record = await createFileFreshnessIndex(recordDirectory).recordWrite(hostileEvent as WriteAttemptedEvent);
    expect(record.ok).toBe(false);
    if (record.ok) throw new Error("expected getter failure");
    expect(record.error.kind).toBe("cache-error");
    if (record.error.kind === "cache-error") {
      expect(record.error.operation).toBe("freshness:recordWrite");
      expect(record.error.message).toContain("resource getter exploded");
    }
    expect(existsSync(recordDirectory)).toBe(false);

    const proxyDirectory = tempDirectory();
    const proxyEvent = writeEvent("snapshot:proxy-throw", "value", 100);
    const proxyWitness = new Proxy(proxyEvent.newWitness, {
      get(target, property, receiver) {
        if (property === "resource") throw new Error("witness proxy exploded");
        return Reflect.get(target, property, receiver);
      },
    });
    const proxyRecord = await createFileFreshnessIndex(proxyDirectory).recordWrite({
      ...proxyEvent,
      newWitness: proxyWitness,
    });
    expect(proxyRecord.ok).toBe(false);
    if (proxyRecord.ok) throw new Error("expected proxy failure");
    expect(proxyRecord.error.kind).toBe("cache-error");
    if (proxyRecord.error.kind === "cache-error") {
      expect(proxyRecord.error.operation).toBe("freshness:recordWrite");
      expect(proxyRecord.error.message).toContain("witness proxy exploded");
    }
    expect(existsSync(proxyDirectory)).toBe(false);

    const findDirectory = tempDirectory();
    const seeded = createFileFreshnessIndex(findDirectory, { now: () => 1_000 });
    await seeded.recordWrite(writeEvent("snapshot:find-throw", "current", 900));
    const pair = Proxy.revocable(W("snapshot:find-throw", "old"), {});
    pair.revoke();
    const found = await seeded.findConflict(pair.proxy, 0);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("expected revoked proxy failure");
    expect(found.error.kind).toBe("cache-error");
    if (found.error.kind === "cache-error") {
      expect(found.error.operation).toBe("freshness:findConflict");
    }
  });
});

describe("createFileFreshnessIndex — symlinks (deliberate checkpointer divergence)", () => {
  // The module header's "Symlink policy" pins WHY the file checkpointer
  // lstat-rejects symlink path components while this index does not: the
  // digest filename is not caller-controlled path material, so the caller's
  // directory is the sole trust boundary. These tests pin the behavior the
  // policy describes — read side follows, write side replaces — so a future
  // "hardening" that starts rejecting (or writing through) symlinks must
  // deliberately change the documented contract.

  it("findConflict FOLLOWS a symlink at the digest path — the decision comes from the target", async () => {
    const directory = tempDirectory();
    const resource = "postgres:orders:42";
    const event = writeEvent(resource, "v1", 9, { runId: "run-old" });
    const index = createFileFreshnessIndex(directory, { now: () => 10 });
    expect(await index.recordWrite(event)).toEqual({ ok: true, value: undefined });

    const recordPath = join(directory, `${keyDigest(resource)}.json`);
    // Relocate the real singleton OUTSIDE the index directory and re-expose
    // the digest path as a symlink back to it.
    const outside = join(resolve(directory, ".."), "outside-singleton.json");
    writeFileSync(outside, readFileSync(recordPath, "utf-8"));
    rmSync(recordPath);
    symlinkSync(outside, recordPath);

    // The conflict decision is derived through the symlink — the stored v1
    // singleton still conflicts a v2 attempt, indistinguishable from a direct
    // file read.
    expect(comparable(unwrap(await index.findConflict(W(resource, "v2"), 0)))).toMatchObject({
      runId: "run-old",
      newWitness: { value: "v1" },
    });
  });

  it("recordWrite's rename REPLACES a symlink at the digest path — it never writes through it", async () => {
    const directory = tempDirectory();
    const resource = "postgres:orders:42";
    let nowMs = 10;
    const index = createFileFreshnessIndex(directory, { now: () => nowMs });
    const first = writeEvent(resource, "v1", 9, { runId: "run-first" });
    expect(await index.recordWrite(first)).toEqual({ ok: true, value: undefined });

    const recordPath = join(directory, `${keyDigest(resource)}.json`);
    // A symlink wearing the digest name whose target is a valid sibling
    // singleton OUTSIDE the directory.
    const outside = join(resolve(directory, ".."), "outside-singleton.json");
    const outsideBytes = readFileSync(recordPath, "utf-8");
    writeFileSync(outside, outsideBytes);
    rmSync(recordPath);
    symlinkSync(outside, recordPath);

    const second = writeEvent(resource, "v2", 19, { runId: "run-second" });
    nowMs = 20;
    expect(await index.recordWrite(second)).toEqual({ ok: true, value: undefined });

    // The symlink is GONE — the atomic rename replaced the path itself:
    expect(lstatSync(recordPath).isSymbolicLink()).toBe(false);
    // …with the NEW singleton's bytes:
    expect(readSingleton(recordPath)).toEqual(expectedSingleton(20, second));
    // …and the link's target was NOT written through — it still holds the
    // pre-write bytes.
    expect(readFileSync(outside, "utf-8")).toBe(outsideBytes);
  });
});

describe("createFileFreshnessIndex — strict codec and typed failures", () => {
  it("a non-finite injected clock is a permanent rejection on recordWrite and findConflict", async () => {
    const directory = tempDirectory();
    const resource = "clock:non-finite";
    // Seed a valid singleton with a healthy clock, then point a broken clock
    // at the same directory: the clock gate fires on both operations.
    await createFileFreshnessIndex(directory, { now: () => 1_000 })
      .recordWrite(writeEvent(resource, "seed", 900));

    const index = createFileFreshnessIndex(directory, { now: () => Number.NaN });

    const write = await index.recordWrite(writeEvent(resource, "must-not-write", 1_100));
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error("expected typed rejection");
    expect(write.error.kind).toBe("cache-error");
    if (write.error.kind === "cache-error") {
      expect(write.error.operation).toBe("freshness:recordWrite");
      expect(write.error.failureClass).toBe("permanent");
      expect(retriabilityOf(write.error)).toBe("non-retriable");
    }

    const found = await index.findConflict(W(resource, "seed"), 0);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("expected typed rejection");
    expect(found.error.kind).toBe("cache-error");
    if (found.error.kind === "cache-error") {
      expect(found.error.operation).toBe("freshness:findConflict");
      expect(found.error.failureClass).toBe("permanent");
      expect(retriabilityOf(found.error)).toBe("non-retriable");
    }
  });

  it("a throwing injected clock is a permanent rejection on recordWrite and findConflict", async () => {
    const directory = tempDirectory();
    const resource = "clock:throwing";
    // Seed a valid singleton with a healthy clock, then point a throwing
    // clock at the same directory: the clock guard fires on both operations
    // (before the non-finite return-value check), pinned "permanent" like the
    // sibling clock sites (journal appendEvent, checkpointer setMeta/load).
    await createFileFreshnessIndex(directory, { now: () => 1_000 })
      .recordWrite(writeEvent(resource, "seed", 900));

    const index = createFileFreshnessIndex(directory, {
      now: () => {
        throw new Error("clock exploded");
      },
    });

    const write = await index.recordWrite(writeEvent(resource, "must-not-write", 1_100));
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error("expected typed rejection");
    expect(write.error.kind).toBe("cache-error");
    if (write.error.kind === "cache-error") {
      expect(write.error.operation).toBe("freshness:recordWrite");
      expect(write.error.failureClass).toBe("permanent");
      expect(retriabilityOf(write.error)).toBe("non-retriable");
      // The guard names its own rule; the hostile clock's text stays DATA
      // inside the total diagnostic, never replacing the guard's message.
      expect(write.error.message).toContain("clock failed while stamping the write");
    }

    const found = await index.findConflict(W(resource, "seed"), 0);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("expected typed rejection");
    expect(found.error.kind).toBe("cache-error");
    if (found.error.kind === "cache-error") {
      expect(found.error.operation).toBe("freshness:findConflict");
      expect(found.error.failureClass).toBe("permanent");
      expect(retriabilityOf(found.error)).toBe("non-retriable");
      expect(found.error.message).toContain("clock failed while evaluating the freshness TTL");
    }

    // The throw must not perturb the durable singleton: the seed survives on
    // a healthy instance.
    const healthy = createFileFreshnessIndex(directory, { now: () => 1_000 });
    const survived = await healthy.findConflict(W(resource, "other"), 0);
    expect(survived.ok).toBe(true);
    if (survived.ok) {
      expect(survived.value).not.toBeNull();
    }
  });

  it("lock-protocol failures are re-tagged at the recordWrite public surface (ADR-0080, journal appendEvent parity)", async () => {
    const directory = tempDirectory();
    const resource = "ride:through";
    // A FILE squatting on the lock path: the rename-born lock cannot be born
    // (ENOTDIR), so acquireFileLock rejects with its OWN typed lock-protocol
    // failure. recordWrite's public surface must re-tag it to the CALLER'S
    // port operation (freshness:recordWrite) — the lock's internal mechanics
    // must not name the port call — while the lock detail (the lock path,
    // the inner acquireFileLock diagnostic) survives in the message chain.
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${keyDigest(resource)}.lock`), "squatter");

    const index = createFileFreshnessIndex(directory);
    const write = await index.recordWrite(writeEvent(resource, "v", 1_000));
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error("expected typed rejection");
    expect(write.error.kind).toBe("cache-error");
    if (write.error.kind === "cache-error") {
      expect(write.error.operation).toBe("freshness:recordWrite");
      // The lock path + the inner lock-protocol diagnostic ride through
      // inside the re-tagged message (the diagnostic chain is preserved).
      expect(write.error.message).toContain(join(directory, `${keyDigest(resource)}.lock`));
      expect(write.error.message).toContain("acquireFileLock");
    }
  });

  it("a body-internal commit failure (atomicWriteFile) is re-tagged to freshness:recordWrite, not withFileLock", async () => {
    const directory = tempDirectory();
    const resource = "commit:fail";
    mkdirSync(directory, { recursive: true });
    // Deterministic commit failure via the test-only seam: the temp path
    // squats under a FILE, so the tmp write cannot land (ENOTDIR) — the
    // body's atomicWriteFile throws inside the locked critical section.
    const squatterFile = join(directory, "tmp-squatter");
    writeFileSync(squatterFile, "squatter");

    const index = createFileFreshnessIndex(directory, {
      now: () => 1_000,
      atomicWriteFileHooks: {
        temporaryPath: () => join(squatterFile, "tmp.json"),
      },
    });
    const write = await index.recordWrite(writeEvent(resource, "v", 1_000));
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error("expected typed rejection");
    expect(write.error.kind).toBe("cache-error");
    if (write.error.kind === "cache-error") {
      // The operation names the CALLER'S port call — not withFileLock
      // (the wrapper) and not atomicWriteFile (the body helper).
      expect(write.error.operation).toBe("freshness:recordWrite");
      // The full chain survives: the withFileLock diagnostic (lock path) +
      // the primary atomicWriteFile commit failure nested inside it.
      expect(write.error.message).toContain("withFileLock");
      expect(write.error.message).toContain("atomicWriteFile");
      expect(write.error.message).toContain(`${keyDigest(resource)}.json`);
    }
  });
  it("explicitly rejects append/member-set and extra-field persisted shapes", async () => {
    const directory = tempDirectory();
    const resource = "codec:singleton-only";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const index = createFileFreshnessIndex(directory, { now: () => 1_000 });
    await index.recordWrite(writeEvent(resource, "seed", 900));

    const rejected = [
      {
        schemaVersion: 1,
        writtenAtMs: 900,
        resource,
        members: [{ member: '["run-1","writer","version","value"]', score: 900 }],
      },
      {
        writtenAtMs: 900,
        runId: "run-1",
        nodeId: "writer",
        newWitness: { kind: "version", resource, value: "value" },
        succeededAtMs: 900,
        history: [],
      },
      {
        writtenAtMs: 900,
        runId: "run-1",
        nodeId: "writer",
        newWitness: { kind: "version", resource, value: "value", extra: true },
        succeededAtMs: 900,
      },
    ] as const;

    const warnings: string[] = [];
    setFrameworkLogger({
      debug() {},
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
    });

    for (const raw of rejected) {
      writeFileSync(path, JSON.stringify(raw));
      expect(await index.findConflict(W(resource, "old"), 0)).toEqual({ ok: true, value: null });
      const bytes = readFileSync(path, "utf-8");
      const write = await index.recordWrite(writeEvent(resource, "must-not-replace", 1_100));
      expect(write.ok).toBe(false);
      if (write.ok) throw new Error("expected typed rejection");
      // The strict-codec rejection is deterministic — pin the permanent
      // class so a regression relabeling it retriable cannot slip through.
      expect(write.error.kind).toBe("cache-error");
      if (write.error.kind === "cache-error") {
        expect(write.error.operation).toBe("freshness:recordWrite");
        expect(write.error.failureClass).toBe("permanent");
        expect(retriabilityOf(write.error)).toBe("non-retriable");
      }
      expect(readFileSync(path, "utf-8")).toBe(bytes);
    }
    expect(warnings).toHaveLength(rejected.length);
  });

  it("recordWrite over a non-JSON corrupt singleton fails closed with a permanent typed cache-error and leaves the corrupt bytes untouched (ADR-0079)", async () => {
    // The strict-codec rejection variants are pinned above; this completes
    // the matrix with the JSON.parse-level corruption a partial write or
    // truncation produces — a regression making recordWrite treat a corrupt
    // singleton as absent (silently overwriting it with a stale write) must
    // fail here.
    const directory = tempDirectory();
    const resource = "corrupt:recordwrite";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const index = createFileFreshnessIndex(directory, { now: () => 1_000 });
    await index.recordWrite(writeEvent(resource, "2", 900));

    const corruptBytes = "not-json";
    writeFileSync(path, corruptBytes);

    const write = await index.recordWrite(writeEvent(resource, "3", 950));
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error.kind).toBe("cache-error");
      if (write.error.kind === "cache-error") {
        expect(write.error.operation).toBe("freshness:recordWrite");
        expect(write.error.failureClass).toBe("permanent");
        expect(retriabilityOf(write.error)).toBe("non-retriable");
        expect(write.error.message).toContain(keyDigest(resource));
      }
    }
    // The corrupt bytes are preserved — never silently replaced.
    expect(readFileSync(path, "utf-8")).toBe(corruptBytes);
  });

  it("warns and treats malformed or digest/content-disagreeing singletons as absent", async () => {
    const directory = tempDirectory();
    const resource = "corrupt:resource";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const index = createFileFreshnessIndex(directory, { now: () => 1_000 });
    await index.recordWrite(writeEvent(resource, "2", 900));

    const warnings: string[] = [];
    setFrameworkLogger({
      debug() {},
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
    });
    const corruptRecords = [
      "not-json",
      JSON.stringify({}),
      JSON.stringify({
        writtenAtMs: 900,
        runId: "../escape",
        nodeId: "writer",
        newWitness: { kind: "version", resource, value: "2" },
        succeededAtMs: 900,
      }),
      JSON.stringify({
        writtenAtMs: 900,
        runId: "run-1",
        nodeId: "writer",
        newWitness: { kind: "unknown", resource, value: "2" },
        succeededAtMs: 900,
      }),
      JSON.stringify({
        writtenAtMs: 900,
        runId: "run-1",
        nodeId: "writer",
        newWitness: { kind: "version", resource: "crossed:resource", value: "2" },
        succeededAtMs: 900,
      }),
    ];

    for (const raw of corruptRecords) {
      writeFileSync(path, raw);
      expect(await index.findConflict(W(resource, "1"), 0)).toEqual({ ok: true, value: null });
    }
    expect(warnings).toHaveLength(corruptRecords.length);
    expect(warnings.every((warning) => warning.includes(`digest=${keyDigest(resource)}`))).toBe(true);
    expect(warnings.some((warning) => warning.includes("digest/content resource disagreement"))).toBe(true);
  });

  it("returns cache-error instead of absence when corrupt-record logging throws", async () => {
    const directory = tempDirectory();
    const resource = "corrupt:logger";
    const path = join(directory, `${keyDigest(resource)}.json`);
    const index = createFileFreshnessIndex(directory, { now: () => 1_000 });
    await index.recordWrite(writeEvent(resource, "2", 900));
    writeFileSync(path, "not-json");

    setFrameworkLogger({
      debug() {},
      info() {},
      warn() { throw new Error("warning transport unavailable"); },
      error() {},
    });
    const result = await index.findConflict(W(resource, "1"), 0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected logger failure");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind === "cache-error") {
      expect(result.error.operation).toBe("freshness:findConflict");
      expect(result.error.message).toContain("warning transport unavailable");
      expect(result.error.message).toContain(`recordPath=${JSON.stringify(resolve(path))}`);
    }
  });

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects non-finite clocks and sinceMs (${String(invalid)}) with typed errors`, async () => {
      const resource = `invalid:number:${String(invalid)}`;
      const directory = tempDirectory();
      const invalidClock = createFileFreshnessIndex(directory, { now: () => invalid });
      const write = await invalidClock.recordWrite(writeEvent(resource, "value", 100));
      expect(write.ok).toBe(false);
      if (!write.ok) {
        expect(write.error.kind).toBe("cache-error");
        if (write.error.kind === "cache-error") expect(write.error.operation).toBe("freshness:recordWrite");
      }
      expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toEqual([]);

      const valid = createFileFreshnessIndex(directory, { now: () => 1_000 });
      await valid.recordWrite(writeEvent(resource, "value", 900));
      const find = await valid.findConflict(W(resource, "old"), invalid);
      expect(find.ok).toBe(false);
      if (!find.ok) {
        expect(find.error.kind).toBe("cache-error");
        if (find.error.kind === "cache-error") expect(find.error.operation).toBe("freshness:findConflict");
      }
    });
  }

  it("maps genuine read/write failures to freshness cache-error operations", async () => {
    const parent = mkdtempSync(join(tmpdir(), "file-freshness-io-"));
    cleanup.push(parent);
    const notDirectory = join(parent, "occupied");
    writeFileSync(notDirectory, "file");
    const index = createFileFreshnessIndex(notDirectory);

    const write = await index.recordWrite(writeEvent("io:resource", "2", 100));
    expect(write.ok).toBe(false);
    if (!write.ok && write.error.kind === "cache-error") {
      expect(write.error.operation).toBe("freshness:recordWrite");
    }
    const read = await index.findConflict(W("io:resource", "1"), 0);
    expect(read.ok).toBe(false);
    if (!read.ok && read.error.kind === "cache-error") {
      expect(read.error.operation).toBe("freshness:findConflict");
    }
  });

  it("a directory squatting on the <digest>.json singleton fails recordWrite and findConflict closed with typed EISDIR-class errors (round-14 A5)", async () => {
    // round-14 A5: the sibling modules pin the errno-class matrix (EACCES/
    // EIO/ENOTDIR/EISDIR) at their read surfaces; the freshness singleton's
    // per-resource record had no EISDIR pin — a DIRECTORY wearing the
    // `<digest>.json` name makes readFileSync throw EISDIR, and both
    // operations must fail closed with the code in the typed diagnostic
    // instead of a raw escape or a misclassified verdict.
    const directory = tempDirectory();
    const resource = "squat:eisdir";
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, `${keyDigest(resource)}.json`));

    const index = createFileFreshnessIndex(directory);

    const write = await index.recordWrite(writeEvent(resource, "squat-write", 100));
    expect(write.ok).toBe(false);
    if (!write.ok && write.error.kind === "cache-error") {
      expect(write.error.operation).toBe("freshness:recordWrite");
      expect(write.error.message).toContain("EISDIR");
    } else {
      throw new Error("expected a typed cache-error(recordWrite)");
    }

    const read = await index.findConflict(W(resource, "squat-read"), 0);
    expect(read.ok).toBe(false);
    if (!read.ok && read.error.kind === "cache-error") {
      expect(read.error.operation).toBe("freshness:findConflict");
      expect(read.error.message).toContain("EISDIR");
    } else {
      throw new Error("expected a typed cache-error(findConflict)");
    }
  });

  it("uses the exact Redis member serialization only for deterministic tie comparison", () => {
    const entry = {
      resource: "tie:serialization",
      runId: R("run-a"),
      nodeId: N("node-a"),
      newWitness: W("tie:serialization", "日本語", "custom"),
      succeededAtMs: 100,
    };
    expect(__testSerializeRedisFreshnessMember(entry)).toBe(
      encodeRedisMember(entry.runId, entry.nodeId, "custom", "日本語"),
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-process singleton convergence (ADR-0079) — the in-process
// serializes-concurrent-writers test cannot prove the invariant across
// processes; the freshness index is the public API whose documented use is
// multi-process sharing, so race three real bun children on one directory
// and demand exactly one deterministic singleton (round-12 A3)
// ---------------------------------------------------------------------------

describe("createFileFreshnessIndex — cross-process singleton convergence (ADR-0079)", () => {
  it("three racing processes converge on exactly one deterministic max-score singleton", async () => {
    const dir = tempDirectory();
    mkdirSync(dir, { recursive: true });
    const resource = "cp:resource";
    // Each child records 5 writes for the SAME resource with globally unique
    // scores (id*100+i ⇒ 0..4, 100..104, 200..204): the winner is therefore
    // unambiguous regardless of lock acquisition order — child "2", i=4
    // (score 204). The 10 ms sleep widens the contention window so the
    // children actually overlap.
    const indexPath = pathToFileURL(join(__dirname, "..", "file", "freshness-index.js")).href;
    const script = join(dir, "child-record.ts");
    writeFileSync(
      script,
      [
        `import { createFileFreshnessIndex } from ${JSON.stringify(indexPath)};`,
        `const dir = process.env.F_DIR;`,
        `const id = process.env.F_ID;`,
        `if (!dir || !id) throw new Error("missing F_DIR/F_ID");`,
        `const index = createFileFreshnessIndex(dir);`,
        `for (let i = 0; i < 5; i++) {`,
        `  const succeededAtMs = Number(id) * 100 + i;`,
        `  const result = await index.recordWrite({`,
        `    type: "write-attempted",`,
        `    runId: \`run-\${id}\`,` ,
        `    dagId: "dag-1",`,
        `    nodeId: \`writer-\${id}\`,` ,
        `    conditionedOn: { kind: "version", resource: "cp:resource", value: "none" },`,
        `    newWitness: { kind: "version", resource: "cp:resource", value: \`\${id}:\${i}\` },`,
        `    succeededAtMs,`,
        `    timestamp: new Date(succeededAtMs),`,
        `  });`,
        `  if (!result.ok) {`,
        `    console.error(\`child \${id} write \${i} failed: \${result.error}\`);`,
        `    process.exit(1);`,
        `  }`,
        `  await new Promise((r) => setTimeout(r, 10));`,
        `}`,
      ].join("\n"),
    );

    const runChild = (id: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: { ...process.env, F_DIR: dir, F_ID: id },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`child ${id} exited ${code}: ${stderr.slice(0, 500)}`));
          else resolve(code ?? 0);
        });
      });

    const codes = await Promise.all([runChild("0"), runChild("1"), runChild("2")]);
    expect(codes).toEqual([0, 0, 0]);

    // Exactly ONE durable record file: no litter, no partials, no divergence.
    const jsonFiles = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(jsonFiles).toEqual([`${keyDigest(resource)}.json`]);

    // A fresh instance (real clock) sees the deterministic max-score winner —
    // the singleton's identity is independent of which process won the lock
    // in which order. The winner must be ASSERTED, not conditionally checked:
    // ADR-0079's drop-with-warning path treats a corrupt singleton as absent
    // (`ok(null)`), and an `if (found.value !== null)` guard would silently
    // skip every assertion below in exactly the failure case this pin guards.
    const reader = createFileFreshnessIndex(dir);
    const found = await reader.findConflict(W(resource, "never-written"), 0);
    const winner = unwrap(found);
    if (winner === null) {
      throw new Error(
        "the committed singleton was dropped-with-warning (ok(null)) — exactly the corrupt-singleton case this pin must not skip",
      );
    }
    expect(winner.succeededAtMs).toBe(204);
    expect(winner.newWitness.value).toBe("2:4");
    expect(String(winner.runId)).toBe("run-2");
    expect(String(winner.nodeId)).toBe("writer-2");
  }, 30_000);
});
