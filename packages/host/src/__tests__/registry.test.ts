import { describe, it, expect } from "bun:test";
import { dagId, gitSha, EMPTY_SHA } from "@fugue/framework";
import type { DagId, GitSha } from "@fugue/framework";
import { z } from "zod";
import {
  emptyRegistry, withDag, withoutDag, freeze,
  lookupDag, healthyCount, isEmpty,
} from "../domain/registry.js";
import type { RegisteredDag, Registry } from "../domain/registry.js";

const sha = gitSha("a".repeat(40));

const makeDag = (id: string, opts?: { healthy?: boolean }): RegisteredDag => ({
  id: dagId(id),
  team: "test-team",
  route: `/dags/${id}/run`,
  dag: { id: dagId(id), nodes: [], edges: [] } as any,
  inputSchema: z.object({}),
  config: { timeout: 30000, maxConcurrency: 10 },
  meta: { description: "test", version: "1.0" },
  loadedAt: Date.now(),
  sha,
  status: (opts?.healthy ?? true) ? { kind: "healthy" } : { kind: "disabled", reason: "test" },
});

describe("Registry", () => {
  describe("emptyRegistry", () => {
    it("creates empty registry", () => {
      const r = emptyRegistry();
      expect(isEmpty(r)).toBe(true);
      expect(healthyCount(r)).toBe(0);
      expect(r.sha).toBe(EMPTY_SHA);
    });

    it("lookupDag returns undefined on empty", () => {
      const r = emptyRegistry();
      expect(lookupDag(r, dagId("nonexistent"))).toBeUndefined();
    });
  });

  describe("withDag", () => {
    it("adds a DAG to empty registry", () => {
      const r = withDag(emptyRegistry(), makeDag("dag-a"));
      expect(isEmpty(r)).toBe(false);
      expect(lookupDag(r, dagId("dag-a"))).toBeDefined();
    });

    it("replaces DAG with same id", () => {
      const dag1 = makeDag("dag-a");
      const dag2 = { ...makeDag("dag-a"), team: "other-team" };
      const r1 = withDag(emptyRegistry(), dag1);
      const r2 = withDag(r1, dag2);
      expect(lookupDag(r2, dagId("dag-a"))!.team).toBe("other-team");
      expect(r2.dags.size).toBe(1);
    });

    it("preserves other DAGs", () => {
      const r1 = withDag(emptyRegistry(), makeDag("dag-a"));
      const r2 = withDag(r1, makeDag("dag-b"));
      expect(r2.dags.size).toBe(2);
      expect(lookupDag(r2, dagId("dag-a"))).toBeDefined();
      expect(lookupDag(r2, dagId("dag-b"))).toBeDefined();
    });

    it("does not mutate original registry", () => {
      const r1 = emptyRegistry();
      withDag(r1, makeDag("dag-a"));
      expect(isEmpty(r1)).toBe(true);
    });
  });

  describe("withoutDag", () => {
    it("removes existing DAG", () => {
      const r = withDag(emptyRegistry(), makeDag("dag-a"));
      const r2 = withoutDag(r, dagId("dag-a"));
      expect(isEmpty(r2)).toBe(true);
    });

    it("noop for non-existent id", () => {
      const r = withDag(emptyRegistry(), makeDag("dag-a"));
      const r2 = withoutDag(r, dagId("dag-b"));
      expect(r2.dags.size).toBe(1);
      expect(lookupDag(r2, dagId("dag-a"))).toBeDefined();
    });

    it("preserves other DAGs", () => {
      let r = withDag(emptyRegistry(), makeDag("dag-a"));
      r = withDag(r, makeDag("dag-b"));
      const r2 = withoutDag(r, dagId("dag-a"));
      expect(r2.dags.size).toBe(1);
      expect(lookupDag(r2, dagId("dag-b"))).toBeDefined();
    });

    it("does not mutate original registry", () => {
      const r = withDag(emptyRegistry(), makeDag("dag-a"));
      withoutDag(r, dagId("dag-a"));
      expect(r.dags.size).toBe(1);
    });
  });

  describe("freeze", () => {
    it("builds registry from array with correct sha and loadedAt", () => {
      const dags = [makeDag("dag-a"), makeDag("dag-b")];
      const r = freeze(dags, sha, 5000);
      expect(r.dags.size).toBe(2);
      expect(r.sha).toBe(sha);
      expect(r.loadedAt).toBe(5000);
    });

    it("deduplicates by id (last wins)", () => {
      const dag1 = makeDag("dag-a");
      const dag2 = { ...makeDag("dag-a"), team: "other" };
      const r = freeze([dag1, dag2], sha, 1000);
      expect(r.dags.size).toBe(1);
      expect(lookupDag(r, dagId("dag-a"))!.team).toBe("other");
    });

    it("empty array produces empty registry", () => {
      const r = freeze([], sha, 1000);
      expect(isEmpty(r)).toBe(true);
      expect(r.sha).toBe(sha);
    });
  });

  describe("lookupDag", () => {
    it("finds existing DAG by id", () => {
      const r = freeze([makeDag("dag-a")], sha, 1000);
      const found = lookupDag(r, dagId("dag-a"));
      expect(found).toBeDefined();
      expect(found!.id).toBe(dagId("dag-a"));
    });

    it("returns undefined for missing id", () => {
      const r = freeze([makeDag("dag-a")], sha, 1000);
      expect(lookupDag(r, dagId("dag-b"))).toBeUndefined();
    });
  });

  describe("healthyCount", () => {
    it("counts only healthy DAGs", () => {
      const dags = [
        makeDag("dag-a", { healthy: true }),
        makeDag("dag-b", { healthy: true }),
        makeDag("dag-c", { healthy: false }),
      ];
      const r = freeze(dags, sha, 1000);
      expect(healthyCount(r)).toBe(2);
    });

    it("returns 0 for empty registry", () => {
      expect(healthyCount(emptyRegistry())).toBe(0);
    });

    it("returns 0 when all disabled", () => {
      const dags = [makeDag("dag-a", { healthy: false }), makeDag("dag-b", { healthy: false })];
      const r = freeze(dags, sha, 1000);
      expect(healthyCount(r)).toBe(0);
    });
  });

  describe("isEmpty", () => {
    it("true for empty registry", () => {
      expect(isEmpty(emptyRegistry())).toBe(true);
    });

    it("false when has dags", () => {
      const r = withDag(emptyRegistry(), makeDag("dag-a"));
      expect(isEmpty(r)).toBe(false);
    });
  });
});
