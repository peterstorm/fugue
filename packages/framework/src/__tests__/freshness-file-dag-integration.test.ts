/**
 * The file-backed `FreshnessIndex` wired into a REAL DAG run.
 *
 * `createFileFreshnessIndex` had exhaustive isolation coverage (locking, TTL,
 * cross-process convergence) and `emitFreshnessWitnessEvents` had exhaustive
 * coverage against the in-memory index — but nothing drove the two together, so
 * the integration point this branch exists to deliver was unexercised. These
 * tests run `runDagStateful` with the file adapter injected and assert the
 * runtime's freshness behaviour AND the durable bytes it leaves behind.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { R, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { witness, witnessValue, RN } from "./_freshness-helpers.js";
import { createFileFreshnessIndex } from "../file/freshness-index.js";
import { keyDigest } from "../file/layout.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { ok } from "../types/result.js";
import type { NodeDef } from "../types/node.js";
import { type NodeOverride, brandedOverride } from "./_node-override.js";
import type { WriteAttemptedEvent, FreshnessViolationEvent } from "../types/events.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDirectory = (): string => {
  const parent = mkdtempSync(join(tmpdir(), "freshness-dag-"));
  cleanup.push(parent);
  return join(parent, "index");
};

const makeNode = (id: string, overrides: NodeOverride = {}): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform" as const,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async (input: unknown) => ok(input),
  requires: [] as const,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  ...brandedOverride(overrides),
});

const RESOURCE = "pg:orders";

/** reads → writes over one resource, the shape freshness tracking exists for. */
const readThenWriteDag = (readVersion: string, writeVersion: string) =>
  defineDag({
    id: "file-freshness",
    nodes: {
      reader: makeNode("reader", {
        sideEffects: {
          kind: "reads",
          resource: RN(RESOURCE),
          extractWitness: () => witnessValue("version", readVersion),
        },
        run: async () => ok({ version: readVersion }),
      }),
      writer: makeNode("writer", {
        sideEffects: {
          kind: "writes",
          resource: RN(RESOURCE),
          extractConditionedOn: () => witness("version", RN(RESOURCE), readVersion),
          extractNewWitness: () => witnessValue("version", writeVersion),
        },
        run: async () => ok({ newVersion: writeVersion }),
      }),
    },
    edges: [
      { from: DAG_INPUT, to: "reader" },
      { from: "reader", to: "writer" },
    ],
    outputNodeId: "writer",
  });

describe("file FreshnessIndex wired into runDagStateful", () => {
  test("a clean run records the write DURABLY and reports no violation", async () => {
    const directory = tempDirectory();
    const observer = new RecordingObserver();
    const ctx = makeNodeContext({ runId: R("run-1"), dagId: D("file-freshness"), observer });

    const result = await runDagStateful(readThenWriteDag("42", "43"), null, ctx, {
      freshnessIndex: createFileFreshnessIndex(directory, { now: () => 5_000 }),
    });

    expect(result.ok).toBe(true);
    expect(observer.events.some((e) => e.type === "freshness-violation")).toBe(false);
    const write = observer.events.find(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(write?.newWitness.value).toBe("43");

    // The point of the FILE adapter: the witness outlives the process.
    expect(existsSync(join(directory, `${keyDigest(RESOURCE)}.json`))).toBe(true);
  });

  test("a SECOND run conditioned on the now-stale version sees the first run's durable write", async () => {
    const directory = tempDirectory();

    // Run 1 moves the resource 42 → 43 and persists that fact.
    const first = await runDagStateful(
      readThenWriteDag("42", "43"),
      null,
      makeNodeContext({ runId: R("run-1"), dagId: D("file-freshness"), observer: new RecordingObserver() }),
      { freshnessIndex: createFileFreshnessIndex(directory, { now: () => 5_000 }) },
    );
    expect(first.ok).toBe(true);

    // Run 2 uses a FRESH index instance over the SAME directory — i.e. what a
    // restarted process sees — and still conditions on 42.
    const observer = new RecordingObserver();
    const second = await runDagStateful(
      readThenWriteDag("42", "44"),
      null,
      makeNodeContext({ runId: R("run-2"), dagId: D("file-freshness"), observer }),
      { freshnessIndex: createFileFreshnessIndex(directory, { now: () => 6_000 }) },
    );

    expect(second.ok).toBe(true);
    const violation = observer.events.find(
      (e): e is FreshnessViolationEvent => e.type === "freshness-violation",
    );
    expect(violation).toBeDefined();
    expect(violation!.resource).toBe(RN(RESOURCE));
    expect(violation!.conditionedOnWitness.value).toBe("42");
    // The conflicting write is the one the PREVIOUS process durably recorded.
    expect(violation!.conflictingWrite.newWitness.value).toBe("43");
  });

  test("the run still completes and records its own write after detecting the conflict", async () => {
    // A freshness violation is an OBSERVATION (ADR-0025), not a run failure —
    // the gate is a human-review concern. Pinned here because the file adapter
    // is the one that makes the conflict survive a restart.
    const directory = tempDirectory();
    await runDagStateful(
      readThenWriteDag("42", "43"),
      null,
      makeNodeContext({ runId: R("run-1"), dagId: D("file-freshness"), observer: new RecordingObserver() }),
      { freshnessIndex: createFileFreshnessIndex(directory, { now: () => 5_000 }) },
    );

    const observer = new RecordingObserver();
    const second = await runDagStateful(
      readThenWriteDag("42", "44"),
      null,
      makeNodeContext({ runId: R("run-2"), dagId: D("file-freshness"), observer }),
      { freshnessIndex: createFileFreshnessIndex(directory, { now: () => 6_000 }) },
    );
    expect(second.ok).toBe(true);

    // Run 3 reads the singleton back: the latest durable write is run 2's.
    const index = createFileFreshnessIndex(directory, { now: () => 7_000 });
    const conflict = await index.findConflict(witness("version", RN(RESOURCE), "43"), 0);
    expect(conflict.ok).toBe(true);
    if (conflict.ok) {
      expect(conflict.value?.newWitness.value).toBe("44");
    }
  });
});
