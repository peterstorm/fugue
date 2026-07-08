import { describe, it, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptsSync, runPromptsCheck, serializeRegistry } from "../../cli/prompts.js";
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

// ---------------------------------------------------------------------------
// Prototype-key robustness: prompt names come from the filesystem, so
// `__proto__.txt` must not vanish through the object-literal prototype setter
// and Object.prototype property names (`constructor`, `toString`) must not
// read truthy non-entries through the prototype chain.
// ---------------------------------------------------------------------------

describe("fugue prompts — prototype-key prompt names", () => {
  it("sync registers a prompt named __proto__ instead of silently dropping it", async () => {
    reset({ ["__proto__"]: "proto body", opener: "hej" });
    const result = await runPromptsSync(DIR);
    expect(result.ok).toBe(true);
    expect(result.prompts["__proto__"]).toEqual({
      version: "1.0.0",
      hash: computePromptHash("proto body"),
      status: "added",
    });
    const written = JSON.parse(readFileSync(join(promptsDir, "registry.json"), "utf-8")) as Record<
      string,
      { version: string; hash: string }
    >;
    expect(Object.hasOwn(written, "__proto__")).toBe(true);
    expect(Object.keys(written).length).toBe(2);
    // Sync over its own output converges: check is clean.
    const check = await runPromptsCheck(DIR);
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  it("sync treats Object.prototype names as NEW prompts, not phantom registry entries", async () => {
    // `constructor`/`toString` are prototype-chain hits on a plain object —
    // an unguarded `existing[name]` would classify these as "bumped" and feed
    // garbage to bumpPatch.
    reset({ constructor: "ctor body", toString: "ts body" });
    const result = await runPromptsSync(DIR);
    expect(result.ok).toBe(true);
    expect(result.prompts.constructor).toMatchObject({ version: "1.0.0", status: "added" });
    expect(result.prompts.toString).toMatchObject({ version: "1.0.0", status: "added" });
  });

  it("check reports a missing __proto__ registration instead of failing forever after sync", async () => {
    reset({ ["__proto__"]: "proto body" });
    const before = await runPromptsCheck(DIR);
    expect(before.ok).toBe(false);
    expect(before.problems.some((p) => p.includes("'__proto__'"))).toBe(true);
    await runPromptsSync(DIR);
    const after = await runPromptsCheck(DIR);
    expect(after.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Environment-failure envelopes: only ENOENT means "absent". Every other
// errno is an unreadable environment — it must surface as `{ ok: false,
// problems }`, NEVER fold to "no prompts"/"no registry" (which would let
// `sync` rewrite the registry down to {} and lose the version history).
// ---------------------------------------------------------------------------

describe("fugue prompts sync/check environment failures", () => {
  it("sync folds a non-ENOENT prompts/ readdir failure into the envelope instead of wiping the registry", async () => {
    // `prompts` is a regular FILE → readdir fails with ENOTDIR, not ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-notdir-"));
    try {
      writeFileSync(join(dir, "prompts"), "i am a file, not a directory");
      const result = await runPromptsSync(dir);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toContain("prompts/ unreadable");
      expect(result.prompts).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check folds the same non-ENOENT readdir failure into the envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-notdir-check-"));
    try {
      writeFileSync(join(dir, "prompts"), "i am a file, not a directory");
      const result = await runPromptsCheck(dir);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toContain("prompts/ unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync folds a non-ENOENT registry read failure (EISDIR) into the registry-unreadable envelope", async () => {
    // registry.json is a DIRECTORY → readFile fails with EISDIR, not ENOENT.
    // Folding that to {} would clobber nothing here, but on a transient EIO it
    // would silently reset every version to 1.0.0 — must fail instead.
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-eisdir-"));
    try {
      mkdirSync(join(dir, "prompts", "registry.json"), { recursive: true });
      writeFileSync(join(dir, "prompts", "opener.txt"), "text");
      const result = await runPromptsSync(dir);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toContain("registry.json unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync rejects a registry entry that is not { version: string, hash: string }, naming the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-badentry-"));
    try {
      mkdirSync(join(dir, "prompts"), { recursive: true });
      writeFileSync(join(dir, "prompts", "opener.txt"), "text");
      writeFileSync(join(dir, "prompts", "registry.json"), JSON.stringify({ opener: { version: 1, hash: "x" } }));
      const result = await runPromptsSync(dir);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toContain("registry.json unreadable");
      expect(result.problems[0]).toContain("'opener'");
      // The malformed registry must NOT have been overwritten.
      expect(readFileSync(join(dir, "prompts", "registry.json"), "utf-8")).toBe(
        JSON.stringify({ opener: { version: 1, hash: "x" } }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync folds a failing registry write into the envelope (stdout-JSON contract), keeping the stack", async () => {
    // Read-only prompts/ dir: readdir + readFile succeed, the registry write
    // fails with EACCES. (chmod does not bind root — skip there.)
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-rowrite-"));
    try {
      mkdirSync(join(dir, "prompts"), { recursive: true });
      writeFileSync(join(dir, "prompts", "opener.txt"), "text");
      chmodSync(join(dir, "prompts"), 0o555);
      const result = await runPromptsSync(dir);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toContain("registry write failed");
      expect(result.problems[0]).toContain("at ");
    } finally {
      chmodSync(join(dir, "prompts"), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical registry bytes: serializeRegistry is the SINGLE writer (scaffold
// batches and sync both call it) — same entries must always produce the same
// bytes, independent of insertion order and host locale.
// ---------------------------------------------------------------------------

describe("serializeRegistry", () => {
  const a = { version: "1.0.0", hash: "ha" };
  const b = { version: "1.0.0", hash: "hb" };

  it("is insertion-order independent (canonical key order)", () => {
    expect(serializeRegistry({ b, a })).toBe(serializeRegistry({ a, b }));
  });

  it("sorts keys by raw codepoint, never locale collation ('Z' before 'a')", () => {
    // localeCompare under ICU orders "a" < "Z"; codepoint order is "Z" < "a".
    const bytes = serializeRegistry({ a: a, Z: b });
    expect(bytes.indexOf('"Z"')).toBeLessThan(bytes.indexOf('"a"'));
    // Byte format: canonical 2-space JSON + trailing newline.
    expect(bytes.endsWith("}\n")).toBe(true);
  });

  it("sync writes byte-stable output: re-running over its own output changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fugue-prompts-stable-"));
    try {
      mkdirSync(join(dir, "prompts"), { recursive: true });
      writeFileSync(join(dir, "prompts", "zeta.txt"), "z");
      writeFileSync(join(dir, "prompts", "alpha.txt"), "a");
      const first = await runPromptsSync(dir);
      expect(first.ok).toBe(true);
      const bytes = readFileSync(join(dir, "prompts", "registry.json"), "utf-8");
      // Keys canonical, regardless of write/readdir order.
      expect(Object.keys(JSON.parse(bytes) as Record<string, unknown>)).toEqual(["alpha", "zeta"]);
      const second = await runPromptsSync(dir);
      expect(second.ok).toBe(true);
      expect(readFileSync(join(dir, "prompts", "registry.json"), "utf-8")).toBe(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
