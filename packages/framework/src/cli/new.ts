// fugue new — scaffold a compliant DAG (C3), in two modes.
//
//   fugue new <team>/<name> --shape <linear|fan-out|diamond|router|sources>
//             [--llm] [--review] [--owner <owner>] [--dir <root>] [--force]
//   fugue new --from <authored.json> [--owner <owner>] [--dir <root>] [--force]
//
// Shape mode is pure orchestration over the string builders in
// `new-templates.ts`; its side effects are writing the scaffold files and,
// under `--force`, reconciling away tool-owned artifacts a prior scaffold
// wrote (the `dag.authored.json` sidecar, stale prompt files, an emptied
// `prompts/` dir).
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
//   * dag.ts      — a lint-clean DAG. In shape mode: for the chosen shape
//                   (current model ids, `frameworkError.*`, correct fan-in
//                   schemas, `$input` edges). In `--from` mode: projected from
//                   the AuthoredDag, its header carrying the `@fugue-integrity`
//                   banner + docblock that stamps the structural hash.
//   * fugue.yaml  — team from the path
//   * README.md   — a stub with the verification loop
//   * prompts/    — `<name>.txt` + a synced `registry.json` (only with `--llm`)
//
// `--from` mode additionally writes:
//   * dag.authored.json — the AuthoredDag sidecar (the drift-guarded source of
//                         truth for REGENERATING `dag.ts`; the integrity hash
//                         itself is computed from the generated module's own
//                         projected body and never reads the sidecar)
//
// `runNew` returns a structured `NewResult` (never throws on author error —
// invalid input surfaces as `{ ok: false, problems }`); the bin prints it as
// JSON, matching `lint` / `describe` / `prompts`.

import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { match } from "ts-pattern";
import {
  DAG_SHAPES,
  buildScaffold,
  fugueYaml,
  parseShape,
  readme,
  type PromptFile,
  type Shape,
  type TemplateCtx,
} from "./new-templates.js";
import { parseAuthoredDagJson, type AuthoredDag } from "./authored.js";
import { buildAuthoredScaffold, stampGenerated } from "./authored-codegen.js";
import { runGauntlet, type GauntletResult } from "./gauntlet.js";
import { parseKebab, parseKebabIdent, type Kebab, type KebabIdent } from "./identifiers.js";
import { resolveRoot } from "./paths.js";
import { freshRegistryEntry, serializeRegistry, type RegistryEntry } from "./prompts.js";
import { formatLintError, type LintAdvisory, type NewResult } from "./types.js";

export interface NewOptions {
  // BRANDED (`Kebab`, `parseNewArgs` is the producer) — mirrors `name`'s
  // treatment so the scaffold outcome (`NewResult.team: Kebab`) carries proof
  // the KEBAB rule passed rather than a re-widened bare string.
  readonly team: Kebab;
  /**
   * DAG id / directory name. BRANDED (`KebabIdent`, `parseNewArgs` is the
   * producer): the name PascalCases into emitted JS identifiers
   * (`create<Pascal>Dag` / `<Pascal>DagOpts`), so a digit-leading name would
   * scaffold a SyntaxError — the brand rejects it at the arg boundary.
   */
  readonly name: KebabIdent;
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
// segment. (Runtime ids allow the wider /^[A-Za-z0-9_:-]{1,128}$/ — ID_PATTERN
// in types/ids.ts; we hold authors to the kebab convention every existing
// DAG follows.)

interface ParsedNewArgs {
  readonly ok: true;
  /** Discriminant: shape mode vs `--from` mode — narrow on this, not key probing. */
  readonly mode: "shape";
  readonly options: NewOptions;
}
/** `fugue new --from <authored.json>` — everything else comes from the file. */
interface ParsedNewFromArgs {
  readonly ok: true;
  /** Discriminant: shape mode vs `--from` mode — narrow on this, not key probing. */
  readonly mode: "from";
  readonly from: string;
  readonly owner?: string;
  readonly root?: string;
  readonly force: boolean;
}
interface ParseNewError {
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
  let team: Kebab | null = null;
  let name: KebabIdent | null = null;
  if (target !== undefined) {
    const parts = target.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      problems.push(`'${target}' is not a <team>/<name> path (exactly one '/', both non-empty)`);
    } else {
      const [rawTeam, rawName] = parts as [string, string];
      team = parseKebab(rawTeam);
      if (team === null) problems.push(`team '${rawTeam}' must be kebab-case (lowercase, digits, single dashes)`);
      // The name feeds codegen'd identifiers (`create<Pascal>Dag`,
      // `<Pascal>DagOpts`) — it must camelCase to a valid JS identifier, so
      // the first segment cannot start with a digit (KEBAB_IDENT, the same
      // rule the AuthoredDag schema enforces on `name` and node ids).
      name = parseKebabIdent(rawName);
      if (name === null) {
        problems.push(
          `name '${rawName}' must be kebab-case starting with a letter (lowercase, digits, single dashes — it becomes a JS identifier in the generated dag.ts, so a digit-leading name would not compile)`,
        );
      }
    }
  }

  // `parseShape` is the single Shape producer (parse, don't validate) — the
  // membership check narrows, so the success arm never needs an `as Shape`.
  let parsedShape: Shape | null = null;
  if (shape === undefined) {
    problems.push(`missing --shape (one of: ${DAG_SHAPES.join(", ")})`);
  } else {
    parsedShape = parseShape(shape);
    if (parsedShape === null) problems.push(`unknown --shape '${shape}' (one of: ${DAG_SHAPES.join(", ")})`);
  }

  // `--review` is a human-review gate (an aspect) — but the scaffold only knows
  // where to place it in a linear chain. For other shapes, gate a node by hand
  // with `withHumanReview`. Reject the combination fail-fast rather than silently
  // dropping the flag. (A missing/unknown shape is already reported above.)
  if (review && parsedShape !== null && parsedShape !== "linear") {
    problems.push(
      "--review is currently supported only with --shape linear " +
        "(gate a node in other shapes with withHumanReview)",
    );
  }

  // Every `name === null` / `team === null` / `parsedShape === null` path
  // pushed a problem above (missing target, bad path shape, non-KEBAB team,
  // non-KEBAB_IDENT name, missing/unknown shape), so the null checks are the
  // same gate — and they also narrow the brands for the success arm below.
  if (name === null || team === null || parsedShape === null || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    mode: "shape",
    options: { team, name, shape: parsedShape, llm, review, force, ...(owner !== undefined ? { owner } : {}), ...(root !== undefined ? { root } : {}) },
  };
};

/**
 * Under `--force`, the generated `prompts/` dir is TOOL-OWNED: reconcile it
 * against the scaffold's prompt set by LISTING — remove `<name>.txt` prompts
 * the new scaffold no longer writes (and, when the new scaffold has no
 * prompts at all, the tool-written `registry.json` and the then-empty dir).
 * Never `rm -rf`: anything that is not a tool-written prompt artifact
 * survives. This makes `--force` regeneration a fixed point — regen(a) then
 * regen(b, --force) leaves the same prompts/ state as a fresh regen(b), so
 * `fugue prompts check` never trips over a stale prompt from a prior shape.
 *
 * Runs AFTER the write batch (sidecar-first ordering untouched); a throw is
 * an environment failure the callers fold into their problems envelope.
 */
const reconcilePromptsDir = async (dir: string, keep: ReadonlySet<string>): Promise<void> => {
  const promptsDir = join(dir, "prompts");
  let entries: string[];
  try {
    entries = await readdir(promptsDir);
  } catch (e) {
    // No prompts/ dir → nothing stale to reconcile. Anything else (EACCES,
    // ENOTDIR, …) means we could not verify the dir's state — rethrow.
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const stale =
      (entry.endsWith(".txt") && !keep.has(entry)) ||
      (entry === "registry.json" && keep.size === 0);
    if (stale) await rm(join(promptsDir, entry));
  }
  if (keep.size === 0) {
    // A now-promptless scaffold never creates prompts/ — drop the leftover
    // dir when (and only when) it is empty; user files keep it alive.
    try {
      await rmdir(promptsDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOTEMPTY" && code !== "ENOENT") throw e;
    }
  }
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
  const cwd = process.cwd();
  const root = options.root ?? cwd;
  const absRoot = resolveRoot(root, cwd);
  const relDir = join("dags", options.team, options.name);
  const dir = join(absRoot, relDir);

  // The emptiness probe is an environment surface too (EACCES/ENOTDIR from
  // readdir) — fold a rethrow into the `{ ok: false, problems }` envelope like
  // the write batch below, so it never escapes the stdout-JSON contract.
  if (!options.force) {
    let dirNonEmpty: boolean;
    try {
      dirNonEmpty = await isDirNonEmpty(dir);
    } catch (e) {
      return {
        ok: false,
        problems: [`cannot verify ${dir} is safe to write: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`],
      };
    }
    if (dirNonEmpty) {
      return {
        ok: false,
        problems: [`${dir} already exists and is not empty — pass --force to overwrite`],
      };
    }
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
      // is always new → `freshRegistryEntry` (version 1.0.0), so the registry is
      // computed in-memory here rather than via a separate `prompts sync`
      // post-step. Computing it in-process (no post-step) means a successful run
      // never leaves a written .txt without a matching registry entry. This is
      // in-process ordering, NOT crash atomicity: a mid-batch IO failure
      // (ENOSPC/EACCES) still surfaces the real cause, but can leave a
      // partially-written scaffold dir behind. Entry shape and byte format are
      // single-sourced in `prompts.ts` (`freshRegistryEntry`/`serializeRegistry` —
      // the same functions `runPromptsSync` writes with).
      const registry = { [scaffold.prompt.name]: freshRegistryEntry(scaffold.prompt.body) };
      await write(join("prompts", "registry.json"), serializeRegistry(registry));
    }

    // `--force` owns the generated prompts/ dir — drop prompt artifacts a
    // previous scaffold wrote that this one does not, so regeneration is a
    // fixed point (`prompts check` stays green after a shape/--llm change).
    if (options.force) {
      // The `dag.authored.json` sidecar is tool-owned too (written only by the
      // --from/compose path). A shape-mode scaffold never writes one, so a
      // leftover from a prior --from scaffold would silently resurrect the OLD
      // DAG on a later `fugue new --from dag.authored.json --force` — remove
      // it for the same fixed-point reason stale prompts are reconciled.
      // `force: true` makes a missing sidecar a no-op (ENOENT ignored).
      await rm(join(dir, "dag.authored.json"), { force: true });
      await reconcilePromptsDir(dir, new Set(scaffold.prompt ? [`${scaffold.prompt.name}.txt`] : []));
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
    // Template scaffolds don't run the proving gauntlet, so there are no
    // describe-pass warnings to carry — always the empty array here.
    warnings: [],
  };
};

// ---------------------------------------------------------------------------
// `fugue new --from <authored.json>` — deterministic codegen (Phase B2)
// ---------------------------------------------------------------------------

interface NewFromOptions {
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
${dag.nodes.some((n) => n.kind === "llm") ? `bun node_modules/@fuguejs/framework/bin/fugue.ts prompts check dags/${dag.team}/${dag.name}\n` : ""}bun test
\`\`\`
`;

/**
 * Scaffold a DAG from an AuthoredDag description file. Everything structural
 * is deterministic; the authored JSON is written back alongside the code as
 * `dag.authored.json` (the sidecar a later `fugue new --from` regeneration
 * re-reads — nothing consumes it automatically today). The description is
 * proven through the validation gauntlet (codegen → defineDag import → lint →
 * describe, in a staging dir) BEFORE anything is written — same guarantee `fugue
 * compose` gives every draft; the gauntlet's non-fatal advisories and
 * `describe`-pass warnings ride along on the success result. Every failure —
 * author errors AND environment throws from the gauntlet or the scaffold
 * write — lands in the same `{ ok: false, problems }` envelope as `runNew`:
 * the bin prints the result as stdout JSON, so nothing may escape as a raw
 * throw.
 */
export const runNewFrom = async (
  options: NewFromOptions,
  // Injectable so the gauntlet-failure path is testable — generated code is
  // gauntlet-clean by construction, so a real failing draft is nearly
  // unrepresentable (mirrors `runCompose`'s seam).
  gauntlet: (dag: AuthoredDag, root: string) => Promise<GauntletResult> = runGauntlet,
): Promise<NewResult> => {
  const cwd = process.cwd();
  const fromPath = resolveRoot(options.from, cwd);

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
  const absRoot = resolveRoot(root, cwd);
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
    // formatLintError keeps the arms' diagnostic payload (import-failed stack,
    // dag-definition-error/describe-failed detail) — the terminal envelope is
    // the only surviving record, so it must not flatten data away.
    return { ok: false, problems: verdict.errors.map(formatLintError) };
  }
  // Same rule for the scaffold write (mirrors runCompose's write-failed arm):
  // a throwing write is an environment failure, not a framework bug — fold it
  // into the envelope rather than crashing past the JSON contract.
  try {
    return await writeAuthoredScaffold(parsed.dag, options, verdict.advisories, verdict.warnings);
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
 * `advisories` are the proving gauntlet's non-fatal hints, and `warnings` are
 * its `describe`-pass schema-serialization warnings — both carried onto the
 * success result (the `NewResult.advisories` / `NewResult.warnings` contract).
 * REQUIRED — not defaulted — so the type forces every caller to thread its
 * verdict's advisories AND warnings rather than silently dropping them from the
 * machine-readable outcome.
 */
export const writeAuthoredScaffold = async (
  authored: AuthoredDag,
  options: Omit<NewFromOptions, "from">,
  advisories: readonly LintAdvisory[],
  warnings: readonly string[],
): Promise<NewResult> => {
  const cwd = process.cwd();
  const root = options.root ?? cwd;
  const absRoot = resolveRoot(root, cwd);
  const relDir = join("dags", authored.team, authored.name);
  const dir = join(absRoot, relDir);

  // Unlike `runNew` (which folds a readdir EACCES/ENOTDIR here into its result),
  // a probe throw is intentionally left to propagate: every caller of
  // `writeAuthoredScaffold` (`runNewFrom`, `runCompose`) wraps it in a try/catch
  // that folds the throw into the stdout envelope, so the fold lives once at the
  // boundary rather than being duplicated at both probe sites.
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
  await write("dag.ts", stampGenerated(scaffold.dagTs));
  await write("fugue.yaml", fugueYaml(ctx, options.owner));
  await write("README.md", authoredReadme(authored));

  if (hasLlm) {
    await mkdir(join(dir, "prompts"), { recursive: true });
    const registry: Record<string, RegistryEntry> = {};
    for (const prompt of scaffold.prompts as readonly PromptFile[]) {
      await write(join("prompts", `${prompt.name}.txt`), prompt.body);
      registry[prompt.name] = freshRegistryEntry(prompt.body);
    }
    await write(join("prompts", "registry.json"), serializeRegistry(registry));
  }

  // `--force` owns the generated prompts/ dir — drop prompt artifacts a
  // previous scaffold wrote that this one does not, so regeneration is a
  // fixed point: regen(a) then regen(b, --force) ≡ fresh regen(b) for
  // everything the tool writes (a throw here propagates to the callers'
  // write-failed folds like the rest of this batch).
  if (options.force) {
    await reconcilePromptsDir(
      dir,
      new Set((scaffold.prompts as readonly PromptFile[]).map((p) => `${p.name}.txt`)),
    );
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
    warnings,
  };
};
