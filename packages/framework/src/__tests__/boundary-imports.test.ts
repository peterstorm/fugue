/**
 * SC-006 — Boundary-import check (FR-043)
 *
 * Asserts that state-machine/**, dag-runtime/**, scheduler/**, and the
 * zero-dependency file backend (file/** + the src/file.ts subpath barrel)
 * do not import from bullmq, ioredis, or queue-bullmq/** — bare OR relative
 * specifiers (../queue-bullmq/..., ./queue-bullmq/..., side-effect imports)
 * — and that the file-backend test files (__tests__/file-*.test.ts) are in
 * scope too. Under production file/** and src/file.ts, FR-041's Node built-in
 * allow-list is exact: only canonical node:fs, node:crypto, and node:path are
 * accepted. Bare built-in spellings and all built-in subpaths are rejected.
 * Relative specifiers are matched by RESOLUTION against the importing file's
 * directory (any number of `../` hops), side-effect imports are extracted,
 * and one deterministic scope pattern gates every `file-*.test.ts`. The same
 * source audit prevents file/** implementations from bypassing the closed
 * FileOperation vocabulary with direct frameworkError.cacheError calls.
 *
 * This is a hard-fail gate: any violation causes the suite to fail.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkImports, findUncheckedBrandImports, type Violation } from "../scripts/check-imports.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import type { RunId } from "../types/ids.js";
import { D, N } from "./_id-helpers.js";

const SRC_DIR = join(__dirname, "../");

describe("SC-006 boundary imports", () => {
  it("state-machine/**, dag-runtime/**, scheduler/**, file/**, and src/file.ts have zero bullmq/ioredis/queue-bullmq imports (bare or relative)", () => {
    const { violations } = checkImports(SRC_DIR);

    if (violations.length > 0) {
      const lines = violations.map(
        (v: Violation) =>
          `  ${v.file}:${v.line}  [${v.importSpecifier}] — ${v.reason}`,
      );
      throw new Error(
        `SC-006: ${violations.length} boundary violation(s) (file, state-machine, dag-runtime, scheduler):\n${lines.join("\n")}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate-integrity pins — the SC-006 gate and the @fuguejs/framework/file
// subpath boundary must not fail silently (broken exports entry, drifting
// byte-identical checkpoint contract).
// ---------------------------------------------------------------------------

describe("SC-006 gate integrity pins", () => {
  it("the __brand*Unchecked trusted-caller gate flags non-whitelisted importers and spares the whitelist", () => {
    // Positive: a non-whitelisted module importing an unchecked cast from
    // types/ids.js is a violation, whatever the relative spelling depth.
    const positives = findUncheckedBrandImports(
      `import { __brandRunIdUnchecked, __brandDagIdUnchecked } from "../types/ids.js";\nconst x = __brandRunIdUnchecked("raw");\n`,
      "file/event-log.ts",
    );
    expect(positives).toHaveLength(1);
    expect(positives[0].importSpecifier).toContain("__brandRunIdUnchecked");
    expect(positives[0].importSpecifier).toContain("__brandDagIdUnchecked");

    const deepSpelling = findUncheckedBrandImports(
      `import { __brandNodeIdUnchecked } from "../../types/ids.js";\n`,
      "file/sub/x.ts",
    );
    expect(deepSpelling).toHaveLength(1);

    // Negative: whitelisted profiled deserialization / pinning test modules
    // are the exact sanctioned importers.
    for (const whitelisted of [
      "checkpoint/checkpointer.ts",
      "checkpoint/redis-checkpointer.ts",
      "file/checkpointer-codec.ts",
      "__tests__/file-boundary.test.ts",
      "__tests__/file-checkpointer.test.ts",
    ]) {
      expect(
        findUncheckedBrandImports(
          `import { __brandRunIdUnchecked } from "../types/ids.js";\n`,
          whitelisted,
        ),
      ).toHaveLength(0);
    }

    // Negative: the validating `__brandRunId` / `__brandNodeId` twins and
    // non-ids imports are not the gate's subject.
    expect(
      findUncheckedBrandImports(
        `import { __brandRunId } from "../types/ids.js";\nimport { ok } from "../types/result.js";\n`,
        "file/event-log.ts",
      ),
    ).toHaveLength(0);
  });

  it("@fuguejs/framework/file exports entry resolves to the barrel module", async () => {
    // A broken `./file` exports line (typo, dropped map entry, wrong target)
    // must not pass CI silently — the gate's own boundary has to be
    // importable before any phase-2 exports land in src/file.ts.
    const barrel = await import("@fuguejs/framework/file");
    expect(barrel).toBeDefined();
    expect(typeof barrel).toBe("object");
  });

  it("InMemoryCheckpointer.saveNode honors composite opts, and folds a no-opts save to the bare key (ADR-0075)", async () => {
    // Was an FR-023 pin (in-memory ignored SaveNodeOpts so F6 changed no
    // layout). F1 PR-A made every backend honor the address, because a fan
    // whose indices collide in memory is a trap that only surfaces when the
    // backend is swapped. What survives from the old pin is the half that must
    // never change: canonical folding keeps a no-opts save on the bare key.
    const cp = new InMemoryCheckpointer();
    const rid = "opts-pin-run" as RunId;
    const metaRes = await cp.setMeta(rid, {
      dagId: D("opts-pin-dag"),
      startedAt: new Date(0),
      nodeCount: 1,
    });
    expect(metaRes.ok).toBe(true);

    const state = {
      nodeId: N("n1"),
      output: { done: true },
      completedAt: new Date(0),
    };
    const saveRes = await cp.saveNode(rid, state, { index: 1, attempt: 2 });
    expect(saveRes.ok).toBe(true);

    const canonicalState = { ...state, output: { done: false } };
    const canonicalRes = await cp.saveNode(rid, canonicalState);
    expect(canonicalRes.ok).toBe(true);

    const loadRes = await cp.load(rid);
    expect(loadRes.ok).toBe(true);
    const runState = loadRes.ok ? loadRes.value : null;
    expect(runState).not.toBeNull();
    if (!runState) return;
    // The composite save landed on its own address...
    expect(runState.nodes["dag@n1@1@2"]).toEqual(state);
    // ...and did not displace the canonical entry, which stays bare.
    expect(runState.nodes["n1"]).toEqual(canonicalState);
  });
});

// ---------------------------------------------------------------------------
// Synthetic-fixture tests — negative coverage to ensure extractImports works
// ---------------------------------------------------------------------------

describe("SC-006 extractImports — synthetic fixtures (FR-043)", () => {
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

  // ---- scheduler symmetric coverage ----

  it("detects bullmq import in scheduler/", () => {
    const dir = setup({
      "scheduler/bad-bullmq.ts": `import { Queue } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toContain("scheduler/bad-bullmq.ts");
  });

  it("detects ioredis import in scheduler/", () => {
    const dir = setup({
      "scheduler/bad-ioredis.ts": `import Redis from "ioredis";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("scheduler/bad-ioredis.ts");
  });

  it("detects queue-bullmq sub-path import in scheduler/", () => {
    const dir = setup({
      "scheduler/bad-qb.ts": `import x from "queue-bullmq/adapter";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("queue-bullmq/adapter");
    expect(violations[0].file).toContain("scheduler/bad-qb.ts");
  });

  it("allows cron-parser import in scheduler/", () => {
    const dir = setup({
      "scheduler/ok.ts": `import { parseExpression } from "cron-parser";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
  });

  // ---- file backend symmetric coverage (SC-006: src/file/ + src/file.ts) ----

  it("detects bullmq import in file/", () => {
    const dir = setup({
      "file/bad-bullmq.ts": `import { Worker } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toContain("file/bad-bullmq.ts");
  });

  it("detects ioredis import in file/", () => {
    const dir = setup({
      "file/bad-ioredis.ts": `import type { Redis } from "ioredis";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("ioredis");
    expect(violations[0].file).toContain("file/bad-ioredis.ts");
  });

  it("detects queue-bullmq sub-path import in file/", () => {
    const dir = setup({
      "file/bad-qb.ts": `import x from "queue-bullmq/adapter";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("queue-bullmq/adapter");
    expect(violations[0].file).toContain("file/bad-qb.ts");
  });

  it("detects broker import in the src/file.ts barrel itself (exact-file scope)", () => {
    const dir = setup({
      "file.ts": `export * from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toBe("file.ts");
  });

  // ---- file cache-error vocabulary boundary ----

  it("rejects a synthetic direct frameworkError.cacheError bypass with actionable file/line diagnostics", () => {
    const dir = setup({
      "file/direct-cache-error.ts": [
        `import { frameworkError } from "../types/error-factories.js";`,
        `const detail = "disk full";`,
        `export const failure = frameworkError.cacheError("appendEvnet", detail);`,
      ].join("\n") + "\n",
    });

    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "file/direct-cache-error.ts",
      line: 3,
      importSpecifier: "frameworkError.cacheError",
    });
    expect(violations[0].reason).toContain("fileCacheError/fileOperationError");
    expect(violations[0].reason).toContain("FileOperation");
    expect(violations[0].reason).toContain("file/boundary-error.ts");
  });

  it("follows renamed and namespace imports instead of relying on a brittle source substring", () => {
    const dir = setup({
      "file/aliased-cache-error.ts": [
        `import { frameworkError as publicErrors } from "../types/error-factories.js";`,
        `publicErrors["cacheError"]("loadTypo", "bad");`,
      ].join("\n") + "\n",
      "file/namespace-cache-error.ts": [
        `import * as errors from "../types/error-factories.js";`,
        `errors.frameworkError.cacheError("saveNdoe", "bad");`,
      ].join("\n") + "\n",
    });

    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => `${violation.file}:${violation.line}`).sort()).toEqual([
      "file/aliased-cache-error.ts:2",
      "file/namespace-cache-error.ts:2",
    ]);
  });

  it("catches destructured local bindings of the public factory, not just member calls", () => {
    const dir = setup({
      "file/destructured-cache-error.ts": [
        `import { frameworkError } from "../types/error-factories.js";`,
        `const { cacheError } = frameworkError;`,
        `export const failure = cacheError("savNode", "bad");`,
      ].join("\n") + "\n",
      "file/member-ref-cache-error.ts": [
        `import { frameworkError } from "../types/error-factories.js";`,
        `const cacheError = frameworkError.cacheError;`,
        `export const failure = cacheError("loadTypo", "bad");`,
      ].join("\n") + "\n",
      "file/namespace-destructured-cache-error.ts": [
        `import * as errors from "../types/error-factories.js";`,
        `const { cacheError } = errors;`,
        `export const failure = cacheError("setMetat", "bad");`,
      ].join("\n") + "\n",
    });

    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(3);
    expect(violations.map((violation) => `${violation.file}:${violation.line}`).sort()).toEqual([
      "file/destructured-cache-error.ts:3",
      "file/member-ref-cache-error.ts:3",
      "file/namespace-destructured-cache-error.ts:3",
    ]);
    for (const violation of violations) {
      expect(violation.reason).toContain("FileOperation");
      expect(violation.reason).toContain("file/boundary-error.ts");
    }
  });

  it("does not flag a same-named local binding that is not derived from the imported factory", () => {
    const dir = setup({
      "file/local-not-bypass.ts": [
        `import { frameworkError } from "../types/error-factories.js";`,
        `const cacheError = (op: string) => ({ kind: "cache-error", operation: op, message: "local" });`,
        `export const failure = cacheError("load");`,
        `export const used = frameworkError;`,
      ].join("\n") + "\n",
    });

    expect(checkImports(dir).violations).toHaveLength(0);
  });

  it("permits the sole bridge definition and ignores comments, strings, unrelated objects, and tests", () => {
    const dir = setup({
      "file/boundary-error.ts": [
        `import { frameworkError as publicFrameworkError } from "../types/error-factories.js";`,
        `export const bridge = publicFrameworkError.cacheError("bridge", "definition");`,
      ].join("\n") + "\n",
      "file/not-a-bypass.ts": [
        `// frameworkError.cacheError("comment", "not executable");`,
        `const text = "frameworkError.cacheError";`,
        `const frameworkError = { cacheError: () => text };`,
        `frameworkError.cacheError();`,
      ].join("\n") + "\n",
      "__tests__/file-source-audit.test.ts": [
        `import { frameworkError } from "../types/error-factories.js";`,
        `frameworkError.cacheError("public-contract-test", "allowed in tests");`,
      ].join("\n") + "\n",
    });

    expect(checkImports(dir).violations).toHaveLength(0);
  });

  // Every allowed capability is exercised in BOTH production scopes. FR-041
  // deliberately requires canonical `node:` spelling so the allow-list is
  // independent of package-vs-core resolution behavior.
  for (const allowedBuiltin of ["node:fs", "node:crypto", "node:path"] as const) {
    it(`allows canonical FR-041 Node built-in ${allowedBuiltin} in file/ and src/file.ts`, () => {
      const dir = setup({
        "file/ok.ts": `import "${allowedBuiltin}";\n`,
        "file.ts": `import "${allowedBuiltin}";\n`,
      });
      const { violations } = checkImports(dir);
      expect(violations).toHaveLength(0);
    });
  }

  for (const [bareBuiltin, canonicalBuiltin] of [
    ["fs", "node:fs"],
    ["crypto", "node:crypto"],
    ["path", "node:path"],
  ] as const) {
    it(`rejects bare approved built-in ${bareBuiltin} in both scopes and recommends ${canonicalBuiltin}`, () => {
      const dir = setup({
        "file/bare-approved.ts": `import "${bareBuiltin}";\n`,
        "file.ts": `import "${bareBuiltin}";\n`,
      });
      const { violations } = checkImports(dir);
      expect(violations).toHaveLength(2);
      for (const violation of violations) {
        expect(violation.importSpecifier).toBe(bareBuiltin);
        expect(violation.reason).toContain("requires canonical Node built-in spelling");
        expect(violation.reason).toContain(`replace "${bareBuiltin}" with "${canonicalBuiltin}"`);
      }
      expect(violations.map((violation) => violation.file).sort()).toEqual([
        "file.ts",
        "file/bare-approved.ts",
      ]);
    });
  }

  // Representative disallowed built-ins are intentionally DISTRIBUTED across
  // file/ and src/file.ts. Each example need not run in both scopes: the
  // allowed matrix above pins both scope matchers, while this matrix broadens
  // canonical built-in coverage without duplicating identical assertions.
  for (
    const [file, disallowedBuiltin] of [
      ["file/bad-child-process.ts", "node:child_process"],
      ["file.ts", "node:os"],
      ["file/bad-worker-threads.ts", "node:worker_threads"],
      ["file.ts", "node:test"],
    ] as const
  ) {
    it(`rejects disallowed canonical FR-041 Node built-in ${disallowedBuiltin} in ${file}`, () => {
      const dir = setup({
        [file]: `import "${disallowedBuiltin}";\n`,
      });
      const { violations } = checkImports(dir);
      expect(violations).toHaveLength(1);
      expect(violations[0].importSpecifier).toBe(disallowedBuiltin);
      expect(violations[0].file).toBe(file);
      expect(violations[0].reason).toContain("FR-041 forbids Node built-in");
      expect(violations[0].reason).toContain("only the exact canonical specifiers node:fs, node:crypto, node:path are allowed");
      expect(violations[0].reason).toContain("Move that capability outside");
    });
  }

  for (
    const [file, bareBuiltin, canonicalBuiltin] of [
      ["file/bad-bare-child-process.ts", "child_process", "node:child_process"],
      ["file.ts", "os", "node:os"],
      ["file/bad-bare-assert.ts", "assert/strict", "node:assert/strict"],
    ] as const
  ) {
    it(`rejects disallowed bare Node built-in ${bareBuiltin} in ${file}`, () => {
      const dir = setup({ [file]: `import "${bareBuiltin}";\n` });
      const { violations } = checkImports(dir);
      expect(violations).toHaveLength(1);
      expect(violations[0].importSpecifier).toBe(bareBuiltin);
      expect(violations[0].file).toBe(file);
      expect(violations[0].reason).toContain(`normalized as "${canonicalBuiltin}"`);
      expect(violations[0].reason).toContain("FR-041 forbids Node built-in");
    });
  }

  for (
    const [file, builtinSubpath, canonicalBuiltin] of [
      ["file/bad-canonical-fs-promises.ts", "node:fs/promises", "node:fs/promises"],
      ["file.ts", "fs/promises", "node:fs/promises"],
      ["file/bad-canonical-path-posix.ts", "node:path/posix", "node:path/posix"],
      ["file.ts", "path/win32", "node:path/win32"],
    ] as const
  ) {
    it(`rejects built-in subpath ${builtinSubpath} in ${file}`, () => {
      const dir = setup({ [file]: `import "${builtinSubpath}";\n` });
      const { violations } = checkImports(dir);
      expect(violations).toHaveLength(1);
      expect(violations[0].importSpecifier).toBe(builtinSubpath);
      expect(violations[0].file).toBe(file);
      expect(violations[0].reason).toContain(canonicalBuiltin);
      expect(violations[0].reason).toContain("built-in subpaths are not approved");
    });
  }

  it("allows framework-internal relative imports in file/", () => {
    const dir = setup({
      "file/ok-rel.ts": `import { toJson } from "../state-machine/serialize.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
  });

  // ---- SC-006 relative-specifier bypass regression coverage ----

  it("detects file/ importing broker via ../queue-bullmq/ relative specifier", () => {
    const dir = setup({
      "file/x.ts": `import { makeAdapter } from "../queue-bullmq/adapter.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("../queue-bullmq/adapter.js");
    expect(violations[0].file).toBe("file/x.ts");
  });

  it("detects the src/file.ts barrel importing broker via ./queue-bullmq/ relative specifier", () => {
    const dir = setup({
      "file.ts": `export * from "./queue-bullmq/adapter.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("./queue-bullmq/adapter.js");
    expect(violations[0].file).toBe("file.ts");
  });

  it("detects file/ importing the bullmq barrel via ../bullmq relative specifier", () => {
    const dir = setup({
      "file/y.ts": `import { Queue } from "../bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("../bullmq");
    expect(violations[0].file).toBe("file/y.ts");
  });

  it("detects broker import in a file-backend test file under __tests__/", () => {
    const dir = setup({
      "__tests__/file-atomic.test.ts": `import { Worker } from "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toBe("__tests__/file-atomic.test.ts");
  });

  it("gates every current file-backend test through the file-*.test.ts pattern", () => {
    // These files were omitted by the prior hand-maintained enumeration. A
    // broker import in any current/future file-prefixed test must be caught.
    const dir = setup({
      "__tests__/file-freshness-index.test.ts": `import { Queue } from "bullmq";\n`,
      "__tests__/file-boundary.test.ts": `import { Redis } from "ioredis";\n`,
      "__tests__/file-boundary-error.test.ts": `import x from "queue-bullmq/adapter";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(3);
    expect(violations.map((v: Violation) => v.file).sort()).toEqual([
      "__tests__/file-boundary-error.test.ts",
      "__tests__/file-boundary.test.ts",
      "__tests__/file-freshness-index.test.ts",
    ]);
  });

  it("does not broaden the file-test pattern to helpers or similarly named files", () => {
    const dir = setup({
      "__tests__/_file-helper.ts": `import { Queue } from "bullmq";\n`,
      "__tests__/file-helper.ts": `import { Redis } from "ioredis";\n`,
      "__tests__/profile-file-example.test.ts": `import x from "queue-bullmq/adapter";\n`,
    });
    expect(checkImports(dir).violations).toHaveLength(0);
  });

  // ---- depth-N relative-resolution regression coverage ----

  it("detects a DEPTH-N relative broker import in a nested file/ module (resolved-path segment match)", () => {
    // `../../queue-bullmq/adapter.js` from `file/sub/x.ts` matches no literal
    // one-level prefix — the old matcher returned 0 violations for this. The
    // resolved path `queue-bullmq/adapter.js` contains the forbidden segment
    // `queue-bullmq`, so resolution-based matching must flag it.
    const dir = setup({
      "file/sub/x.ts": `import { makeAdapter } from "../../queue-bullmq/adapter.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("../../queue-bullmq/adapter.js");
    expect(violations[0].file).toBe("file/sub/x.ts");
  });

  it("detects a depth-N relative broker import that resolves ABOVE srcDir (escape hop)", () => {
    // `../../../../queue-bullmq/adapter.js` from `file/sub/x2.ts` normalizes
    // ABOVE srcDir (`../queue-bullmq/adapter.js`); the segment check still
    // applies — a src file reaching up into a sibling package directory is
    // exactly the broker import this gate exists for.
    const dir = setup({
      "file/sub/x2.ts": `import { makeAdapter } from "../../../../queue-bullmq/adapter.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("../../../../queue-bullmq/adapter.js");
    expect(violations[0].file).toBe("file/sub/x2.ts");
  });

  it("allows a depth-N relative import into framework core from a nested file/ module", () => {
    // Negative control: deep relative into framework core (state-machine) is
    // fine — only the forbidden module SEGMENTS trip resolution matching.
    const dir = setup({
      "file/sub/deeper/y.ts": `import { toJson } from "../../../state-machine/serialize.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
  });

  // ---- side-effect import-form regression coverage ----

  it("detects the side-effect import form (`import \"bullmq\";`) in file/", () => {
    // A side-effect import has no `from` clause, so the from-requiring
    // IMPORT_RE never saw it — `import "bullmq";` slipped through silently
    // even though it drags the broker into the import graph.
    const dir = setup({
      "file/side-effect-bullmq.ts": `import "bullmq";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("bullmq");
    expect(violations[0].file).toBe("file/side-effect-bullmq.ts");
  });

  it("detects single-quoted side-effect imports too, in the src/file.ts barrel", () => {
    const dir = setup({
      "file.ts": `import 'queue-bullmq';\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("queue-bullmq");
    expect(violations[0].file).toBe("file.ts");
  });

  it("allows a side-effect import of an approved canonical Node built-in in file/", () => {
    const dir = setup({
      "file/side-effect-ok.ts": `import "node:fs";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
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

  // ---- Wave 7 §7.2 / §7.3: dag-runtime/ must not import from executor/ ----

  it("detects dag-runtime/ importing from ../executor/", () => {
    const dir = setup({
      "dag-runtime/bad-executor-import.ts":
        `import { runDag } from "../executor/run-dag.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].importSpecifier).toBe("../executor/run-dag.js");
    expect(violations[0].file).toContain("dag-runtime/bad-executor-import.ts");
  });

  it("allows dag-runtime/ importing from ../shared/", () => {
    const dir = setup({
      "dag-runtime/ok-shared.ts":
        `import { topoSort } from "../shared/topo.js";\n`,
    });
    const { violations } = checkImports(dir);
    expect(violations).toHaveLength(0);
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
