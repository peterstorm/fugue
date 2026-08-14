/**
 * Cross-cutting filesystem-boundary sweep (FR-016/FR-029, NFR-010).
 *
 * The same hostile/reserved-looking strings cross the three public file
 * surfaces. Job dedup keys and checkpointer IDs obey their own constrained
 * grammars; freshness resources remain intentionally unbounded and are safe
 * because only sha256 digests become filenames. No value may create anything
 * outside its caller-supplied root.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFileCheckpointer } from "../file/checkpointer.js";
import { isDedupKey } from "../file/event-record.js";
import { createFileFreshnessIndex } from "../file/freshness-index.js";
import { createFileJob } from "../file/job.js";
import { EVENTS_DIR, isBoundaryId, keyDigest } from "../file/layout.js";
import type { RunMeta } from "../checkpoint/checkpointer.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import { witness, resourceName } from "../types/freshness.js";
import { __brandNodeIdUnchecked, __brandRunIdUnchecked } from "../types/ids.js";
import { isFrameworkError } from "../types/errors.js";
import { D, N, R } from "./_id-helpers.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const meta: RunMeta = {
  dagId: D("boundary-dag"),
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
  nodeCount: 1,
};

const freshnessEvent = (resource: string, value: string): WriteAttemptedEvent => ({
  type: "write-attempted",
  runId: R("boundary-run"),
  dagId: D("boundary-dag"),
  nodeId: N("boundary-node"),
  conditionedOn: witness("version", resourceName(resource), "old"),
  newWitness: witness("version", resourceName(resource), value),
  succeededAtMs: 100,
  timestamp: new Date(100),
});

describe("file backend hostile identifier/resource boundary", () => {
  it("revalidates bypassed freshness runId/nodeId brands before creating any artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "fugue-freshness-id-boundary-"));
    roots.push(root);
    const freshnessRoot = join(root, "freshness-root");
    const absoluteEscape = join(root, "absolute-escape");
    const hostileIds: readonly string[] = [
      "../escape",
      "..%2Fescape",
      absoluteEscape,
      "nul\u0000byte",
      "contains space",
      "contains.dot",
      "x".repeat(129),
      "$input",
    ];
    const freshness = createFileFreshnessIndex(freshnessRoot, { now: () => 400 });

    for (const [index, hostileId] of hostileIds.entries()) {
      const base = freshnessEvent(`hostile-id:${index}`, `value-${index}`);
      const invalidRun = await freshness.recordWrite({
        ...base,
        runId: __brandRunIdUnchecked(hostileId),
      });
      expect(invalidRun.ok).toBe(false);
      if (invalidRun.ok) throw new Error(`expected invalid runId rejection for ${JSON.stringify(hostileId)}`);
      expect(invalidRun.error.kind).toBe("cache-error");
      if (invalidRun.error.kind === "cache-error") {
        expect(invalidRun.error.operation).toBe("freshness:recordWrite");
        expect(invalidRun.error.message).toContain("runId");
      }

      const invalidNode = await freshness.recordWrite({
        ...base,
        nodeId: __brandNodeIdUnchecked(hostileId),
      });
      expect(invalidNode.ok).toBe(false);
      if (invalidNode.ok) throw new Error(`expected invalid nodeId rejection for ${JSON.stringify(hostileId)}`);
      expect(invalidNode.error.kind).toBe("cache-error");
      if (invalidNode.error.kind === "cache-error") {
        expect(invalidNode.error.operation).toBe("freshness:recordWrite");
        expect(invalidNode.error.message).toContain("nodeId");
      }

      expect(existsSync(freshnessRoot)).toBe(false);
      expect(existsSync(absoluteEscape)).toBe(false);
      expect(existsSync(join(root, "escape"))).toBe(false);
    }

    expect(readdirSync(root)).toEqual([]);
  });

  it("fails closed where constrained, digests unbounded resources, and never path-escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "fugue-file-boundary-"));
    roots.push(root);
    const absoluteEscape = join(root, "absolute-escape");
    const jobRoot = join(root, "job-root");
    const checkpointRoot = join(root, "checkpoint-root");
    const freshnessRoot = join(root, "freshness-root");

    const values: readonly string[] = [
      "../escape",
      "..%2Fescape",
      absoluteEscape,
      "nul\u0000byte",
      "contains space",
      "contains.dot",
      "x".repeat(129),
      "$input",
      "events",
      "checkpoint.json",
      "meta.json",
      "nodes",
      "constructor",
      "__proto__",
    ];

    // Job surface: dedup keys are the constrained durable identifier. Each
    // invalid key fails before appending or creating artifacts for that failed
    // call; valid-but-reserved-looking keys are digest-addressed and remain
    // inside the run directory.
    const job = createFileJob({
      directory: jobRoot,
      initial: { state: "ready", context: {} },
      now: () => 200,
    });
    let validJobKeys = 0;
    for (const value of values) {
      if (isDedupKey(value)) {
        await job.appendEvent({ type: "boundary", value }, value);
        validJobKeys++;
      } else {
        let failure: unknown;
        try {
          await job.appendEvent({ type: "boundary", value }, value);
        } catch (error) {
          failure = error;
        }
        expect(isFrameworkError(failure)).toBe(true);
        if (!isFrameworkError(failure) || failure.kind !== "cache-error") {
          throw new Error("expected typed cache-error for invalid dedupKey");
        }
        expect(failure.kind).toBe("cache-error");
        expect(failure.operation).toBe("appendEvent");
        expect(failure.message).toContain("FR-015-valid");
        expect(failure.message).toContain(jobRoot);
      }
      expect(existsSync(absoluteEscape)).toBe(false);
      expect(existsSync(join(root, "escape"))).toBe(false);
    }
    expect(readdirSync(join(jobRoot, EVENTS_DIR)).filter((name) => name.endsWith(".json"))).toHaveLength(validJobKeys);

    // Checkpointer surface: bypass the RunId brand exactly as a JS/untrusted
    // boundary can. Invalid IDs return checkpoint-write-failed; valid reserved
    // words are ordinary in-root run directory names, never control filenames.
    const checkpointer = createFileCheckpointer(checkpointRoot, { now: () => 300 });
    for (const value of values) {
      const result = await checkpointer.setMeta(__brandRunIdUnchecked(value), meta);
      if (isBoundaryId(value)) {
        expect(result.ok).toBe(true);
        expect(existsSync(join(checkpointRoot, value, "meta.json"))).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error(`expected rejection for ${JSON.stringify(value)}`);
        expect(result.error.kind).toBe("checkpoint-write-failed");
      }
      expect(existsSync(absoluteEscape)).toBe(false);
      expect(existsSync(join(root, "escape"))).toBe(false);
    }

    // Freshness surface: EVERY non-empty resource is legal, including values
    // rejected by both constrained surfaces. Exactly sha256hex(resource).json
    // is created and a fresh instance can query it by the same unbounded value.
    const freshness = createFileFreshnessIndex(freshnessRoot, { now: () => 400 });
    for (const [index, resource] of values.entries()) {
      const recorded = await freshness.recordWrite(freshnessEvent(resource, `new-${index}`));
      expect(recorded).toEqual({ ok: true, value: undefined });
      const expectedPath = join(freshnessRoot, `${keyDigest(resource)}.json`);
      expect(existsSync(expectedPath)).toBe(true);

      const queried = await createFileFreshnessIndex(freshnessRoot, { now: () => 401 }).findConflict(
        witness("version", resourceName(resource), "old"),
        100,
      );
      expect(queried.ok).toBe(true);
      if (!queried.ok) throw new Error(JSON.stringify(queried.error));
      expect(String(queried.value?.newWitness.resource)).toBe(resource);
      expect(existsSync(absoluteEscape)).toBe(false);
      expect(existsSync(join(root, "escape"))).toBe(false);
    }

    const freshnessEntries = readdirSync(freshnessRoot);
    const freshnessFiles = freshnessEntries.filter((name) => name.endsWith(".json"));
    expect(freshnessFiles).toHaveLength(values.length);
    expect(freshnessFiles.every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
    expect(new Set(freshnessFiles)).toEqual(
      new Set(values.map((resource) => `${keyDigest(resource)}.json`)),
    );
    // Permanent lock fences are metadata only, and are addressed by the same
    // digest — hostile resource text still never reaches a path component.
    expect(
      freshnessEntries
        .filter((name) => !name.endsWith(".json"))
        .every((name) => /^[0-9a-f]{64}\.lock\.fence$/.test(name)),
    ).toBe(true);

    // The temp root contains only the three caller-supplied roots. Traversal,
    // absolute values, encoded traversal, NUL, and reserved names created no
    // sibling entry and no path outside those roots.
    expect(readdirSync(root).sort()).toEqual(
      [basename(jobRoot), basename(checkpointRoot), basename(freshnessRoot)].sort(),
    );
  });
});
