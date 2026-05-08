/**
 * SC-005 — Boundary-import check (FR-082)
 *
 * Asserts that state-machine/** and dag-runtime/** do not import
 * from bullmq, ioredis, or queue-bullmq/**.
 *
 * This is a hard-fail gate: any violation causes the suite to fail.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkImports, type Violation } from "../../scripts/check-imports.js";

const SRC_DIR = join(import.meta.dir, "../");

describe("FR-082 boundary imports", () => {
  it("state-machine/** and dag-runtime/** have zero bullmq/ioredis/queue-bullmq imports", () => {
    const { violations } = checkImports(SRC_DIR);

    if (violations.length > 0) {
      const lines = violations.map(
        (v: Violation) => `  ${v.file}:${v.line}  imports "${v.importSpecifier}"`,
      );
      throw new Error(
        `SC-005: ${violations.length} boundary violation(s):\n${lines.join("\n")}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic-fixture tests — negative coverage to ensure extractImports works
// ---------------------------------------------------------------------------

describe("FR-082 extractImports — synthetic fixtures", () => {
  let tmpDir: string;

  function setup(files: Record<string, string>): string {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-check-"));
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(tmpDir, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true });
  });

  it("detects plain import in state-machine/", () => {
    const dir = setup({ "state-machine/bad.ts": `import x from "ioredis";\n` });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("state-machine/bad.ts");
  });

  it("detects import type in state-machine/", () => {
    const dir = setup({
      "state-machine/bad2.ts": `import type { Redis } from "ioredis";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("state-machine/bad2.ts");
  });

  it("detects dynamic import() in state-machine/", () => {
    const dir = setup({
      "state-machine/bad3.ts": `const mod = await import("ioredis");\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("state-machine/bad3.ts");
  });

  it("detects export { ... } from in state-machine/", () => {
    const dir = setup({
      "state-machine/bad4.ts": `export { Worker } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toContain("state-machine/bad4.ts");
  });

  it("detects export type { ... } from in state-machine/", () => {
    const dir = setup({
      "state-machine/bad4b.ts": `export type { Job } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
  });

  it("detects export * from in state-machine/", () => {
    const dir = setup({
      "state-machine/bad4c.ts": `export * from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
  });

  it("detects require() call in state-machine/", () => {
    const dir = setup({
      "state-machine/bad5.ts": `const x = require("ioredis");\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("state-machine/bad5.ts");
  });

  it("detects queue-bullmq sub-path import in dag-runtime/", () => {
    const dir = setup({
      "dag-runtime/bad6.ts": `import something from "queue-bullmq/whatever";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("queue-bullmq/whatever");
    expect(violations[0].file).toContain("dag-runtime/bad6.ts");
  });

  it("allows bullmq and ioredis inside queue-bullmq/", () => {
    const dir = setup({
      "queue-bullmq/ok.ts": [
        `import { Queue } from "bullmq";`,
        `import { Redis } from "ioredis";`,
      ].join("\n") + "\n",
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
  });

  it("allows sub-path imports inside queue-bullmq/", () => {
    const dir = setup({
      "queue-bullmq-adapter/ok.ts": `import something from "bullmq";\n`,
    });
    // queue-bullmq-adapter does NOT match the rule (rule uses startsWith("state-machine/") etc.)
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
  });

  // ---- dag-runtime symmetric coverage ----

  it("detects bullmq direct import in dag-runtime/", () => {
    const dir = setup({
      "dag-runtime/bad-bullmq.ts": `import { Worker } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toContain("dag-runtime/bad-bullmq.ts");
  });

  it("detects ioredis direct import in dag-runtime/", () => {
    const dir = setup({
      "dag-runtime/bad-ioredis.ts": `import type { Redis } from "ioredis";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("dag-runtime/bad-ioredis.ts");
  });

  // ---- exact-specifier (=== mod) arm coverage ----

  it("detects exact queue-bullmq import (no trailing slash) in state-machine/", () => {
    const dir = setup({
      "state-machine/bad-exact.ts": `import x from "queue-bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("queue-bullmq");
    expect(violations[0].file).toContain("state-machine/bad-exact.ts");
  });

  // ---- multi-violation test ----

  it("returns two violations for a file with two forbidden imports", () => {
    const dir = setup({
      "state-machine/bad-multi.ts": [
        `import { Queue } from "bullmq";`,
        `import type { Redis } from "ioredis";`,
      ].join("\n") + "\n",
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(2);
    const specifiers = violations.map((v: Violation) => v.importSpecifier).sort();
    expect(specifiers).toEqual(["bullmq", "ioredis"]);
  });
});
