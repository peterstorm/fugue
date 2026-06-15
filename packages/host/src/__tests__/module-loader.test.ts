import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ok, err, dagId, gitSha, computePromptHash } from "@fuguejs/framework";
import type { Result, DagId, DagDef, GitSha } from "@fuguejs/framework";
import { z } from "zod";
import type { HostError } from "../domain/host-error.js";
import {
  loadDagModule,
  discoverDagPaths,
  loadAll,
  createModuleLoader,
} from "../adapters/module-loader.js";
import type { ModuleLoaderPort, LoadResult, BulkLoadResult } from "../ports.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

// ── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, "__fixtures_module_loader__");
// Separate root for fugue.yaml fixtures so they don't pollute loadAll(TEST_DIR) counts.
const YAML_DIR = join(import.meta.dir, "__fixtures_module_loader_yaml__");

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

// Nested deeper than dags/{team}/{dag} — proves discovery is depth-agnostic
// (dags/business-sales/leads/lead-scoring/dag.ts). Team is the first folder.
const NESTED_DAG_MODULE = `
import { z } from "zod";

const dag = {
  id: "business-sales-leads-lead-scoring",
  nodes: [{ id: "score", execute: async () => ({ ok: true }) }],
  edges: [],
};

export default {
  dag,
  inputSchema: z.object({ leadId: z.string() }),
  meta: { description: "Nested DAG", version: "1.0.0" },
};
`;

// DAG + sibling fugue.yaml for merge/override tests
const YAML_DAG_MODULE = `
import { z } from "zod";
const dag = {
  id: "cx-with-yaml",
  nodes: [{ id: "n", execute: async () => ({}) }],
  edges: [],
};
export default {
  dag,
  inputSchema: z.object({ q: z.string() }),
  route: "/from-dag-ts",
  config: { timeoutMs: 30000, maxConcurrent: 2 },
  meta: { description: "x", version: "1.0.0" },
};
`;

const FUGUE_YAML = `team: cx
owner: platform
route: /from-yaml
maxConcurrent: 7
timeoutMs: 90000
cacheTtlMs: 600000
`;

const ENV_DAG_MODULE = `
import { z } from "zod";
const dag = { id: "cx-needs-env", nodes: [{ id: "n", execute: async () => ({}) }], edges: [] };
export default { dag, inputSchema: z.object({ q: z.string() }), meta: { description: "x", version: "1.0.0" } };
`;

const FUGUE_YAML_ENV = `team: cx
env:
  - REQUIRED_TEST_VAR
`;

const FUGUE_YAML_MALFORMED = `route: [unclosed`;

const FUGUE_YAML_NO_TEAM = `owner: platform
maxConcurrent: 3
`;

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  mkdirSync(join(TEST_DIR, "dags", "team-a", "test-dag"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts"), VALID_DAG_MODULE);

  mkdirSync(join(TEST_DIR, "dags", "billing", "invoice"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "billing", "invoice", "dag.ts"), VALID_DAG_MODULE_2);

  // Deeper than the {team}/{dag} convention — discovery must still find it.
  mkdirSync(join(TEST_DIR, "dags", "business-sales", "leads", "lead-scoring"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "business-sales", "leads", "lead-scoring", "dag.ts"), NESTED_DAG_MODULE);

  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-export"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-export", "dag.ts"), INVALID_DAG_MODULE_NO_EXPORT);

  mkdirSync(join(TEST_DIR, "dags", "broken", "bad-schema"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "bad-schema", "dag.ts"), INVALID_DAG_MODULE_BAD_SCHEMA);

  mkdirSync(join(TEST_DIR, "dags", "broken", "syntax-error"), { recursive: true });
  writeFileSync(join(TEST_DIR, "dags", "broken", "syntax-error", "dag.ts"), SYNTAX_ERROR_MODULE);

  // fugue.yaml fixtures live under a SEPARATE root so loadAll(TEST_DIR) counts are unaffected.
  if (existsSync(YAML_DIR)) rmSync(YAML_DIR, { recursive: true });

  // DAG with a sibling fugue.yaml (merge/override)
  mkdirSync(join(YAML_DIR, "dags", "cx", "with-yaml"), { recursive: true });
  writeFileSync(join(YAML_DIR, "dags", "cx", "with-yaml", "dag.ts"), YAML_DAG_MODULE);
  writeFileSync(join(YAML_DIR, "dags", "cx", "with-yaml", "fugue.yaml"), FUGUE_YAML);

  // DAG whose fugue.yaml declares a required env var
  mkdirSync(join(YAML_DIR, "dags", "cx", "needs-env"), { recursive: true });
  writeFileSync(join(YAML_DIR, "dags", "cx", "needs-env", "dag.ts"), ENV_DAG_MODULE);
  writeFileSync(join(YAML_DIR, "dags", "cx", "needs-env", "fugue.yaml"), FUGUE_YAML_ENV);

  // DAG with a malformed fugue.yaml
  mkdirSync(join(YAML_DIR, "dags", "cx", "bad-yaml"), { recursive: true });
  writeFileSync(join(YAML_DIR, "dags", "cx", "bad-yaml", "dag.ts"), YAML_DAG_MODULE);
  writeFileSync(join(YAML_DIR, "dags", "cx", "bad-yaml", "fugue.yaml"), FUGUE_YAML_MALFORMED);

  // DAG with a fugue.yaml missing the required `team` field
  mkdirSync(join(YAML_DIR, "dags", "cx", "no-team"), { recursive: true });
  writeFileSync(join(YAML_DIR, "dags", "cx", "no-team", "dag.ts"), YAML_DAG_MODULE);
  writeFileSync(join(YAML_DIR, "dags", "cx", "no-team", "fugue.yaml"), FUGUE_YAML_NO_TEAM);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (existsSync(YAML_DIR)) rmSync(YAML_DIR, { recursive: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Module Loader", () => {
  describe("loadDagModule", () => {
    it("loads a valid DAG module and returns LoadResult", async () => {
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result = await loadDagModule(path, gitSha("sha123"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(dagId("test-team-test-dag"));
        expect(result.value.registration.dag.id).toBe(dagId("test-team-test-dag"));
        expect(result.value.modulePath).toBe(path);
      }
    });

    it("returns import-failed for syntax errors with message and path", async () => {
      const path = join(TEST_DIR, "dags", "broken", "syntax-error", "dag.ts");
      const result = await loadDagModule(path, gitSha("sha123"));

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
      const result = await loadDagModule(path, gitSha("sha123"));

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
      const result = await loadDagModule(path, gitSha("sha123"));

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
      const result = await loadDagModule(path, gitSha("sha123"));

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
      const result1 = await loadDagModule(path, gitSha("sha-v1"));
      const result2 = await loadDagModule(path, gitSha("sha-v2"));

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });

    it("cache-busting produces distinct module instances per SHA (falsifiable hot-reload check)", async () => {
      // This is the critical invariant: importing the same path with different SHAs
      // MUST produce different module references. If they're identical, hot-reload is
      // broken and the host ships first-seen DAG code frozen until process restart.
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result1 = await loadDagModule(path, gitSha("sha-aaa"));
      const result2 = await loadDagModule(path, gitSha("sha-bbb"));

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
        expect(result.value).toHaveLength(6);
        expect(result.value.some((p) => p.includes("team-a/test-dag/dag.ts"))).toBe(true);
        expect(result.value.some((p) => p.includes("billing/invoice/dag.ts"))).toBe(true);
        expect(result.value.some((p) => p.includes("broken/bad-export/dag.ts"))).toBe(true);
        // Depth-agnostic: a dag.ts nested under a domain folder is discovered.
        expect(result.value.some((p) => p.includes("business-sales/leads/lead-scoring/dag.ts"))).toBe(true);
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
      const result = await loadAll(TEST_DIR, gitSha("sha-bulk"));

      expect(result.loaded).toHaveLength(3);
      expect(result.errors).toHaveLength(3);

      const dagIds = result.loaded.map((l) => l.id as unknown as string);
      expect(dagIds).toContain("test-team-test-dag");
      expect(dagIds).toContain("billing-invoice");
      expect(dagIds).toContain("business-sales-leads-lead-scoring");
    });

    it("isolates errors — one bad DAG does not affect others (NFR-010)", async () => {
      const result = await loadAll(TEST_DIR, gitSha("sha-isolation"));

      // Valid DAGs load despite broken ones existing (2 flat + 1 nested)
      expect(result.loaded).toHaveLength(3);
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

      const result = await loadAll(tempDir, gitSha("sha-no-valid"));
      expect(result.loaded).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it("returns empty loaded AND empty errors for directory with zero dag.ts files", async () => {
      const emptyDir = join(TEST_DIR, "truly-empty");
      mkdirSync(emptyDir, { recursive: true });

      const result = await loadAll(emptyDir, gitSha("sha-empty"));
      expect(result.loaded).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("surfaces discovery-failed as an error when directory is inaccessible", async () => {
      const result = await loadAll("/nonexistent/dags/root", gitSha("sha-bad-root"));

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

  describe("prompt loading (loadPromptsForModule)", () => {
    it("loads .txt files from sibling prompts/ directory", async () => {
      // Setup: create dag with prompts dir
      const dagDir = join(TEST_DIR, "dags", "team-a", "test-dag");
      const promptsDir = join(dagDir, "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "synthesis.txt"), "Hello {{name}}");
      writeFileSync(join(promptsDir, "greeting.txt"), "Welcome!");
      // A VALID registry (hashes match) — non-.txt files are ignored as
      // prompts, and a present registry is validated (see prompt versioning).
      writeFileSync(join(promptsDir, "registry.json"), JSON.stringify({
        synthesis: { version: "1.0.0", hash: computePromptHash("Hello {{name}}") },
        greeting: { version: "1.0.0", hash: computePromptHash("Welcome!") },
      }));

      const path = join(dagDir, "dag.ts");
      const result = await loadDagModule(path, gitSha("prompt-test-sha"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.prompts.size).toBe(2);
        expect(result.value.prompts.get("synthesis")).toBe("Hello {{name}}");
        expect(result.value.prompts.get("greeting")).toBe("Welcome!");
        expect(result.value.prompts.has("registry")).toBe(false); // .json ignored
      }

      // Cleanup
      rmSync(promptsDir, { recursive: true });
    });

    it("returns empty map when no prompts/ directory exists", async () => {
      const path = join(TEST_DIR, "dags", "billing", "invoice", "dag.ts");
      const result = await loadDagModule(path, gitSha("no-prompts-sha"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.prompts.size).toBe(0);
      }
    });

    it("calls onFileError callback for unreadable prompt files", async () => {
      // We test loadPromptsForModule directly for this case
      const { loadPromptsForModule } = await import("../adapters/module-loader.js");

      const dagDir = join(TEST_DIR, "dags", "team-a", "unreadable-prompt");
      const promptsDir = join(dagDir, "prompts");
      mkdirSync(promptsDir, { recursive: true });
      // Create a directory with the name "broken.txt" — readFile will fail on it
      mkdirSync(join(promptsDir, "broken.txt"), { recursive: true });
      writeFileSync(join(promptsDir, "good.txt"), "works fine");

      const errors: string[] = [];
      const result = await loadPromptsForModule(
        join(dagDir, "dag.ts"),
        (path) => errors.push(path),
      );

      expect(result.get("good")).toBe("works fine");
      expect(result.has("broken")).toBe(false);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("broken.txt");

      // Cleanup
      rmSync(dagDir, { recursive: true });
    });

    it("prompts flow through loadAll into BulkLoadResult", async () => {
      // Setup prompts for billing/invoice
      const dagDir = join(TEST_DIR, "dags", "billing", "invoice");
      const promptsDir = join(dagDir, "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "invoice-summary.txt"), "Summarize {{invoiceId}}");

      const result = await loadAll(TEST_DIR, gitSha("bulk-prompts-sha"));

      const invoiceDag = result.loaded.find(l => l.id === dagId("billing-invoice"));
      expect(invoiceDag).toBeDefined();
      expect(invoiceDag!.prompts.get("invoice-summary")).toBe("Summarize {{invoiceId}}");

      // Cleanup
      rmSync(promptsDir, { recursive: true });
    });
  });

  describe("fugue.yaml merge", () => {
    it("merges fugue.yaml over dag.ts config (fugue.yaml wins) and threads team/owner", async () => {
      const path = join(YAML_DIR, "dags", "cx", "with-yaml", "dag.ts");
      const result = await loadDagModule(path, gitSha("yaml-sha"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { registration, team, owner } = result.value;
      expect(registration.route).toBe("/from-yaml");        // overrides dag.ts "/from-dag-ts"
      expect(registration.config?.timeoutMs).toBe(90000);   // overrides dag.ts 30000
      expect(registration.config?.maxConcurrent).toBe(7);   // overrides dag.ts 2
      expect(registration.config?.cacheTtlMs).toBe(600000); // yaml-only field applied
      expect(team).toBe("cx");
      expect(owner).toBe("platform");
    });

    it("returns no team/owner when there is no fugue.yaml", async () => {
      const path = join(TEST_DIR, "dags", "team-a", "test-dag", "dag.ts");
      const result = await loadDagModule(path, gitSha("no-yaml-sha"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.team).toBeUndefined();
      expect(result.value.owner).toBeUndefined();
    });

    it("fails the load (isolated) on malformed fugue.yaml", async () => {
      const path = join(YAML_DIR, "dags", "cx", "bad-yaml", "dag.ts");
      const result = await loadDagModule(path, gitSha("bad-yaml-sha"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("config-invalid");
    });

    it("fails the load when fugue.yaml is missing the required team field", async () => {
      const path = join(YAML_DIR, "dags", "cx", "no-team", "dag.ts");
      const result = await loadDagModule(path, gitSha("no-team-sha"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("validation-failed");
    });

    it("fail-closed: a missing required env var fails the load", async () => {
      const path = join(YAML_DIR, "dags", "cx", "needs-env", "dag.ts");
      const result = await loadDagModule(path, gitSha("env-sha"), undefined, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("dag-validation-failed");
      if (result.error.kind === "dag-validation-failed") {
        expect(result.error.reason).toContain("REQUIRED_TEST_VAR");
      }
    });

    it("passes env validation when the required var is present", async () => {
      const path = join(YAML_DIR, "dags", "cx", "needs-env", "dag.ts");
      const result = await loadDagModule(path, gitSha("env-sha-2"), undefined, { REQUIRED_TEST_VAR: "set" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.team).toBe("cx");
    });
  });
});

// ── Prompt versioning (prompts/registry.json, opt-in) ───────────────────────

describe("prompt registry validation (opt-in via prompts/registry.json)", () => {
  const REG_DIR = join(import.meta.dir, "__fixtures_module_loader_registry__");
  const dagDir = join(REG_DIR, "dags", "cx", "versioned");
  const promptsDir = join(dagDir, "prompts");
  const PROMPT_TEXT = "Skriv en åbner for {{companyName}}.";

  const setup = (registry: string | null, promptText: string | null = PROMPT_TEXT) => {
    if (existsSync(REG_DIR)) rmSync(REG_DIR, { recursive: true });
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(dagDir, "dag.ts"), VALID_DAG_MODULE);
    if (promptText !== null) writeFileSync(join(promptsDir, "opener.txt"), promptText);
    if (registry !== null) writeFileSync(join(promptsDir, "registry.json"), registry);
  };

  afterAll(() => {
    if (existsSync(REG_DIR)) rmSync(REG_DIR, { recursive: true });
  });

  const load = (sha: string) => loadDagModule(join(dagDir, "dag.ts"), gitSha(sha));

  it("absent registry.json skips validation (versioning is opt-in)", async () => {
    setup(null);
    const result = await load("reg-sha-absent");
    expect(result.ok).toBe(true);
  });

  it("valid registry (matching hash) loads", async () => {
    setup(JSON.stringify({ opener: { version: "1.0.0", hash: computePromptHash(PROMPT_TEXT) } }));
    const result = await load("reg-sha-valid");
    expect(result.ok).toBe(true);
  });

  it("hash mismatch fails the load — prompt edited without version bump", async () => {
    setup(JSON.stringify({ opener: { version: "1.0.0", hash: computePromptHash("OLD TEXT") } }));
    const result = await load("reg-sha-mismatch");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("dag-validation-failed");
    expect(result.error.kind === "dag-validation-failed" && result.error.reason).toContain("version bump");
  });

  it("prompt file present but missing from the registry fails the load", async () => {
    setup(JSON.stringify({}));
    const result = await load("reg-sha-unregistered");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind === "dag-validation-failed" && result.error.reason).toContain("not in registry.json");
  });

  it("registered prompt whose file is missing fails the load", async () => {
    setup(JSON.stringify({ opener: { version: "1.0.0", hash: "abc" } }), null);
    const result = await load("reg-sha-missing-file");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind === "dag-validation-failed" && result.error.reason).toContain("missing");
  });

  it("malformed registry JSON fails the load", async () => {
    setup("{not json");
    const result = await load("reg-sha-malformed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind === "dag-validation-failed" && result.error.reason).toContain("not valid JSON");
  });

  it("entry without version/hash shape fails the load", async () => {
    setup(JSON.stringify({ opener: {} }));
    const result = await load("reg-sha-bad-entry");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind === "dag-validation-failed" && result.error.reason).toContain("version: string");
  });
});
