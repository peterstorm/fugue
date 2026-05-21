/**
 * Property-based tests for the immutable registry.
 *
 * Verifies invariants hold for arbitrary operations:
 * - withDag then withoutDag(same id) → size unchanged (round-trip)
 * - freeze then lookupDag for each input dag → all found
 * - freeze produces a registry with correct count
 * - withDag is idempotent for same id (last write wins)
 * - isEmpty is consistent with size
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import type { DagId, DagDef } from "@fugue/framework";
import { dagId } from "@fugue/framework";
import { z } from "zod";
import {
  emptyRegistry,
  withDag,
  withoutDag,
  freeze,
  lookupDag,
  healthyCount,
  isEmpty,
  type RegisteredDag,
  type Registry,
} from "../domain/registry.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const makeRegisteredDag = (id: string, healthy = true): RegisteredDag => ({
  id: dagId(id),
  team: "test",
  route: `/dags/${id}/run`,
  dag: { id, nodes: [], edges: [] } as unknown as DagDef,
  inputSchema: z.object({ input: z.string() }),
  config: {},
  loadedAt: Date.now(),
  sha: "abc123",
  healthy,
});

// Arbitrary for valid DAG IDs (lowercase alphanumeric with hyphens)
const dagIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(s) || (s.length === 1 && /^[a-z]$/.test(s)));

// ── Properties ─────────────────────────────────────────────────────────────

describe("registry properties", () => {
  test("withDag then withoutDag(same id) on empty → still empty", () => {
    fc.assert(
      fc.property(dagIdArb, (id) => {
        const r = emptyRegistry();
        const added = withDag(r, makeRegisteredDag(id));
        const removed = withoutDag(added, dagId(id));
        expect(isEmpty(removed)).toBe(true);
      }),
    );
  });

  test("withDag then withoutDag(same id) preserves original size", () => {
    fc.assert(
      fc.property(
        fc.array(dagIdArb, { minLength: 1, maxLength: 10 }),
        dagIdArb,
        (existingIds, newId) => {
          // Build a base registry with existing DAGs
          let r = emptyRegistry();
          const uniqueIds = [...new Set(existingIds)];
          for (const id of uniqueIds) {
            r = withDag(r, makeRegisteredDag(id));
          }

          // Add and remove a new DAG (not in existing)
          const freshId = `fresh-${newId}`;
          const originalSize = r.dags.size;
          const added = withDag(r, makeRegisteredDag(freshId));
          const removed = withoutDag(added, dagId(freshId));

          expect(removed.dags.size).toBe(originalSize);
        },
      ),
    );
  });

  test("freeze then lookupDag for each input → all found", () => {
    fc.assert(
      fc.property(
        fc.array(dagIdArb, { minLength: 1, maxLength: 20 }),
        (ids) => {
          const uniqueIds = [...new Set(ids)];
          const dags = uniqueIds.map((id) => makeRegisteredDag(id));
          const registry = freeze(dags, "sha-1", Date.now());

          for (const dag of dags) {
            const found = lookupDag(registry, dag.id);
            expect(found).toBeDefined();
            expect(found!.id).toBe(dag.id);
          }
        },
      ),
    );
  });

  test("freeze produces registry with correct dag count", () => {
    fc.assert(
      fc.property(
        fc.array(dagIdArb, { minLength: 0, maxLength: 20 }),
        (ids) => {
          const uniqueIds = [...new Set(ids)];
          const dags = uniqueIds.map((id) => makeRegisteredDag(id));
          const registry = freeze(dags, "sha-1", Date.now());

          expect(registry.dags.size).toBe(uniqueIds.length);
        },
      ),
    );
  });

  test("withDag is idempotent — same id overwrites", () => {
    fc.assert(
      fc.property(dagIdArb, (id) => {
        const r = emptyRegistry();
        const dag1 = makeRegisteredDag(id);
        const dag2 = { ...makeRegisteredDag(id), sha: "different-sha" };

        const added1 = withDag(r, dag1);
        const added2 = withDag(added1, dag2);

        expect(added2.dags.size).toBe(1);
        expect(lookupDag(added2, dagId(id))?.sha).toBe("different-sha");
      }),
    );
  });

  test("isEmpty is consistent with dags.size", () => {
    fc.assert(
      fc.property(
        fc.array(dagIdArb, { minLength: 0, maxLength: 10 }),
        (ids) => {
          const uniqueIds = [...new Set(ids)];
          let r = emptyRegistry();
          for (const id of uniqueIds) {
            r = withDag(r, makeRegisteredDag(id));
          }

          expect(isEmpty(r)).toBe(r.dags.size === 0);
        },
      ),
    );
  });

  test("healthyCount matches count of healthy DAGs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(dagIdArb, fc.boolean()), { minLength: 0, maxLength: 15 }),
        (entries) => {
          // Deduplicate by id (last entry wins)
          const deduped = new Map(entries.map(([id, h]) => [id, h]));
          const dags = Array.from(deduped.entries()).map(([id, healthy]) =>
            makeRegisteredDag(id, healthy),
          );
          const registry = freeze(dags, "sha-1", Date.now());

          const expectedHealthy = dags.filter((d) => d.healthy).length;
          expect(healthyCount(registry)).toBe(expectedHealthy);
        },
      ),
    );
  });

  test("withoutDag on non-existent id doesn't change size", () => {
    fc.assert(
      fc.property(
        fc.array(dagIdArb, { minLength: 1, maxLength: 10 }),
        (ids) => {
          const uniqueIds = [...new Set(ids)];
          let r = emptyRegistry();
          for (const id of uniqueIds) {
            r = withDag(r, makeRegisteredDag(id));
          }

          const originalSize = r.dags.size;
          const removed = withoutDag(r, dagId("nonexistent-dag-xyz"));
          expect(removed.dags.size).toBe(originalSize);
        },
      ),
    );
  });
});
