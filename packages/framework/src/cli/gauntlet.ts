// The validation gauntlet — prove an AuthoredDag through the real machinery
// (deterministic-core convergence, Phase B3).
//
// codegen → write `dag.ts` to a staging dir → import it (running `defineDag`'s
// structural validation, which throws) → `fugue lint` (fan-in keys,
// passthrough, shape hints) → `fugue describe` (the derived `DescribedDag`,
// carried on the ok verdict so callers can present the ACTUAL generated DAG —
// `fugue compose` renders its Mermaid preview from it). Shared by `fugue
// compose` (every LLM draft is proven before the user sees it) and `fugue new
// --from` (an authored file is proven before anything is written). Depends
// only on `buildAuthoredScaffold` + `runLint` + `runDescribe`.
//
// The staging dir lives UNDER `root` (`.fugue-compose/draft-*`) so the
// generated file resolves `@fuguejs/*` through the project's node_modules.
// Always cleaned up; the `.fugue-compose` base is removed too once empty.

import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DescribedDag } from "../describe/index.js";
import type { AuthoredDag } from "./authored.js";
import { buildAuthoredScaffold } from "./authored-codegen.js";
import { runDescribe } from "./describe.js";
import { runLint } from "./lint.js";
import type { LintError, LintResult } from "./types.js";

/**
 * Gauntlet verdict — mirrors `LintResult`: errors exist only on failure. The
 * ok arm carries the `DescribedDag` derived from the generated (and now
 * discarded) staging module, so consumers can show the user what the code
 * ACTUALLY builds rather than re-deriving the topology from the AuthoredDag.
 */
export type GauntletResult =
  | {
      readonly ok: true;
      /** The generated DAG as `fugue describe` sees it (nodes/edges/waves). */
      readonly described: DescribedDag;
      readonly advisories: LintResult["advisories"];
    }
  | {
      readonly ok: false;
      readonly errors: readonly LintError[];
      readonly advisories: LintResult["advisories"];
    };

/**
 * Prove a draft through the real machinery: generate `dag.ts`, import it
 * (running `defineDag`'s structural validation), lint it, describe it.
 */
export const runGauntlet = async (dag: AuthoredDag, root: string): Promise<GauntletResult> => {
  const scaffold = buildAuthoredScaffold(dag);
  const stagingBase = join(root, ".fugue-compose");
  await mkdir(stagingBase, { recursive: true });
  const staging = await mkdtemp(join(stagingBase, "draft-"));
  try {
    const dagPath = join(staging, "dag.ts");
    await writeFile(dagPath, scaffold.dagTs, "utf-8");
    const lint = await runLint(dagPath);
    if (!lint.ok) {
      return { ok: false, errors: lint.errors, advisories: lint.advisories };
    }
    // Derive the DescribedDag from the same staged module. `runDescribe`
    // re-imports the path `runLint` just imported SUCCESSFULLY, so this hits
    // the module cache (the failed-evaluation TDZ caveat in `importDagFile`
    // only applies to modules whose first import threw — those returned above).
    const described = await runDescribe(dagPath);
    if (!described.ok) {
      return { ok: false, errors: described.errors, advisories: lint.advisories };
    }
    return { ok: true, described: described.dag, advisories: lint.advisories };
  } finally {
    // Cleanup failures must not mask the verdict: a throw inside `finally`
    // REPLACES the function's result, so a flaky rm would turn a proven draft
    // into an environment error. Leftover staging dirs are cheap — warn on
    // stderr (so the leak is diagnosable) but never throw.
    await rm(staging, { recursive: true, force: true }).catch((e: unknown) =>
      process.stderr.write(
        `warning: failed to clean up compose staging dir ${staging}: ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    // Leave no empty `.fugue-compose` behind. A concurrent draft's staging dir
    // makes this rmdir fail — that is fine, the last one out removes it.
    await rmdir(stagingBase).catch(() => {});
  }
};
