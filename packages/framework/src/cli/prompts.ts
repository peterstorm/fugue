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
 * Canonical key order: raw UTF-16 codepoint comparison. NEVER `localeCompare`
 * — its answer depends on the host's ICU tables/locale, so two machines could
 * write byte-different registries for identical content.
 */
const codepointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The `prompts/registry.json` byte format: canonical 2-space JSON, keys in
 * codepoint order, plus a trailing newline. Single-sourced so scaffold writers
 * and `runPromptsSync` can never drift — a later `prompts sync`/`check` over a
 * scaffolded registry sees no spurious diff, and the same entries always
 * serialize to the same bytes regardless of insertion order or host locale.
 */
export const serializeRegistry = (entries: Record<string, RegistryEntry>): string => {
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => codepointCompare(a, b)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
};

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
  } catch (e) {
    // ONLY a missing prompts/ dir means "nothing to version". Any other errno
    // (EACCES, EIO, ENOTDIR, …) means we could not SEE the prompt files —
    // folding that into an empty map would let `runPromptsSync` mark every
    // prompt removed and rewrite the registry to {} under ok: true. Rethrow;
    // the callers fold it into their `{ ok: false, problems }` envelope.
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return map;
    throw e;
  }
  // Codepoint order (matching `serializeRegistry`) so the iteration — and
  // therefore every result/registry derived from it — is independent of the
  // filesystem's readdir order.
  for (const entry of [...entries].sort(codepointCompare)) {
    if (!entry.endsWith(".txt")) continue;
    map.set(entry.slice(0, -4), await readFile(join(dir, entry), "utf-8"));
  }
  return map;
};

const readRegistry = async (registryPath: string): Promise<Record<string, RegistryEntry>> => {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (e) {
    // ONLY a missing registry.json means "no registry yet". Any other errno
    // (EACCES, EIO, EISDIR, …) means the registry exists but could not be
    // read — treating that as {} would silently discard the version history
    // on the next sync. Rethrow; callers report through their envelope.
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
    throw e;
  }
  const parsed = JSON.parse(raw) as unknown; // malformed JSON throws → caller reports
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("registry.json must be an object keyed by prompt name");
  }
  // Parse, don't validate-by-cast: each entry must be { version: string,
  // hash: string } or `bumpPatch`/hash comparison would operate on junk —
  // name the offending key so a hand-edited registry is fixable from the
  // message alone.
  for (const [name, entry] of Object.entries(parsed)) {
    const e = entry as { version?: unknown; hash?: unknown } | null;
    if (
      e === null ||
      typeof e !== "object" ||
      Array.isArray(e) ||
      typeof e.version !== "string" ||
      typeof e.hash !== "string"
    ) {
      throw new Error(
        `registry.json entry '${name}' must be { "version": string, "hash": string }`,
      );
    }
  }
  return parsed as Record<string, RegistryEntry>;
};

/** `fugue prompts sync <dagDir>` — rewrite registry.json from the prompt files. */
export const runPromptsSync = async (dagDir: string): Promise<PromptsResult> => {
  const registryPath = join(dagDir, PROMPTS_DIR, REGISTRY_FILE);

  // An unreadable prompts/ dir (EACCES/EIO/…, rethrown by readPromptFiles) is
  // an environment failure, not "no prompts" — fold it into the envelope
  // instead of syncing the registry down to {} under ok: true.
  let files: ReadonlyMap<string, string>;
  try {
    files = await readPromptFiles(dagDir);
  } catch (e) {
    return {
      ok: false,
      registryPath,
      prompts: {},
      problems: [`prompts/ unreadable: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // A corrupt/unreadable registry must surface through the stdout-JSON envelope
  // — the same contract `runPromptsCheck` honours — not a raw stderr stack.
  // We fail rather than silently overwrite so a hand-edited registry isn't
  // clobbered (and its version history lost) without the operator knowing.
  let existing: Record<string, RegistryEntry>;
  try {
    existing = await readRegistry(registryPath);
  } catch (e) {
    return {
      ok: false,
      registryPath,
      prompts: {},
      problems: [`registry.json unreadable: ${e instanceof Error ? e.message : String(e)} — fix or remove it, then re-run \`fugue prompts sync\``],
    };
  }

  // Accumulate in Maps, NOT plain Records: prompt names are filesystem-derived,
  // so a prompt file named `__proto__.txt` would hit the object-literal
  // prototype setter (entry silently vanishes from the written registry while
  // sync reports ok), and `existing[name]` for any Object.prototype property
  // name (`constructor`, `toString`, …) would read a truthy non-entry through
  // the prototype chain. `readEntry` guards the reads with Object.hasOwn;
  // Object.fromEntries at the serialization edge defines own properties only.
  const prompts = new Map<string, { version: string; hash: string; status: PromptStatus }>();
  const next = new Map<string, RegistryEntry>();
  const readEntry = (name: string): RegistryEntry | undefined =>
    Object.hasOwn(existing, name) ? existing[name] : undefined;

  // `files` iterates in codepoint order already (readPromptFiles), and
  // `serializeRegistry` canonicalizes key order on write — no locale-dependent
  // sort anywhere on the path to registry bytes.
  for (const [name, text] of files) {
    const hash = computePromptHash(text);
    const prior = readEntry(name);
    if (prior === undefined) {
      const entry = freshRegistryEntry(text);
      next.set(name, entry);
      prompts.set(name, { ...entry, status: "added" });
    } else if (prior.hash !== hash) {
      const entry = { version: bumpPatch(prior.version), hash };
      next.set(name, entry);
      prompts.set(name, { ...entry, status: "bumped" });
    } else {
      next.set(name, prior);
      prompts.set(name, { ...prior, status: "unchanged" });
    }
  }
  for (const name of Object.keys(existing)) {
    if (!files.has(name)) prompts.set(name, { ...existing[name]!, status: "removed" });
  }

  // The write is an environment surface (ENOSPC/EACCES/EISDIR, …) — fold a
  // throw into the `{ ok: false, problems }` envelope (mirrors `runNew`'s
  // write batch) rather than crashing past the stdout-JSON contract, keeping
  // the stack so the environment is debuggable from the outcome.
  try {
    if (files.size > 0 || Object.keys(existing).length > 0) {
      await writeFile(registryPath, serializeRegistry(Object.fromEntries(next)), "utf-8");
    }
  } catch (e) {
    return {
      ok: false,
      registryPath,
      prompts: Object.fromEntries(prompts),
      problems: [`registry write failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`],
    };
  }
  return { ok: true, registryPath, prompts: Object.fromEntries(prompts), problems: [] };
};

/** `fugue prompts check <dagDir>` — verify registry.json matches the files (no writes). */
export const runPromptsCheck = async (dagDir: string): Promise<PromptsResult> => {
  const registryPath = join(dagDir, PROMPTS_DIR, REGISTRY_FILE);

  // Same fold as `runPromptsSync`: an unreadable prompts/ dir must surface
  // through the envelope, never masquerade as "no prompts" (which would flag
  // every registered prompt as missing).
  let files: ReadonlyMap<string, string>;
  try {
    files = await readPromptFiles(dagDir);
  } catch (e) {
    return {
      ok: false,
      registryPath,
      prompts: {},
      problems: [`prompts/ unreadable: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

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
  // Map + Object.hasOwn for the same reason as runPromptsSync: filesystem-
  // derived names must never traverse the prototype chain or hit its setter.
  const prompts = new Map<string, { version: string; hash: string; status: PromptStatus }>();

  if (files.size > 0 && Object.keys(existing).length === 0) {
    problems.push("prompts exist but registry.json is missing or empty — run `fugue prompts sync`");
  }
  for (const [name, text] of files) {
    const hash = computePromptHash(text);
    const prior = Object.hasOwn(existing, name) ? existing[name] : undefined;
    if (prior === undefined) {
      problems.push(`'${name}': not in registry.json — run \`fugue prompts sync\``);
    } else if (prior.hash !== hash) {
      problems.push(`'${name}': hash mismatch — prompt edited without version bump, run \`fugue prompts sync\``);
      prompts.set(name, { ...prior, status: "bumped" });
    } else {
      prompts.set(name, { ...prior, status: "unchanged" });
    }
  }
  for (const name of Object.keys(existing)) {
    if (!files.has(name)) problems.push(`'${name}': registered but prompts/${name}.txt is missing`);
  }

  return { ok: problems.length === 0, registryPath, prompts: Object.fromEntries(prompts), problems };
};
