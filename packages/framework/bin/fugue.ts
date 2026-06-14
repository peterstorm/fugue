#!/usr/bin/env bun
//
// fugue — DAG authoring CLI.
//
// Subcommands:
//   fugue lint <path>      Import a dag.ts and report structural diagnostics
//                          as JSON. Exit 0 on success, 1 on failure.
//   fugue describe <path>  Print a structured summary of a DAG file:
//                          input/output schemas, waves, prompts, capabilities.
//   fugue new <team>/<name> --shape <shape> [--llm] [--review]
//                          Scaffold a compliant DAG directory under dags/.
//
// All output is JSON on stdout. Unexpected errors land on stderr with a
// non-zero exit code. Designed for LLM tooling: parse `ok` and `errors[].kind`
// rather than scraping prose.

import { match } from "ts-pattern";
import { runLint } from "../src/cli/lint.js";
import { runDescribe } from "../src/cli/describe.js";
import { runCapabilities } from "../src/cli/capabilities.js";
import { runPromptsSync, runPromptsCheck } from "../src/cli/prompts.js";
import { parseNewArgs, runNew } from "../src/cli/new.js";

const USAGE = `Usage: fugue <command> [path]

Commands:
  lint <path>              Validate a DAG file. Prints JSON, exits 0 on success.
  describe <path>          Print a structured summary of a DAG file as JSON.
  capabilities             List the framework's built-in capabilities as JSON
                           (takes no path).
  prompts sync <dagDir>    Rewrite prompts/registry.json from the prompt files
                           (new prompt → 1.0.0, edited prompt → patch bump).
  prompts check <dagDir>   Verify prompts/registry.json matches the prompt
                           files. Exits 1 on drift — use in CI.
  new <team>/<name>        Scaffold a compliant DAG directory under dags/.
      --shape <shape>      Required: linear | fan-out | diamond | router | sources
      --llm                Add an LLM node + prompts/ + synced registry.json
      --review             Add a human-review gate (ADR-0060); --shape linear only
      --owner <owner>      Set fugue.yaml owner (optional)
      --dir <root>         Root that contains dags/ (defaults to cwd)
      --force              Overwrite a non-empty target directory

For lint/describe the path must point to a dag.ts (or other module) that
default-exports a DagRegistration: { dag: defineDag(...), inputSchema, ... }`;

const printUsage = (stream: NodeJS.WriteStream): void => {
  stream.write(`${USAGE}\n`);
};

const dieUsage = (message: string): never => {
  process.stderr.write(`${message}\n\n`);
  printUsage(process.stderr);
  process.exit(2);
};

const main = async (): Promise<number> => {
  const [, , command, pathArg, ...rest] = process.argv;

  if (!command) {
    printUsage(process.stderr);
    return 2;
  }

  if (command === "--help" || command === "-h") {
    printUsage(process.stdout);
    return 0;
  }

  // `prompts` takes a subcommand + dag directory — handle before the generic
  // single-<path> requirement below.
  if (command === "prompts") {
    const [sub, dagDir] = [pathArg, ...rest];
    if (sub !== "sync" && sub !== "check") {
      dieUsage("`prompts` requires a subcommand: sync | check");
    }
    if (!dagDir || rest.length > 1) {
      dieUsage("`prompts` requires exactly one <dagDir> argument.");
    }
    const result = sub === "sync" ? await runPromptsSync(dagDir) : await runPromptsCheck(dagDir);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  // `new` takes `<team>/<name>` plus flags — handle it before the generic
  // single-<path> requirement below.
  if (command === "new") {
    const parsed = parseNewArgs([pathArg, ...rest].filter((a): a is string => a !== undefined));
    if (!parsed.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, problems: parsed.problems }, null, 2)}\n`);
      return 1;
    }
    const result = await runNew(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  // `capabilities` is the one command that takes no path — it emits static
  // framework data. Handle it before the <path> requirement below.
  if (command === "capabilities") {
    if (pathArg !== undefined) {
      dieUsage("`capabilities` takes no arguments.");
    }
    process.stdout.write(`${JSON.stringify(runCapabilities(), null, 2)}\n`);
    return 0;
  }

  if (!pathArg) {
    dieUsage("Missing required <path> argument.");
  }

  if (rest.length > 0) {
    dieUsage(`Unexpected extra arguments: ${rest.join(" ")}`);
  }

  return match(command)
    .with("lint", async () => {
      const result = await runLint(pathArg);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    })
    .with("describe", async () => {
      const result = await runDescribe(pathArg);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    })
    .otherwise(() => {
      dieUsage(`Unknown command: ${command}`);
    });
};

// Top-level guard: main() is designed not to reject, but JSON.stringify of a
// pathological result payload could throw. Surface it as a clean non-zero exit
// rather than an unhandled rejection with a non-deterministic exit code.
main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
