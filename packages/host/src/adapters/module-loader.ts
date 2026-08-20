/**
 * Module Loader — Dynamic import of DAG modules with validation.
 *
 * Discovers DAG modules by glob pattern, imports them with cache-busting,
 * and validates each default export against DagRegistrationSchema.
 * All failures are captured as Result.err — loader never throws.
 *
 * @satisfies FR-004 — Validate each module against DagRegistration schema; invalid DAGs MUST NOT be registered
 * @satisfies NFR-010 — A failing DAG import MUST NOT affect other already-registered DAGs
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, computePromptHash, probeErrorCode } from "@fuguejs/framework";
import type { Result, DagId, GitSha } from "@fuguejs/framework";
import { tryDagId, dagId } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import { validateDagRegistration, applyFugueYaml, missingEnvVars } from "../domain/dag-registration.js";
import { parseFugueYaml } from "../domain/config.js";
import type { FugueYaml } from "../domain/config.js";
import type { LoadResult, LoadError, BulkLoadResult, ModuleLoaderPort } from "../ports.js";

/** Bun's native YAML parser (not yet in @types/bun) — typed minimally here. */
const BunYAML = (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML;

// ── fugue.yaml (per-DAG deployment config) ─────────────────────────────────

/**
 * Read and validate a sibling `fugue.yaml` from the DAG's directory.
 *
 * - Missing file → `ok(null)` — fugue.yaml is optional.
 * - Present but malformed/schema-invalid → `err` — the caller treats it as an
 *   isolated load failure (the DAG is skipped, others are unaffected; NFR-010),
 *   because silently ignoring deployment config would mask operator mistakes.
 */
const loadFugueYaml = async (modulePath: string): Promise<Result<FugueYaml | null, HostError>> => {
  const yamlPath = join(dirname(modulePath), "fugue.yaml");
  let text: string;
  try {
    text = await readFile(yamlPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return ok(null);
    return err({ kind: "config-invalid", message: `Cannot read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}` });
  }
  // Guard the native API at first use: if Bun.YAML is unavailable on this runtime, report
  // THAT — not a misleading "malformed fugue.yaml" that blames the operator's file.
  if (typeof BunYAML?.parse !== "function") {
    return err({ kind: "config-invalid", message: `Cannot parse ${yamlPath}: Bun.YAML API unavailable in this runtime` });
  }
  let parsed: unknown;
  try {
    parsed = BunYAML.parse(text);
  } catch (e) {
    return err({ kind: "config-invalid", message: `Malformed fugue.yaml at ${yamlPath}: ${e instanceof Error ? e.message : String(e)}` });
  }
  return parseFugueYaml(parsed, yamlPath);
};

// (applyFugueYaml + missingEnvVars are pure domain logic — see domain/dag-registration.ts.)


// ── Implementation ─────────────────────────────────────────────────────────

/** Prompt diagnostics are secondary to the loader's Result/no-throw contract. */
const reportPromptError = (
  handler: ((path: string, error: unknown) => void) | undefined,
  path: string,
  error: unknown,
): void => {
  try {
    handler?.(path, error);
  } catch {
    // A broken diagnostic sink must not turn a best-effort prompt read into a rejection.
  }
};

/**
 * Load a single DAG module from the filesystem.
 *
 * - Uses `import(path + "?v=" + sha)` for cache-busting between versions
 * - Validates default export against DagRegistrationSchema
 * - Catches thrown errors during import (syntax, missing deps)
 * - Never throws — all failures returned as Result.err
 *
 * @satisfies FR-004, NFR-010
 */
export const loadDagModule = async (
  modulePath: string,
  sha: GitSha,
  onPromptError?: (path: string, e: unknown) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<Result<LoadResult, HostError>> => {
  let mod: unknown;

  try {
    // Bun treats ?v=X as distinct module specifier → fresh evaluation per SHA
    mod = await import(`${modulePath}?v=${sha}`);
  } catch (e) {
    return err({
      kind: "import-failed",
      path: modulePath,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
  }

  const defaultExport = (mod as Record<string, unknown>)?.default;
  if (defaultExport === undefined || defaultExport === null) {
    return err({
      kind: "no-default-export",
      path: modulePath,
    });
  }

  const validation = validateDagRegistration(defaultExport);
  if (!validation.ok) {
    return validation;
  }

  const baseRegistration = validation.value;
  const idResult = tryDagId(baseRegistration.dag.id);
  if (!idResult.ok) {
    return err({
      kind: "dag-validation-failed",
      dagId: dagId("unknown"),
      reason: `Invalid DAG ID: ${idResult.error}`,
      message: `DagRegistration has invalid ID '${baseRegistration.dag.id}': ${idResult.error}`,
    });
  }

  // Load + merge sibling fugue.yaml (deployment config). Overrides dag.ts config.
  const yamlResult = await loadFugueYaml(modulePath);
  if (!yamlResult.ok) {
    return yamlResult;
  }
  const yaml = yamlResult.value;
  const registration = yaml ? applyFugueYaml(baseRegistration, yaml) : baseRegistration;

  // Fail-closed env requirement check (fugue.yaml `env` declares required host env vars).
  if (yaml && yaml.env.length > 0) {
    const missing = missingEnvVars(yaml.env, env);
    if (missing.length > 0) {
      return err({
        kind: "dag-validation-failed",
        dagId: idResult.value,
        reason: `Missing required env vars: ${missing.join(", ")}`,
        message: `DAG '${idResult.value}' declares required env vars not set in the host: ${missing.join(", ")}`,
      });
    }
  }

  // Load prompts from sibling prompts/ directory (best-effort)
  const promptErrorHandler = onPromptError ?? ((path: string, e: unknown) => {
    // Fallback when no logger injected — prompt errors still surfaced, just via console
    console.warn(`[module-loader] Failed to read prompt file '${path}': ${e instanceof Error ? e.message : String(e)}`);
  });
  const prompts = await loadPromptsForModule(modulePath, promptErrorHandler);

  // Opt-in prompt versioning: when prompts/registry.json exists, every prompt
  // must match its registered hash. Fail-closed per DAG (NFR-010): an edited-
  // without-bump prompt must not deploy.
  const registryResult = await validatePromptRegistry(modulePath, prompts, idResult.value);
  if (!registryResult.ok) {
    return registryResult;
  }

  return ok({
    id: idResult.value,
    registration,
    modulePath,
    prompts,
    team: yaml?.team,
    owner: yaml?.owner,
  });
};

/**
 * Validate the optional `prompts/registry.json` (prompt versioning, opt-in).
 *
 * Shape: `{ "<prompt-name>": { "version": "1.0.0", "hash": "<sha256/16>" } }` —
 * the same contract as the framework's `FilePromptRegistry`. When the file is
 * absent the check is skipped (prompts are still implicitly versioned by git).
 * When present, ALL of these fail the DAG load:
 * - malformed registry JSON / entry shape,
 * - a loaded prompt missing from the registry,
 * - a registry entry whose prompt file is missing,
 * - a hash mismatch (prompt edited without a version bump).
 */
const validatePromptRegistry = async (
  modulePath: string,
  prompts: ReadonlyMap<string, string>,
  forDagId: DagId,
): Promise<Result<void, HostError>> => {
  const registryPath = join(dirname(modulePath), "prompts", "registry.json");
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return ok(undefined); // opt-in
    return err({
      kind: "dag-validation-failed",
      dagId: forDagId,
      reason: `Cannot read prompt registry: ${e instanceof Error ? e.message : String(e)}`,
      message: `DAG '${forDagId}': cannot read ${registryPath}`,
    });
  }

  const invalid = (reason: string): Result<void, HostError> =>
    err({
      kind: "dag-validation-failed",
      dagId: forDagId,
      reason,
      message: `DAG '${forDagId}' prompt registry: ${reason}`,
    });

  let registry: unknown;
  try {
    registry = JSON.parse(raw);
  } catch (e) {
    return invalid(`registry.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) {
    return invalid("registry.json must be an object keyed by prompt name");
  }

  const entries = registry as Record<string, unknown>;
  const problems: string[] = [];

  for (const [name, entry] of Object.entries(entries)) {
    const e = entry as { version?: unknown; hash?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.version !== "string" || typeof e.hash !== "string") {
      problems.push(`'${name}': entry must be { version: string, hash: string }`);
      continue;
    }
    const text = prompts.get(name);
    if (text === undefined) {
      problems.push(`'${name}': registered but prompts/${name}.txt is missing`);
      continue;
    }
    const actual = computePromptHash(text);
    if (actual !== e.hash) {
      problems.push(`'${name}': hash mismatch (registry ${e.hash}, file ${actual}) — prompt edited without version bump`);
    }
  }
  for (const name of prompts.keys()) {
    if (!(name in entries)) {
      problems.push(`'${name}': prompt file present but not in registry.json`);
    }
  }

  if (problems.length > 0) {
    return invalid(problems.join("; "));
  }
  return ok(undefined);
};

/**
 * Load all .txt files from a prompts/ directory colocated with the DAG module.
 * Returns an empty Map if no prompts directory exists.
 * Best-effort: individual file failures are logged but don't block loading.
 */
export const loadPromptsForModule = async (
  modulePath: string,
  onFileError?: (path: string, error: unknown) => void,
): Promise<ReadonlyMap<string, string>> => {
  const dagDir = dirname(modulePath);
  const promptsDir = join(dagDir, "prompts");
  const map = new Map<string, string>();

  try {
    const entries = await readdir(promptsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".txt")) continue;
      const filePath = join(promptsDir, entry);
      try {
        const text = await readFile(filePath, "utf-8");
        const name = entry.slice(0, -4); // strip .txt
        map.set(name, text);
      } catch (e) {
        // Prompt file exists but can't be read — DAG will fail at runtime
        // with "prompt-not-found". Log so operators can diagnose.
        reportPromptError(onFileError, filePath, e);
      }
    }
  } catch (e) {
    // Absence is ENOENT ONLY — a bare catch would swallow EACCES/ENOTDIR/
    // ELOOP/EMFILE and misreport a permission-broken prompts dir as "no
    // prompts", deferring the failure to a misattributed runtime
    // prompt-not-found (parity with validatePromptRegistry's non-ENOENT
    // hard-error handling and the per-file onFileError logging above).
    const probe = probeErrorCode(e);
    if (probe.kind !== "code" || probe.code !== "ENOENT") {
      reportPromptError(onFileError, promptsDir, e);
    }
  }

  return map;
};

/**
 * Discover all DAG module paths in the given root directory.
 *
 * Convention: `dags/{team}/.../{dag-name}/dag.ts` — the FIRST folder under
 * `dags/` is the team (see `extractTeam`); intermediate folders are free-form
 * intra-team grouping (e.g. `dags/business-sales/leads/lead-scoring/dag.ts`).
 * A `dag.ts` file marks a DAG root at ANY depth, so the glob is depth-agnostic
 * (`dags/**` + `dag.ts`) rather than the old fixed two-level team/dag glob.
 *
 * `dag.ts` therefore means "this is a DAG root" — do NOT name a non-DAG module
 * `dag.ts` (a node helper, a barrel) anywhere under `dags/`. Paths inside a
 * `node_modules/` are excluded so a baked dependency's example `dag.ts` is never
 * mistaken for a deployed DAG.
 *
 * Returns absolute paths to each discovered dag.ts file.
 * Wraps all I/O in Result — never throws.
 */
export const discoverDagPaths = async (dagsRoot: string): Promise<Result<string[], HostError>> => {
  try {
    const pathSet = new Set<string>();
    // A baked image (DAGS_LOCAL_PATH) ships node_modules alongside dags/; a
    // dependency may carry its own example dag.ts. Never register those.
    const isDeployable = (file: string): boolean => !file.includes("/node_modules/");

    // Any depth under dags/ — supports both dags/{team}/{dag} and deeper
    // domain grouping like dags/{team}/{domain}/{dag}.
    const primaryGlob = new Bun.Glob("dags/**/dag.ts");
    for await (const file of primaryGlob.scan({ cwd: dagsRoot, absolute: true })) {
      if (isDeployable(file)) pathSet.add(file);
    }

    // Fallback glob for flat layouts (cwd is already the dags root) — dedup via Set.
    const altGlob = new Bun.Glob("**/dag.ts");
    for await (const file of altGlob.scan({ cwd: dagsRoot, absolute: true })) {
      if (isDeployable(file)) pathSet.add(file);
    }

    return ok([...pathSet].sort());
  } catch (e) {
    return err({
      kind: "discovery-failed",
      dagsRoot,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Load all discovered DAG modules from a root directory.
 * Errors in individual DAGs do NOT affect others (NFR-010).
 * Discovery failures are surfaced as errors, never thrown.
 */
export const loadAll = async (
  dagsRoot: string,
  sha: GitSha,
  onPromptError?: (path: string, e: unknown) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<BulkLoadResult> => {
  const pathsResult = await discoverDagPaths(dagsRoot);
  if (!pathsResult.ok) {
    return { loaded: [], errors: [{ path: dagsRoot, error: pathsResult.error }] };
  }

  const paths = pathsResult.value;
  const loaded: LoadResult[] = [];
  const errors: LoadError[] = [];

  for (const path of paths) {
    const result = await loadDagModule(path, sha, onPromptError, env);
    if (result.ok) {
      loaded.push(result.value);
    } else {
      errors.push({ path, error: result.error });
    }
  }

  return { loaded, errors };
};

/**
 * Create a ModuleLoaderPort using the real filesystem implementations.
 * Accepts an optional logger — when provided, prompt-file read errors route
 * through the structured LogPort instead of console.warn.
 */
export const createModuleLoader = (logger?: import("../ports.js").LogPort): ModuleLoaderPort => {
  const onPromptError: ((path: string, e: unknown) => void) | undefined = logger
    ? (path, e) => logger.warn("[module-loader] Failed to read prompt file", {
        promptPath: path,
        error: e instanceof Error ? e.message : String(e),
      })
    : undefined;
  return {
    loadDagModule: (modulePath, sha) => loadDagModule(modulePath, sha, onPromptError),
    discoverDagPaths,
    loadAll: (dagsRoot, sha) => loadAll(dagsRoot, sha, onPromptError),
  };
};
