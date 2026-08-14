/**
 * Tests for `src/file/checkpointer.ts` — the filesystem `Checkpointer`
 * backend (spec FR-016/FR-020/FR-022/FR-024..FR-029/FR-040, SC-001, US2;
 * plan AD-1/AD-2/AD-6):
 *
 * - the ENTIRE shared `checkpointerSuite` over fresh temp directories, with
 *   all byte-persistence capabilities enabled: corrupt meta and corrupt node,
 *   plus shared version/fingerprint/TTL semantics (SC-001)
 * - AD-1 composite addressing: canonical folding, and every permutation of
 *   namespace/index/attempt resolving to a DISTINCT durable entry, all
 *   returned by one `load` (FR-022)
 * - per-entry corruption dropped and surfaced in `corruptNodeIds`, keyed by
 *   the stored nodeKey when it is trustworthy and by the filename when it is
 *   not; duplicate primitive Map keys are rejected before deserialization
 * - node-file read failures remain `cache-error(load)` and are never warned/
 *   dropped as persisted corruption (FR-028)
 * - FR-016 hostile identifiers: runId / nodeId / state.nodeId / namespace /
 *   index / attempt all fail closed with a typed error and never escape the
 *   caller-supplied directory
 * - FR-029 atomicity: `.tmp.<unique-token>` crash litter is invisible to the reader, a
 *   failed commit leaves no partial entry, sequential re-saves replace cleanly
 * - FR-025/FR-026/FR-027 load order: version mismatch, opt-in fingerprint
 *   gate, lazy 24h expiry through the injected clock
 * - US2: unknown run ⇒ clean `null`, never an error
 * - FR-040: nothing throws across the port boundary
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCheckpointer, META_RECORD_NODE_ID } from "../file/checkpointer.js";
import {
  createFileCheckpointer as barrelCreateFileCheckpointer,
  META_RECORD_NODE_ID as barrelMetaRecordNodeId,
} from "../file.js";
import { META_FILE, NODES_DIR, TTL_SECONDS, keyDigest } from "../file/layout.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import type { Checkpointer, NodeState, RunMeta } from "../checkpoint/checkpointer.js";
import { checkpointerSuite } from "./_checkpointer-suite.js";
import { D, R } from "./_id-helpers.js";
import type { RunId } from "../types/ids.js";
import { __brandRunIdUnchecked } from "../types/ids.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";

/**
 * Brand a HOSTILE string as a `RunId` without validating it — `R()` (and the
 * framework's smart constructors) reject these by design, which is exactly
 * why they cannot build the fixture. This simulates the real threat: a
 * bypassed brand reaching the persistence boundary, where the backend's own
 * re-validation (FR-016) must catch it.
 */
const hostileRunId = (raw: string): RunId => __brandRunIdUnchecked(raw);

const expectFactoryFailure = (construct: () => unknown, message: RegExp): void => {
  let failure: unknown;
  try {
    construct();
  } catch (error) {
    failure = error;
  }
  expect(isFrameworkError(failure)).toBe(true);
  if (!isFrameworkError(failure) || failure.kind !== "cache-error") {
    throw new Error("expected typed cache-error from createFileCheckpointer");
  }
  const typed: Extract<FrameworkError, { readonly kind: "cache-error" }> = failure;
  expect(typed.kind).toBe("cache-error");
  expect(typed.operation).toBe("createFileCheckpointer");
  expect(typed.message).toMatch(message);
};

// ---------------------------------------------------------------------------
// Temp-directory plumbing
// ---------------------------------------------------------------------------

const created: string[] = [];

const freshDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "fugue-file-checkpointer-"));
  created.push(directory);
  return directory;
};

afterEach(() => {
  __resetFrameworkLogger();
});

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

const META = (overrides?: Partial<RunMeta>): RunMeta => ({
  dagId: D("d"),
  startedAt: new Date("2025-01-01T00:00:00Z"),
  nodeCount: 1,
  ...overrides,
});

const node = (nodeId: string, output: unknown): NodeState => ({
  nodeId,
  output,
  completedAt: new Date("2025-06-01T12:00:00Z"),
});

/** Fresh instances are required because a revoked Proxy cannot be cloned or
 * safely labelled. Every value is legal to throw in JavaScript and hostile to
 * at least one ordinary error-formatting fallback. */
const hostileErrorCorpus = (): readonly unknown[] => {
  const throwingMessage = new Error("hidden");
  Object.defineProperty(throwingMessage, "message", {
    configurable: true,
    get: () => { throw new Error("message getter must stay contained"); },
  });

  const throwingToString = Object.defineProperties({}, {
    toString: {
      get: () => { throw new Error("toString getter must stay contained"); },
    },
    [Symbol.toPrimitive]: {
      get: () => { throw new Error("Symbol.toPrimitive getter must stay contained"); },
    },
  });
  const throwingPrototype = new Proxy({}, {
    getPrototypeOf: () => { throw new Error("getPrototypeOf trap must stay contained"); },
  });
  const throwingOwnKeys = new Proxy({}, {
    ownKeys: () => { throw new Error("ownKeys trap must stay contained"); },
  });
  const throwingCoercion = new Proxy({}, {
    get: (_target, key) => {
      if (key === "toString" || key === Symbol.toPrimitive || key === Symbol.toStringTag) {
        throw new Error("coercion trap must stay contained");
      }
      return undefined;
    },
  });
  const revokedPair = Proxy.revocable({}, {});
  revokedPair.revoke();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  return [
    throwingPrototype,
    throwingOwnKeys,
    throwingToString,
    throwingCoercion,
    throwingMessage,
    revokedPair.proxy,
    cyclic,
  ];
};

const nodesDirOf = (directory: string, runId: string): string =>
  join(directory, runId, NODES_DIR);

/** Write a raw `meta.json` straight to disk, bypassing `setMeta` — the file
 * backend's equivalent of the Redis suite's raw `redis.set`. */
const writeRawMeta = (directory: string, runId: string, contents: string): void => {
  mkdirSync(join(directory, runId), { recursive: true });
  writeFileSync(join(directory, runId, META_FILE), contents);
};

/** Write a raw node entry, addressed by an EXPLICIT filename so tests can
 * deliberately break the AD-2 filename↔content digest agreement. */
const writeRawNode = (directory: string, runId: string, fileName: string, contents: string): void => {
  const nodes = nodesDirOf(directory, runId);
  mkdirSync(nodes, { recursive: true });
  writeFileSync(join(nodes, fileName), contents);
};

/** Build raw node bytes while leaving `outputJson` untouched, so adversarial
 * serializer-tag and pollution-key payloads are not normalized by the test
 * fixture's own serializer before reaching the checkpointer. */
const rawNodeWithOutput = (nodeKey: string, outputJson: string): string =>
  `{"nodeKey":${JSON.stringify(nodeKey)},"nodeId":${JSON.stringify(nodeKey)},"output":${outputJson},"completedAt":"2025-06-01T12:00:00.000Z"}`;

// ---------------------------------------------------------------------------
// SC-001 — the ENTIRE shared suite, zero carve-outs
// ---------------------------------------------------------------------------

// `factory` runs first in the suite's `beforeEach`, so every test gets a
// pristine directory and the raw callbacks below address that same directory.
let suiteDirectory = "";

checkpointerSuite(
  "FileCheckpointer",
  () => {
    suiteDirectory = freshDirectory();
    return createFileCheckpointer(suiteDirectory);
  },
  {
    // Caller-supplied frameworkVersion wins over the FR-024 default stamp —
    // the public API is enough to construct a stale-version payload.
    setStaleVersion: async (cp, runId, { startedAt, nodeCount }) => {
      const result = await cp.setMeta(R(runId), {
        dagId: D("d"),
        startedAt,
        nodeCount,
        frameworkVersion: "1",
      });
      expect(result.ok).toBe(true);
    },
    // `setMeta` always stamps a version, so the "written before the field
    // existed" payload must bypass it — raw bytes, exactly like the Redis
    // suite's `redis.set`.
    setMissingVersion: async (_cp, runId, { startedAt, nodeCount }) => {
      writeRawMeta(
        suiteDirectory,
        runId,
        JSON.stringify({
          dagId: "d",
          startedAt: startedAt.toISOString(),
          nodeCount,
          createdAt: new Date().toISOString(),
        }),
      );
    },
    setExpired: async (_cp, runId, { startedAt, nodeCount, expiredAt }) => {
      writeRawMeta(
        suiteDirectory,
        runId,
        JSON.stringify({
          dagId: "d",
          startedAt: startedAt.toISOString(),
          nodeCount,
          createdAt: expiredAt.toISOString(),
          frameworkVersion: FRAMEWORK_VERSION,
        }),
      );
    },
    // The file backend persists BYTES, so the corrupt-meta case is mandatory
    // here — unlike in-memory, it is a representable durable state.
    setCorrupt: async (_cp, runId) => {
      writeRawMeta(suiteDirectory, runId, "{ not valid json");
    },
    setCorruptNode: async (_cp, runId, nodeId) => {
      writeRawNode(
        suiteDirectory,
        runId,
        `${keyDigest(nodeId)}.json`,
        JSON.stringify({
          nodeKey: nodeId,
          nodeId,
          output: null,
          completedAt: "not-a-date",
        }),
      );
      return { corruptAddress: nodeId };
    },
  },
);

// ---------------------------------------------------------------------------
// Barrel surface (FR-042)
// ---------------------------------------------------------------------------

describe("FileCheckpointer — subpath barrel", () => {
  it("exports the factory and grammar-valid metadata diagnostic location", () => {
    expect(barrelCreateFileCheckpointer).toBe(createFileCheckpointer);
    expect(barrelMetaRecordNodeId).toBe(META_RECORD_NODE_ID);
    expect(String(META_RECORD_NODE_ID)).toBe("checkpoint_meta");
  });
});

// ---------------------------------------------------------------------------
// US2 — unknown run ⇒ clean null
// ---------------------------------------------------------------------------

describe("FileCheckpointer — unknown run", () => {
  it("load of a run that was never written returns ok(null)", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    const result = await cp.load(R("never-existed"));
    expect(result).toEqual({ ok: true, value: null });
  });

  it("load of a run directory with no meta.json returns ok(null), not an error", async () => {
    const directory = freshDirectory();
    // A run directory (and even node entries) with no committed meta is the
    // shape a crash between mkdir and the meta commit leaves behind.
    writeRawNode(directory, "half-born", `${keyDigest("n1")}.json`, "{}");
    const result = await createFileCheckpointer(directory).load(R("half-born"));
    expect(result).toEqual({ ok: true, value: null });
  });

  it("load after setMeta on a DIFFERENT run still returns null for the unknown one", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-a"), META());
    const result = await cp.load(R("run-b"));
    expect(result).toEqual({ ok: true, value: null });
  });

  it("meta with no nodes/ directory loads with an empty nodes map and no corruptNodeIds", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-empty"), META({ nodeCount: 4 }));
    const result = await cp.load(R("run-empty"));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.nodes).toEqual({});
    expect(result.value.corruptNodeIds).toBeUndefined();
    expect(result.value.meta.nodeCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// FR-024 — framework version stamping, and full meta round-trip
// ---------------------------------------------------------------------------

describe("FileCheckpointer — metadata", () => {
  it("stamps FRAMEWORK_VERSION when the caller supplies none (FR-024)", async () => {
    const directory = freshDirectory();
    await createFileCheckpointer(directory).setMeta(R("run-v"), META());
    const stored = JSON.parse(readFileSync(join(directory, "run-v", META_FILE), "utf-8"));
    expect(stored.frameworkVersion).toBe(FRAMEWORK_VERSION);
  });

  it("round-trips subject and dagFingerprint", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(
      R("run-s"),
      META({ subject: "tenant-42", dagFingerprint: "fp-1", startedAt: new Date("2024-03-04T05:06:07.008Z") }),
    );
    const result = await cp.load(R("run-s"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.meta.subject).toBe("tenant-42");
    expect(result.value.meta.dagFingerprint).toBe("fp-1");
    expect(result.value.meta.startedAt.toISOString()).toBe("2024-03-04T05:06:07.008Z");
  });

  it("rejects parseable but non-canonical startedAt/createdAt spellings", async () => {
    const canonical = {
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      frameworkVersion: FRAMEWORK_VERSION,
    };
    const nonCanonical = [
      "2025-01-01",
      "2025-01-01T00:00:00Z",
      "2025-01-01T01:00:00.000+01:00",
    ] as const;

    for (const field of ["startedAt", "createdAt"] as const) {
      for (const [index, timestamp] of nonCanonical.entries()) {
        const directory = freshDirectory();
        const runId = `run-noncanonical-${field}-${index}`;
        writeRawMeta(directory, runId, JSON.stringify({ ...canonical, [field]: timestamp }));
        const result = await createFileCheckpointer(directory).load(R(runId));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected non-canonical metadata rejection");
        expect(result.error.kind).toBe("checkpoint-corrupt");
        if (result.error.kind !== "checkpoint-corrupt") throw new Error("unreachable");
        expect(result.error.message).toContain(`${field} must be a canonical ISO timestamp`);
      }
    }
  });

  it("strictly parses known metadata fields while permitting unknown additive fields", async () => {
    const directory = freshDirectory();
    writeRawMeta(directory, "run-additive-meta", JSON.stringify({
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 2,
      createdAt: new Date().toISOString(),
      frameworkVersion: FRAMEWORK_VERSION,
      futureSchemaVersion: 2,
      futureMetadata: { nested: true },
    }));

    const result = await createFileCheckpointer(directory).load(R("run-additive-meta"));
    if (!result.ok || result.value === null) throw new Error("expected additive metadata to load");
    expect(result.value.meta).toEqual({
      dagId: "d",
      startedAt: new Date("2025-01-01T00:00:00.000Z"),
      nodeCount: 2,
      frameworkVersion: FRAMEWORK_VERSION,
    });
  });

  it("setMeta is idempotent-by-overwrite — the last committed meta wins", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-o"), META({ nodeCount: 1 }));
    await cp.setMeta(R("run-o"), META({ nodeCount: 9 }));
    const result = await cp.load(R("run-o"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.meta.nodeCount).toBe(9);
    expect(readdirSync(join(created[created.length - 1], "run-o"))).toEqual([META_FILE]);
  });

  it("snapshots every required and optional metadata accessor exactly once before validation", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    const reads: Record<string, number> = {
      dagId: 0,
      startedAt: 0,
      nodeCount: 0,
      subject: 0,
      dagFingerprint: 0,
      frameworkVersion: 0,
    };
    const firstThen = <T>(field: string, first: T, later: unknown) => () => {
      reads[field] += 1;
      return reads[field] === 1 ? first : later;
    };
    const meta = Object.defineProperties({}, {
      dagId: { enumerable: true, get: firstThen("dagId", "dag-snapshot", 7) },
      startedAt: {
        enumerable: true,
        get: firstThen("startedAt", new Date("2025-02-03T04:05:06.007Z"), new Date("invalid")),
      },
      nodeCount: { enumerable: true, get: firstThen("nodeCount", 3, -1) },
      subject: { enumerable: true, get: firstThen("subject", "subject-first", false) },
      dagFingerprint: {
        enumerable: true,
        get: firstThen("dagFingerprint", "fingerprint-first", null),
      },
      frameworkVersion: {
        enumerable: true,
        get: firstThen("frameworkVersion", FRAMEWORK_VERSION, 99),
      },
    }) as RunMeta;

    const saved = await cp.setMeta(R("run-meta-snapshot"), meta);
    expect(saved.ok).toBe(true);
    expect(reads).toEqual({
      dagId: 1,
      startedAt: 1,
      nodeCount: 1,
      subject: 1,
      dagFingerprint: 1,
      frameworkVersion: 1,
    });
    const stored = JSON.parse(
      readFileSync(join(directory, "run-meta-snapshot", META_FILE), "utf-8"),
    );
    expect(stored).toMatchObject({
      dagId: "dag-snapshot",
      startedAt: "2025-02-03T04:05:06.007Z",
      nodeCount: 3,
      subject: "subject-first",
      dagFingerprint: "fingerprint-first",
      frameworkVersion: FRAMEWORK_VERSION,
    });
  });

  it("maps a throwing getter for every metadata field to checkpoint-write-failed without bytes", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    const fields = [
      "dagId",
      "startedAt",
      "nodeCount",
      "subject",
      "dagFingerprint",
      "frameworkVersion",
    ] as const;

    for (const [index, field] of fields.entries()) {
      const meta = {
        ...META({
          subject: "subject",
          dagFingerprint: "fingerprint",
          frameworkVersion: FRAMEWORK_VERSION,
        }),
      } as Record<string, unknown>;
      Object.defineProperty(meta, field, {
        enumerable: true,
        get: () => { throw new Error(`${field} unavailable`); },
      });
      const runId = `run-meta-throw-${index}`;
      const result = await cp.setMeta(R(runId), meta as unknown as RunMeta);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${field} getter rejection`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      expect(result.error.message).toContain(`${field} unavailable`);
      expect(existsSync(join(directory, runId))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-026 — opt-in DAG fingerprint gate
// ---------------------------------------------------------------------------

describe("FileCheckpointer — expectedDagFingerprint (FR-026)", () => {
  const withFingerprint = async (fingerprint?: string): Promise<Checkpointer> => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-f"), META(fingerprint !== undefined ? { dagFingerprint: fingerprint } : {}));
    return cp;
  };

  it("accepts a matching fingerprint", async () => {
    const cp = await withFingerprint("fp-1");
    const result = await cp.load(R("run-f"), { expectedDagFingerprint: "fp-1" });
    expect(result.ok).toBe(true);
  });

  it("rejects a DIFFERENT stored fingerprint with checkpoint-version-mismatch", async () => {
    const cp = await withFingerprint("fp-1");
    const result = await cp.load(R("run-f"), { expectedDagFingerprint: "fp-2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-version-mismatch");
    if (result.error.kind !== "checkpoint-version-mismatch") throw new Error("unreachable");
    expect(result.error.expected).toBe("fp-2");
    expect(result.error.actual).toBe("fp-1");
  });

  it("rejects an ABSENT stored fingerprint with checkpoint-version-mismatch", async () => {
    const cp = await withFingerprint(undefined);
    const result = await cp.load(R("run-f"), { expectedDagFingerprint: "fp-2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-version-mismatch");
    if (result.error.kind !== "checkpoint-version-mismatch") throw new Error("unreachable");
    expect(result.error.actual).toBeUndefined();
  });

  it("runs no check at all when the caller omits the option", async () => {
    const cp = await withFingerprint("fp-1");
    const result = await cp.load(R("run-f"));
    expect(result.ok).toBe(true);
  });

  it("strictly rejects every unsupported runtime load-options shape as cache-error(load)", async () => {
    class OptionsInstance {
      readonly expectedDagFingerprint = "fp-1";
    }
    const inherited = Object.create({ expectedDagFingerprint: "fp-1" });
    const throwingPrototype = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("prototype unavailable"); },
    });
    const throwingKeys = new Proxy({}, {
      ownKeys: () => { throw new Error("keys unavailable"); },
    });
    const throwingFingerprint = Object.defineProperty({}, "expectedDagFingerprint", {
      enumerable: true,
      get: () => { throw new Error("fingerprint unavailable"); },
    });
    const hostile: readonly unknown[] = [
      null,
      false,
      true,
      0,
      1,
      "options",
      1n,
      Symbol("options"),
      () => ({}),
      [],
      ["fp-1"],
      new Date(),
      /fp-1/,
      new OptionsInstance(),
      inherited,
      { unsupported: true },
      { expectedDagFingerprint: "fp-1", extra: true },
      { [Symbol("fingerprint")]: "fp-1" },
      { expectedDagFingerprint: null },
      { expectedDagFingerprint: 1 },
      throwingPrototype,
      throwingKeys,
      throwingFingerprint,
    ];
    const cp = await withFingerprint("fp-1");

    for (const option of hostile) {
      const result = await cp.load(
        R("run-f"),
        option as Parameters<Checkpointer["load"]>[1],
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected hostile load options to be rejected");
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind !== "cache-error") throw new Error("unreachable");
      expect(result.error.operation).toBe("load");
    }
  });

  it("snapshots an own fingerprint getter once and accepts null-prototype load options", async () => {
    const cp = await withFingerprint("fp-1");
    let reads = 0;
    const stateful = Object.defineProperty({}, "expectedDagFingerprint", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "fp-1" : "wrong-after-snapshot";
      },
    });
    const matched = await cp.load(
      R("run-f"),
      stateful as Parameters<Checkpointer["load"]>[1],
    );
    expect(matched.ok).toBe(true);
    expect(reads).toBe(1);

    const nullPrototype = Object.create(null) as { expectedDagFingerprint?: string };
    nullPrototype.expectedDagFingerprint = "fp-1";
    expect((await cp.load(R("run-f"), nullPrototype)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-027 — lazy 24h expiry through the injected clock
// ---------------------------------------------------------------------------

describe("FileCheckpointer — lazy TTL (FR-027)", () => {
  const atBoundary = async (offsetMs: number) => {
    let nowMs = Date.parse("2025-01-01T00:00:00Z");
    const cp = createFileCheckpointer(freshDirectory(), { now: () => nowMs });
    await cp.setMeta(R("run-t"), META());
    nowMs += offsetMs;
    return cp.load(R("run-t"));
  };

  it("accepts a checkpoint exactly at the TTL boundary", async () => {
    const result = await atBoundary(TTL_SECONDS * 1000);
    expect(result.ok).toBe(true);
  });

  it("rejects one millisecond past the TTL with checkpoint-expired", async () => {
    const result = await atBoundary(TTL_SECONDS * 1000 + 1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-expired");
    if (result.error.kind !== "checkpoint-expired") throw new Error("unreachable");
    expect(result.error.expiredAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("evaluates expiry lazily — the bytes stay on disk and a rewound clock loads them again", async () => {
    let nowMs = Date.parse("2025-01-01T00:00:00Z");
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory, { now: () => nowMs });
    await cp.setMeta(R("run-l"), META());
    await cp.saveNode(R("run-l"), "n1", node("n1", 1));

    nowMs += TTL_SECONDS * 1000 + 1;
    const expired = await cp.load(R("run-l"));
    expect(expired.ok).toBe(false);

    // No sweeper, no physical GC: the durable state is untouched, so the same
    // directory read at an in-window instant still serves the checkpoint.
    expect(existsSync(join(directory, "run-l", META_FILE))).toBe(true);
    expect(readdirSync(nodesDirOf(directory, "run-l"))).toHaveLength(1);
    nowMs = Date.parse("2025-01-01T01:00:00Z");
    const alive = await cp.load(R("run-l"));
    expect(alive.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-025..FR-028 — overlapping failure precedence
// ---------------------------------------------------------------------------

describe("FileCheckpointer — load failure precedence", () => {
  const nowMs = Date.parse("2025-01-03T00:00:00.000Z");
  const warnings: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
    });
  });

  const seedOverlappingFailures = (
    directory: string,
    metaOverrides: Readonly<Record<string, unknown>>,
  ): void => {
    writeRawMeta(
      directory,
      "run-order",
      JSON.stringify({
        dagId: "d",
        startedAt: "2025-01-01T00:00:00.000Z",
        nodeCount: 1,
        createdAt: "2025-01-01T00:00:00.000Z",
        frameworkVersion: FRAMEWORK_VERSION,
        dagFingerprint: "expected-fingerprint",
        ...metaOverrides,
      }),
    );
    writeRawNode(
      directory,
      "run-order",
      `${keyDigest("corrupt-node")}.json`,
      "truncated{",
    );
  };

  const load = (directory: string) =>
    createFileCheckpointer(directory, { now: () => nowMs }).load(R("run-order"), {
      expectedDagFingerprint: "expected-fingerprint",
    });

  it("meta shape wins over version, fingerprint, TTL, and corrupt nodes", async () => {
    const directory = freshDirectory();
    seedOverlappingFailures(directory, {
      nodeCount: "not-a-number",
      frameworkVersion: "stale",
      dagFingerprint: "wrong",
    });
    const result = await load(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-corrupt");
    expect(warnings).toEqual([]);
  });

  it("framework version wins over fingerprint, TTL, and corrupt nodes", async () => {
    const directory = freshDirectory();
    seedOverlappingFailures(directory, {
      frameworkVersion: "stale",
      dagFingerprint: "wrong",
    });
    const result = await load(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-version-mismatch");
    if (result.error.kind !== "checkpoint-version-mismatch") throw new Error("unreachable");
    expect(result.error.expected).toBe(FRAMEWORK_VERSION);
    expect(result.error.actual).toBe("stale");
    expect(warnings).toEqual([]);
  });

  it("expected fingerprint wins over TTL and corrupt nodes", async () => {
    const directory = freshDirectory();
    seedOverlappingFailures(directory, { dagFingerprint: "wrong" });
    const result = await load(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-version-mismatch");
    if (result.error.kind !== "checkpoint-version-mismatch") throw new Error("unreachable");
    expect(result.error.expected).toBe("expected-fingerprint");
    expect(result.error.actual).toBe("wrong");
    expect(warnings).toEqual([]);
  });

  it("TTL wins over corrupt nodes", async () => {
    const directory = freshDirectory();
    seedOverlappingFailures(directory, {});
    const result = await load(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-expired");
    expect(warnings).toEqual([]);
  });

  it("nodes are evaluated only after meta shape, version, fingerprint, and TTL pass", async () => {
    const directory = freshDirectory();
    seedOverlappingFailures(directory, { createdAt: new Date(nowMs).toISOString() });
    const result = await load(directory);
    if (!result.ok || result.value === null) throw new Error("expected a loaded checkpoint");
    expect(result.value.nodes).toEqual({});
    expect(result.value.corruptNodeIds).toEqual([`${keyDigest("corrupt-node")}.json`]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Dropping corrupt checkpoint entry");
    expect(warnings[0]).toContain(`nodeKey=${keyDigest("corrupt-node")}.json`);
  });
});

// ---------------------------------------------------------------------------
// FR-022 / AD-1 — composite addressing
// ---------------------------------------------------------------------------

describe("FileCheckpointer — composite addressing (FR-022, AD-1)", () => {
  it("stores every distinct address as a distinct entry and returns them all", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-x"), META({ nodeCount: 7 }));

    const addresses: readonly (readonly [string, Parameters<Checkpointer["saveNode"]>[3], string])[] = [
      ["n1", undefined, "n1"],
      ["n1", { index: 0 }, "dag@n1@0@0"],
      ["n1", { index: 1 }, "dag@n1@1@0"],
      ["n1", { attempt: 1 }, "dag@n1@0@1"],
      ["n1", { index: 1, attempt: 1 }, "dag@n1@1@1"],
      ["n1", { namespace: "sub", index: 0 }, "sub@n1@0@0"],
      ["n2", { index: 0 }, "dag@n2@0@0"],
    ];

    for (const [nodeId, opts, expectedKey] of addresses) {
      const saved = await cp.saveNode(R("run-x"), nodeId, node(nodeId, expectedKey), opts);
      expect(saved.ok).toBe(true);
    }

    // Distinct addresses ⇒ distinct digest filenames, no collisions.
    expect(readdirSync(nodesDirOf(directory, "run-x")).sort()).toHaveLength(addresses.length);

    const result = await cp.load(R("run-x"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes).sort()).toEqual(
      addresses.map(([, , key]) => key).sort(),
    );
    for (const [nodeId, , expectedKey] of addresses) {
      // The entry is keyed by the stored nodeKey; `nodeId` inside it still
      // names the real node (AD-1).
      expect(result.value.nodes[expectedKey].output).toBe(expectedKey);
      expect(result.value.nodes[expectedKey].nodeId).toBe(nodeId);
    }
    expect(result.value.corruptNodeIds).toBeUndefined();
  });

  it("folds a namespace-only save onto the canonical key (index and attempt both absent)", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-fold"), META());
    await cp.saveNode(R("run-fold"), "n1", node("n1", "canonical"));
    await cp.saveNode(R("run-fold"), "n1", node("n1", "namespaced"), { namespace: "other" });

    expect(readdirSync(nodesDirOf(directory, "run-fold"))).toEqual([`${keyDigest("n1")}.json`]);
    const result = await cp.load(R("run-fold"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["n1"]);
    expect(result.value.nodes["n1"].output).toBe("namespaced");
  });

  it("never collides a composite key with a canonical nodeId of the same spelling", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-collide"), META());
    // The canonical id `dag` and the composite address `dag@dag@0@0` are two
    // genuinely different addresses; `@` is outside ID_PATTERN so they can
    // never be spelled the same way.
    await cp.saveNode(R("run-collide"), "dag", node("dag", "canonical"));
    await cp.saveNode(R("run-collide"), "dag", node("dag", "composite"), { index: 0 });

    const result = await cp.load(R("run-collide"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.nodes["dag"].output).toBe("canonical");
    expect(result.value.nodes["dag@dag@0@0"].output).toBe("composite");
  });

  // `__proto__` matches ID_PATTERN (`_` is in the charset), so it is a
  // LEGAL nodeId. Building the returned map with `nodes[key] = state` would
  // hit `Object.prototype`'s `__proto__` setter and re-parent the map instead
  // of storing an entry — the node would vanish with no `corruptNodeIds`
  // trace, which is exactly the silent loss US2 forbids.
  it("round-trips prototype-named node ids (__proto__/constructor/prototype) as OWN entries", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-proto"), META({ nodeCount: 3 }));
    const hostileIds = ["__proto__", "constructor", "prototype"] as const;
    for (const id of hostileIds) {
      expect((await cp.saveNode(R("run-proto"), id, node(id, `out-${id}`))).ok).toBe(true);
    }

    const result = await cp.load(R("run-proto"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes).sort()).toEqual([...hostileIds].sort());
    for (const id of hostileIds) {
      expect(Object.hasOwn(result.value.nodes, id)).toBe(true);
      expect(result.value.nodes[id].output).toBe(`out-${id}`);
      expect(result.value.nodes[id].nodeId).toBe(id);
    }
    expect(result.value.corruptNodeIds).toBeUndefined();
    // The map itself was never re-parented by the `__proto__` entry.
    expect(Object.getPrototypeOf(result.value.nodes)).toBe(Object.prototype);
  });

  it("round-trips a composite address whose nodeId and namespace are __proto__", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-proto2"), META());
    const saved = await cp.saveNode(R("run-proto2"), "__proto__", node("__proto__", "composite"), {
      namespace: "__proto__",
      index: 1,
    });
    expect(saved.ok).toBe(true);

    const result = await cp.load(R("run-proto2"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["__proto__@__proto__@1@0"]);
    expect(result.value.nodes["__proto__@__proto__@1@0"].output).toBe("composite");
  });

  it("addresses node files by the sha256 digest of the stored nodeKey (AD-2)", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-digest"), META());
    await cp.saveNode(R("run-digest"), "n1", node("n1", 1), { namespace: "sub", index: 2, attempt: 3 });
    expect(readdirSync(nodesDirOf(directory, "run-digest"))).toEqual([
      `${keyDigest("sub@n1@2@3")}.json`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Output fidelity
// ---------------------------------------------------------------------------

describe("FileCheckpointer — output fidelity", () => {
  it("round-trips Map/Set/Date inside a node output", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-fid"), META());
    const output = {
      map: new Map<string, number>([["a", 1]]),
      set: new Set([1, 2]),
      when: new Date("2023-07-08T09:10:11.012Z"),
      nested: [{ deep: true }],
    };
    await cp.saveNode(R("run-fid"), "n1", node("n1", output));

    const result = await cp.load(R("run-fid"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.nodes["n1"].output).toEqual(output);
    expect(result.value.nodes["n1"].completedAt.toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });

  it("round-trips an undefined output without treating the entry as corrupt", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-undef"), META());
    await cp.saveNode(R("run-undef"), "n1", node("n1", undefined));

    const result = await cp.load(R("run-undef"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["n1"]);
    expect(result.value.nodes["n1"].output).toBeUndefined();
    expect(result.value.corruptNodeIds).toBeUndefined();
  });

  it("preserves distinct object-key identities even when their serialized shapes match", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-object-keys"), META());
    const first = { id: 1 };
    const second = { id: 1 };
    await cp.saveNode(
      R("run-object-keys"),
      "n1",
      node("n1", new Map<Readonly<{ id: number }>, string>([[first, "first"], [second, "second"]])),
    );

    const result = await cp.load(R("run-object-keys"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    const output = result.value.nodes["n1"].output;
    expect(output).toBeInstanceOf(Map);
    expect([...(output as Map<unknown, unknown>).entries()]).toEqual([
      [{ id: 1 }, "first"],
      [{ id: 1 }, "second"],
    ]);
  });

  it("preserves distinct Set object identities with equal serialized shapes", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-object-set"), META());
    const first = { id: 1 };
    const second = { id: 1 };
    await cp.saveNode(
      R("run-object-set"),
      "n1",
      node("n1", new Set<unknown>([first, second, "primitive", undefined])),
    );

    const result = await cp.load(R("run-object-set"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    const output = result.value.nodes["n1"].output;
    expect(output).toBeInstanceOf(Set);
    expect([...(output as Set<unknown>).values()]).toEqual([
      { id: 1 },
      { id: 1 },
      "primitive",
      undefined,
    ]);
  });
});

// ---------------------------------------------------------------------------
// FR-028 — per-entry corruption is dropped and surfaced
// ---------------------------------------------------------------------------

describe("FileCheckpointer — corrupt node entries (FR-028)", () => {
  const warnings: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
    });
  });

  const expectWarningsFor = (addresses: readonly string[]): void => {
    expect(warnings).toHaveLength(addresses.length);
    for (const address of addresses) {
      const warning = warnings.find((candidate) => candidate.includes(`nodeKey=${address}:`));
      expect(warning).toBeDefined();
      expect(warning).toContain("[FileCheckpointer] Dropping corrupt checkpoint entry");
      expect(warning).toContain("runId=run-c");
    }
  };

  const seed = async (): Promise<{ directory: string; cp: Checkpointer }> => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-c"), META({ nodeCount: 5 }));
    await cp.saveNode(R("run-c"), "good", node("good", "kept"));
    return { directory, cp };
  };

  it("drops a truncated entry and surfaces its FILENAME (the nodeKey is unrecoverable)", async () => {
    const { directory, cp } = await seed();
    const fileName = `${keyDigest("truncated")}.json`;
    writeRawNode(directory, "run-c", fileName, '{"nodeKey":"trunc');

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    expect(result.value.nodes["good"].output).toBe("kept");
    expect(result.value.corruptNodeIds).toEqual([fileName]);
    expectWarningsFor([fileName]);
  });

  it("drops a digest-mismatched entry and surfaces its recoverable nodeKey", async () => {
    const { directory, cp } = await seed();
    const fileName = `${keyDigest("addressed-as")}.json`;
    writeRawNode(
      directory,
      "run-c",
      fileName,
      JSON.stringify({
        nodeKey: "claims-to-be",
        nodeId: "claims-to-be",
        output: 1,
        completedAt: "2025-06-01T12:00:00.000Z",
      }),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual(["claims-to-be"]);
    expect(result.value.nodes["claims-to-be"]).toBeUndefined();
    expectWarningsFor(["claims-to-be"]);
  });

  it("drops an entry with a well-formed, correctly-addressed nodeKey and surfaces the NODEKEY", async () => {
    const { directory, cp } = await seed();
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest("dag@n9@0@0")}.json`,
      JSON.stringify({
        nodeKey: "dag@n9@0@0",
        nodeId: "n9",
        output: 1,
        completedAt: "not-a-date",
      }),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual(["dag@n9@0@0"]);
    expectWarningsFor(["dag@n9@0@0"]);
  });

  it("drops Date-parseable non-canonical completedAt values, warns, and surfaces every nodeKey", async () => {
    const { directory, cp } = await seed();
    const nonCanonical = [
      ["date-only", "2025-06-01"],
      ["missing-millis", "2025-06-01T12:00:00Z"],
      ["offset", "2025-06-01T13:00:00.000+01:00"],
    ] as const;
    for (const [nodeKey, completedAt] of nonCanonical) {
      writeRawNode(
        directory,
        "run-c",
        `${keyDigest(nodeKey)}.json`,
        JSON.stringify({ nodeKey, nodeId: nodeKey, output: 1, completedAt }),
      );
    }

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    const addresses = nonCanonical.map(([nodeKey]) => nodeKey);
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    expect([...(result.value.corruptNodeIds ?? [])].sort()).toEqual([...addresses].sort());
    expectWarningsFor(addresses);
    expect(
      warnings.every((warning) =>
        warning.includes("completedAt must be a canonical ISO timestamp"),
      ),
    ).toBe(true);
  });

  it("drops an entry missing its output field and surfaces the nodeKey", async () => {
    const { directory, cp } = await seed();
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest("n8")}.json`,
      JSON.stringify({ nodeKey: "n8", nodeId: "n8", completedAt: "2025-06-01T12:00:00.000Z" }),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual(["n8"]);
    expectWarningsFor(["n8"]);
  });

  it("drops a wrongly named *.json file and surfaces its recoverable nodeKey", async () => {
    const { directory, cp } = await seed();
    writeRawNode(directory, "run-c", "not-a-digest.json", JSON.stringify({ nodeKey: "x" }));

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual(["x"]);
    expectWarningsFor(["x"]);
  });

  it("drops an entry whose nodeKey and nodeId disagree", async () => {
    const { directory, cp } = await seed();
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest("dag@n1@2@0")}.json`,
      JSON.stringify({
        nodeKey: "dag@n1@2@0",
        nodeId: "n2",
        output: 1,
        completedAt: "2025-06-01T12:00:00.000Z",
      }),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual(["dag@n1@2@0"]);
    expect(result.value.nodes["dag@n1@2@0"]).toBeUndefined();
    expectWarningsFor(["dag@n1@2@0"]);
  });

  it("drops an entry whose nodeKey is a malformed composite address", async () => {
    const { directory, cp } = await seed();
    const malformed = "dag@n1@notanumber@0";
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest(malformed)}.json`,
      JSON.stringify({
        nodeKey: malformed,
        nodeId: "n1",
        output: 1,
        completedAt: "2025-06-01T12:00:00.000Z",
      }),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual([`${keyDigest(malformed)}.json`]);
    expectWarningsFor([`${keyDigest(malformed)}.json`]);
  });

  it("surfaces every corrupt address at once while keeping all good entries", async () => {
    const { directory, cp } = await seed();
    await cp.saveNode(R("run-c"), "good2", node("good2", "kept2"), { index: 3 });
    writeRawNode(directory, "run-c", `${keyDigest("a")}.json`, "nope");
    writeRawNode(directory, "run-c", `${keyDigest("b")}.json`, "[]");

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes).sort()).toEqual(["dag@good2@3@0", "good"]);
    const corruptAddresses = [`${keyDigest("a")}.json`, `${keyDigest("b")}.json`];
    expect([...(result.value.corruptNodeIds ?? [])].sort()).toEqual(
      [...corruptAddresses].sort(),
    );
    expectWarningsFor(corruptAddresses);
  });

  it("rejects non-canonical and ambiguous serializer tags before deserialization", async () => {
    const { directory, cp } = await seed();
    const adversarialOutputs: readonly (readonly [string, string])[] = [
      ["map-extra", '{"__map__":[["kept",1]],"extra":"would-be-truncated"}'],
      ["map-wide-tuple", '{"__map__":[["key",1,"silently-ignored"]]}'],
      ["set-extra", '{"__set__":[1,2],"extra":true}'],
      ["date-noncanonical", '{"__date__":"2025-01-01"}'],
      ["undefined-extra", '{"__undefined__":true,"extra":1}'],
      ["map-malformed", '{"__map__":"not-an-array"}'],
    ];
    for (const [nodeKey, outputJson] of adversarialOutputs) {
      writeRawNode(
        directory,
        "run-c",
        `${keyDigest(nodeKey)}.json`,
        rawNodeWithOutput(nodeKey, outputJson),
      );
    }

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    const addresses = adversarialOutputs.map(([nodeKey]) => nodeKey);
    expect([...(result.value.corruptNodeIds ?? [])].sort()).toEqual([...addresses].sort());
    expectWarningsFor(addresses);
    expect(warnings.every((warning) => /canonical|serializer-tag|__map__/.test(warning))).toBe(true);
  });

  it("drops raw Map bytes with a duplicate primitive key instead of collapsing an entry", async () => {
    const { directory, cp } = await seed();
    const nodeKey = "duplicate-map-key";
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest(nodeKey)}.json`,
      rawNodeWithOutput(nodeKey, '{"__map__":[["same",1],["same",2]]}'),
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    expect(result.value.corruptNodeIds).toEqual([nodeKey]);
    expectWarningsFor([nodeKey]);
    expect(warnings[0]).toContain("duplicates a primitive Map key");
  });

  it("rejects duplicate primitive raw Set values using SameValueZero semantics", async () => {
    const { directory, cp } = await seed();
    const adversarialSets: readonly (readonly [string, string])[] = [
      ["set-duplicate-string", '{"__set__":["same","same"]}'],
      ["set-duplicate-zero", '{"__set__":[0,-0]}'],
      ["set-duplicate-null", '{"__set__":[null,null]}'],
      ["set-duplicate-boolean", '{"__set__":[true,true]}'],
      [
        "set-duplicate-undefined",
        '{"__set__":[{"__undefined__":true},{"__undefined__":true}]}',
      ],
    ];
    for (const [nodeKey, outputJson] of adversarialSets) {
      writeRawNode(
        directory,
        "run-c",
        `${keyDigest(nodeKey)}.json`,
        rawNodeWithOutput(nodeKey, outputJson),
      );
    }

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    const addresses = adversarialSets.map(([nodeKey]) => nodeKey);
    expect([...(result.value.corruptNodeIds ?? [])].sort()).toEqual([...addresses].sort());
    expectWarningsFor(addresses);
    expect(warnings.every((warning) => warning.includes("duplicates a primitive Set value"))).toBe(true);
  });

  it("rejects pollution-filtered keys in raw output, including inside serializer tags", async () => {
    const { directory, cp } = await seed();
    const adversarialOutputs: readonly (readonly [string, string])[] = [
      ["pollution-constructor", '{"safe":1,"constructor":{"polluted":true}}'],
      ["pollution-proto", '{"__proto__":{"polluted":true}}'],
      ["pollution-in-map", '{"__map__":[["safe",{"prototype":{"polluted":true}}]]}'],
    ];
    for (const [nodeKey, outputJson] of adversarialOutputs) {
      writeRawNode(
        directory,
        "run-c",
        `${keyDigest(nodeKey)}.json`,
        rawNodeWithOutput(nodeKey, outputJson),
      );
    }

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    const addresses = adversarialOutputs.map(([nodeKey]) => nodeKey);
    expect([...(result.value.corruptNodeIds ?? [])].sort()).toEqual([...addresses].sort());
    expectWarningsFor(addresses);
    expect(warnings.every((warning) => warning.includes("prototype-pollution-filtered"))).toBe(true);
  });

  it("rejects a stored node envelope with unknown fields instead of truncating it", async () => {
    const { directory, cp } = await seed();
    const nodeKey = "extra-envelope-field";
    writeRawNode(
      directory,
      "run-c",
      `${keyDigest(nodeKey)}.json`,
      `{"nodeKey":"${nodeKey}","nodeId":"${nodeKey}","output":1,"completedAt":"2025-06-01T12:00:00.000Z","ignored":true}`,
    );

    const result = await cp.load(R("run-c"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.corruptNodeIds).toEqual([nodeKey]);
    expectWarningsFor([nodeKey]);
    expect(warnings[0]).toContain("unknown node-envelope field");
  });

  it("returns cache-error(load) for a *.json directory/read failure without warning or dropping", async () => {
    const { directory, cp } = await seed();
    const fileName = `${keyDigest("unreadable")}.json`;
    mkdirSync(join(nodesDirOf(directory, "run-c"), fileName));

    const result = await cp.load(R("run-c"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind !== "cache-error") throw new Error("unreachable");
    expect(result.error.operation).toBe("load");
    expect(result.error.message).toContain(fileName.slice(0, 60));
    expect(result.error.message).toContain("non-file entry");
    expect(warnings).toEqual([]);
  });

  it("maps a throwing required corrupt-node warning to cache-error(load)", async () => {
    const { directory, cp } = await seed();
    const fileName = `${keyDigest("logger-failure")}.json`;
    writeRawNode(directory, "run-c", fileName, "truncated{");
    let warningAttempted = false;
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {
        warningAttempted = true;
        throw new Error("logger unavailable");
      },
      error: () => {},
    });

    const result = await cp.load(R("run-c"));
    expect(warningAttempted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind !== "cache-error") throw new Error("unreachable");
    expect(result.error.operation).toBe("load");
    expect(result.error.message).toContain("required corrupt-node warning");
    expect(result.error.message).toContain("logger unavailable");
    expect(result.error.message).toContain(fileName.slice(0, 60));
  });

  it("reports a corrupt meta as checkpoint-corrupt, not as a per-entry drop", async () => {
    const directory = freshDirectory();
    writeRawMeta(directory, "run-bad", JSON.stringify({ dagId: 7, startedAt: "x", nodeCount: 1, createdAt: "y" }));
    const result = await createFileCheckpointer(directory).load(R("run-bad"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-corrupt");
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FR-029 — atomicity
// ---------------------------------------------------------------------------

describe("FileCheckpointer — atomic writes (FR-029)", () => {
  it("leaves no .tmp litter and exactly one file per address after repeated saves", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-at"), META());
    for (const value of [1, 2, 3]) {
      expect((await cp.saveNode(R("run-at"), "n1", node("n1", value))).ok).toBe(true);
    }

    expect(readdirSync(nodesDirOf(directory, "run-at"))).toEqual([`${keyDigest("n1")}.json`]);
    const result = await cp.load(R("run-at"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.nodes["n1"].output).toBe(3);
  });

  it("a reader never observes .tmp.<token> crash litter — only the committed entry", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-crash"), META());
    await cp.saveNode(R("run-crash"), "n1", node("n1", "committed"));
    // Exactly what a crash between write and rename leaves behind.
    writeRawNode(directory, "run-crash", `${keyDigest("n1")}.json.tmp.999999`, "half-written{");

    const result = await cp.load(R("run-crash"));
    if (!result.ok || result.value === null) throw new Error("expected a loaded run state");
    expect(result.value.nodes["n1"].output).toBe("committed");
    expect(result.value.corruptNodeIds).toBeUndefined();
  });

  it("a failed commit returns cache-error(saveNode) and leaves no partial entry", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-fail"), META());
    // Squat the target path with a non-empty directory: the tmp write
    // succeeds, the rename commit cannot, so the write must fail closed.
    const squat = join(nodesDirOf(directory, "run-fail"), `${keyDigest("n1")}.json`);
    mkdirSync(squat, { recursive: true });
    writeFileSync(join(squat, "occupant"), "x");

    const result = await cp.saveNode(R("run-fail"), "n1", node("n1", 1));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind !== "cache-error") throw new Error("unreachable");
    expect(result.error.operation).toBe("saveNode");
    // Cleanup ran: no `.tmp.<unique-token>` remains for a commit that never happened.
    expect(readdirSync(nodesDirOf(directory, "run-fail")).filter((f) => f.includes(".tmp."))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Managed-path containment — symlinked run/nodes descendants fail closed
// ---------------------------------------------------------------------------

describe("FileCheckpointer — canonical descendant containment", () => {
  it("rejects a symlinked run directory on setMeta, saveNode, and load without outside I/O", async () => {
    const base = freshDirectory();
    const outside = freshDirectory();
    symlinkSync(outside, join(base, "run-link"), "dir");
    const cp = createFileCheckpointer(base);

    const meta = await cp.setMeta(R("run-link"), META());
    expect(meta).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "setMeta" } });
    const saved = await cp.saveNode(R("run-link"), "n1", node("n1", 1));
    expect(saved).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "saveNode" } });
    const loaded = await cp.load(R("run-link"));
    expect(loaded).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "load" } });

    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a symlinked nodes directory on save and load without outside I/O", async () => {
    const base = freshDirectory();
    const outside = freshDirectory();
    const cp = createFileCheckpointer(base);
    expect((await cp.setMeta(R("run-nodes-link"), META())).ok).toBe(true);
    symlinkSync(outside, nodesDirOf(base, "run-nodes-link"), "dir");

    const saved = await cp.saveNode(R("run-nodes-link"), "n1", node("n1", 1));
    expect(saved).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "saveNode" } });
    const loaded = await cp.load(R("run-nodes-link"));
    expect(loaded).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "load" } });

    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, `${keyDigest("n1")}.json`))).toBe(false);
  });

  it("rejects a symlinked meta file instead of reading external checkpoint bytes", async () => {
    const base = freshDirectory();
    const outside = freshDirectory();
    const runDirectory = join(base, "run-meta-link");
    mkdirSync(runDirectory);
    const externalMeta = join(outside, META_FILE);
    writeFileSync(externalMeta, JSON.stringify({
      dagId: "external",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 0,
      createdAt: new Date().toISOString(),
      frameworkVersion: FRAMEWORK_VERSION,
    }));
    symlinkSync(externalMeta, join(runDirectory, META_FILE), "file");

    const loaded = await createFileCheckpointer(base).load(R("run-meta-link"));
    expect(loaded).toMatchObject({ ok: false, error: { kind: "cache-error", operation: "load" } });
  });
});

// ---------------------------------------------------------------------------
// FR-016 — hostile identifiers fail closed
// ---------------------------------------------------------------------------

describe("FileCheckpointer — boundary validation (FR-016)", () => {
  const HOSTILE_IDS: readonly string[] = [
    "..",
    "../escape",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "",
    ".",
    "a@b", // the composite separator is outside the ID charset
    "a b",
    "a\u0000b",
    "a\tb",
    "a\nb",
    // Trailing newline: `$` in JS is strict end-of-input (no Perl/Python
    // "before a final newline" leniency), and this pins that it stays so.
    "ab\n",
    "x".repeat(129), // one past the ID_PATTERN length ceiling
  ];

  it("rejects every hostile runId on setMeta without creating anything", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    for (const hostile of HOSTILE_IDS) {
      const result = await cp.setMeta(hostileRunId(hostile), META());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(hostile)}`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      // Required legacy fields use grammar-valid INTERNAL locations; the raw
      // rejected value is diagnostic-only and is never branded as itself.
      expect(String(result.error.runId)).toBe("checkpoint_invalid_run");
      expect(result.error.invalidRunId).toBe(hostile);
      expect(result.error.nodeId).toBe(META_RECORD_NODE_ID);
      expect(result.error.invalidNodeId).toBeUndefined();
    }
    expect(readdirSync(directory)).toEqual([]);
    expect(existsSync(join(directory, "..", "escape"))).toBe(false);
  });

  it("rejects every hostile runId on saveNode without creating anything", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    for (const hostile of HOSTILE_IDS) {
      const result = await cp.saveNode(hostileRunId(hostile), "n1", node("n1", 1));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(hostile)}`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      expect(String(result.error.runId)).toBe("checkpoint_invalid_run");
      expect(result.error.invalidRunId).toBe(hostile);
      expect(String(result.error.nodeId)).toBe("n1");
      expect(result.error.invalidNodeId).toBeUndefined();
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it("rejects every hostile nodeId on saveNode without creating anything", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-h"), META());
    for (const hostile of HOSTILE_IDS) {
      const result = await cp.saveNode(R("run-h"), hostile, node("n1", 1));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(hostile)}`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      expect(String(result.error.runId)).toBe("run-h");
      expect(result.error.invalidRunId).toBeUndefined();
      expect(String(result.error.nodeId)).toBe("checkpoint_invalid_node");
      expect(result.error.invalidNodeId).toBe(hostile);
    }
    expect(existsSync(nodesDirOf(directory, "run-h"))).toBe(false);
    expect(existsSync(join(directory, "run-h", "..", "..", "etc"))).toBe(false);
  });

  it("rejects a hostile or disagreeing state.nodeId even when the addressing nodeId is valid", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-h2"), META());
    for (const stateNodeId of ["../escape", "n2"]) {
      const result = await cp.saveNode(R("run-h2"), "n1", node(stateNodeId, 1));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a rejection");
      expect(result.error.kind).toBe("checkpoint-write-failed");
    }
    expect(existsSync(nodesDirOf(directory, "run-h2"))).toBe(false);
  });

  it("rejects a hostile composite namespace", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-h3"), META());
    for (const hostile of HOSTILE_IDS) {
      const result = await cp.saveNode(R("run-h3"), "n1", node("n1", 1), { namespace: hostile, index: 0 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(hostile)}`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
    }
    expect(existsSync(nodesDirOf(directory, "run-h3"))).toBe(false);
  });

  it("rejects out-of-range index and attempt values", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-h4"), META());
    const badNumbers = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -0.5];
    for (const bad of badNumbers) {
      const byIndex = await cp.saveNode(R("run-h4"), "n1", node("n1", 1), { index: bad });
      expect(byIndex.ok).toBe(false);
      const byAttempt = await cp.saveNode(R("run-h4"), "n1", node("n1", 1), { attempt: bad });
      expect(byAttempt.ok).toBe(false);
    }
  });

  it("parses the complete hostile SaveNodeOpts runtime matrix before any write", async () => {
    class OptionsInstance {
      readonly index = 1;
    }

    const inheritedOptions = Object.create({ index: 1 }) as unknown;
    const symbolOptions = { [Symbol("unsupported")]: true };
    const unreadablePrototype = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("prototype unavailable");
      },
    });
    const unreadableKeys = new Proxy({}, {
      ownKeys: () => {
        throw new Error("keys unavailable");
      },
    });
    const hostileOptions: readonly unknown[] = [
      null,
      false,
      true,
      0,
      1,
      "",
      "options",
      1n,
      Symbol("options"),
      () => ({ index: 1 }),
      [],
      [{ index: 1 }],
      new Date(),
      new OptionsInstance(),
      inheritedOptions,
      { unknown: true },
      { namespace: "dag", index: 0, extra: true },
      symbolOptions,
      { namespace: null },
      { index: "0" },
      { attempt: {} },
      unreadablePrototype,
      unreadableKeys,
    ];

    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-hostile-opts"), META());
    expect(
      (await cp.saveNode(R("run-hostile-opts"), "n1", node("n1", "canonical"))).ok,
    ).toBe(true);
    const canonicalFile = `${keyDigest("n1")}.json`;
    const before = readFileSync(
      join(nodesDirOf(directory, "run-hostile-opts"), canonicalFile),
      "utf-8",
    );

    for (const hostile of hostileOptions) {
      const result = await cp.saveNode(
        R("run-hostile-opts"),
        "n1",
        node("n1", "must-not-overwrite"),
        hostile as Parameters<Checkpointer["saveNode"]>[3],
      );
      expect(result.ok, `expected rejection for ${String(hostile)}`).toBe(false);
      if (result.ok) throw new Error(`expected rejection for ${String(hostile)}`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      expect(
        readFileSync(join(nodesDirOf(directory, "run-hostile-opts"), canonicalFile), "utf-8"),
      ).toBe(before);
    }

    expect(readdirSync(nodesDirOf(directory, "run-hostile-opts"))).toEqual([canonicalFile]);
    const loaded = await cp.load(R("run-hostile-opts"));
    if (!loaded.ok || loaded.value === null) throw new Error("expected loaded canonical node");
    expect(loaded.value.nodes.n1.output).toBe("canonical");
  });

  it("accepts plain null-prototype SaveNodeOpts and copies their supported shape", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-null-proto"), META());
    const opts = Object.create(null) as { namespace?: string; index?: number };
    opts.namespace = "nested";
    opts.index = 2;

    const saved = await cp.saveNode(R("run-null-proto"), "n1", node("n1", 1), opts);
    expect(saved.ok).toBe(true);
    const loaded = await cp.load(R("run-null-proto"));
    if (!loaded.ok || loaded.value === null) throw new Error("expected loaded node");
    expect(loaded.value.nodes["nested@n1@2@0"].output).toBe(1);
  });

  it("snapshots NodeState and SaveNodeOpts accessors once before validation and serialization", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-state-snapshot"), META());
    const reads = { nodeId: 0, output: 0, completedAt: 0, namespace: 0, index: 0, attempt: 0 };
    const state = Object.defineProperties({}, {
      nodeId: {
        enumerable: true,
        get: () => (++reads.nodeId === 1 ? "n1" : "different-node"),
      },
      output: {
        enumerable: true,
        get: () => (++reads.output === 1 ? { persisted: "first" } : (() => "lossy")),
      },
      completedAt: {
        enumerable: true,
        get: () => (++reads.completedAt === 1
          ? new Date("2025-04-05T06:07:08.009Z")
          : new Date("invalid")),
      },
    }) as NodeState;
    const opts = Object.defineProperties({}, {
      namespace: {
        enumerable: true,
        get: () => (++reads.namespace === 1 ? "nested" : "../escape"),
      },
      index: { enumerable: true, get: () => (++reads.index === 1 ? 2 : -1) },
      attempt: { enumerable: true, get: () => (++reads.attempt === 1 ? 3 : Number.NaN) },
    });

    const saved = await cp.saveNode(
      R("run-state-snapshot"),
      "n1",
      state,
      opts as Parameters<Checkpointer["saveNode"]>[3],
    );
    expect(saved.ok).toBe(true);
    expect(reads).toEqual({ nodeId: 1, output: 1, completedAt: 1, namespace: 1, index: 1, attempt: 1 });
    const loaded = await cp.load(R("run-state-snapshot"));
    if (!loaded.ok || loaded.value === null) throw new Error("expected snapshotted node");
    const stored = loaded.value.nodes["nested@n1@2@3"];
    expect(stored.nodeId).toBe("n1");
    expect(stored.output).toEqual({ persisted: "first" });
    expect(stored.completedAt.toISOString()).toBe("2025-04-05T06:07:08.009Z");
  });

  it("materializes top-level and nested Proxy outputs from one descriptor snapshot", async () => {
    const cases: readonly {
      readonly label: string;
      readonly descriptorValue: unknown;
      readonly get: () => unknown;
      readonly expected: unknown;
    }[] = [
      {
        label: "get-function",
        descriptorValue: "descriptor-safe",
        get: () => () => "lossy",
        expected: "descriptor-safe",
      },
      {
        label: "get-undefined",
        descriptorValue: "descriptor-present",
        get: () => undefined,
        expected: "descriptor-present",
      },
      {
        label: "get-changed-primitive",
        descriptorValue: 7,
        get: () => 99,
        expected: 7,
      },
      {
        label: "descriptor-undefined",
        descriptorValue: undefined,
        get: () => "changed-from-undefined",
        expected: undefined,
      },
      {
        label: "get-throws",
        descriptorValue: "read-without-get",
        get: () => { throw new Error("get trap must never run"); },
        expected: "read-without-get",
      },
    ];

    for (const location of ["top", "nested"] as const) {
      for (const testCase of cases) {
        const directory = freshDirectory();
        const runId = `run-proxy-${location}-${testCase.label}`;
        const nodeId = `node-${location}-${testCase.label}`;
        const cp = createFileCheckpointer(directory);
        expect((await cp.setMeta(R(runId), META())).ok).toBe(true);

        let getReads = 0;
        const target = Object.defineProperty({}, "value", {
          value: "target-value",
          enumerable: true,
          configurable: true,
          writable: true,
        });
        const proxy = new Proxy(target, {
          getOwnPropertyDescriptor: (_source, key) =>
            key === "value"
              ? {
                  value: testCase.descriptorValue,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                }
              : Reflect.getOwnPropertyDescriptor(target, key),
          get: (_source, key) => {
            if (key !== "value") return Reflect.get(target, key);
            getReads++;
            return testCase.get();
          },
        });
        const output = location === "top" ? proxy : { nested: proxy };

        const saved = await cp.saveNode(R(runId), nodeId, node(nodeId, output));
        expect(saved.ok, `${location}/${testCase.label}`).toBe(true);
        expect(getReads, `${location}/${testCase.label} must not invoke get`).toBe(0);

        const expectedOutput = location === "top"
          ? { value: testCase.expected }
          : { nested: { value: testCase.expected } };
        const nodeFile = join(nodesDirOf(directory, runId), `${keyDigest(nodeId)}.json`);
        expect(readFileSync(nodeFile, "utf-8")).toBe(JSON.stringify({
          nodeKey: nodeId,
          nodeId,
          output: testCase.expected === undefined
            ? location === "top"
              ? { value: { __undefined__: true } }
              : { nested: { value: { __undefined__: true } } }
            : expectedOutput,
          completedAt: "2025-06-01T12:00:00.000Z",
        }));

        const loaded = await createFileCheckpointer(directory).load(R(runId));
        if (!loaded.ok || loaded.value === null) throw new Error("expected fresh load");
        expect(loaded.value.nodes[nodeId].output).toEqual(expectedOutput);
      }
    }
  });

  it("materializes array indices from one data-descriptor snapshot without invoking disagreeing gets", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-array-descriptor"), META());
    const target = ["target-value"];
    let indexGets = 0;
    const output = new Proxy(target, {
      getOwnPropertyDescriptor: (source, key) =>
        key === "0"
          ? {
              value: "descriptor-value",
              enumerable: true,
              configurable: true,
              writable: true,
            }
          : Reflect.getOwnPropertyDescriptor(source, key),
      get: (source, key, receiver) => {
        if (key === "0") {
          indexGets += 1;
          throw new Error("array index get trap must never run");
        }
        return Reflect.get(source, key, receiver);
      },
    });

    const saved = await cp.saveNode(
      R("run-array-descriptor"),
      "n1",
      node("n1", output),
    );
    expect(saved.ok).toBe(true);
    expect(indexGets).toBe(0);
    const nodeFile = join(
      nodesDirOf(directory, "run-array-descriptor"),
      `${keyDigest("n1")}.json`,
    );
    expect(readFileSync(nodeFile, "utf-8")).toBe(
      '{"nodeKey":"n1","nodeId":"n1","output":["descriptor-value"],"completedAt":"2025-06-01T12:00:00.000Z"}',
    );
  });

  it("rejects throwing or accessor array-index descriptors as typed failures without writing", async () => {
    for (const mode of ["throws", "accessor"] as const) {
      const directory = freshDirectory();
      const runId = `run-array-descriptor-${mode}`;
      const cp = createFileCheckpointer(directory);
      await cp.setMeta(R(runId), META());
      const target = ["target-value"];
      let indexGets = 0;
      const output = new Proxy(target, {
        getOwnPropertyDescriptor: (source, key) => {
          if (key !== "0") return Reflect.getOwnPropertyDescriptor(source, key);
          if (mode === "throws") throw new Error("descriptor unavailable");
          return {
            get: () => "accessor-value",
            enumerable: true,
            configurable: true,
          };
        },
        get: (source, key, receiver) => {
          if (key === "0") {
            indexGets += 1;
            return "get-looks-safe";
          }
          return Reflect.get(source, key, receiver);
        },
      });

      const saved = await cp.saveNode(R(runId), "n1", node("n1", output));
      expect(saved.ok).toBe(false);
      if (saved.ok) throw new Error("expected adversarial array rejection");
      expect(saved.error.kind).toBe("checkpoint-write-failed");
      expect(indexGets).toBe(0);
      expect(existsSync(join(nodesDirOf(directory, runId), `${keyDigest("n1")}.json`))).toBe(false);
    }
  });

  it("rejects Proxy descriptor functions and malformed missing descriptors without a node file", async () => {
    for (const location of ["top", "nested"] as const) {
      for (const malformed of ["function", "missing"] as const) {
        const directory = freshDirectory();
        const runId = `run-proxy-reject-${location}-${malformed}`;
        const nodeId = `node-${location}-${malformed}`;
        const cp = createFileCheckpointer(directory);
        expect((await cp.setMeta(R(runId), META())).ok).toBe(true);

        const target = Object.defineProperty({}, "value", {
          value: "target-value",
          enumerable: true,
          configurable: true,
          writable: true,
        });
        const proxy = new Proxy(target, {
          ownKeys: () => ["value"],
          getOwnPropertyDescriptor: () =>
            malformed === "missing"
              ? undefined
              : {
                  value: () => "descriptor-is-lossy",
                  enumerable: true,
                  configurable: true,
                  writable: true,
                },
          get: () => "get-looks-safe",
        });
        const output = location === "top" ? proxy : { nested: proxy };

        const saved = await cp.saveNode(R(runId), nodeId, node(nodeId, output));
        expect(saved.ok, `${location}/${malformed}`).toBe(false);
        if (saved.ok) throw new Error("expected Proxy rejection");
        expect(saved.error.kind).toBe("checkpoint-write-failed");
        expect(existsSync(join(nodesDirOf(directory, runId), `${keyDigest(nodeId)}.json`))).toBe(false);
      }
    }
  });

  it("never returns ok when the first NodeState snapshot is malformed or mismatched", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-state-invalid-first"), META());
    const cases: readonly (readonly [string, () => NodeState])[] = [
      ["nodeId", () => {
        let reads = 0;
        return Object.defineProperty(node("n1", 1), "nodeId", {
          enumerable: true,
          get: () => (++reads === 1 ? "n2" : "n1"),
        });
      }],
      ["output", () => {
        let reads = 0;
        return Object.defineProperty(node("n1", 1), "output", {
          enumerable: true,
          get: () => (++reads === 1 ? (() => "not serializable") : { valid: true }),
        });
      }],
      ["completedAt", () => {
        let reads = 0;
        return Object.defineProperty(node("n1", 1), "completedAt", {
          enumerable: true,
          get: () => (++reads === 1 ? new Date("invalid") : new Date()),
        });
      }],
    ];

    for (const [label, makeState] of cases) {
      const result = await cp.saveNode(R("run-state-invalid-first"), "n1", makeState());
      expect(result.ok, `${label} first snapshot must fail`).toBe(false);
      if (result.ok) throw new Error(`expected ${label} rejection`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
    }
    expect(existsSync(nodesDirOf(directory, "run-state-invalid-first"))).toBe(false);
  });

  it("maps throwing NodeState and SaveNodeOpts getters to checkpoint-write-failed", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-state-throws"), META());
    for (const field of ["nodeId", "output", "completedAt"] as const) {
      const state = node("n1", 1) as unknown as Record<string, unknown>;
      Object.defineProperty(state, field, {
        enumerable: true,
        get: () => { throw new Error(`${field} unavailable`); },
      });
      const result = await cp.saveNode(R("run-state-throws"), "n1", state as unknown as NodeState);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${field} getter rejection`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      expect(result.error.message).toContain(`${field} unavailable`);
    }
    for (const field of ["namespace", "index", "attempt"] as const) {
      const opts = Object.defineProperty({}, field, {
        enumerable: true,
        get: () => { throw new Error(`${field} unavailable`); },
      });
      const result = await cp.saveNode(
        R("run-state-throws"),
        "n1",
        node("n1", 1),
        opts as Parameters<Checkpointer["saveNode"]>[3],
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${field} getter rejection`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind !== "checkpoint-write-failed") throw new Error("unreachable");
      expect(result.error.message).toContain(`${field} unavailable`);
    }
    expect(existsSync(nodesDirOf(directory, "run-state-throws"))).toBe(false);
  });

  it("rejects a hostile runId on load with a typed cache-error, never a throw", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    for (const hostile of HOSTILE_IDS) {
      const result = await cp.load(hostileRunId(hostile));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(hostile)}`);
      expect(result.error.kind).toBe("cache-error");
    }
  });
});

// ---------------------------------------------------------------------------
// FR-040 — nothing throws across the port boundary
// ---------------------------------------------------------------------------

describe("FileCheckpointer — typed failure surface (FR-040)", () => {
  it("contains a hostile thrown-value corpus across metadata/state/load accessors", async () => {
    for (const [index, hostile] of hostileErrorCorpus().entries()) {
      const directory = freshDirectory();
      const cp = createFileCheckpointer(directory);

      const unreadableMeta = Object.defineProperty(META(), "dagId", {
        enumerable: true,
        get: () => { throw hostile; },
      });
      const metaResult = await cp.setMeta(R(`run-hostile-meta-${index}`), unreadableMeta);
      expect(metaResult.ok).toBe(false);
      if (metaResult.ok) throw new Error("expected typed setMeta rejection");
      expect(metaResult.error.kind).toBe("checkpoint-write-failed");

      expect((await cp.setMeta(R(`run-hostile-node-${index}`), META())).ok).toBe(true);
      const unreadableState = Object.defineProperty(node("n1", 1), "output", {
        enumerable: true,
        get: () => { throw hostile; },
      });
      const nodeResult = await cp.saveNode(
        R(`run-hostile-node-${index}`),
        "n1",
        unreadableState,
      );
      expect(nodeResult.ok).toBe(false);
      if (nodeResult.ok) throw new Error("expected typed saveNode rejection");
      expect(nodeResult.error.kind).toBe("checkpoint-write-failed");

      expect((await cp.setMeta(R(`run-hostile-load-${index}`), META())).ok).toBe(true);
      const unreadableLoadOpts = Object.defineProperty({}, "expectedDagFingerprint", {
        enumerable: true,
        get: () => { throw hostile; },
      });
      const loadResult = await cp.load(
        R(`run-hostile-load-${index}`),
        unreadableLoadOpts as Parameters<Checkpointer["load"]>[1],
      );
      expect(loadResult.ok).toBe(false);
      if (loadResult.ok) throw new Error("expected typed load rejection");
      expect(loadResult.error.kind).toBe("cache-error");
    }
  });

  it("contains hostile clock throws on both setMeta and load without promise rejection", async () => {
    for (const [index, hostile] of hostileErrorCorpus().entries()) {
      const directory = freshDirectory();
      const runId = `run-hostile-clock-${index}`;
      const throwingClock = createFileCheckpointer(directory, { now: () => { throw hostile; } });
      const writeResult = await throwingClock.setMeta(R(runId), META());
      expect(writeResult.ok).toBe(false);
      if (writeResult.ok) throw new Error("expected typed clock-write rejection");
      expect(writeResult.error.kind).toBe("cache-error");
      if (writeResult.error.kind !== "cache-error") throw new Error("unreachable");
      expect(writeResult.error.operation).toBe("setMeta");

      writeRawMeta(directory, runId, JSON.stringify({
        dagId: "d",
        startedAt: "2025-01-01T00:00:00.000Z",
        nodeCount: 1,
        createdAt: new Date().toISOString(),
        frameworkVersion: FRAMEWORK_VERSION,
      }));
      const loadResult = await throwingClock.load(R(runId));
      expect(loadResult.ok).toBe(false);
      if (loadResult.ok) throw new Error("expected typed clock-load rejection");
      expect(loadResult.error.kind).toBe("cache-error");
      if (loadResult.error.kind !== "cache-error") throw new Error("unreachable");
      expect(loadResult.error.operation).toBe("load");
    }
  });

  it("validates the directory eagerly with typed cache-error(createFileCheckpointer)", () => {
    const invalidDirectories: readonly unknown[] = [
      undefined,
      null,
      false,
      0,
      () => "directory",
      {},
      [],
      "",
      "bad\u0000path",
    ];
    for (const invalid of invalidDirectories) {
      expectFactoryFailure(
        () => createFileCheckpointer(
          invalid as Parameters<typeof createFileCheckpointer>[0],
        ),
        /directory must be a non-empty NUL-free string/,
      );
    }
  });

  it("validates factory options eagerly while correctly omitted options still work", async () => {
    const omitted = createFileCheckpointer(freshDirectory());
    const empty = createFileCheckpointer(freshDirectory(), {});
    expect((await omitted.setMeta(R("run-config-a"), META())).ok).toBe(true);
    expect((await empty.setMeta(R("run-config-b"), META())).ok).toBe(true);

    class OptionsInstance {}
    for (const malformed of [null, false, 0, "options", [], new OptionsInstance()]) {
      expectFactoryFailure(
        () => createFileCheckpointer(
          freshDirectory(),
          malformed as unknown as Parameters<typeof createFileCheckpointer>[1],
        ),
        /options must be a plain object/,
      );
    }
    for (const invalidNow of [null, 0, "now", {}, []]) {
      expectFactoryFailure(
        () => createFileCheckpointer(
          freshDirectory(),
          { now: invalidNow } as unknown as Parameters<typeof createFileCheckpointer>[1],
        ),
        /options\.now must be a function/,
      );
    }
  });

  it("rejects a misspelled own factory option instead of silently falling back to Date.now", () => {
    const construct = () => createFileCheckpointer(
      freshDirectory(),
      { nwo: () => 0 } as unknown as Parameters<typeof createFileCheckpointer>[1],
    );

    expectFactoryFailure(construct, /unsupported own key "nwo"; supported key is now/);
  });

  it("rejects symbol and non-enumerable unsupported own factory options", () => {
    const symbolKey = Symbol("clock-typo");
    const withSymbol = { [symbolKey]: () => 0 };
    const withHiddenTypo = Object.defineProperty({}, "nwo", {
      value: () => 0,
      enumerable: false,
    });

    for (const malformed of [withSymbol, withHiddenTypo]) {
      const construct = () => createFileCheckpointer(
        freshDirectory(),
        malformed as Parameters<typeof createFileCheckpointer>[1],
      );
      expectFactoryFailure(construct, /unsupported own key/);
    }
  });

  it("snapshots factory option reflection and the now accessor exactly once", async () => {
    let prototypeInspections = 0;
    let ownKeyInspections = 0;
    let descriptorInspections = 0;
    let accessorReads = 0;
    const configuredNow = Date.parse("2025-04-05T06:07:08.009Z");
    const target = Object.defineProperty({}, "now", {
      enumerable: false,
      get: () => {
        accessorReads += 1;
        return () => configuredNow;
      },
    });
    const options = new Proxy(target, {
      getPrototypeOf: (source) => {
        prototypeInspections += 1;
        return Reflect.getPrototypeOf(source);
      },
      ownKeys: (source) => {
        ownKeyInspections += 1;
        return Reflect.ownKeys(source);
      },
      getOwnPropertyDescriptor: (source, key) => {
        descriptorInspections += 1;
        return Reflect.getOwnPropertyDescriptor(source, key);
      },
    });

    const directory = freshDirectory();
    const cp = createFileCheckpointer(
      directory,
      options as Parameters<typeof createFileCheckpointer>[1],
    );
    expect({ prototypeInspections, ownKeyInspections, descriptorInspections, accessorReads }).toEqual({
      prototypeInspections: 1,
      ownKeyInspections: 1,
      descriptorInspections: 1,
      accessorReads: 1,
    });
    expect((await cp.setMeta(R("run-config-snapshot"), META())).ok).toBe(true);
    const stored = JSON.parse(
      readFileSync(join(directory, "run-config-snapshot", META_FILE), "utf-8"),
    );
    expect(stored.createdAt).toBe("2025-04-05T06:07:08.009Z");
  });

  it("fails clearly at factory time when an own options.now accessor cannot be read", () => {
    const unreadable = Object.defineProperty({}, "now", {
      enumerable: true,
      get: () => { throw new Error("configuration unavailable"); },
    });
    expectFactoryFailure(
      () => createFileCheckpointer(
        freshDirectory(),
        unreadable as Parameters<typeof createFileCheckpointer>[1],
      ),
      /could not read options\.now: configuration unavailable/,
    );
  });

  it("normalizes hostile factory option reflection traps to typed cache-error", () => {
    const cases: readonly (readonly [object, RegExp])[] = [
      [
        new Proxy({}, {
          getPrototypeOf: () => { throw new Error("prototype unavailable"); },
        }),
        /could not inspect options object: prototype unavailable/,
      ],
      [
        new Proxy({}, {
          ownKeys: () => { throw new Error("keys unavailable"); },
        }),
        /could not inspect options own keys: keys unavailable/,
      ],
      [
        new Proxy({ now: () => 0 }, {
          getOwnPropertyDescriptor: () => { throw new Error("descriptor unavailable"); },
        }),
        /could not inspect options\.now descriptor: descriptor unavailable/,
      ],
    ];

    for (const [uninspectable, expectedMessage] of cases) {
      const construct = () => createFileCheckpointer(
        freshDirectory(),
        uninspectable as Parameters<typeof createFileCheckpointer>[1],
      );
      expectFactoryFailure(construct, expectedMessage);
    }
  });

  it("normalizes revoked factory options to typed cache-error without raw leakage", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const construct = () => createFileCheckpointer(
      freshDirectory(),
      revoked.proxy as Parameters<typeof createFileCheckpointer>[1],
    );

    expectFactoryFailure(construct, /could not inspect options object/);
  });

  it("rejects meta whose startedAt is not a valid Date", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    // Deliberately bypasses the type so the RUNTIME boundary is exercised —
    // this is exactly the bypassed-brand case the validator exists for.
    const badMeta = { dagId: "d", startedAt: new Date("nope"), nodeCount: 1 } as unknown as RunMeta;
    const result = await cp.setMeta(R("run-e1"), badMeta);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("checkpoint-write-failed");
  });

  it("rejects malformed metadata fields before writing", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    const invalidMetas: readonly RunMeta[] = [
      META({ nodeCount: -1 }),
      META({ nodeCount: 1.5 }),
      META({ nodeCount: Number.NaN }),
      META({ subject: 7 as unknown as string }),
      META({ dagFingerprint: false as unknown as string }),
      META({ frameworkVersion: 2 as unknown as string }),
    ];
    for (const meta of invalidMetas) {
      const result = await cp.setMeta(R("run-e2"), meta);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a rejection");
      expect(result.error.kind).toBe("checkpoint-write-failed");
    }
  });

  it("rejects a node state that is not an object, and one with an invalid completedAt", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-e3"), META());
    // Same rationale as above: the port type forbids these, the boundary must
    // still refuse them rather than throw.
    const notAnObject = await cp.saveNode(R("run-e3"), "n1", null as unknown as NodeState);
    expect(notAnObject.ok).toBe(false);
    const badDate = await cp.saveNode(R("run-e3"), "n1", {
      nodeId: "n1",
      output: 1,
      completedAt: new Date("nope"),
    });
    expect(badDate.ok).toBe(false);
    if (badDate.ok) throw new Error("expected a rejection");
    expect(badDate.error.kind).toBe("checkpoint-write-failed");
  });

  it("rejects every non-lossless output class with checkpoint-write-failed and no bytes", async () => {
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory);
    await cp.setMeta(R("run-e4"), META());

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let accessorReads = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => { accessorReads++; return "must-not-run"; },
    });
    class UnsupportedOutput {
      readonly value = 1;
    }
    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth < 513; depth++) tooDeep = { next: tooDeep };

    const cases: readonly (readonly [string, unknown])[] = [
      ["cycle", circular],
      ["function", () => "not JSON"],
      ["symbol", Symbol("not JSON")],
      ["bigint", 1n],
      ["NaN", { nested: Number.NaN }],
      ["infinity", { nested: Number.POSITIVE_INFINITY }],
      ["accessor", accessor],
      ["class instance", new UnsupportedOutput()],
      ["unsupported prototype", /regexp/],
      ["sparse array", new Array(1)],
      ["invalid date", new Date("invalid")],
      ["excessive depth", tooDeep],
    ];
    for (const [label, output] of cases) {
      const result = await cp.saveNode(R("run-e4"), "n1", node("n1", output));
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error(`expected ${label} rejection`);
      expect(result.error.kind).toBe("checkpoint-write-failed");
    }
    expect(accessorReads).toBe(0);
    expect(existsSync(nodesDirOf(directory, "run-e4"))).toBe(false);
  });

  it("rejects malformed or unreadable options without throwing", async () => {
    const cp = createFileCheckpointer(freshDirectory());
    await cp.setMeta(R("run-opts"), META({ dagFingerprint: "fp" }));

    const nullSaveOpts = await cp.saveNode(
      R("run-opts"),
      "n1",
      node("n1", 1),
      null as unknown as Parameters<Checkpointer["saveNode"]>[3],
    );
    expect(nullSaveOpts.ok).toBe(false);
    if (nullSaveOpts.ok) throw new Error("expected a rejection");
    expect(nullSaveOpts.error.kind).toBe("checkpoint-write-failed");

    const throwingOpts = new Proxy(
      { expectedDagFingerprint: "fp" },
      {
        get: () => {
          throw new Error("unreadable options");
        },
      },
    ) as Parameters<Checkpointer["load"]>[1];
    const load = await cp.load(R("run-opts"), throwingOpts);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error("expected a rejection");
    expect(load.error.kind).toBe("cache-error");
  });

  it("maps setMeta filesystem failures to cache-error(setMeta)", async () => {
    const directory = freshDirectory();
    writeFileSync(join(directory, "run-e5"), "not a directory");
    const result = await createFileCheckpointer(directory).setMeta(R("run-e5"), META());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind !== "cache-error") throw new Error("unreachable");
    expect(result.error.operation).toBe("setMeta");
  });

  it("reports an unreadable meta.json as a typed cache-error(load)", async () => {
    const directory = freshDirectory();
    // A directory where meta.json belongs: readable path, unreadable file.
    mkdirSync(join(directory, "run-e6", META_FILE), { recursive: true });
    const result = await createFileCheckpointer(directory).load(R("run-e6"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind !== "cache-error") throw new Error("unreachable");
    expect(result.error.operation).toBe("load");
  });

  it("maps throwing clocks to typed cache errors on write and load", async () => {
    const directory = freshDirectory();
    const failingClock = createFileCheckpointer(directory, {
      now: () => {
        throw new Error("clock unavailable");
      },
    });
    const write = await failingClock.setMeta(R("run-clock"), META());
    expect(write.ok).toBe(false);
    if (write.ok || write.error.kind !== "cache-error") throw new Error("expected cache-error");
    expect(write.error.operation).toBe("setMeta");

    writeRawMeta(
      directory,
      "run-clock",
      JSON.stringify({
        dagId: "d",
        startedAt: new Date().toISOString(),
        nodeCount: 1,
        createdAt: new Date().toISOString(),
        frameworkVersion: FRAMEWORK_VERSION,
      }),
    );
    const load = await failingClock.load(R("run-clock"));
    expect(load.ok).toBe(false);
    if (load.ok || load.error.kind !== "cache-error") throw new Error("expected cache-error");
    expect(load.error.operation).toBe("load");

    const nonFiniteClock = createFileCheckpointer(directory, { now: () => Number.NaN });
    const nonFiniteWrite = await nonFiniteClock.setMeta(R("run-clock-2"), META());
    expect(nonFiniteWrite.ok).toBe(false);
    if (nonFiniteWrite.ok || nonFiniteWrite.error.kind !== "cache-error") {
      throw new Error("expected cache-error");
    }
    expect(nonFiniteWrite.error.operation).toBe("setMeta");
  });

  it("maps finite Date-unrepresentable clock values to cache-error", async () => {
    const beyondDateRange = 8_640_000_000_000_001;
    const directory = freshDirectory();
    const cp = createFileCheckpointer(directory, { now: () => beyondDateRange });

    const write = await cp.setMeta(R("run-clock-range"), META());
    expect(write.ok).toBe(false);
    if (write.ok || write.error.kind !== "cache-error") throw new Error("expected cache-error");
    expect(write.error.operation).toBe("setMeta");
    expect(write.error.message).toContain("non-representable timestamp");
    expect(existsSync(join(directory, "run-clock-range"))).toBe(false);

    writeRawMeta(
      directory,
      "run-clock-range",
      JSON.stringify({
        dagId: "d",
        startedAt: new Date().toISOString(),
        nodeCount: 1,
        createdAt: new Date().toISOString(),
        frameworkVersion: FRAMEWORK_VERSION,
      }),
    );
    const load = await cp.load(R("run-clock-range"));
    expect(load.ok).toBe(false);
    if (load.ok || load.error.kind !== "cache-error") throw new Error("expected cache-error");
    expect(load.error.operation).toBe("load");
    expect(load.error.message).toContain("non-representable timestamp");
  });
});
