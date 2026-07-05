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
// and Mermaid previews are prose on stdout; only its final output is a JSON
// block). Unexpected errors land on stderr with a non-zero exit code. Designed
// for LLM tooling: parse `ok` and `errors[].kind` rather than scraping prose.

import { match } from "ts-pattern";
import { runLint } from "../src/cli/lint.js";
import { runDescribe } from "../src/cli/describe.js";
import { runVisualize } from "../src/cli/visualize.js";
import { runCapabilities } from "../src/cli/capabilities.js";
import { runPromptsSync, runPromptsCheck } from "../src/cli/prompts.js";
import { parseNewArgs, runNew, runNewFrom } from "../src/cli/new.js";
import { parseComposeArgs, runCompose } from "../src/cli/compose.js";
import { readlineComposeIo } from "../src/cli/compose-io.js";
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
    const result = parsed.mode === "from"
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
      // Same machine-readable envelope as every other author-facing failure —
      // tooling parses stdout JSON, so a missing key must not break the contract.
      process.stdout.write(
        `${JSON.stringify({ ok: false, problems: ["compose needs ANTHROPIC_API_KEY in the environment"] }, null, 2)}\n`,
      );
      return 1;
    }
    const [{ AnthropicLlmClient }, { default: Anthropic }, readline] = await Promise.all([
      import("../src/llm/anthropic-client.js"),
      import("@anthropic-ai/sdk"),
      import("node:readline/promises"),
    ]);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C: close the interface so any pending `ask` settles as closed (the
    // adapter routes the loop to its clean aborted outcome), and SAY SO — an
    // in-flight LLM/gauntlet round finishes before the loop can observe the
    // closed stream, so silence here reads as a hang. (AbortSignal threading
    // into the LLM client is deliberately deferred.)
    //
    // Registered on BOTH process and the readline Interface: with a real TTY,
    // readline puts stdin in raw mode and CONSUMES ^C itself, emitting
    // 'SIGINT' on the Interface — the process-level handler never fires there
    // (it covers `kill -INT` and non-TTY/piped stdin; once the first interrupt
    // closes readline, raw mode is off and later ^C reaches the process
    // handler). The first interrupt closes readline and says so; a SECOND
    // interrupt means the user is done waiting on the in-flight LLM/gauntlet
    // round — force-quit with the conventional SIGINT exit code instead of
    // silently swallowing it. This wiring is bin-only on purpose: the
    // compose-io fake cannot cover it.
    let interrupted = false;
    const interrupt = (): void => {
      if (interrupted) {
        process.stderr.write("force-quitting\n");
        process.exit(130);
      }
      interrupted = true;
      process.stderr.write("\ninterrupted — finishing the current step, then aborting…\n");
      rl.close();
    };
    process.on("SIGINT", interrupt);
    rl.on("SIGINT", interrupt);
    // Ctrl-D / piped-stdin exhaustion / close-mid-question semantics live in
    // the adapter (see compose-io.ts).
    const io = readlineComposeIo(rl);
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
      // The rl-level listener dies with rl.close(); the process-level one
      // would otherwise LEAK past compose completion — a Ctrl-C during the
      // post-completion stdout drain would print the misleading "finishing
      // the current step" message, and a second press would exit(130) and
      // truncate the final JSON payload mid-write.
      process.removeListener("SIGINT", interrupt);
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

// Top-level guard: main() is designed not to reject, but two paths are known
// to: genuine readline failures, which compose-io deliberately RETHROWS (a
// rejection from a live interface is never folded into the "closed" sentinel
// — see compose-io.ts), and compose's dynamic imports (the Anthropic SDK /
// readline modules failing to resolve). JSON.stringify of a pathological
// result payload could also throw. Surface any of these as a clean non-zero
// exit rather than an unhandled rejection with a non-deterministic exit code.
//
// Success path sets `process.exitCode` and lets the loop drain naturally —
// `process.exit(code)` can truncate a large JSON payload still buffered in a
// piped stdout. Every handle is closed by the time main() resolves (readline
// closes in compose's finally), so the drain terminates. The pathological
// catch arm keeps the hard exit: state is unknown there, and its output is a
// short stderr line, not a stdout payload.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
