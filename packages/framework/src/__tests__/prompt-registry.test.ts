import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computePromptHash } from "../prompts/hash.js";
import { FilePromptRegistry } from "../prompts/registry.js";

describe("computePromptHash", () => {
  test("is deterministic", () => {
    const a = computePromptHash("hello world");
    const b = computePromptHash("hello world");
    expect(a).toBe(b);
  });

  test("returns 16-char hex string", () => {
    const h = computePromptHash("test");
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("different inputs produce different hashes", () => {
    expect(computePromptHash("a")).not.toBe(computePromptHash("b"));
  });
});

describe("FilePromptRegistry", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
    registryPath = join(dir, "registry.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  test("load resolves text + hash + version correctly", async () => {
    const text = "You are a helpful assistant.";
    const hash = computePromptHash(text);
    await writeFile(join(dir, "summarize.txt"), text);
    await writeFile(registryPath, JSON.stringify({ summarize: { version: "1.0", hash } }));

    const registry = FilePromptRegistry({ dir, registryPath });
    const result = await registry.load("summarize");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe(text);
      expect(result.value.hash).toBe(hash);
      expect(result.value.version).toBe("1.0");
    }
  });

  test("missing file returns Err(prompt-not-found)", async () => {
    await writeFile(registryPath, JSON.stringify({}));
    const registry = FilePromptRegistry({ dir, registryPath });
    const result = await registry.load("missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("prompt-not-found");
      if (result.error.kind === "prompt-not-found") {
        expect(result.error.reason).toBe("file not found");
      }
    }
  });

  test("missing registry entry returns Err(prompt-not-found)", async () => {
    await writeFile(join(dir, "orphan.txt"), "some text");
    await writeFile(registryPath, JSON.stringify({}));
    const registry = FilePromptRegistry({ dir, registryPath });
    const result = await registry.load("orphan");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("prompt-not-found");
      if (result.error.kind === "prompt-not-found") {
        expect(result.error.reason).toBe("not in registry");
      }
    }
  });

  test("hash mismatch returns Err with hash mismatch message", async () => {
    await writeFile(join(dir, "stale.txt"), "updated text");
    await writeFile(registryPath, JSON.stringify({ stale: { version: "1.0", hash: "0000000000000000" } }));
    const registry = FilePromptRegistry({ dir, registryPath });
    const result = await registry.load("stale");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("prompt-not-found");
      if (result.error.kind === "prompt-not-found") {
        expect(result.error.reason).toContain("hash mismatch");
      }
    }
  });
});
