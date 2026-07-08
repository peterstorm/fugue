// fugue lint — import a DAG file, capture any DagDefinitionError, return a
// structured result. Pure function — never prints, never exits. The bin
// entry (`bin/fugue.ts`) handles I/O.
//
// The lint check has two halves. First, the import surfaces what `defineDag`
// already validated at module-load time (topology, registration shape) as a
// machine-readable `DagDefinitionError`. Second, `analyzeDag` runs schema-
// aware structural checks `defineDag` deliberately does NOT perform: fan-in
// key mismatches are errors, pass-through/shape hints are advisories, and a
// crashed analyzer is itself an `analyzer-failed` error. A lint-green file
// therefore proves buildability AND fan-in soundness, not just importability.

import { pathToFileURL } from "node:url";
import { DagDefinitionError } from "../executor/define-dag.js";
import type { DagDef } from "../types/dag.js";
import { analyzeDag } from "./lint-checks.js";
import { resolveRoot } from "./paths.js";
import type { LintAdvisory, LintError, LintResult } from "./types.js";

/**
 * Result of importing a DAG file. Shared between `runLint` and `runDescribe`
 * so we only `await import()` the file once per CLI invocation — re-imports
 * of a module whose first evaluation threw can return a record with the
 * default binding in TDZ on Bun, which would lose the original error.
 */
export type ImportedDagFile =
  | {
      readonly ok: true;
      readonly path: string;
      /** The registration record (route/meta/inputSchema live here, untyped). */
      readonly defaultExport: Record<string, unknown>;
      /**
       * The registration's `.dag`, already checked object-shaped — the ONE
       * cast to `DagDef` lives at that check, so consumers (`runLint`,
       * `runDescribe`) never re-cast from the raw record.
       */
      readonly dag: DagDef;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly errors: readonly LintError[];
    };

/**
 * Import a DAG module file and extract its default export. Captures
 * `DagDefinitionError`, generic import errors, and shape mismatches (no
 * default export, no `.dag` field) as discriminated `LintError` values.
 */
export const importDagFile = async (path: string): Promise<ImportedDagFile> => {
  // `importDagFile` is the imperative shell (it `await import()`s the file), so
  // the `process.cwd()` env read stays here at the boundary — `resolveRoot` is
  // the pure core fed the cwd explicitly.
  const absolute = resolveRoot(path, process.cwd());
  // Note: this CLI is intended to be invoked as a subprocess (one DAG file
  // per run). When re-used within a single process across multiple files,
  // each file imports cleanly. Bun caches a module's *failed* evaluation
  // record by resolved path, so re-importing the *same* failed file in the
  // same process will surface a TDZ ReferenceError instead of the original
  // throw — but the CLI's subprocess lifecycle makes this a non-issue in
  // practice.
  const moduleUrl = pathToFileURL(absolute).href;

  let mod: unknown;
  let defaultExport: unknown;
  try {
    mod = await import(moduleUrl);
    // When a module threw during a *prior* `await import()` (e.g. DagDefinitionError
    // from `defineDag`) but the ESM record still resolves on re-import, the
    // `default` binding can be in TDZ. Property access must live inside the
    // try so the TDZ ReferenceError surfaces through the same paths.
    defaultExport = (mod as Record<string, unknown>)?.default;
  } catch (e) {
    if (e instanceof DagDefinitionError) {
      const error: LintError = {
        kind: "dag-definition-error",
        dagId: e.dagId,
        message: e.message,
        detail: e.detail,
      };
      return { ok: false, path: absolute, errors: [error] };
    }
    const error: LintError = {
      kind: "import-failed",
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    };
    return { ok: false, path: absolute, errors: [error] };
  }

  if (defaultExport === undefined || defaultExport === null) {
    return {
      ok: false,
      path: absolute,
      errors: [
        {
          kind: "no-default-export",
          message: `Module at ${absolute} has no default export. Export a DagRegistration as default.`,
        },
      ],
    };
  }

  // A DagRegistration is `{ dag: DagDef, inputSchema, ... }`. We don't deep-
  // validate the host-shape here (that's `@fuguejs/host`'s contract); we only
  // require that .dag is present and brand-shaped. If a downstream LLM tool
  // wants stricter validation, it can use `@fuguejs/host/contract` separately.
  const dagField = (defaultExport as Record<string, unknown>)?.dag;
  if (dagField === undefined || dagField === null || typeof dagField !== "object") {
    return {
      ok: false,
      path: absolute,
      errors: [
        {
          kind: "missing-dag-field",
          message: `Default export does not have a 'dag' field. Expected a DagRegistration shape: { dag: defineDag(...), inputSchema, ... }`,
        },
      ],
    };
  }

  return {
    ok: true,
    path: absolute,
    defaultExport: defaultExport as Record<string, unknown>,
    // The single checked cast: `dagField` is present and object-shaped (the
    // guard above). Deep validation is `@fuguejs/host`'s contract.
    dag: dagField as DagDef,
  };
};

/**
 * Run lint against a DAG file path. Returns a structured result describing
 * either success or the first failure encountered.
 */
export const runLint = async (path: string): Promise<LintResult> => {
  const imported = await importDagFile(path);
  if (!imported.ok) {
    return { ok: false, path: imported.path, errors: imported.errors, advisories: [] };
  }

  // `.dag` is present and object-shaped (importDagFile guaranteed it). Run the
  // structural checks the topology validator can't (schema-aware fan-in keys,
  // shape-helper advisories). Defensive: a bug in the analyzer must not crash
  // the CLI — but it must NOT silently pass lint either, or a real
  // `fan-in-key-mismatch` could hide behind a crashed analyzer. Surface the
  // failure as an `analyzer-failed` error so the result is `ok: false`.
  let errors: readonly LintError[] = [];
  let advisories: readonly LintAdvisory[] = [];
  try {
    const analysis = analyzeDag(imported.dag);
    errors = analysis.errors;
    advisories = analysis.advisories;
  } catch (e) {
    return {
      ok: false,
      path: imported.path,
      errors: [
        {
          kind: "analyzer-failed",
          message: `Structural lint analyzer threw: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      advisories: [],
    };
  }

  if (errors.length > 0) {
    return { ok: false, path: imported.path, errors, advisories };
  }
  return { ok: true, path: imported.path, advisories };
};
