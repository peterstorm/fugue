import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptsSync, runPromptsCheck } from "../../cli/prompts.js";
import { computePromptHash } from "../../prompts/hash.js";

const DIR = mkdtempSync(join(tmpdir(), "fugue-prompts-cli-"));
const promptsDir = join(DIR, "prompts");

const reset = (files: Record<string, string>, registry?: object) => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(promptsDir, `${name}.txt`), text);
  }
  if (registry !== undefined) {
    writeFileSync(join(promptsDir, "registry.json"), JSON.stringify(registry));
  }
};

afterAll(() => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
});

describe("fugue prompts sync", () => {
  it("creates registry entries at 1.0.0 for new prompts", async () => {
    reset({ opener: "Hej {{name}}" });
    const result = await runPromptsSync(DIR);
    expect(result.ok).toBe(true);
    expect(result.prompts.opener).toEqual({
      version: "1.0.0",
      hash: computePromptHash("Hej {{name}}"),
      status: "added",
    });
    const written = JSON.parse(readFileSync(join(promptsDir, "registry.json"), "utf-8"));
    expect(written.opener.version).toBe("1.0.0");
  });

  it("bumps the patch version when a prompt is edited", async () => {
    reset({ opener: "v2 text" }, { opener: { version: "1.0.3", hash: computePromptHash("v1 text") } });
    const result = await runPromptsSync(DIR);
    expect(result.prompts.opener).toMatchObject({ version: "1.0.4", status: "bumped" });
  });

  it("is idempotent — unchanged prompts keep their version", async () => {
    reset({ opener: "stable" }, { opener: { version: "2.1.0", hash: computePromptHash("stable") } });
    const result = await runPromptsSync(DIR);
    expect(result.prompts.opener).toMatchObject({ version: "2.1.0", status: "unchanged" });
  });

  it("drops registry entries whose prompt file is gone", async () => {
    reset({}, { ghost: { version: "1.0.0", hash: "dead" } });
    const result = await runPromptsSync(DIR);
    expect(result.prompts.ghost).toMatchObject({ status: "removed" });
    const written = JSON.parse(readFileSync(join(promptsDir, "registry.json"), "utf-8"));
    expect(written.ghost).toBeUndefined();
  });
});

describe("fugue prompts check", () => {
  it("passes when registry matches files", async () => {
    reset({ opener: "match" }, { opener: { version: "1.0.0", hash: computePromptHash("match") } });
    const result = await runPromptsCheck(DIR);
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
  });

  it("fails on hash drift with an actionable message", async () => {
    reset({ opener: "edited!" }, { opener: { version: "1.0.0", hash: computePromptHash("original") } });
    const result = await runPromptsCheck(DIR);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("fugue prompts sync"))).toBe(true);
  });

  it("fails when prompts exist but no registry does", async () => {
    reset({ opener: "unregistered" });
    const result = await runPromptsCheck(DIR);
    expect(result.ok).toBe(false);
  });
});
