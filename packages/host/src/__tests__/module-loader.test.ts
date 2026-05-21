import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ok, err, dagId } from "@fugue/framework";
import type { Result, DagId, DagDef } from "@fugue/framework";
import { z } from "zod";
import type { HostError } from "../domain/host-error.js";
import type { DagRegistration } from "../domain/dag-registration.js";
import { validateDagRegistration } from "../domain/dag-registration.js";
import {
  loadDagModule,
  discoverDagPaths,
  loadAll,
  createModuleLoader,
} from "../adapters/module-loader.js";
import type { ModuleLoaderPort, LoadResult, BulkLoadResult } from "../adapters/module-loader.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

// ── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, "__fixtures_module_loader__");

const VALID_DAG_MODULE = `
import { z } from "zod";

const dag = {
  id: "test-team:test-dag",
  nodes: [{ id: "node-1", execute: async () => ({ result: "ok" }) }],
  edges: [],
};

export default {
  dag,
  inputSchema: z.object({ query: z.string() }),
  meta: { description: "Test DAG", version: "1.0.0" },
};
`;

const INVALID_DAG_MODULE_NO_EXPORT = `
// No default export
export const notDefault = { dag: null };
`;

const INVALID_DAG_MODULE_BAD_SCHEMA = `
export default {
  dag: "not a dag object",
  inputSchema: "not a schema",
};
`;

const VALID_DAG_MODULE_2 = `
import { z } from "zod";

const dag = {
  id: "billing:invoice",
  nodes: [{ id: "fetch", execute: async () => ({ data: [] }) }],
  edges: [],
};

export default {
  dag,
  inputSchema: z.object({ invoiceId: z.string() }),
  route: "/billing/invoice/run",
  config: { timeoutMs: 60000, maxConcurrent: 5 },
};
`;

const SYNTAX_ERROR_MODULE = `
export default {
  this is not valid javascript
};
`;

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  // Create test fixture directory structure
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  // dags/team-a/test-dag/dag.ts
  mkdirSync(join(TEST_DIR, "dags", "team-a", "test-dag"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts"), VALID_DAG_MODULE);

  // dags/billing/invoice/dag.ts
  mkdirSync(join(TEST_DIR, "dags", "billing", "invoice"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "billing", "invoice", "dag.ts"), VALID_DAG_MODULE_2);

  // dags/broken/bad-export/dag.ts
  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-export"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-export", "dag.ts"), INVALID_DAG_MODULE_NO_EXPORT);

  // dags/broken/bad-schema/dag.ts
  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-schema"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-schema", "dag.ts"), INVALID_DAG_MODULE_BAD_SCHEMA);

  // dags/broken/syntax-error/dag.ts
  mkdirSync(join(TEST_DIR, "dags", "broken", "syntax-error"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "syntax-error", "dag.ts"), SYNTAX_ERROR_MODULE);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Module Loader", () => {
  describe("loadDagModule", () => {
    it("loads a valid DAG module and returns LoadResult", async () => {
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("test-team:test-dag");
        expect(result.value.registration.dag.id).toBe("test-team:test-dag");
        expect(result.value.modulePath).toBe(path);
      }
    });

    it("returns import-failed for syntax errors", async () => {
      const path = join(TEST_DIR, "dags", "broken", "syntax-error", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("import-failed");
      }
    });

    it("returns no-default-export when module has no default export", async () => {
      const path = join(TEST_DIR, "dags", "broken", "bad-export", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no-default-export");
        if (result.error.kind === "no-default-export") {
          expect(result.error.path).toBe(path);
        }
      }
    });

    it("returns dag-validation-failed for invalid schema shape", async () => {
      const path = join(TEST_DIR, "dags", "broken", "bad-schema", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("dag-validation-failed");
      }
    });

    it("returns import-failed for non-existent path", async () => {
      const path = join(TEST_DIR, "dags", "nonexistent", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("import-failed");
      }
    });

    it("uses SHA for cache-busting (different SHA does not break loading)", async () => {
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result1 = await loadDagModule(path, "sha-v1");
      const result2 = await loadDagModule(path, "sha-v2");

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it("cache-busting produces distinct module instances per SHA (falsifiable hot-reload check)", async () => {
      // This is the critical invariant: importing the same path with different SHAs
      // MUST produce different module references. If they're identical, hot-reload is
      // broken and the host ships first-seen DAG code frozen until process restart.
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result1 = await loadDagModule(path, "sha-aaa");
      const result2 = await loadDagModule(path, "sha-bbb");

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        // Different SHA = different module evaluation = different object identity
        // This proves the ESM module cache is busted correctly
        expect(result1.value.registration).not.toBe(result2.value.registration);
      }
    });
  });

  describe("discoverDagPaths", () => {
    it("discovers all dag.ts files matching glob pattern", async () => {
      const paths = await discoverDagPaths(TEST_DIR);

      // Should find all 5 dag.ts files
      expect(paths.length).toBeGreaterThanOrEqual(5);
      expect(paths.some((p) => p.includes("team-a/test-dag/dag.ts"))).toBe(true);
      expect(paths.some((p) => p.includes("billing/invoice/dag.ts"))).toBe(true);
      expect(paths.some((p) => p.includes("broken/bad-export/dag.ts"))).toBe(true);
    });

    it("returns absolute paths", async () => {
      const paths = await discoverDagPaths(TEST_DIR);
      for (const p of paths) {
        expect(p.startsWith("/")).toBe(true);
      }
    });

    it("returns sorted paths", async () => {
      const paths = await discoverDagPaths(TEST_DIR);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it("returns empty array for directory with no DAGs", async () => {
      const emptyDir = join(TEST_DIR, "empty-subdir");
      mkdirSync(emptyDir, { recursive: true });
      const paths = await discoverDagPaths(emptyDir);
      expect(paths).toEqual([]);
    });
  });

  describe("loadAll", () => {
    it("loads valid DAGs and reports errors for invalid ones", async () => {
      const result = await loadAll(TEST_DIR, "sha-bulk");

      // Should have loaded the valid DAGs
      expect(result.loaded.length).toBeGreaterThanOrEqual(2);

      // Should have errors for the broken DAGs
      expect(result.errors.length).toBeGreaterThanOrEqual(2);

      // Verify valid ones loaded correctly
      const dagIds = result.loaded.map((l) => l.id as string);
      expect(dagIds).toContain("test-team:test-dag");
      expect(dagIds).toContain("billing:invoice");
    });

    it("isolates errors — one bad DAG does not affect others (NFR-010)", async () => {
      const result = await loadAll(TEST_DIR, "sha-isolation");

      // Valid DAGs should still load even though broken ones exist
      expect(result.loaded.length).toBeGreaterThanOrEqual(2);

      // Each error should reference its specific path
      for (const loadError of result.errors) {
        expect(loadError.path).toContain("dag.ts");
        expect(loadError.error.kind).toBeDefined();
      }
    });

    it("returns empty loaded array for directory with no valid DAGs", async () => {
      const brokenDir = join(TEST_DIR, "dags", "broken");
      // Create a temporary dir with only broken DAGs
      const tempDir = join(TEST_DIR, "only-broken");
      mkdirSync(join(tempDir, "dags", "broken", "bad-export"), { recursive: true });
      writeFileSync(join(tempDir, "dags", "broken", "bad-export", "dag.ts"), INVALID_DAG_MODULE_NO_EXPORT);

      const result = await loadAll(tempDir, "sha-no-valid");
      expect(result.loaded).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("createModuleLoader (port factory)", () => {
    it("creates a ModuleLoaderPort with all methods", () => {
      const loader = createModuleLoader();
      expect(typeof loader.loadDagModule).toBe("function");
      expect(typeof loader.discoverDagPaths).toBe("function");
      expect(typeof loader.loadAll).toBe("function");
    });
  });

  describe("validateDagRegistration", () => {
    it("validates a correct DagRegistration object", () => {
      const valid: unknown = {
        dag: { id: "my-dag", nodes: [{ id: "n1" }], edges: [] },
        inputSchema: z.object({ x: z.string() }),
      };
      const result = validateDagRegistration(valid);
      expect(result.ok).toBe(true);
    });

    it("rejects when dag is missing", () => {
      const invalid: unknown = {
        inputSchema: z.object({}),
      };
      const result = validateDagRegistration(invalid);
      expect(result.ok).toBe(false);
    });

    it("rejects when inputSchema has no .parse method", () => {
      const invalid: unknown = {
        dag: { id: "my-dag", nodes: [], edges: [] },
        inputSchema: { notASchema: true },
      };
      const result = validateDagRegistration(invalid);
      expect(result.ok).toBe(false);
    });

    it("accepts optional fields", () => {
      const valid: unknown = {
        dag: { id: "my-dag", nodes: [], edges: [] },
        inputSchema: z.object({}),
        route: "/custom/route",
        config: { timeoutMs: 5000, maxConcurrent: 3 },
        meta: { description: "A DAG", version: "2.0.0" },
      };
      const result = validateDagRegistration(valid);
      expect(result.ok).toBe(true);
    });
  });
});

// ── Fake Module Loader for Other Tests ─────────────────────────────────────

export const createFakeModuleLoader = (
  dags: LoadResult[] = [],
  errors: Array<{ path: string; error: HostError }> = [],
): ModuleLoaderPort => ({
  loadDagModule: async (modulePath, sha) => {
    const found = dags.find((d) => d.modulePath === modulePath);
    if (found) return ok(found);
    return err({ kind: "import-failed", path: modulePath, message: "not found in fake" });
  },
  discoverDagPaths: async () => dags.map((d) => d.modulePath),
  loadAll: async () => ({ loaded: dags, errors }),
});
