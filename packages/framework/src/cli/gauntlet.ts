// The validation gauntlet — prove an AuthoredDag through the real machinery
// (deterministic-core convergence, Phase B3).
//
// codegen → write `dag.ts` to a staging dir → import it (running `defineDag`'s
// structural validation, which throws) → `fugue lint` (fan-in keys,
// passthrough, shape hints). Shared by `fugue compose` (every LLM draft is
// proven before the user sees it) and `fugue new --from` (an authored file is
// proven before anything is written). Depends only on `buildAuthoredScaffold`
// + `runLint`.
//
// The staging dir lives UNDER `root` (`.fugue-compose/draft-*`) so the
// generated file resolves `@fuguejs/*` through the project's node_modules.
// Always cleaned up; the `.fugue-compose` base is removed too once empty.

import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthoredDag } from "./authored.js";
import { buildAuthoredScaffold } from "./authored-codegen.js";
import { runLint } from "./lint.js";
import type { LintError, LintResult } from "./types.js";

/** Gauntlet verdict — mirrors `LintResult`: errors exist only on failure. */
export type GauntletResult =
  | {
      readonly ok: true;
      readonly advisories: LintResult["advisories"];
    }
  | {
      readonly ok: false;
      readonly errors: readonly LintError[];
      readonly advisories: LintResult["advisories"];
    };

/**
 * Prove a draft through the real machinery: generate `dag.ts`, import it
 * (running `defineDag`'s structural validation), lint it.
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
    return lint.ok
      ? { ok: true, advisories: lint.advisories }
      : { ok: false, errors: lint.errors, advisories: lint.advisories };
  } finally {
    await rm(staging, { recursive: true, force: true });
    // Leave no empty `.fugue-compose` behind. A concurrent draft's staging dir
    // makes this rmdir fail — that is fine, the last one out removes it.
    await rmdir(stagingBase).catch(() => {});
  }
};
