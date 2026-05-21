import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { dagId } from "@fugue/framework";
import type { DagDef } from "@fugue/framework";
import { z } from "zod";
import {
  emptyRegistry,
  withDag,
  withoutDag,
  freeze,
  lookupDag,
  healthyCount,
  isEmpty,
} from "../domain/registry.js";
import type { RegisteredDag, Registry } from "../domain/registry.js";

// ── Test Helpers ───────────────────────────────────────────────────────────

const makeDag = (id: string, overrides?: Partial<RegisteredDag>): RegisteredDag => ({
  id: dagId(id),
  team: "test-team",
  route: `/run/${id}`,
  dag: {} as DagDef,
  inputSchema: z.object({}),
  config: {},
  loadedAt: Date.now(),
  sha: "abc123",
  healthy: true,
  ...overrides,
});

// ── Unit Tests ─────────────────────────────────────────────────────────────

describe("Registry", () => {
  describe("emptyRegistry", () => {
    it("creates a registry with no DAGs", () => {
      const r = emptyRegistry();
      expect(r.dags.size).toBe(0);
      expect(r.loadedAt).toBe(0);
      expect(r.sha).toBe("");
    });

    it("isEmpty returns true for empty registry", () => {
      expect(isEmpty(emptyRegistry())).toBe(true);
    });
  });

  describe("withDag", () => {
    it("adds a DAG to an empty registry", () => {
      const r = emptyRegistry();
      const dag = makeDag("my-dag");
      const r2 = withDag(r, dag);

      expect(r2.dags.size).toBe(1);
      expect(r2.dags.get(dagId("my-dag"))).toEqual(dag);
    });

    it("does not mutate the original registry", () => {
      const r = emptyRegistry();
      const dag = makeDag("my-dag");
      withDag(r, dag);

      expect(r.dags.size).toBe(0);
    });

    it("replaces a DAG with the same id", () => {
      const r = emptyRegistry();
      const dag1 = makeDag("my-dag", { team: "team-a" });
      const dag2 = makeDag("my-dag", { team: "team-b" });
      const r2 = withDag(withDag(r, dag1), dag2);

      expect(r2.dags.size).toBe(1);
      expect(r2.dags.get(dagId("my-dag"))?.team).toBe("team-b");
    });

    it("preserves existing DAGs when adding a new one", () => {
      const r = emptyRegistry();
      const dag1 = makeDag("dag-1");
      const dag2 = makeDag("dag-2");
      const r2 = withDag(withDag(r, dag1), dag2);

      expect(r2.dags.size).toBe(2);
      expect(r2.dags.get(dagId("dag-1"))).toEqual(dag1);
      expect(r2.dags.get(dagId("dag-2"))).toEqual(dag2);
    });

    it("preserves loadedAt and sha from original registry", () => {
      const r: Registry = { dags: new Map(), loadedAt: 1000, sha: "sha-orig" };
      const dag = makeDag("test");
      const r2 = withDag(r, dag);

      expect(r2.loadedAt).toBe(1000);
      expect(r2.sha).toBe("sha-orig");
    });
  });

  describe("withoutDag", () => {
    it("removes a DAG from the registry", () => {
      const dag = makeDag("my-dag");
      const r = withDag(emptyRegistry(), dag);
      const r2 = withoutDag(r, dagId("my-dag"));

      expect(r2.dags.size).toBe(0);
    });

    it("does not mutate the original registry", () => {
      const dag = makeDag("my-dag");
      const r = withDag(emptyRegistry(), dag);
      withoutDag(r, dagId("my-dag"));

      expect(r.dags.size).toBe(1);
    });

    it("is a no-op for non-existent DAG id", () => {
      const dag = makeDag("dag-1");
      const r = withDag(emptyRegistry(), dag);
      const r2 = withoutDag(r, dagId("non-existent"));

      expect(r2.dags.size).toBe(1);
      expect(r2.dags.get(dagId("dag-1"))).toEqual(dag);
    });

    it("preserves other DAGs", () => {
      const dag1 = makeDag("dag-1");
      const dag2 = makeDag("dag-2");
      const dag3 = makeDag("dag-3");
      const r = withDag(withDag(withDag(emptyRegistry(), dag1), dag2), dag3);
      const r2 = withoutDag(r, dagId("dag-2"));

      expect(r2.dags.size).toBe(2);
      expect(r2.dags.has(dagId("dag-1"))).toBe(true);
      expect(r2.dags.has(dagId("dag-2"))).toBe(false);
      expect(r2.dags.has(dagId("dag-3"))).toBe(true);
    });
  });

  describe("freeze", () => {
    it("creates a frozen registry from an array of DAGs", () => {
      const dags = [makeDag("dag-1"), makeDag("dag-2")];
      const r = freeze(dags, "sha-456", 5000);

      expect(r.dags.size).toBe(2);
      expect(r.sha).toBe("sha-456");
      expect(r.loadedAt).toBe(5000);
    });

    it("frozen registry object prevents property reassignment", () => {
      const dags = [makeDag("dag-1")];
      const r = freeze(dags, "sha-456", 5000);

      // The registry object itself is frozen
      expect(Object.isFrozen(r)).toBe(true);
      expect(() => {
        (r as any).sha = "mutated";
      }).toThrow();
    });

    it("Object.freeze prevents mutations on the registry object", () => {
      const dags = [makeDag("dag-1")];
      const r = freeze(dags, "sha-456", 5000);

      expect(() => {
        (r as any).sha = "mutated";
      }).toThrow();
    });

    it("handles empty DAG array", () => {
      const r = freeze([], "empty-sha", 1000);

      expect(r.dags.size).toBe(0);
      expect(r.sha).toBe("empty-sha");
      expect(r.loadedAt).toBe(1000);
    });

    it("last DAG wins on duplicate ids", () => {
      const dag1 = makeDag("same-id", { team: "team-a" });
      const dag2 = makeDag("same-id", { team: "team-b" });
      const r = freeze([dag1, dag2], "sha", 1000);

      expect(r.dags.size).toBe(1);
      expect(r.dags.get(dagId("same-id"))?.team).toBe("team-b");
    });
  });

  describe("lookupDag", () => {
    it("returns the DAG when found", () => {
      const dag = makeDag("lookup-me");
      const r = withDag(emptyRegistry(), dag);

      expect(lookupDag(r, dagId("lookup-me"))).toEqual(dag);
    });

    it("returns undefined when not found", () => {
      const r = emptyRegistry();

      expect(lookupDag(r, dagId("missing"))).toBeUndefined();
    });
  });

  describe("healthyCount", () => {
    it("counts only healthy DAGs", () => {
      const dags = [
        makeDag("healthy-1", { healthy: true }),
        makeDag("unhealthy-1", { healthy: false }),
        makeDag("healthy-2", { healthy: true }),
      ];
      const r = freeze(dags, "sha", 1000);

      expect(healthyCount(r)).toBe(2);
    });

    it("returns 0 for empty registry", () => {
      expect(healthyCount(emptyRegistry())).toBe(0);
    });
  });

  // ── Property Tests ─────────────────────────────────────────────────────

  describe("property tests", () => {
    const arbDagId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).map((s) => dagId(s));
    const arbSha = fc.stringMatching(/^[0-9a-f]{7}$/);

    const arbRegisteredDag = arbDagId.chain((id) =>
      fc.record({
        id: fc.constant(id),
        team: fc.string({ minLength: 1, maxLength: 10 }),
        route: fc.constant(`/run/${id}`),
        dag: fc.constant({} as DagDef),
        inputSchema: fc.constant(z.object({})),
        config: fc.constant({}),
        loadedAt: fc.nat(),
        sha: arbSha,
        healthy: fc.boolean(),
      })
    );

    it("withDag then withoutDag restores original size (for new ids)", () => {
      fc.assert(
        fc.property(arbRegisteredDag, (dag) => {
          const r = emptyRegistry();
          const r2 = withDag(r, dag);
          const r3 = withoutDag(r2, dag.id);
          return r3.dags.size === r.dags.size;
        }),
      );
    });

    it("withDag is idempotent for same DAG", () => {
      fc.assert(
        fc.property(arbRegisteredDag, (dag) => {
          const r = emptyRegistry();
          const r2 = withDag(r, dag);
          const r3 = withDag(r2, dag);
          return r3.dags.size === 1;
        }),
      );
    });

    it("withoutDag on non-existent id doesn't change size", () => {
      fc.assert(
        fc.property(arbRegisteredDag, arbDagId, (dag, otherId) => {
          // Only test when ids differ
          fc.pre(dag.id !== otherId);
          const r = withDag(emptyRegistry(), dag);
          const r2 = withoutDag(r, otherId);
          return r2.dags.size === r.dags.size;
        }),
      );
    });

    it("freeze produces registry with correct count (deduped by id)", () => {
      fc.assert(
        fc.property(
          fc.array(arbRegisteredDag, { minLength: 0, maxLength: 10 }),
          arbSha,
          fc.nat(),
          (dags, sha, now) => {
            const r = freeze(dags, sha, now);
            const uniqueIds = new Set(dags.map((d) => d.id));
            return r.dags.size === uniqueIds.size;
          },
        ),
      );
    });

    it("freeze preserves sha and loadedAt", () => {
      fc.assert(
        fc.property(
          fc.array(arbRegisteredDag, { minLength: 0, maxLength: 5 }),
          arbSha,
          fc.nat(),
          (dags, sha, now) => {
            const r = freeze(dags, sha, now);
            return r.sha === sha && r.loadedAt === now;
          },
        ),
      );
    });

    it("lookupDag finds what withDag added", () => {
      fc.assert(
        fc.property(arbRegisteredDag, (dag) => {
          const r = withDag(emptyRegistry(), dag);
          const found = lookupDag(r, dag.id);
          return found !== undefined && found.id === dag.id;
        }),
      );
    });

    it("healthyCount equals count of dags with healthy=true", () => {
      fc.assert(
        fc.property(
          fc.array(arbRegisteredDag, { minLength: 0, maxLength: 10 }),
          arbSha,
          fc.nat(),
          (dags, sha, now) => {
            const r = freeze(dags, sha, now);
            // Count unique healthy dags (last one wins for duplicate ids)
            const lastByIdMap = new Map(dags.map((d) => [d.id, d]));
            const expectedHealthy = [...lastByIdMap.values()].filter((d) => d.healthy).length;
            return healthyCount(r) === expectedHealthy;
          },
        ),
      );
    });
  });
});
