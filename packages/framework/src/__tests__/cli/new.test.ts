// `fugue new` — scaffold generation.
//
// The load-bearing assertion: every (shape × llm) scaffold this command emits
// must `runLint` clean and (for --llm) pass `prompts check`. That is the whole
// point of C3 — the generated DAG is compliant by construction — so the matrix
// test below is the regression guard. The rest covers arg parsing, file layout,
// the overwrite guard, and the bin subprocess contract.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runLint } from "../../cli/lint.js";
import { runPromptsCheck } from "../../cli/prompts.js";
import { parseNewArgs, runNew } from "../../cli/new.js";
import { SHAPES } from "../../cli/new-templates.js";

// NB: this package can't import `@fuguejs/host/contract` (host depends on
// framework, not the reverse). The generated dag.ts references DagRegistration
// only as an `import type` (erased at runtime, so runLint never loads host).
// fugue.yaml's schema is validated by host's own suite; here we check the
// generated shape directly.

const tmpRoot = resolve(__dirname, ".tmp-new");
const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");

beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const runBin = async (
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", binPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

// --------------------------------------------------------------------------
// The acceptance matrix: generated scaffolds lint clean.
// --------------------------------------------------------------------------

describe("generated scaffolds lint clean", () => {
  for (const shape of SHAPES) {
    for (const llm of [false, true]) {
      const label = `${shape}${llm ? " --llm" : ""}`;
      it(`${label} → dag.ts lints, fugue.yaml parses${llm ? ", prompts check green" : ""}`, async () => {
        const root = join(tmpRoot, `lint-${shape}-${llm ? "llm" : "plain"}`);
        const name = `scaffold-${shape}`;
        const result = await runNew({ team: "demo", name, shape, llm, force: false, root });
        if (!result.ok) throw new Error(`runNew failed: ${result.problems.join("; ")}`);

        const dagDir = join(root, "dags", "demo", name);

        // 1. dag.ts lints clean (imports + topology + fan-in keys).
        const lint = await runLint(join(dagDir, "dag.ts"));
        if (!lint.ok) {
          throw new Error(`${label} dag.ts failed to lint: ${JSON.stringify(lint.errors, null, 2)}`);
        }

        // 2. fugue.yaml carries the team from the path.
        const yaml = await readFile(join(dagDir, "fugue.yaml"), "utf-8");
        expect(yaml).toContain("team: demo");

        // 3. README is present.
        expect((await readFile(join(dagDir, "README.md"), "utf-8")).length).toBeGreaterThan(0);

        // 4. prompts: only for --llm, and then registry is in sync.
        if (llm) {
          const check = await runPromptsCheck(dagDir);
          if (!check.ok) throw new Error(`prompts check failed: ${check.problems.join("; ")}`);
          expect(check.ok).toBe(true);
        } else {
          // No prompts dir for a non-LLM scaffold.
          await expect(readdir(join(dagDir, "prompts"))).rejects.toThrow();
        }
      });
    }
  }
});

// --------------------------------------------------------------------------
// File layout + content.
// --------------------------------------------------------------------------

describe("runNew file layout", () => {
  it("writes dag.ts, fugue.yaml, README.md under dags/<team>/<name>", async () => {
    const root = join(tmpRoot, "layout");
    const result = await runNew({ team: "leads", name: "my-dag", shape: "linear", llm: false, force: false, root });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dir).toBe(join(root, "dags", "leads", "my-dag"));
      expect(result.files).toEqual([
        join("dags", "leads", "my-dag", "dag.ts"),
        join("dags", "leads", "my-dag", "fugue.yaml"),
        join("dags", "leads", "my-dag", "README.md"),
      ]);
      expect(result.nextSteps.some((s) => s.includes("fugue.ts lint"))).toBe(true);
    }
  });

  it("--llm adds prompts/<name>.txt and a synced registry.json", async () => {
    const root = join(tmpRoot, "layout-llm");
    const result = await runNew({ team: "leads", name: "opener", shape: "sources", llm: true, force: false, root });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toContain(join("dags", "leads", "opener", "prompts", "opener.txt"));
      expect(result.files).toContain(join("dags", "leads", "opener", "prompts", "registry.json"));
      const registry = JSON.parse(
        await readFile(join(result.dir, "prompts", "registry.json"), "utf-8"),
      ) as Record<string, { version: string; hash: string }>;
      expect(registry.opener?.version).toBe("1.0.0");
    }
  });

  it("--owner sets the fugue.yaml owner", async () => {
    const root = join(tmpRoot, "owner");
    await runNew({ team: "leads", name: "owned", shape: "linear", llm: false, owner: "peter.hansen", force: false, root });
    const yaml = await readFile(join(root, "dags", "leads", "owned", "fugue.yaml"), "utf-8");
    expect(yaml).toContain("owner: peter.hansen");
  });

  it("emits a YAML-hostile owner as a quoted scalar (no injected keys)", async () => {
    // A `:`/newline in the owner must not break out of the scalar into new YAML
    // keys. The value is emitted double-quoted (JSON-escaped) by construction.
    const root = join(tmpRoot, "owner-hostile");
    const owner = "evil: true\ninjected: pwned";
    await runNew({ team: "leads", name: "h", shape: "linear", llm: false, owner, force: false, root });
    const yaml = await readFile(join(root, "dags", "leads", "h", "fugue.yaml"), "utf-8");
    // The whole owner sits inside one quoted scalar; the newline is escaped, so
    // `injected:` never appears as its own top-level mapping line.
    expect(yaml).toContain(`owner: ${JSON.stringify(owner)}`);
    expect(yaml).not.toMatch(/^injected: pwned$/m);
  });

  it("the LLM factory shape exports create<Pascal>Dag", async () => {
    const root = join(tmpRoot, "factory");
    await runNew({ team: "leads", name: "lead-opener", shape: "sources", llm: true, force: false, root });
    const dagTs = await readFile(join(root, "dags", "leads", "lead-opener", "dag.ts"), "utf-8");
    expect(dagTs).toContain("export const createLeadOpenerDag");
  });
});

// --------------------------------------------------------------------------
// Overwrite guard.
// --------------------------------------------------------------------------

describe("runNew overwrite guard", () => {
  it("refuses a non-empty target dir without --force", async () => {
    const root = join(tmpRoot, "guard");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "existing.txt"), "keep me", "utf-8");

    const result = await runNew({ team: "t", name: "x", shape: "linear", llm: false, force: false, root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("--force");
  });

  it("overwrites with --force", async () => {
    const root = join(tmpRoot, "guard-force");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dag.ts"), "// stale", "utf-8");

    const result = await runNew({ team: "t", name: "x", shape: "linear", llm: false, force: true, root });
    expect(result.ok).toBe(true);
    const dagTs = await readFile(join(dir, "dag.ts"), "utf-8");
    expect(dagTs).not.toBe("// stale");
  });

  it("scaffolds into an empty existing dir without --force", async () => {
    const root = join(tmpRoot, "guard-empty");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    const result = await runNew({ team: "t", name: "x", shape: "linear", llm: false, force: false, root });
    expect(result.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Arg parsing.
// --------------------------------------------------------------------------

describe("parseNewArgs", () => {
  it("parses a full invocation", () => {
    const parsed = parseNewArgs(["leads/my-dag", "--shape", "sources", "--llm", "--owner", "p.h"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options).toMatchObject({
        team: "leads",
        name: "my-dag",
        shape: "sources",
        llm: true,
        owner: "p.h",
        force: false,
      });
    }
  });

  it("accepts flags before the positional", () => {
    const parsed = parseNewArgs(["--shape", "linear", "leads/x"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options).toMatchObject({ team: "leads", name: "x", shape: "linear" });
  });

  it("reports missing shape", () => {
    const parsed = parseNewArgs(["leads/x"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("--shape");
  });

  it("reports an unknown shape", () => {
    const parsed = parseNewArgs(["leads/x", "--shape", "spaghetti"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("spaghetti");
  });

  it("rejects a non <team>/<name> path", () => {
    const parsed = parseNewArgs(["just-a-name", "--shape", "linear"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("<team>/<name>");
  });

  it("rejects a non-kebab name", () => {
    const parsed = parseNewArgs(["leads/My_Dag", "--shape", "linear"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("kebab");
  });

  it("rejects an unknown flag", () => {
    const parsed = parseNewArgs(["leads/x", "--shape", "linear", "--turbo"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("--turbo");
  });

  it("accumulates multiple problems", () => {
    const parsed = parseNewArgs([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.length).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------------------------------------
// Bin subprocess contract.
// --------------------------------------------------------------------------

describe("fugue new (subprocess)", () => {
  it("exits 0 and emits ok JSON on a valid scaffold", async () => {
    const root = join(tmpRoot, "bin-ok");
    const { exitCode, stdout } = await runBin([
      "new", "demo/cli-dag", "--shape", "fan-out", "--dir", root,
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; files?: string[] };
    expect(json.ok).toBe(true);
    expect(json.files).toContain(join("dags", "demo", "cli-dag", "dag.ts"));
  });

  it("exits 1 and emits problems JSON on bad args", async () => {
    const { exitCode, stdout } = await runBin(["new", "demo/cli-dag"]); // no --shape
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout) as { ok: boolean; problems?: string[] };
    expect(json.ok).toBe(false);
    expect(json.problems?.join()).toContain("--shape");
  });

  it("lists `new` in --help", async () => {
    const { exitCode, stdout } = await runBin(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("new <team>/<name>");
  });
});
