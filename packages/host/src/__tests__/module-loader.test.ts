import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ok, err, dagId } from "@fugue/framework";
import type { Result, DagId, DagDef } from "@fugue/framework";
import { z } from "zod";
import type { HostError } from "../domain/host-error.js";
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
  id: "test-team-test-dag",
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
  id: "billing-invoice",
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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  mkdirSync(join(TEST_DIR, "dags", "team-a", "test-dag"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts"), VALID_DAG_MODULE);

  mkdirSync(join(TEST_DIR, "dags", "billing", "invoice"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "billing", "invoice", "dag.ts"), VALID_DAG_MODULE_2);

  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-export"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-export", "dag.ts"), INVALID_DAG_MODULE_NO_EXPORT);

  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-schema"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-schema", "dag.ts"), INVALID_DAG_MODULE_BAD_SCHEMA);

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
        expect(result.value.id).toBe(dagId("test-team-test-dag"));
        expect(result.value.registration.dag.id).toBe(dagId("test-team-test-dag"));
        expect(result.value.modulePath).toBe(path);
      }
    });

    it("returns import-failed for syntax errors with message and path", async () => {
      const path = join(TEST_DIR, "dags", "broken", "syntax-error", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("import-failed");
        if (result.error.kind === "import-failed") {
          expect(result.error.path).toBe(path);
          expect(result.error.message).not.toBe("");
        }
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

    it("returns dag-validation-failed with dagId and reason for invalid schema shape", async () => {
      const path = join(TEST_DIR, "dags", "broken", "bad-schema", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("dag-validation-failed");
        if (result.error.kind === "dag-validation-failed") {
          // extractDagId can't find a valid id in "not a dag object"
          expect(result.error.dagId).toBeDefined();
          expect(result.error.reason).not.toBe("");
          expect(result.error.message).not.toBe("");
        }
      }
    });

    it("returns import-failed for non-existent path", async () => {
      const path = join(TEST_DIR, "dags", "nonexistent", "dag.ts");
      const result = await loadDagModule(path, "sha123");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("import-failed");
        if (result.error.kind === "import-failed") {
          expect(result.error.path).toBe(path);
          expect(result.error.message).not.toBe("");
        }
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
        expect(result1.value.registration).not.toBe(result2.value.registration);
      }
    });
  });

  describe("discoverDagPaths", () => {
    it("discovers all dag.ts files matching glob pattern", async () => {
      const result = await discoverDagPaths(TEST_DIR);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(5);
        expect(result.value.some((p) => p.includes("team-a/test-dag/dag.ts"))).toBe(true);
        expect(result.value.some((p) => p.includes("billing/invoice/dag.ts"))).toBe(true);
        expect(result.value.some((p) => p.includes("broken/bad-export/dag.ts"))).toBe(true);
      }
    });

    it("returns absolute paths", async () => {
      const result = await discoverDagPaths(TEST_DIR);

      expect(result.ok).toBe(true);
      if (result.ok) {
        for (const p of result.value) {
          expect(p.startsWith("/")).toBe(true);
        }
      }
    });

    it("returns sorted paths (deterministic ordering)", async () => {
      const result = await discoverDagPaths(TEST_DIR);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const sorted = [...result.value].sort();
        expect(result.value).toEqual(sorted);
      }
    });

    it("returns ok with empty array for directory with no DAGs", async () => {
      const emptyDir = join(TEST_DIR, "empty-subdir");
      mkdirSync(emptyDir, { recursive: true });
      const result = await discoverDagPaths(emptyDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns discovery-failed for non-existent directory", async () => {
      const result = await discoverDagPaths("/nonexistent/path/that/does/not/exist");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("discovery-failed");
        if (result.error.kind === "discovery-failed") {
          expect(result.error.dagsRoot).toBe("/nonexistent/path/that/does/not/exist");
          expect(result.error.message).not.toBe("");
        }
      }
    });
  });

  describe("loadAll", () => {
    it("loads valid DAGs and reports errors for invalid ones", async () => {
      const result = await loadAll(TEST_DIR, "sha-bulk");

      expect(result.loaded).toHaveLength(2);
      expect(result.errors).toHaveLength(3);

      const dagIds = result.loaded.map((l) => l.id as unknown as string);
      expect(dagIds).toContain("test-team-test-dag");
      expect(dagIds).toContain("billing-invoice");
    });

    it("isolates errors — one bad DAG does not affect others (NFR-010)", async () => {
      const result = await loadAll(TEST_DIR, "sha-isolation");

      // Valid DAGs load despite broken ones existing
      expect(result.loaded).toHaveLength(2);
      // Exactly 3 broken fixtures: syntax-error, bad-export, bad-schema
      expect(result.errors).toHaveLength(3);

      for (const loadError of result.errors) {
        expect(loadError.path).toContain("dag.ts");
        expect(loadError.error.kind).toBeDefined();
      }
    });

    it("returns empty loaded array for directory with no valid DAGs", async () => {
      const tempDir = join(TEST_DIR, "only-broken");
      mkdirSync(join(tempDir, "dags", "broken", "bad-export"), { recursive: true });
      writeFileSync(join(tempDir, "dags", "broken", "bad-export", "dag.ts"), INVALID_DAG_MODULE_NO_EXPORT);

      const result = await loadAll(tempDir, "sha-no-valid");
      expect(result.loaded).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it("returns empty loaded AND empty errors for directory with zero dag.ts files", async () => {
      const emptyDir = join(TEST_DIR, "truly-empty");
      mkdirSync(emptyDir, { recursive: true });

      const result = await loadAll(emptyDir, "sha-empty");
      expect(result.loaded).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("surfaces discovery-failed as an error when directory is inaccessible", async () => {
      const result = await loadAll("/nonexistent/dags/root", "sha-bad-root");

      expect(result.loaded).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error.kind).toBe("discovery-failed");
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
});
