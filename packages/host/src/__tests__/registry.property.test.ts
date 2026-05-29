/**
 * Property-based tests for immutable Registry.
 *
 * Invariants:
 * 1. withDag always produces a registry containing the added DAG
 * 2. withoutDag is idempotent — applying twice has same effect
 * 3. lookupDag(withDag(r, dag), dag.id) always returns the dag
 * 4. freeze → withDag/withoutDag never mutates the original
 * 5. healthyCount <= total dags.size
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { dagId, gitSha } from "@fugue/framework";
import type { DagId, GitSha, DagDef } from "@fugue/framework";
import { z } from "zod";
import {
  emptyRegistry, freeze, withDag, withoutDag,
  lookupDag, healthyCount, isEmpty,
} from "../domain/registry.js";
import type { RegisteredDag, Registry } from "../domain/registry.js";

// ── Arbitraries ────────────────────────────────────────────────────────────

const dagIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}$/).map((s) => dagId(s));
const shaArb = fc.stringMatching(/^[0-9a-f]{8}$/).map((s) => gitSha(s));

const registeredDagArb = (idOverride?: DagId): fc.Arbitrary<RegisteredDag> =>
  fc.record({
    id: idOverride ? fc.constant(idOverride) : dagIdArb,
    team: fc.stringMatching(/^[a-z]{3,10}$/),
    route: fc.constant("/dags/test/run"),
    dag: fc.constant({ id: "test", nodes: [], edges: [] } as unknown as DagDef),
    inputSchema: fc.constant(z.any()),
    config: fc.record({
      route: fc.constant("/dags/test/run"),
      timeout: fc.integer({ min: 1000, max: 120000 }),
      maxConcurrency: fc.integer({ min: 1, max: 50 }),
    }),
    meta: fc.record({
      description: fc.string({ minLength: 0, maxLength: 50 }),
      version: fc.constant("1.0.0"),
    }),
    loadedAt: fc.integer({ min: 0, max: 999999 }),
    sha: shaArb,
    status: fc.oneof(
      fc.constant({ kind: "healthy" as const }),
      fc.record({ kind: fc.constant("disabled" as const), reason: fc.string() }),
    ),
    prompts: fc.constant(new Map()),
    modulePath: fc.constant("/tmp/dags/test/dag.ts"),
  }) as unknown as fc.Arbitrary<RegisteredDag>;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Registry property tests", () => {
  it("INVARIANT: withDag always makes the dag findable via lookupDag", () => {
    fc.assert(
      fc.property(
        dagIdArb,
        registeredDagArb(),
        shaArb,
        (id, dag, sha) => {
          const dagWithId = { ...dag, id };
          const registry = freeze([], sha, Date.now());
          const updated = withDag(registry, dagWithId);
          const found = lookupDag(updated, id);
          expect(found).toBeDefined();
          expect(found!.id).toBe(id);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT: withDag(r, dag).dags.size >= r.dags.size", () => {
    fc.assert(
      fc.property(
        registeredDagArb(),
        shaArb,
        (dag, sha) => {
          const registry = freeze([], sha, Date.now());
          const updated = withDag(registry, dag);
          expect(updated.dags.size).toBeGreaterThanOrEqual(registry.dags.size);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT: withoutDag is idempotent", () => {
    fc.assert(
      fc.property(
        dagIdArb,
        registeredDagArb(),
        shaArb,
        (id, dag, sha) => {
          const dagWithId = { ...dag, id };
          const registry = withDag(freeze([], sha, Date.now()), dagWithId);
          const once = withoutDag(registry, id);
          const twice = withoutDag(once, id);
          expect(once.dags.size).toBe(twice.dags.size);
          expect(lookupDag(twice, id)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT: freeze never mutates when followed by withDag/withoutDag", () => {
    fc.assert(
      fc.property(
        registeredDagArb(),
        shaArb,
        (dag, sha) => {
          const original = freeze([], sha, Date.now());
          const originalSize = original.dags.size;

          // withDag should not mutate original
          withDag(original, dag);
          expect(original.dags.size).toBe(originalSize);

          // Add then remove should not mutate original
          const withAdded = withDag(original, dag);
          withoutDag(withAdded, dag.id);
          expect(original.dags.size).toBe(originalSize);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT: healthyCount <= dags.size", () => {
    fc.assert(
      fc.property(
        fc.array(registeredDagArb(), { minLength: 0, maxLength: 10 }),
        shaArb,
        (dags, sha) => {
          // Deduplicate by id
          const unique = new Map(dags.map(d => [d.id, d]));
          const registry = freeze(Array.from(unique.values()), sha, Date.now());
          expect(healthyCount(registry)).toBeLessThanOrEqual(registry.dags.size);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT: emptyRegistry is empty", () => {
    const r = emptyRegistry();
    expect(isEmpty(r)).toBe(true);
    expect(r.dags.size).toBe(0);
    expect(healthyCount(r)).toBe(0);
  });
});
