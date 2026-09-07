// The shared `Checkpointer` contract suite — ONE definition of what every
// backend must do, parametrized over the backend-specific bypass paths.
//
// Extracted from `redis-checkpointer.test.ts` (which still owns the
// Redis-SPECIFIC cases: NOSCRIPT/EVAL fallback, raw `redis.set` metadata
// and `redis.hset` node payload shapes) so a third backend cannot quietly pass
// a WEAKER suite. `SC-001` requires the file backend to pass this file IN ITS
// ENTIRETY. Version,
// fingerprint, TTL, and representable corrupt-node behavior live here because
// they are backend contract, not filesystem mechanics.
//
// Composite addressing (ADR-0075) MOVED HERE in F1 PR-A. It used to live only
// in `file-checkpointer.test.ts` because F6's FR-023 required Redis and
// in-memory to ignore composite options, so a shared expectation would have
// been a fake carve-out. All three backends now honor the address, which makes
// it port contract — and the suite is where contract belongs, so a fourth
// backend cannot ship indexed fan-out that silently overwrites itself.
//
// Deliberate division: filesystem atomicity (rename/tmp) stays in
// `file-checkpointer.test.ts`, a property of that adapter, not of the port.
// The file backend's richer composite cases (digest filenames, the full
// namespace/index/attempt permutation table) also stay there.
//
// Not named `*.test.ts` on purpose: it declares no top-level tests, it is a
// library the real test files call (same convention as `_id-helpers.ts`).

import { describe, test, expect, beforeEach } from "bun:test";
import type { NodeId, DagId } from "../types/ids.js";
import type {
  Checkpointer,
  CorruptCheckpointAddress,
  RunMeta,
  NodeState,
} from "../checkpoint/checkpointer.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { D, N, R } from "./_id-helpers.js";

/**
 * Bypass-injection callbacks the shared ADR-0017/TTL/corruption tests need.
 * Backends reach their durable state by different means — Redis metadata
 * bypasses use `redis.set` while corrupt node entries use `redis.hset`,
 * in-memory writes records into its test-owned store (the constructor-adopted
 * seam that replaced `__testRawMetas`), and the file backend writes
 * checkpoint files directly — so the suite is parametric over the bypass and
 * the CONTRACT assertions stay byte-identical for all of them.
 *
 * Corrupt-meta/node callbacks are optional for exactly ONE reason: a backend
 * with no serialization step (in-memory, whose stores contain already-parsed
 * values) cannot represent corrupt bytes. Every byte-persisting backend
 * supplies both; the assertions remain shared between Redis and file.
 */
export interface CheckpointerSuiteRaw {
  setStaleVersion(
    cp: Checkpointer,
    runId: string,
    opts: { readonly startedAt: Date; readonly nodeCount: number },
  ): Promise<void>;
  setMissingVersion(
    cp: Checkpointer,
    runId: string,
    opts: { readonly startedAt: Date; readonly nodeCount: number },
  ): Promise<void>;
  setExpired(
    cp: Checkpointer,
    runId: string,
    opts: {
      readonly startedAt: Date;
      readonly nodeCount: number;
      readonly expiredAt: Date;
    },
  ): Promise<void>;
  setCorrupt?(cp: Checkpointer, runId: string): Promise<void>;
  setCorruptNode?(
    cp: Checkpointer,
    runId: string,
    nodeId: string,
  ): Promise<{ readonly corruptAddress: CorruptCheckpointAddress }>;
}

export function checkpointerSuite(
  name: string,
  factory: () => Checkpointer,
  raw: CheckpointerSuiteRaw,
  cleanup?: () => Promise<void>,
): void {
  describe(name, () => {
    let cp: Checkpointer;

    beforeEach(async () => {
      cp = factory();
      if (cleanup) await cleanup();
    });

    test("load returns null for non-existent runId", async () => {
      const result = await cp.load(R("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    test("setMeta + load round-trips metadata and stamps the current framework version", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date("2025-01-01T00:00:00Z"), nodeCount: 3 };
      const setResult = await cp.setMeta(R("run-1"), meta);
      expect(setResult.ok).toBe(true);

      const loadResult = await cp.load(R("run-1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(loadResult.value.meta.dagId).toBe(D("dag-1"));
        expect(loadResult.value.meta.nodeCount).toBe(3);
        expect(loadResult.value.meta.frameworkVersion).toBe(FRAMEWORK_VERSION);
        expect(loadResult.value.nodes).toEqual({});
      }
    });

    test("saveNode + load round-trips correctly", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-2"), meta);

      const nodeState: NodeState = { nodeId: "n1" as NodeId, output: { text: "hello" }, completedAt: new Date("2025-06-01T12:00:00Z") };
      const saveResult = await cp.saveNode(R("run-2"), nodeState);
      expect(saveResult.ok).toBe(true);

      const loadResult = await cp.load(R("run-2"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(loadResult.value.nodes["n1"].nodeId).toBe(N("n1"));
        expect(loadResult.value.nodes["n1"].output).toEqual({ text: "hello" });
      }
    });

    // ── Composite addressing (ADR-0075) — port contract since F1 PR-A ───────
    //
    // These five are the durable precondition for F1's runtime-width fan-out.
    // They pin three separate guarantees, each with its own failure mode, so a
    // backend that passes some and not others fails in a different way:
    //
    //   DISTINCTNESS (1st, 3rd, 4th) — a composite address is stored under
    //   itself, distinct indices address distinct entries, and a canonical
    //   save coexists with an indexed one. Fail these and a mapped node's
    //   indices collide: a partial fan silently restarts from whichever index
    //   wrote last on resume.
    //
    //   CANONICAL-KEY STABILITY (2nd) — a no-opts save is keyed by exactly the
    //   bare nodeId. This is not about fan-out at all; it is the no-migration
    //   guarantee. Fail it and every EXISTING, non-mapped run's checkpoints
    //   move to a new key, so each one silently resumes from nothing.
    //
    //   FAIL-CLOSED (5th) — a malformed address issues no write rather than
    //   falling back to the canonical key. That fallback is how a fan index
    //   would clobber the node's own checkpoint.

    test("composite opts store under the composite address, not the bare nodeId", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-c1"), meta);
      const nodeState: NodeState = {
        nodeId: "n1" as NodeId,
        output: { text: "indexed" },
        completedAt: new Date("2025-06-01T12:00:00Z"),
      };

      const saveResult = await cp.saveNode(R("run-c1"), nodeState, {
        namespace: "sub",
        index: 3,
        attempt: 1,
      });
      expect(saveResult.ok).toBe(true);

      const loadResult = await cp.load(R("run-c1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes)).toEqual(["sub@n1@3@1"]);
        // The KEY is the address; `nodeId` stays the canonical DAG identity.
        expect(loadResult.value.nodes["sub@n1@3@1"].nodeId).toBe(N("n1"));
        expect(loadResult.value.nodes["sub@n1@3@1"].output).toEqual({ text: "indexed" });
      }
    });

    test("canonical folding: a no-opts save is keyed by exactly the bare nodeId", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-c2"), meta);
      const nodeState: NodeState = {
        nodeId: "n1" as NodeId,
        output: { text: "canonical" },
        completedAt: new Date("2025-06-01T12:00:00Z"),
      };
      await cp.saveNode(R("run-c2"), nodeState);

      const loadResult = await cp.load(R("run-c2"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes)).toEqual(["n1"]);
      }
    });

    test("distinct indices of one node address distinct entries (F1 fan-out)", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-c3"), meta);
      const at = new Date("2025-06-01T12:00:00Z");

      for (const i of [0, 1, 2]) {
        const saved = await cp.saveNode(
          R("run-c3"),
          { nodeId: "n1" as NodeId, output: { i }, completedAt: at },
          { index: i },
        );
        expect(saved.ok).toBe(true);
      }

      const loadResult = await cp.load(R("run-c3"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes).sort()).toEqual([
          "dag@n1@0@0",
          "dag@n1@1@0",
          "dag@n1@2@0",
        ]);
        // Each index kept ITS OWN output — the overwrite this whole address
        // space exists to prevent.
        expect(loadResult.value.nodes["dag@n1@1@0"].output).toEqual({ i: 1 });
      }
    });

    test("a canonical save and an indexed save of the same node coexist", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-c4"), meta);
      const at = new Date("2025-06-01T12:00:00Z");

      await cp.saveNode(R("run-c4"), { nodeId: "n1" as NodeId, output: "canonical", completedAt: at });
      await cp.saveNode(
        R("run-c4"),
        { nodeId: "n1" as NodeId, output: "indexed", completedAt: at },
        { index: 0 },
      );

      const loadResult = await cp.load(R("run-c4"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes).sort()).toEqual(["dag@n1@0@0", "n1"]);
        expect(loadResult.value.nodes["n1"].output).toBe("canonical");
        expect(loadResult.value.nodes["dag@n1@0@0"].output).toBe("indexed");
      }
    });

    test("a malformed composite address fails typed and writes nothing", async () => {
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta(R("run-c5"), meta);
      const nodeState: NodeState = {
        nodeId: "n1" as NodeId,
        output: { text: "nope" },
        completedAt: new Date("2025-06-01T12:00:00Z"),
      };

      const result = await cp.saveNode(
        R("run-c5"),
        nodeState,
        Object.freeze({ namespace: "../bad", index: -1 }) as never,
      );
      expect(result.ok).toBe(false);
      // The SAME error kind on every backend. A malformed address is caller
      // error, not a driver fault, so it must not surface as `cache-error` on
      // one backend and `checkpoint-write-failed` on another — a caller cannot
      // branch on a kind that depends on deployment configuration.
      if (!result.ok) expect(result.error.kind).toBe("checkpoint-write-failed");

      // Fail closed: it must NOT have fallen back to the canonical key. A
      // silent canonical write would let a fan index clobber the node's own
      // checkpoint.
      const loadResult = await cp.load(R("run-c5"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes)).toEqual([]);
      }
    });

    // `__proto__` matches ID_PATTERN (`_` is in the charset), so it is a LEGAL
    // nodeId, and the Checkpointer seam's shared save→load contract is that
    // every saved node round-trips as an OWN entry with the returned map
    // un-reparented. A plain bracket assignment in any adapter's `load` would
    // hit `Object.prototype`'s `__proto__` SETTER: no own entry, no
    // `corruptNodeAddresses` trace, no error — a silent re-execution on resume.
    // Lifted into the shared suite in round-17 (previously pinned per-adapter
    // in file-checkpointer.test.ts and the in-memory block of
    // redis-checkpointer.test.ts, which the Redis leg itself never ran) so
    // every leg — including the opt-in Redis leg — is held to the same
    // contract by the suite that defines it.
    test("saveNode round-trips a prototype-named nodeId (__proto__) as an OWN entry, un-reparented", async () => {
      await cp.setMeta(R("hostile-proto"), {
        dagId: D("d"),
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 1,
        subject: "s",
        frameworkVersion: FRAMEWORK_VERSION,
      });
      const saved = await cp.saveNode(R("hostile-proto"), {
        nodeId: N("__proto__"),
        output: { value: 1 },
        completedAt: new Date(),
      });
      expect(saved.ok).toBe(true);
      const loaded = await cp.load(R("hostile-proto"));
      if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
      expect(Object.hasOwn(loaded.value.nodes, "__proto__")).toBe(true);
      expect(loaded.value.nodes["__proto__"].output).toEqual({ value: 1 });
      expect(loaded.value.nodes["__proto__"].nodeId).toBe(N("__proto__"));
      // The map itself was never re-parented by the `__proto__` entry.
      expect(Object.getPrototypeOf(loaded.value.nodes)).toBe(Object.prototype);
    });

    test("saveNode/setMeta snapshot at write time: post-call caller mutation cannot rewrite stored state", async () => {
      // Write-time snapshot parity across every backend: file/Redis serialize
      // at write time; in-memory detaches on both write paths (saveNode and
      // setMeta). A caller mutating its own objects after a successful write
      // must never silently rewrite stored checkpoint state.
      const runId = "alias-snapshot";
      const startedAt = new Date("2025-01-01T00:00:00Z");
      const setResult = await cp.setMeta(R(runId), {
        dagId: D("dag-alias"),
        startedAt,
        nodeCount: 1,
      });
      expect(setResult.ok).toBe(true);

      const nodeState: NodeState = {
        nodeId: N("n1"),
        output: { text: "hello" },
        completedAt: new Date("2025-06-01T12:00:00Z"),
      };
      const saveResult = await cp.saveNode(R(runId), nodeState);
      expect(saveResult.ok).toBe(true);

      // Mutate the caller-owned inputs AFTER the successful writes...
      startedAt.setFullYear(1999);
      (nodeState.output as { text: string }).text = "mutated";
      nodeState.completedAt.setFullYear(1999);

      // ...the stored checkpoint must be unaffected.
      const loadResult = await cp.load(R(runId));
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok || loadResult.value === null) throw new Error("expected loaded checkpoint");
      expect(loadResult.value.meta.startedAt.toISOString()).toBe("2025-01-01T00:00:00.000Z");
      expect(loadResult.value.nodes["n1"].output).toEqual({ text: "hello" });
      expect(loadResult.value.nodes["n1"].completedAt.toISOString()).toBe("2025-06-01T12:00:00.000Z");

      // Mutating the LOADED snapshot must not corrupt the stored state either.
      (loadResult.value.nodes["n1"].output as { text: string }).text = "post-load-mutation";
      const secondLoad = await cp.load(R(runId));
      expect(secondLoad.ok).toBe(true);
      if (!secondLoad.ok || secondLoad.value === null) throw new Error("expected reloaded checkpoint");
      expect(secondLoad.value.nodes["n1"].output).toEqual({ text: "hello" });
    });

    test("multiple nodes saved, all present in load", async () => {
      const meta: RunMeta = { dagId: "dag-2" as DagId, startedAt: new Date(), nodeCount: 3 };
      await cp.setMeta(R("run-3"), meta);

      for (const id of ["a", "b", "c"]) {
        await cp.saveNode(R("run-3"), { nodeId: N(id), output: id, completedAt: new Date() });
      }

      const loadResult = await cp.load(R("run-3"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes).sort()).toEqual(["a", "b", "c"]);
      }
    });

    test("expectedDagFingerprint accepts a match and remains opt-in when omitted", async () => {
      await cp.setMeta(R("fingerprint-match"), {
        dagId: D("dag-fingerprint"),
        startedAt: new Date(),
        nodeCount: 1,
        dagFingerprint: "fingerprint-v1",
      });

      const matching = await cp.load(R("fingerprint-match"), {
        expectedDagFingerprint: "fingerprint-v1",
      });
      expect(matching.ok).toBe(true);
      const omitted = await cp.load(R("fingerprint-match"));
      expect(omitted.ok).toBe(true);
    });

    test("expectedDagFingerprint rejects both a mismatch and an absent stored value", async () => {
      await cp.setMeta(R("fingerprint-wrong"), {
        dagId: D("dag-fingerprint"),
        startedAt: new Date(),
        nodeCount: 1,
        dagFingerprint: "fingerprint-v1",
      });
      const mismatch = await cp.load(R("fingerprint-wrong"), {
        expectedDagFingerprint: "fingerprint-v2",
      });
      expect(mismatch.ok).toBe(false);
      if (mismatch.ok) throw new Error("expected fingerprint mismatch");
      expect(mismatch.error.kind).toBe("checkpoint-version-mismatch");
      if (mismatch.error.kind === "checkpoint-version-mismatch") {
        expect(mismatch.error.expected).toBe("fingerprint-v2");
        expect(mismatch.error.actual).toBe("fingerprint-v1");
      }

      await cp.setMeta(R("fingerprint-absent"), {
        dagId: D("dag-fingerprint"),
        startedAt: new Date(),
        nodeCount: 1,
      });
      const absent = await cp.load(R("fingerprint-absent"), {
        expectedDagFingerprint: "fingerprint-v2",
      });
      expect(absent.ok).toBe(false);
      if (absent.ok) throw new Error("expected absent fingerprint mismatch");
      expect(absent.error.kind).toBe("checkpoint-version-mismatch");
      if (absent.error.kind === "checkpoint-version-mismatch") {
        expect(absent.error.actual).toBeUndefined();
      }
    });

    // ADR-0017 / W5.3 — all backends MUST reject mismatched frameworkVersion
    // on load. Without this, a checkpoint produced by an older framework
    // release can be replayed under newer validation semantics, silently
    // skipping invariants that were tightened in the meantime.
    test("load rejects checkpoint with stale frameworkVersion", async () => {
      await raw.setStaleVersion(cp, "stale-1", { startedAt: new Date(), nodeCount: 1 });
      const result = await cp.load(R("stale-1"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("checkpoint-version-mismatch");
        if (result.error.kind === "checkpoint-version-mismatch") {
          // @ts-expect-error — branded ID test fixture
          expect(result.error.runId).toBe(N("stale-1"));
          expect(result.error.expected).toBe(FRAMEWORK_VERSION);
          expect(result.error.actual).toBe("1");
        }
      }
    });

    test("load rejects checkpoint missing frameworkVersion field", async () => {
      await raw.setMissingVersion(cp, "missing-1", { startedAt: new Date(), nodeCount: 1 });
      const result = await cp.load(R("missing-1"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("checkpoint-version-mismatch");
        if (result.error.kind === "checkpoint-version-mismatch") {
          expect(result.error.actual).toBeUndefined();
        }
      }
    });

    test("load rejects expired checkpoint (createdAt older than TTL)", async () => {
      const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await raw.setExpired(cp, "expired-1", { startedAt: new Date(), nodeCount: 1, expiredAt });
      const result = await cp.load(R("expired-1"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("checkpoint-expired");
        if (result.error.kind === "checkpoint-expired") {
          // @ts-expect-error — branded ID test fixture
          expect(result.error.runId).toBe(N("expired-1"));
          expect(result.error.expiredAt).toBe(expiredAt.toISOString());
        }
      }
    });

    // In-memory has no serialization step, so malformed durable bytes are not
    // representable there. Every backend exposing the capability runs the same
    // assertions; this is capability-based portability, not a file carve-out.
    if (raw.setCorrupt !== undefined) {
      test("load rejects malformed meta payload with checkpoint-corrupt", async () => {
        await raw.setCorrupt!(cp, "corrupt-1");
        const result = await cp.load(R("corrupt-1"));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("checkpoint-corrupt");
          if (result.error.kind === "checkpoint-corrupt") {
            // @ts-expect-error — branded ID test fixture
            expect(result.error.runId).toBe(N("corrupt-1"));
          }
        }
      });
    }

    if (raw.setCorruptNode !== undefined) {
      test("load drops one corrupt node, reports its backend address, and keeps good nodes", async () => {
        const runId = "corrupt-node-1";
        await cp.setMeta(R(runId), {
          dagId: D("dag-corrupt-node"),
          startedAt: new Date(),
          nodeCount: 2,
        });
        await cp.saveNode(R(runId), {
          nodeId: N("good-node"),
          output: { kept: true },
          completedAt: new Date(),
        });
        const { corruptAddress } = await raw.setCorruptNode!(cp, runId, "bad-node");

        const result = await cp.load(R(runId));
        expect(result.ok).toBe(true);
        if (!result.ok || result.value === null) throw new Error("expected loaded checkpoint");
        expect(Object.keys(result.value.nodes)).toEqual(["good-node"]);
        expect(result.value.nodes["good-node"].output).toEqual({ kept: true });
        expect(result.value.corruptNodeAddresses).toEqual([corruptAddress]);
      });
    }
  });
}
