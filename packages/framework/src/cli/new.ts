// fugue new — scaffold a compliant DAG (C3). Pure orchestration over the
// string builders in `new-templates.ts`; the only side effect is writing files.
//
//   fugue new <team>/<name> --shape <linear|fan-out|diamond|router|sources>
//             [--llm] [--owner <owner>] [--dir <root>] [--force]
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

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  SHAPES,
  buildScaffold,
  fugueYaml,
  readme,
  type Shape,
  type TemplateCtx,
} from "./new-templates.js";
import { runPromptsSync } from "./prompts.js";
import type { NewResult } from "./types.js";

export interface NewOptions {
  readonly team: string;
  readonly name: string;
  readonly shape: Shape;
  readonly llm: boolean;
  readonly owner?: string;
  /** Root dir that contains `dags/`; defaults to `process.cwd()`. */
  readonly root?: string;
  /** Overwrite a non-empty target dir. */
  readonly force: boolean;
}

// kebab-case, lowercase, single internal dashes — a valid DAG id and directory
// segment. (Node ids allow `[A-Za-z0-9_-]+`; we hold authors to the kebab
// convention every existing DAG follows.)
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const pascalCase = (kebab: string): string =>
  kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export interface ParsedNewArgs {
  readonly ok: true;
  readonly options: NewOptions;
}
export interface ParseNewError {
  readonly ok: false;
  readonly problems: readonly string[];
}

/**
 * Parse `fugue new`'s arguments (everything after the `new` token) into
 * validated `NewOptions`. Pure — no I/O, no `process.cwd()`; the caller passes
 * the cwd via `root` later. Accumulates all problems rather than failing on the
 * first, so an LLM author sees every fix at once.
 */
export const parseNewArgs = (args: readonly string[]): ParsedNewArgs | ParseNewError => {
  const problems: string[] = [];
  let target: string | undefined;
  let shape: string | undefined;
  let owner: string | undefined;
  let root: string | undefined;
  let llm = false;
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
    switch (arg) {
      case "--shape":
        shape = takeValue("--shape");
        break;
      case "--owner":
        owner = takeValue("--owner");
        break;
      case "--dir":
        root = takeValue("--dir");
        break;
      case "--llm":
        llm = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        if (arg.startsWith("--")) {
          problems.push(`unknown flag: ${arg}`);
        } else if (target === undefined) {
          target = arg;
        } else {
          problems.push(`unexpected argument: ${arg}`);
        }
    }
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
      if (!SEGMENT.test(team)) problems.push(`team '${team}' must be kebab-case (lowercase, digits, single dashes)`);
      if (!SEGMENT.test(name)) problems.push(`name '${name}' must be kebab-case (lowercase, digits, single dashes)`);
    }
  }

  if (shape === undefined) {
    problems.push(`missing --shape (one of: ${SHAPES.join(", ")})`);
  } else if (!(SHAPES as readonly string[]).includes(shape)) {
    problems.push(`unknown --shape '${shape}' (one of: ${SHAPES.join(", ")})`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    options: { team, name, shape: shape as Shape, llm, force, ...(owner !== undefined ? { owner } : {}), ...(root !== undefined ? { root } : {}) },
  };
};

const isDirNonEmpty = async (dir: string): Promise<boolean> => {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false; // ENOENT → does not exist → not "non-empty"
  }
};

/**
 * Scaffold a DAG. Writes the files and returns the structured outcome. The only
 * failure modes are a non-empty target dir without `--force` (the author's to
 * resolve) — everything else (a malformed template) is a framework bug, not an
 * author error, so it propagates rather than being swallowed.
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
    pascal: pascalCase(options.name),
    llm: options.llm,
  };
  const scaffold = buildScaffold(options.shape, ctx);

  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    await writeFile(join(dir, rel), content, "utf-8");
    written.push(join(relDir, rel));
  };

  await write("dag.ts", scaffold.dagTs);
  await write("fugue.yaml", fugueYaml(ctx, options.owner));
  await write("README.md", readme(ctx, options.shape));

  if (scaffold.prompt) {
    await mkdir(join(dir, "prompts"), { recursive: true });
    await write(join("prompts", `${scaffold.prompt.name}.txt`), scaffold.prompt.body);
    // Generate prompts/registry.json (new prompt → 1.0.0) so `fugue prompts
    // check` is green out of the box. Only record it as written after the sync
    // succeeds — on failure the registry was not produced.
    const sync = await runPromptsSync(dir);
    if (!sync.ok) {
      return { ok: false, problems: sync.problems };
    }
    written.push(join(relDir, "prompts", "registry.json"));
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
    files: written,
    nextSteps,
  };
};
