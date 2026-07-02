#!/usr/bin/env bun
//
// fugue — DAG authoring CLI.
//
// Subcommands:
//   fugue lint <path>          Import a dag.ts and report structural diagnostics
//                              as JSON. Exit 0 on success, 1 on failure.
//   fugue describe <path>      Print a structured summary of a DAG file:
//                              input/output schemas, waves, prompts, capabilities.
//   fugue visualize <path>     Render a DAG file as a Mermaid flowchart. JSON
//                              result by default; `--raw` prints the bare
//                              Mermaid diagram for piping into docs.
//   fugue capabilities         List the framework's built-in capabilities.
//   fugue prompts sync|check <dagDir>
//                              Rewrite / verify prompts/registry.json.
//   fugue new <team>/<name> --shape <shape> [--llm] [--review]
//                              Scaffold a compliant DAG directory under dags/.
//   fugue new --from <authored.json>
//                              Deterministic codegen from an AuthoredDag file.
//   fugue compose "<intent>" --team <team>
//                              Conversational authoring: the LLM edits only the
//                              AuthoredDag JSON; code is generated and proven.
//
// All output is JSON on stdout — except `visualize --raw`, which prints the
// bare Mermaid text, and `compose`, which is INTERACTIVE (prompts, summaries
// and Mermaid previews are prose on stdout; only its final outcome line is
// JSON). Unexpected errors land on stderr with a non-zero exit code. Designed
// for LLM tooling: parse `ok` and `errors[].kind` rather than scraping prose.

import { match } from "ts-pattern";
import { runLint } from "../src/cli/lint.js";
import { runDescribe } from "../src/cli/describe.js";
import { runVisualize } from "../src/cli/visualize.js";
import { runCapabilities } from "../src/cli/capabilities.js";
import { runPromptsSync, runPromptsCheck } from "../src/cli/prompts.js";
import { parseNewArgs, runNew, runNewFrom } from "../src/cli/new.js";
import { parseComposeArgs, runCompose, type ComposeAnswer, type ComposeIo } from "../src/cli/compose.js";
import { DEFAULT_MODEL } from "../src/cli/new-templates.js";

const USAGE = `Usage: fugue <command> [path]

Commands:
  lint <path>              Validate a DAG file. Prints JSON, exits 0 on success.
  describe <path>          Print a structured summary of a DAG file as JSON.
  visualize <path>         Render a DAG file as a Mermaid flowchart (JSON result;
                           --raw prints only the diagram).
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
  new --from <authored.json>
                           Deterministic codegen from an AuthoredDag description
                           (no <team>/<name>/--shape — all come from the file).
      --owner/--dir/--force  As above.
  compose "<intent>" --team <team>
                           Conversational authoring: an LLM drafts/edits ONLY the
                           AuthoredDag JSON; code is always generated and proven
                           through defineDag + lint before you see it.
      --model <id>         Model id (default: ${DEFAULT_MODEL}); needs ANTHROPIC_API_KEY.
      --owner/--dir/--force  As above.

For lint/describe/visualize the path must point to a dag.ts (or other module)
that default-exports a DagRegistration: { dag: defineDag(...), inputSchema, ... }`;

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

  // `new` takes `<team>/<name>` plus flags (or `--from <authored.json>`) —
  // handle it before the generic single-<path> requirement below.
  if (command === "new") {
    const parsed = parseNewArgs([pathArg, ...rest].filter((a): a is string => a !== undefined));
    if (!parsed.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, problems: parsed.problems }, null, 2)}\n`);
      return 1;
    }
    const result = "from" in parsed
      ? await runNewFrom({ from: parsed.from, force: parsed.force, ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}), ...(parsed.root !== undefined ? { root: parsed.root } : {}) })
      : await runNew(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  // `compose` — interactive; needs an Anthropic key. Args are parsed by the
  // pure `parseComposeArgs` (accumulated problems as JSON, like `new`); this
  // block keeps only readline/SIGINT/env-key wiring.
  if (command === "compose") {
    const parsed = parseComposeArgs([pathArg, ...rest].filter((a): a is string => a !== undefined));
    if (!parsed.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, problems: parsed.problems }, null, 2)}\n`);
      return 1;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      process.stderr.write("compose needs ANTHROPIC_API_KEY in the environment.\n");
      return 1;
    }
    const [{ AnthropicLlmClient }, { default: Anthropic }, readline] = await Promise.all([
      import("../src/llm/anthropic-client.js"),
      import("@anthropic-ai/sdk"),
      import("node:readline/promises"),
    ]);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-D / piped-stdin exhaustion closes the interface and Ctrl-C fires
    // SIGINT — either way a pending `ask` must settle rather than hang the
    // process forever. Resolving to { kind: "closed" } routes the compose
    // loop to its clean { ok: false, reason: "aborted" } outcome from ANY ask
    // site — a closed stream is a fact about the terminal, distinct from a
    // user who typed the word "abort". Registered ONCE, up front, so every
    // subsequent ask shares the same close promise.
    const closed: ComposeAnswer = { kind: "closed" };
    const closedToAbort: Promise<ComposeAnswer> = new Promise((resolveClosed) => {
      rl.once("close", () => resolveClosed(closed));
    });
    process.once("SIGINT", () => rl.close());
    const io: ComposeIo = {
      // If the interface closes mid-question, rl.question either never settles
      // or rejects (runtime-dependent) — race it against the close promise and
      // fold a rejection into { kind: "closed" } too.
      ask: (q) =>
        Promise.race([
          rl.question(`${q}\n> `).then(
            (text): ComposeAnswer => ({ kind: "answer", text }),
            (): ComposeAnswer => closed,
          ),
          closedToAbort,
        ]),
      say: (m) => process.stdout.write(`${m}\n`),
    };
    try {
      const outcome = await runCompose(
        parsed.options,
        new AnthropicLlmClient(new Anthropic({ apiKey })),
        io,
      );
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return outcome.ok ? 0 : 1;
    } finally {
      rl.close();
    }
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

  // `visualize` accepts an optional `--raw` after the path.
  const raw = rest.includes("--raw");
  const restNonFlags = rest.filter((a) => a !== "--raw");
  if (restNonFlags.length > 0 || (raw && command !== "visualize")) {
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
    .with("visualize", async () => {
      const result = await runVisualize(pathArg);
      if (raw) {
        if (result.ok) {
          process.stdout.write(`${result.diagram}\n`);
          return 0;
        }
        process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
        return 1;
      }
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
