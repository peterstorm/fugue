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
// Cleaned up best-effort (a failed rm warns on stderr rather than masking the
// verdict); the `.fugue-compose` base is removed too once empty.

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
      /**
       * `runDescribe`'s non-fatal schema-serialization warnings, carried
       * through (the warnings-threading contract `DescribeResult` states:
       * in-process consumers never have to scrape stderr). Always an array,
       * empty when every schema serialized cleanly.
       */
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly LintError[];
      readonly advisories: LintResult["advisories"];
    };

/**
 * The gauntlet's I/O collaborators, injectable for the branches a REAL
 * generated module makes nearly unrepresentable: `describe` failing after
 * `lint` passed, and a cleanup `rm` failing. Production always uses the
 * defaults (mirrors the injectable gauntlet seam on `runCompose` /
 * `runNewFrom`).
 */
export interface GauntletDeps {
  readonly lint?: typeof runLint;
  readonly describe?: typeof runDescribe;
  readonly cleanup?: typeof rm;
  /** Removes the empty `.fugue-compose` base — injectable for the unexpected-errno warn path. */
  readonly removeBase?: typeof rmdir;
  /**
   * Cleanup-failure warning sink; defaults to stderr. Injectable so tests
   * assert the warn paths with a plain captured-array fake instead of
   * spying on `process.stderr`.
   */
  readonly warn?: (message: string) => void;
}

/**
 * Prove a draft through the real machinery: generate `dag.ts`, import it
 * (running `defineDag`'s structural validation), lint it, describe it.
 */
export const runGauntlet = async (
  dag: AuthoredDag,
  root: string,
  deps: GauntletDeps = {},
): Promise<GauntletResult> => {
  const lintDag = deps.lint ?? runLint;
  const describeDag = deps.describe ?? runDescribe;
  const cleanup = deps.cleanup ?? rm;
  const removeBase = deps.removeBase ?? rmdir;
  const warn = deps.warn ?? ((message: string): void => void process.stderr.write(message));
  const scaffold = buildAuthoredScaffold(dag);
  const stagingBase = join(root, ".fugue-compose");
  await mkdir(stagingBase, { recursive: true });
  const staging = await mkdtemp(join(stagingBase, "draft-"));
  try {
    const dagPath = join(staging, "dag.ts");
    await writeFile(dagPath, scaffold.dagTs, "utf-8");
    const lint = await lintDag(dagPath);
    if (!lint.ok) {
      return { ok: false, errors: lint.errors, advisories: lint.advisories };
    }
    // Derive the DescribedDag from the same staged module. `runDescribe`
    // re-imports the path `runLint` just imported SUCCESSFULLY, so this hits
    // the module cache (the failed-evaluation TDZ caveat in `importDagFile`
    // only applies to modules whose first import threw — those returned above).
    const described = await describeDag(dagPath);
    if (!described.ok) {
      return { ok: false, errors: described.errors, advisories: lint.advisories };
    }
    return {
      ok: true,
      described: described.dag,
      advisories: lint.advisories,
      warnings: described.warnings,
    };
  } finally {
    // Cleanup failures must not mask the verdict: a throw inside `finally`
    // REPLACES the function's result, so a flaky rm would turn a proven draft
    // into an environment error. Leftover staging dirs are cheap — warn (so
    // the leak is diagnosable) but never throw.
    await cleanup(staging, { recursive: true, force: true }).catch((e: unknown) =>
      warn(
        `warning: failed to clean up compose staging dir ${staging}: ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    // Leave no empty `.fugue-compose` behind. A concurrent draft's staging
    // dir makes this rmdir ENOTEMPTY (the last one out removes the base) and
    // losing the removal race makes it ENOENT — both expected. Any OTHER code
    // (EACCES/EPERM/EIO, …) is a real cleanup failure: warn (symmetry with
    // the rm above), never throw.
    await removeBase(stagingBase).catch((e: unknown) => {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOTEMPTY" || code === "ENOENT") return;
      warn(
        `warning: failed to remove compose staging base ${stagingBase}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    });
  }
};
