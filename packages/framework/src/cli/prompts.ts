// fugue prompts — maintain a DAG's prompts/registry.json (prompt versioning).
//
// `sync`  rewrites registry.json from the prompt files: new prompts get
//         version 1.0.0, edited prompts get a PATCH bump + new hash,
//         entries whose file disappeared are dropped. Idempotent.
// `check` verifies registry.json matches the prompt files without writing —
//         the CI half of the workflow (exit 1 on any drift).
//
// The host validates the same contract at load time (a present registry.json
// must match, fail-closed), so `sync` is how authors stay deployable after
// editing a prompt: edit → `fugue prompts sync <dagDir>` → commit both files.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computePromptHash } from "../prompts/hash.js";

export interface RegistryEntry {
  readonly version: string;
  readonly hash: string;
}

/**
 * The registry entry a freshly scaffolded prompt gets: version 1.0.0 plus the
 * body's hash. Single-sourced here so every writer (`runPromptsSync`, the
 * `fugue new` scaffold batches) produces the same entry shape.
 */
export const freshRegistryEntry = (body: string): RegistryEntry => ({
  version: "1.0.0",
  hash: computePromptHash(body),
});

/**
 * The `prompts/registry.json` byte format: canonical 2-space JSON plus a
 * trailing newline. Single-sourced so scaffold writers and `runPromptsSync`
 * can never drift — a later `prompts sync`/`check` over a scaffolded registry
 * sees no spurious diff.
 */
export const serializeRegistry = (entries: Record<string, RegistryEntry>): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

export type PromptStatus = "unchanged" | "added" | "bumped" | "removed";

export interface PromptsResult {
  readonly ok: boolean;
  readonly registryPath: string;
  readonly prompts: Record<string, { version: string; hash: string; status: PromptStatus }>;
  readonly problems: readonly string[];
}

const PROMPTS_DIR = "prompts";
const REGISTRY_FILE = "registry.json";

const bumpPatch = (version: string): string => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return "1.0.0"; // non-semver registry entry — reset to a known shape
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
};

const readPromptFiles = async (dagDir: string): Promise<ReadonlyMap<string, string>> => {
  const dir = join(dagDir, PROMPTS_DIR);
  const map = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return map; // no prompts/ — nothing to version
  }
  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    map.set(entry.slice(0, -4), await readFile(join(dir, entry), "utf-8"));
  }
  return map;
};

const readRegistry = async (registryPath: string): Promise<Record<string, RegistryEntry>> => {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown; // malformed JSON throws → caller reports
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("registry.json must be an object keyed by prompt name");
  }
  return parsed as Record<string, RegistryEntry>;
};

/** `fugue prompts sync <dagDir>` — rewrite registry.json from the prompt files. */
export const runPromptsSync = async (dagDir: string): Promise<PromptsResult> => {
  const registryPath = join(dagDir, PROMPTS_DIR, REGISTRY_FILE);
  const files = await readPromptFiles(dagDir);
  const existing = await readRegistry(registryPath);

  const prompts: Record<string, { version: string; hash: string; status: PromptStatus }> = {};
  const next: Record<string, RegistryEntry> = {};

  for (const [name, text] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const hash = computePromptHash(text);
    const prior = existing[name];
    if (prior === undefined) {
      next[name] = freshRegistryEntry(text);
      prompts[name] = { ...next[name], status: "added" };
    } else if (prior.hash !== hash) {
      next[name] = { version: bumpPatch(prior.version), hash };
      prompts[name] = { ...next[name], status: "bumped" };
    } else {
      next[name] = prior;
      prompts[name] = { ...prior, status: "unchanged" };
    }
  }
  for (const name of Object.keys(existing)) {
    if (!files.has(name)) prompts[name] = { ...existing[name]!, status: "removed" };
  }

  if (files.size > 0 || Object.keys(existing).length > 0) {
    await writeFile(registryPath, serializeRegistry(next), "utf-8");
  }
  return { ok: true, registryPath, prompts, problems: [] };
};

/** `fugue prompts check <dagDir>` — verify registry.json matches the files (no writes). */
export const runPromptsCheck = async (dagDir: string): Promise<PromptsResult> => {
  const registryPath = join(dagDir, PROMPTS_DIR, REGISTRY_FILE);
  const files = await readPromptFiles(dagDir);

  let existing: Record<string, RegistryEntry>;
  try {
    existing = await readRegistry(registryPath);
  } catch (e) {
    return {
      ok: false,
      registryPath,
      prompts: {},
      problems: [`registry.json unreadable: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const problems: string[] = [];
  const prompts: Record<string, { version: string; hash: string; status: PromptStatus }> = {};

  if (files.size > 0 && Object.keys(existing).length === 0) {
    problems.push("prompts exist but registry.json is missing or empty — run `fugue prompts sync`");
  }
  for (const [name, text] of files) {
    const hash = computePromptHash(text);
    const prior = existing[name];
    if (prior === undefined) {
      problems.push(`'${name}': not in registry.json — run \`fugue prompts sync\``);
    } else if (prior.hash !== hash) {
      problems.push(`'${name}': hash mismatch — prompt edited without version bump, run \`fugue prompts sync\``);
      prompts[name] = { ...prior, status: "bumped" };
    } else {
      prompts[name] = { ...prior, status: "unchanged" };
    }
  }
  for (const name of Object.keys(existing)) {
    if (!files.has(name)) problems.push(`'${name}': registered but prompts/${name}.txt is missing`);
  }

  return { ok: problems.length === 0, registryPath, prompts, problems };
};
