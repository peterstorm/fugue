#!/usr/bin/env bun
//
// fugue — DAG authoring CLI.
//
// Subcommands:
//   fugue lint <path>      Import a dag.ts and report structural diagnostics
//                          as JSON. Exit 0 on success, 1 on failure.
//   fugue describe <path>  Print a structured summary of a DAG file:
//                          input/output schemas, waves, prompts, capabilities.
//
// All output is JSON on stdout. Unexpected errors land on stderr with a
// non-zero exit code. Designed for LLM tooling: parse `ok` and `errors[].kind`
// rather than scraping prose.

import { match } from "ts-pattern";
import { runLint } from "../src/cli/lint.js";
import { runDescribe } from "../src/cli/describe.js";

const USAGE = `Usage: fugue <command> <path>

Commands:
  lint <path>      Validate a DAG file. Prints JSON, exits 0 on success.
  describe <path>  Print a structured summary of a DAG file as JSON.

The path must point to a dag.ts (or other module) that default-exports a
DagRegistration: { dag: defineDag(...), inputSchema, ... }`;

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

process.exit(await main());
