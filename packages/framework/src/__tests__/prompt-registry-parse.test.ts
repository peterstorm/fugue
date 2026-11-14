// The registry file is wire data: parsed at the boundary, never cast. Every
// shape that is not `{ [name]: { version: string, hash: string } }` settles as a
// typed `prompt-not-found` instead of a TypeError or an unsound entry.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePromptRegistry } from "../prompts/registry.js";
import { computePromptHash } from "../prompts/hash.js";

describe("FilePromptRegistry — registry parse", () => {
  let dir: string;
  let registryPath: string;
  const text = "You are a helpful assistant.";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-parse-"));
    registryPath = join(dir, "registry.json");
    await writeFile(join(dir, "p.txt"), text);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  const reasonFor = async (registryJson: string, name = "p"): Promise<string> => {
    await writeFile(registryPath, registryJson);
    const result = await FilePromptRegistry({ dir, registryPath }).load(name);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "prompt-not-found") {
      throw new Error(`expected prompt-not-found, got ${JSON.stringify(result)}`);
    }
    return result.error.reason;
  };

  test.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["a number", "7"],
  ])("a registry that is %s is rejected as malformed", async (_label, json) => {
    expect(await reasonFor(json)).toContain("registry file is malformed");
  });

  test.each([
    ["a string", '"1.0"'],
    ["an array", "[]"],
    ["null", "null"],
    ["false", "false"],
    ["zero", "0"],
    ["the empty string", '""'],
    ["missing hash", '{"version":"1"}'],
    ["a non-string version", `{"version":1,"hash":"${computePromptHash(text)}"}`],
    ["a non-string hash", '{"version":"1","hash":5}'],
  ])("an entry that is %s is rejected as malformed", async (_label, entry) => {
    expect(await reasonFor(`{"p":${entry}}`)).toContain("registry entry is malformed");
  });

  test("an inherited Object.prototype key is not a registry entry", async () => {
    await writeFile(join(dir, "constructor.txt"), "t");
    expect(await reasonFor("{}", "constructor")).toBe("not in registry");
  });
});
