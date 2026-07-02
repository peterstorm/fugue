// fugue new — scaffold a compliant DAG (C3), in two modes.
//
//   fugue new <team>/<name> --shape <linear|fan-out|diamond|router|sources>
//             [--llm] [--review] [--owner <owner>] [--dir <root>] [--force]
//   fugue new --from <authored.json> [--owner <owner>] [--dir <root>] [--force]
//
// Shape mode is pure orchestration over the string builders in
// `new-templates.ts`; its only side effect is writing the scaffold files.
// `--from` mode instead parses an AuthoredDag file and PROVES it through the
// validation gauntlet before writing — which stages a temporary draft under
// `<root>/.fugue-compose/` (created and removed during the check) in addition
// to the scaffold writes.
//
// `--review` adds a human-review gate (ADR-0060) — a `createHumanReviewNode` that
// pauses the run for an approve/reject decision. Currently supported only with
// `--shape linear`; for other shapes, gate a node by hand with `withHumanReview`.
//
// Generates, under `<root>/dags/<team>/<name>/`:
//   * dag.ts      — a lint-clean DAG for the chosen shape (current model ids,
//                   `frameworkError.*`, correct fan-in schemas, `$input` edges)
//   * fugue.yaml  — team from the path
//   * README.md   — a stub with the verification loop
//   * prompts/    — `<name>.txt` + a synced `registry.json` (only with `--llm`)
//
// `runNew` returns a structured `NewResult` (never throws on author error —
// invalid input surfaces as `{ ok: false, problems }`); the bin prints it as
// JSON, matching `lint` / `describe` / `prompts`.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { match } from "ts-pattern";
import {
  SHAPES,
  buildScaffold,
  fugueYaml,
  readme,
  type PromptFile,
  type Shape,
  type TemplateCtx,
} from "./new-templates.js";
import { parseAuthoredDagJson, type AuthoredDag } from "./authored.js";
import { buildAuthoredScaffold } from "./authored-codegen.js";
import { runGauntlet, type GauntletResult } from "./gauntlet.js";
import { KEBAB } from "./identifiers.js";
import { computePromptHash } from "../prompts/hash.js";
import type { LintAdvisory, NewResult } from "./types.js";

export interface NewOptions {
  readonly team: string;
  readonly name: string;
  readonly shape: Shape;
  readonly llm: boolean;
  /** Add a human-review gate (ADR-0060). Linear shape only. */
  readonly review: boolean;
  readonly owner?: string;
  /** Root dir that contains `dags/`; defaults to `process.cwd()`. */
  readonly root?: string;
  /** Overwrite a non-empty target dir. */
  readonly force: boolean;
}

// KEBAB (single-sourced in `identifiers.ts`) is a valid DAG id and directory
// segment. (Runtime ids allow the wider /^[A-Za-z0-9_:-]{1,128}$/ — ID_REGEX
// in types/ids.ts; we hold authors to the kebab convention every existing
// DAG follows.)

export interface ParsedNewArgs {
  readonly ok: true;
  /** Discriminant: shape mode vs `--from` mode — narrow on this, not key probing. */
  readonly mode: "shape";
  readonly options: NewOptions;
}
/** `fugue new --from <authored.json>` — everything else comes from the file. */
export interface ParsedNewFromArgs {
  readonly ok: true;
  /** Discriminant: shape mode vs `--from` mode — narrow on this, not key probing. */
  readonly mode: "from";
  readonly from: string;
  readonly owner?: string;
  readonly root?: string;
  readonly force: boolean;
}
export interface ParseNewError {
  readonly ok: false;
  readonly problems: readonly string[];
}

/**
 * Parse `fugue new`'s arguments (everything after the `new` token) into
 * validated `NewOptions` — or, when `--from` is present, into
 * `ParsedNewFromArgs` (name/team/shape all come from the authored file, so
 * the shape-mode arguments are rejected as contradictions). Pure — no I/O, no
 * `process.cwd()`; the caller passes the cwd via `root` later. Accumulates all
 * problems rather than failing on the first, so an LLM author sees every fix
 * at once.
 */
export const parseNewArgs = (args: readonly string[]): ParsedNewArgs | ParsedNewFromArgs | ParseNewError => {
  const problems: string[] = [];
  let target: string | undefined;
  let shape: string | undefined;
  let owner: string | undefined;
  let root: string | undefined;
  let from: string | undefined;
  let llm = false;
  let review = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const takeValue = (flag: string): string | undefined => {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        problems.push(`${flag} requires a value`);
        return undefined;
      }
      i++;
      return value;
    };
    match(arg)
      .with("--shape", () => {
        shape = takeValue("--shape");
      })
      .with("--owner", () => {
        owner = takeValue("--owner");
      })
      .with("--dir", () => {
        root = takeValue("--dir");
      })
      .with("--from", () => {
        from = takeValue("--from");
      })
      .with("--llm", () => {
        llm = true;
      })
      .with("--review", () => {
        review = true;
      })
      .with("--force", () => {
        force = true;
      })
      .otherwise((other) => {
        if (other.startsWith("--")) {
          problems.push(`unknown flag: ${other}`);
        } else if (target === undefined) {
          target = other;
        } else {
          problems.push(`unexpected argument: ${other}`);
        }
      });
  }

  // `--from` mode: name/team/shape/nodes all come from the authored file —
  // the shape-mode arguments are contradictions, not extras. Reject loudly.
  if (from !== undefined) {
    if (target !== undefined) problems.push("--from takes no <team>/<name> argument (name/team come from the authored file)");
    if (shape !== undefined) problems.push("--from and --shape are mutually exclusive (shape comes from the authored file)");
    if (llm) problems.push("--from and --llm are mutually exclusive (LLM nodes come from the authored file)");
    if (review) problems.push("--from and --review are mutually exclusive (review gates come from the authored file)");
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, mode: "from", from, force, ...(owner !== undefined ? { owner } : {}), ...(root !== undefined ? { root } : {}) };
  }

  if (target === undefined) {
    problems.push("missing <team>/<name> argument (e.g. `fugue new leads/my-dag --shape sources`)");
  }
  let team = "";
  let name = "";
  if (target !== undefined) {
    const parts = target.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      problems.push(`'${target}' is not a <team>/<name> path (exactly one '/', both non-empty)`);
    } else {
      [team, name] = parts as [string, string];
      if (!KEBAB.test(team)) problems.push(`team '${team}' must be kebab-case (lowercase, digits, single dashes)`);
      if (!KEBAB.test(name)) problems.push(`name '${name}' must be kebab-case (lowercase, digits, single dashes)`);
    }
  }

  if (shape === undefined) {
    problems.push(`missing --shape (one of: ${SHAPES.join(", ")})`);
  } else if (!(SHAPES as readonly string[]).includes(shape)) {
    problems.push(`unknown --shape '${shape}' (one of: ${SHAPES.join(", ")})`);
  }

  // `--review` is a human-review gate (an aspect) — but the scaffold only knows
  // where to place it in a linear chain. For other shapes, gate a node by hand
  // with `withHumanReview`. Reject the combination fail-fast rather than silently
  // dropping the flag. (A missing/unknown shape is already reported above.)
  if (review && shape !== undefined && (SHAPES as readonly string[]).includes(shape) && shape !== "linear") {
    problems.push(
      "--review is currently supported only with --shape linear " +
        "(gate a node in other shapes with withHumanReview)",
    );
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    mode: "shape",
    options: { team, name, shape: shape as Shape, llm, review, force, ...(owner !== undefined ? { owner } : {}), ...(root !== undefined ? { root } : {}) },
  };
};

const isDirNonEmpty = async (dir: string): Promise<boolean> => {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (e) {
    // ENOENT → does not exist → genuinely not "non-empty". Any other error
    // (EACCES, ENOTDIR, …) means we *could not verify* emptiness, so we must
    // not report the target as safe-to-write — rethrow rather than swallow.
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
    throw e;
  }
};

/**
 * Scaffold a DAG. Writes the files and returns the structured outcome. Author
 * errors (a non-empty target dir without `--force`) and environment write
 * failures (ENOSPC/EACCES/EISDIR, …) both land in `{ ok: false, problems }` —
 * the bin prints stdout JSON, so a raw throw would break the machine-readable
 * contract (mirrors `runNewFrom`'s write-failed arm). A malformed template is
 * a framework bug, not an author error, so it still propagates.
 */
export const runNew = async (options: NewOptions): Promise<NewResult> => {
  const root = options.root ?? process.cwd();
  const absRoot = isAbsolute(root) ? root : resolve(process.cwd(), root);
  const relDir = join("dags", options.team, options.name);
  const dir = join(absRoot, relDir);

  if (!options.force && (await isDirNonEmpty(dir))) {
    return {
      ok: false,
      problems: [`${dir} already exists and is not empty — pass --force to overwrite`],
    };
  }

  const ctx: TemplateCtx = {
    name: options.name,
    team: options.team,
    llm: options.llm,
    review: options.review,
  };
  const scaffold = buildScaffold(options.shape, ctx);

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    await writeFile(join(dir, rel), content, "utf-8");
    written.push(join(relDir, rel));
  };

  // The mkdir + write batch is an environment surface (ENOSPC/EACCES/EISDIR,
  // …) — fold a throw into the `{ ok: false, problems }` envelope (mirrors
  // `runNewFrom`) rather than crashing past the stdout-JSON contract, keeping
  // the stack so the environment is debuggable from the outcome.
  try {
    await mkdir(dir, { recursive: true });

    await write("dag.ts", scaffold.dagTs);
    await write("fugue.yaml", fugueYaml(ctx, options.owner));
    await write("README.md", readme(ctx, options.shape));

    if (scaffold.prompt) {
      await mkdir(join(dir, "prompts"), { recursive: true });
      await write(join("prompts", `${scaffold.prompt.name}.txt`), scaffold.prompt.body);
      // Write prompts/registry.json as part of the same scaffold write batch so
      // `fugue prompts check` is green out of the box. A freshly scaffolded prompt
      // is always new → version 1.0.0, so the registry is computed in-memory here
      // rather than via a separate `prompts sync` post-step. Computing it in-process
      // (no post-step) means a successful run never leaves a written .txt without a
      // matching registry entry. This is in-process ordering, NOT crash atomicity:
      // a mid-batch IO failure (ENOSPC/EACCES) still surfaces the real cause, but
      // can leave a partially-written scaffold dir behind. Format matches
      // `runPromptsSync` byte-for-byte (2-space JSON + trailing newline) so a later
      // `prompts sync`/`check` sees no drift.
      const registry = {
        [scaffold.prompt.name]: {
          version: "1.0.0",
          hash: computePromptHash(scaffold.prompt.body),
        },
      };
      await write(join("prompts", "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
    }
  } catch (e) {
    return {
      ok: false,
      problems: [`write failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`],
    };
  }

  const fugueBin = "node_modules/@fuguejs/framework/bin/fugue.ts";
  const nextSteps = [
    `Fill in the placeholder schemas, fetch, and transforms in ${join(relDir, "dag.ts")}`,
    `bun ${fugueBin} lint ${join(relDir, "dag.ts")}`,
    `bun ${fugueBin} describe ${join(relDir, "dag.ts")}`,
    ...(scaffold.prompt ? [`bun ${fugueBin} prompts check ${relDir}`] : []),
    "bun test",
    "Add this DAG's row to the repo README table",
  ];

  return {
    ok: true,
    dir,
    shape: options.shape,
    team: options.team,
    name: options.name,
    llm: options.llm,
    review: options.review,
    files: written,
    nextSteps,
    advisories: [],
  };
};

// ---------------------------------------------------------------------------
// `fugue new --from <authored.json>` — deterministic codegen (Phase B2)
// ---------------------------------------------------------------------------

export interface NewFromOptions {
  /** Path to the dag.authored.json file. */
  readonly from: string;
  readonly owner?: string;
  /** Root dir that contains `dags/`; defaults to `process.cwd()`. */
  readonly root?: string;
  readonly force: boolean;
}

const authoredReadme = (dag: AuthoredDag): string => `# ${dag.name}

> Generated deterministically from \`dag.authored.json\` (via \`fugue new
> --from\` or \`fugue compose\`). The STRUCTURE is authoritative in
> \`dag.authored.json\` — edit it and regenerate rather than rewiring
> \`dag.ts\` by hand. Node bodies marked "Placeholder" are yours.

**Team:** ${dag.team}
**Route:** \`/${dag.name}\`
**Shape:** ${dag.structure.shape}

## What it does

${dag.description}

${dag.nodes.map((n) => `- \`${n.id}\` (${n.kind}) — ${n.purpose}`).join("\n")}

## Verify

\`\`\`bash
bun node_modules/@fuguejs/framework/bin/fugue.ts lint      dags/${dag.team}/${dag.name}/dag.ts
bun node_modules/@fuguejs/framework/bin/fugue.ts describe  dags/${dag.team}/${dag.name}/dag.ts
bun node_modules/@fuguejs/framework/bin/fugue.ts visualize dags/${dag.team}/${dag.name}/dag.ts
bun test
\`\`\`
`;

/**
 * Scaffold a DAG from an AuthoredDag description file. Everything structural
 * is deterministic; the authored JSON is written back alongside the code as
 * `dag.authored.json` (the sidecar a later `fugue new --from` regeneration
 * re-reads — nothing consumes it automatically today). The description is
 * proven through the validation gauntlet (codegen → defineDag import → lint →
 * describe, in a staging dir) BEFORE anything is written — same guarantee `fugue
 * compose` gives every draft; the gauntlet's non-fatal advisories ride along
 * on the success result. Same failure envelope as `runNew` — author errors
 * return `{ ok: false, problems }`, framework bugs propagate.
 */
export const runNewFrom = async (
  options: NewFromOptions,
  // Injectable so the gauntlet-failure path is testable — generated code is
  // gauntlet-clean by construction, so a real failing draft is nearly
  // unrepresentable (mirrors `runCompose`'s seam).
  gauntlet: (dag: AuthoredDag, root: string) => Promise<GauntletResult> = runGauntlet,
): Promise<NewResult> => {
  const cwd = process.cwd();
  const fromPath = isAbsolute(options.from) ? options.from : resolve(cwd, options.from);

  let json: string;
  try {
    json = await readFile(fromPath, "utf-8");
  } catch (e) {
    return { ok: false, problems: [`cannot read ${fromPath}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = parseAuthoredDagJson(json);
  if (!parsed.ok) {
    return { ok: false, problems: parsed.problems.map((p) => `${fromPath}: ${p}`) };
  }

  const root = options.root ?? cwd;
  const absRoot = isAbsolute(root) ? root : resolve(cwd, root);
  // The gauntlet stages real files (mkdir → write → import → rm) — a throw
  // there is an ENVIRONMENT failure (ENOSPC, EACCES, …), not an author error.
  // It must land in the same `{ ok: false, problems }` envelope as every
  // other failure (the bin prints stdout JSON; a raw throw would break the
  // machine-readable contract) — mirrors runCompose's gauntlet-failed arm,
  // keeping the stack so the environment is debuggable from the outcome.
  let verdict: GauntletResult;
  try {
    verdict = await gauntlet(parsed.dag, absRoot);
  } catch (e) {
    return {
      ok: false,
      problems: [`gauntlet failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`],
    };
  }
  if (!verdict.ok) {
    return { ok: false, problems: verdict.errors.map((e) => `${e.kind}: ${e.message}`) };
  }
  // Same rule for the scaffold write (mirrors runCompose's write-failed arm):
  // a throwing write is an environment failure, not a framework bug — fold it
  // into the envelope rather than crashing past the JSON contract.
  try {
    return await writeAuthoredScaffold(parsed.dag, options, verdict.advisories);
  } catch (e) {
    return {
      ok: false,
      problems: [`write failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`],
    };
  }
};

/**
 * Write the scaffold for an already-validated AuthoredDag. Shared between
 * `runNewFrom` (file input) and `fugue compose` (LLM-drafted input).
 *
 * `advisories` are the proving gauntlet's non-fatal hints, carried onto the
 * success result (the `NewResult.advisories` contract). REQUIRED — not
 * defaulted — so the type forces every caller to thread its verdict's
 * advisories rather than silently dropping them from the machine-readable
 * outcome.
 */
export const writeAuthoredScaffold = async (
  authored: AuthoredDag,
  options: Omit<NewFromOptions, "from">,
  advisories: readonly LintAdvisory[],
): Promise<NewResult> => {
  const cwd = process.cwd();
  const root = options.root ?? cwd;
  const absRoot = isAbsolute(root) ? root : resolve(cwd, root);
  const relDir = join("dags", authored.team, authored.name);
  const dir = join(absRoot, relDir);

  if (!options.force && (await isDirNonEmpty(dir))) {
    return {
      ok: false,
      problems: [`${dir} already exists and is not empty — pass --force to overwrite`],
    };
  }

  const scaffold = buildAuthoredScaffold(authored);
  const hasLlm = scaffold.prompts.length > 0;

  const ctx: TemplateCtx = {
    name: authored.name,
    team: authored.team,
    llm: hasLlm,
  };

  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    await writeFile(join(dir, rel), content, "utf-8");
    written.push(join(relDir, rel));
  };

  // Partial-write semantics: this batch is in-process ordering, NOT crash
  // atomicity — a mid-batch IO failure (ENOSPC/EACCES) propagates the real
  // cause but can leave a partially-written dir behind. The sidecar
  // (dag.authored.json) is therefore written FIRST: it is the authoritative
  // description, and everything after it can be regenerated from it with
  // `fugue new --from`. Canonical 2-space JSON so diffs stay clean across
  // regenerations.
  await write("dag.authored.json", `${JSON.stringify(authored, null, 2)}\n`);
  await write("dag.ts", scaffold.dagTs);
  await write("fugue.yaml", fugueYaml(ctx, options.owner));
  await write("README.md", authoredReadme(authored));

  if (hasLlm) {
    await mkdir(join(dir, "prompts"), { recursive: true });
    const registry: Record<string, { version: string; hash: string }> = {};
    for (const prompt of scaffold.prompts as readonly PromptFile[]) {
      await write(join("prompts", `${prompt.name}.txt`), prompt.body);
      registry[prompt.name] = { version: "1.0.0", hash: computePromptHash(prompt.body) };
    }
    await write(join("prompts", "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  }

  const fugueBin = "node_modules/@fuguejs/framework/bin/fugue.ts";
  const nextSteps = [
    `Implement the "Placeholder" node bodies in ${join(relDir, "dag.ts")}`,
    `bun ${fugueBin} lint ${join(relDir, "dag.ts")}`,
    `bun ${fugueBin} visualize ${join(relDir, "dag.ts")}`,
    ...(hasLlm ? [`bun ${fugueBin} prompts check ${relDir}`] : []),
    "bun test",
  ];

  return {
    ok: true,
    dir,
    shape: authored.structure.shape,
    team: authored.team,
    name: authored.name,
    llm: hasLlm,
    review: authored.nodes.some((n) => n.kind === "human-review"),
    files: written,
    nextSteps,
    advisories,
  };
};
