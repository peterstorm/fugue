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
import fc from "fast-check";
import { parse as parseYaml } from "yaml";
import { runLint } from "../../cli/lint.js";
import { runPromptsCheck } from "../../cli/prompts.js";
import { parseNewArgs, runNew } from "../../cli/new.js";
import { parseKebab, parseKebabIdent, type Kebab, type KebabIdent } from "../../cli/identifiers.js";
import { DAG_SHAPES, buildScaffold, yamlScalar } from "../../cli/new-templates.js";
import { runBin } from "./_run-bin.js";

// `NewOptions.name` / `TemplateCtx.name` are branded (`KebabIdent`) — parse
// test names through the single smart constructor, never cast.
const mustName = (raw: string): KebabIdent => {
  const parsed = parseKebabIdent(raw);
  if (parsed === null) throw new Error(`not a KebabIdent: ${raw}`);
  return parsed;
};

// `NewOptions.team` is branded (`Kebab`) — parse test teams through the single
// smart constructor, never cast (mirrors `mustName`).
const mustTeam = (raw: string): Kebab => {
  const parsed = parseKebab(raw);
  if (parsed === null) throw new Error(`not a Kebab: ${raw}`);
  return parsed;
};

// NB: this package can't import `@fuguejs/host/contract` (host depends on
// framework, not the reverse). The generated dag.ts references DagRegistration
// only as an `import type` (erased at runtime, so runLint never loads host).
// fugue.yaml's schema is validated by host's own suite; here we check the
// generated shape directly.

const tmpRoot = resolve(__dirname, ".tmp-new");
beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// The acceptance matrix: generated scaffolds lint clean.
// --------------------------------------------------------------------------

describe("generated scaffolds lint clean", () => {
  for (const shape of DAG_SHAPES) {
    for (const llm of [false, true]) {
      const label = `${shape}${llm ? " --llm" : ""}`;
      it(`${label} → dag.ts lints, fugue.yaml parses${llm ? ", prompts check green" : ""}`, async () => {
        const root = join(tmpRoot, `lint-${shape}-${llm ? "llm" : "plain"}`);
        const name = mustName(`scaffold-${shape}`);
        const result = await runNew({ team: mustTeam("demo"), name, shape, llm, review: false, force: false, root });
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
// Human-review scaffolds (--review).
//
// A human-review gate is an aspect, not a topology — `--review` adds a
// `createHumanReviewNode` to the linear scaffold (plain and --llm). Both must
// still lint clean, the same contract the shape × llm matrix proves.
// --------------------------------------------------------------------------

describe("human-review scaffolds (--review)", () => {
  for (const llm of [false, true]) {
    const label = `linear --review${llm ? " --llm" : ""}`;
    it(`${label} → dag.ts lints and carries a human-review gate`, async () => {
      const root = join(tmpRoot, `review-${llm ? "llm" : "plain"}`);
      const name = mustName("scaffold-review");
      const result = await runNew({ team: mustTeam("demo"), name, shape: "linear", llm, review: true, force: false, root });
      if (!result.ok) throw new Error(`runNew failed: ${result.problems.join("; ")}`);
      expect(result.review).toBe(true);

      const dagDir = join(root, "dags", "demo", name);
      const dagTs = await readFile(join(dagDir, "dag.ts"), "utf-8");
      expect(dagTs).toContain("createHumanReviewNode");

      const lint = await runLint(join(dagDir, "dag.ts"));
      if (!lint.ok) {
        throw new Error(`${label} dag.ts failed to lint: ${JSON.stringify(lint.errors, null, 2)}`);
      }
      expect(lint.ok).toBe(true);

      if (llm) {
        const check = await runPromptsCheck(dagDir);
        if (!check.ok) throw new Error(`prompts check failed: ${check.problems.join("; ")}`);
        expect(check.ok).toBe(true);
      }
    });
  }
});

// --------------------------------------------------------------------------
// Generated-content guarantees.
//
// The matrix above proves scaffolds *lint clean*; these pin the specific
// promises the template header makes that linting can't see — a current
// (non-dated) model id, and error returns routed through `frameworkError.*`
// rather than raw `err({ kind })` literals. A future template edit that
// reintroduced a retired id or a hand-rolled error would stay lint-clean but
// fail here.
// --------------------------------------------------------------------------

describe("generated content guarantees", () => {
  const ctx = (llm: boolean) => ({ name: mustName("x"), team: mustTeam("t"), llm });

  for (const shape of DAG_SHAPES) {
    it(`${shape} --llm pins a current, non-dated model id`, () => {
      const { dagTs } = buildScaffold(shape, ctx(true));
      const m = dagTs.match(/DEFAULT_MODEL = "([^"]+)"/);
      expect(m).not.toBeNull();
      const id = m![1]!;
      expect(id).toMatch(/^claude-/);
      // The dated `claude-…-YYYYMMDD` form is the "stale" id the authoring
      // guide warns against — current ids carry no 8-digit date suffix.
      expect(id).not.toMatch(/-\d{8}$/);
    });
  }

  it("routes errors through frameworkError.*, never raw err({ kind }) literals", () => {
    // The linear (non-llm) scaffold is the one with an error path; it must use
    // the typed factory, not a stringly-typed error object.
    const { dagTs } = buildScaffold("linear", ctx(false));
    expect(dagTs).toContain("frameworkError.");
    expect(dagTs).not.toMatch(/\berr\(\s*\{\s*kind:/);
  });
});

// --------------------------------------------------------------------------
// File layout + content.
// --------------------------------------------------------------------------

describe("runNew file layout", () => {
  it("writes dag.ts, fugue.yaml, README.md under dags/<team>/<name>", async () => {
    const root = join(tmpRoot, "layout");
    const result = await runNew({ team: mustTeam("leads"), name: mustName("my-dag"), shape: "linear", llm: false, review: false, force: false, root });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The no-`--review` case carries the literal `false` (stable-JSON contract),
      // not an absent field — the symmetric counterpart of the --review test.
      expect(result.review).toBe(false);
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
    const result = await runNew({ team: mustTeam("leads"), name: mustName("opener"), shape: "sources", llm: true, review: false, force: false, root });
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
    await runNew({ team: mustTeam("leads"), name: mustName("owned"), shape: "linear", llm: false, review: false, owner: "peter.hansen", force: false, root });
    const yaml = await readFile(join(root, "dags", "leads", "owned", "fugue.yaml"), "utf-8");
    expect(yaml).toContain("owner: peter.hansen");
  });

  it("emits a YAML-hostile owner as a quoted scalar (no injected keys)", async () => {
    // A `:`/newline in the owner must not break out of the scalar into new YAML
    // keys. The value is emitted double-quoted (JSON-escaped) by construction.
    const root = join(tmpRoot, "owner-hostile");
    const owner = "evil: true\ninjected: pwned";
    await runNew({ team: mustTeam("leads"), name: mustName("h"), shape: "linear", llm: false, review: false, owner, force: false, root });
    const yaml = await readFile(join(root, "dags", "leads", "h", "fugue.yaml"), "utf-8");
    // The whole owner sits inside one quoted scalar; the newline is escaped, so
    // `injected:` never appears as its own top-level mapping line.
    expect(yaml).toContain(`owner: ${JSON.stringify(owner)}`);
    expect(yaml).not.toMatch(/^injected: pwned$/m);
  });

  it("emits a YAML-coercible team through yamlScalar so it parses back as a STRING", async () => {
    // KEBAB admits YAML-coercible words (`true`/`null`/`0`/`1e5`) — a raw
    // `team: ${ctx.team}` would parse back as boolean true, silently changing
    // the value the host reads. The team must route through yamlScalar (which
    // quotes it), exactly like owner. Pins the round-12 fix.
    const root = join(tmpRoot, "team-coercible");
    await runNew({ team: mustTeam("true"), name: mustName("coerce"), shape: "linear", llm: false, review: false, force: false, root });
    const yaml = await readFile(join(root, "dags", "true", "coerce", "fugue.yaml"), "utf-8");
    const parsed = parseYaml(yaml) as { team: unknown };
    expect(typeof parsed.team).toBe("string");
    expect(parsed.team).toBe("true");
  });

  it("the LLM factory shape exports create<Pascal>Dag", async () => {
    const root = join(tmpRoot, "factory");
    await runNew({ team: mustTeam("leads"), name: mustName("lead-opener"), shape: "sources", llm: true, review: false, force: false, root });
    const dagTs = await readFile(join(root, "dags", "leads", "lead-opener", "dag.ts"), "utf-8");
    expect(dagTs).toContain("export const createLeadOpenerDag");
  });
});

// --------------------------------------------------------------------------
// yamlScalar round-trip property — the whole input space, not one hostile example.
// --------------------------------------------------------------------------

describe("yamlScalar", () => {
  it("round-trips ANY string through `owner: <scalar>` to the original value", () => {
    // The invariant: whatever `s` is — a `:`-injection, a newline, a leading `#`,
    // a trailing space, a YAML indicator — emitting it as a scalar and parsing
    // `owner: <scalar>` yields exactly `{ owner: s }`. This subsumes the single
    // hostile-owner example above and covers the trailing-space / leading-`#`
    // branches the example never exercised.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const parsed = parseYaml(`owner: ${yamlScalar(s)}`) as { owner: unknown };
        expect(parsed.owner).toBe(s);
      }),
    );
  });

  it("keeps conservative scalars plain (unquoted) and quotes the rest", () => {
    expect(yamlScalar("peter.hansen")).toBe("peter.hansen");
    expect(yamlScalar("a-b_c 1@2+3")).toBe("a-b_c 1@2+3");
    // Trailing space, leading `#`, embedded `:` and newline all force quoting.
    expect(yamlScalar("trailing ")).toBe(JSON.stringify("trailing "));
    expect(yamlScalar("#comment")).toBe(JSON.stringify("#comment"));
    expect(yamlScalar("evil: true")).toBe(JSON.stringify("evil: true"));
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

    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: false, root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("--force");
  });

  it("overwrites with --force", async () => {
    const root = join(tmpRoot, "guard-force");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dag.ts"), "// stale", "utf-8");

    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: true, root });
    expect(result.ok).toBe(true);
    const dagTs = await readFile(join(dir, "dag.ts"), "utf-8");
    expect(dagTs).not.toBe("// stale");
  });

  it("--force removes a leftover dag.authored.json sidecar (tool-owned, shape mode never writes one)", async () => {
    // A prior --from/compose scaffold leaves a dag.authored.json sidecar. A
    // shape-mode --force regeneration must remove it — otherwise a later
    // `fugue new --from dag.authored.json --force` silently resurrects the
    // OLD DAG, breaking the documented regen fixed point.
    const root = join(tmpRoot, "guard-force-sidecar");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dag.authored.json"), `{"fugueAuthored":1}`, "utf-8");
    // A user file outside the tool-owned set must SURVIVE (never rm -rf).
    await writeFile(join(dir, "notes.md"), "mine", "utf-8");

    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: true, root });
    expect(result.ok).toBe(true);
    const entries = await readdir(dir);
    expect(entries).not.toContain("dag.authored.json");
    expect(entries).toContain("notes.md");
    expect(entries).toContain("dag.ts");
  });

  it("--force treats generated prompts/ as tool-owned: an --llm scaffold force-regenerated without --llm drops the stale prompt artifacts", async () => {
    // regen(a) then regen(b, --force) must equal a fresh regen(b) for
    // everything the tool writes — a stale prompts/ from the --llm scaffold
    // would otherwise fail `fugue prompts check` forever.
    const root = join(tmpRoot, "guard-force-prompts");
    const first = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: true, review: false, force: false, root });
    expect(first.ok).toBe(true);
    const dir = join(root, "dags", "t", "x");
    // A user file inside prompts/ must SURVIVE the reconciliation (never rm -rf).
    await writeFile(join(dir, "prompts", "notes.md"), "mine", "utf-8");

    const second = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: true, root });
    expect(second.ok).toBe(true);
    // Tool-owned artifacts gone; the user file (and thus the dir) kept.
    const entries = await readdir(join(dir, "prompts"));
    expect(entries).toEqual(["notes.md"]);
  });

  it("--force with no leftover user files removes the now-promptless prompts/ dir entirely (fixed point)", async () => {
    const root = join(tmpRoot, "guard-force-prompts-clean");
    const first = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: true, review: false, force: false, root });
    expect(first.ok).toBe(true);
    const second = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: true, root });
    expect(second.ok).toBe(true);
    // Identical to a fresh non-llm scaffold: no prompts/ dir at all.
    await expect(readdir(join(root, "dags", "t", "x", "prompts"))).rejects.toThrow();
  });

  it("scaffolds into an empty existing dir without --force", async () => {
    const root = join(tmpRoot, "guard-empty");
    const dir = join(root, "dags", "t", "x");
    await mkdir(dir, { recursive: true });
    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: false, root });
    expect(result.ok).toBe(true);
  });

  it("folds a throwing write batch into the problems envelope, keeping the stdout-JSON contract", async () => {
    // `dag.ts` pre-exists as a DIRECTORY, so the batch's writeFile fails with
    // EISDIR mid-write. That is an environment failure — it must land in the
    // `{ ok: false, problems }` envelope (mirrors runNewFrom's write-failed
    // arm), never crash past the machine-readable contract.
    const root = join(tmpRoot, "write-envelope");
    await mkdir(join(root, "dags", "t", "x", "dag.ts"), { recursive: true });
    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: true, root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain("write failed");
      // Environment failures keep the STACK, not just the message.
      expect(result.problems[0]).toContain("at ");
    }
  });

  it("folds a non-ENOENT stat error into the problems envelope rather than treating the target as safe-to-write", async () => {
    // `dags` is a regular file, so readdir(dags/t/x) fails with ENOTDIR — we
    // *cannot verify* emptiness, so isDirNonEmpty rethrows (not report
    // safe-to-write) and runNew must fold it into the `{ ok: false, problems }`
    // envelope (the bin prints stdout JSON — an escaping throw would break the
    // machine-readable contract like any other environment failure).
    const root = join(tmpRoot, "guard-notdir");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "dags"), "i am a file, not a directory", "utf-8");

    const result = await runNew({ team: mustTeam("t"), name: mustName("x"), shape: "linear", llm: false, review: false, force: false, root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain("cannot verify");
      // Environment failures keep the STACK, not just the message.
      expect(result.problems[0]).toContain("at ");
    }
  });
});

// --------------------------------------------------------------------------
// Arg parsing.
// --------------------------------------------------------------------------

describe("parseNewArgs", () => {
  it("parses a full invocation", () => {
    const parsed = parseNewArgs(["leads/my-dag", "--shape", "sources", "--llm", "--owner", "p.h"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && "options" in parsed) {
      expect(parsed.options).toMatchObject({
        team: "leads",
        name: mustName("my-dag"),
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
    if (parsed.ok && "options" in parsed) expect(parsed.options).toMatchObject({ team: "leads", name: mustName("x"), shape: "linear" });
  });

  it("parses --review on a linear shape", () => {
    const parsed = parseNewArgs(["leads/x", "--shape", "linear", "--review"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && "options" in parsed) expect(parsed.options.review).toBe(true);
  });

  it("rejects --review with a non-linear shape", () => {
    const parsed = parseNewArgs(["leads/x", "--shape", "router", "--review"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("--review");
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

  it("reports a value-taking flag followed by another flag as missing its value", () => {
    // `--shape --llm`: the next token is itself a flag, so --shape consumed no
    // value. The parser must not silently swallow `--llm` as the shape value.
    const parsed = parseNewArgs(["leads/x", "--shape", "--llm"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join()).toContain("--shape requires a value");
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

  // The name PascalCases into emitted identifiers (`create<Pascal>Dag`,
  // `<Pascal>DagOpts`) — a digit-leading name would scaffold `export
  // interface 2fastDagOpts {`, a SyntaxError, under ok: true (template
  // scaffolds never run the gauntlet). Must be rejected at the arg boundary
  // with the rule named, in both llm and non-llm mode.
  for (const [label, args] of [
    ["without --llm", ["team/2fast", "--shape", "linear"]],
    ["with --llm", ["team/2fast", "--shape", "linear", "--llm"]],
  ] as const) {
    it(`rejects a digit-leading name ${label}, naming the JS-identifier rule`, () => {
      const parsed = parseNewArgs(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        const all = parsed.problems.join("\n");
        expect(all).toContain("name '2fast' must be kebab-case starting with a letter");
        expect(all).toContain("JS identifier");
      }
    });
  }

  it("still accepts digit-bearing names whose first segment starts with a letter", () => {
    const parsed = parseNewArgs(["leads/v2-sync", "--shape", "linear"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.mode === "shape") expect(parsed.options.name as string).toBe("v2-sync");
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

  it("a repeated value-taking flag is last-wins (pinned)", () => {
    // Duplicate flags are not rejected — the LAST occurrence binds (matches
    // getopt convention). Pinned so a future "reject duplicates" change is a
    // deliberate decision, not drift.
    const parsed = parseNewArgs(["leads/x", "--shape", "router", "--shape", "linear", "--owner", "a", "--owner", "b"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.mode === "shape") {
      expect(parsed.options.shape).toBe("linear");
      expect(parsed.options.owner).toBe("b");
    }
  });
});

describe("parseNewArgs --from", () => {
  it("parses --from with --owner/--dir/--force into the from variant (mode discriminant)", () => {
    const parsed = parseNewArgs(["--from", "x.authored.json", "--owner", "p.h", "--dir", "root", "--force"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "from") throw new Error("expected the --from variant");
    expect(parsed.from).toBe("x.authored.json");
    expect(parsed.owner).toBe("p.h");
    expect(parsed.root).toBe("root");
    expect(parsed.force).toBe(true);
  });

  it("shape mode carries mode: 'shape' (the discriminant the bin dispatches on)", () => {
    const parsed = parseNewArgs(["leads/x", "--shape", "linear"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "shape") throw new Error("expected the shape variant");
    expect(parsed.options.shape).toBe("linear");
  });

  // name/team/shape/nodes all come from the authored file — the shape-mode
  // arguments are contradictions, and each must be rejected loudly.
  const exclusions: readonly (readonly [string, readonly string[]])[] = [
    ["<team>/<name>", ["leads/x", "--from", "x.authored.json"]],
    ["--shape", ["--from", "x.authored.json", "--shape", "linear"]],
    ["--llm", ["--from", "x.authored.json", "--llm"]],
    ["--review", ["--from", "x.authored.json", "--review"]],
  ];
  for (const [what, args] of exclusions) {
    it(`rejects --from combined with ${what}`, () => {
      const parsed = parseNewArgs(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toContain("--from");
    });
  }
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

  it("dispatches --from mode: deterministic codegen from an authored file", async () => {
    const root = join(tmpRoot, "bin-from");
    await mkdir(root, { recursive: true });
    const fromPath = join(root, "cli.authored.json");
    await writeFile(
      fromPath,
      JSON.stringify({
        fugueAuthored: 1,
        name: "bin-from-dag",
        team: "demo",
        description: "bin --from dispatch",
        input: { fields: [{ name: "id", type: { kind: "string" } }] },
        nodes: [
          { id: "fetch-x", kind: "fetch", purpose: "x", output: { fields: [{ name: mustName("x"), type: { kind: "string" } }] } },
          { id: "shape-x", kind: "transform", purpose: "y", output: { fields: [{ name: "y", type: { kind: "string" } }] } },
        ],
        structure: { shape: "linear", order: ["fetch-x", "shape-x"] },
      }),
      "utf-8",
    );
    const { exitCode, stdout } = await runBin(["new", "--from", fromPath, "--dir", root]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; name?: string; files?: string[] };
    expect(json.ok).toBe(true);
    // The sidecar proves --from mode ran (shape mode never writes one).
    expect(json.name).toBe("bin-from-dag");
    expect(json.files).toContain(join("dags", "demo", "bin-from-dag", "dag.authored.json"));
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
