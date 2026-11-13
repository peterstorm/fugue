import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Result, ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { computePromptHash } from "./hash.js";

export interface PromptEntry {
  readonly text: string;
  readonly hash: string;
  readonly version: string;
}

export interface PromptRegistry {
  load(name: string): Promise<Result<PromptEntry, FrameworkError>>;
}

const promptNotFound = (promptName: string, reason: string): FrameworkError => ({
  kind: "prompt-not-found",
  promptName,
  reason,
});

const isJsonObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseRegistryEntry = (
  raw: unknown,
): { readonly version: string; readonly hash: string } | undefined =>
  isJsonObject(raw) && typeof raw.version === "string" && typeof raw.hash === "string"
    ? { version: raw.version, hash: raw.hash }
    : undefined;

/**
 * Parse the registry document and look `name` up in it. The file is wire data:
 * a non-object document, an inherited key, and an entry that is not
 * `{ version: string, hash: string }` each settle as a typed `prompt-not-found`.
 */
const lookupEntry = (
  registry: unknown,
  name: string,
): Result<{ readonly version: string; readonly hash: string }, FrameworkError> => {
  if (!isJsonObject(registry)) {
    return err(promptNotFound(name, "registry file is malformed: expected a JSON object"));
  }
  const rawEntry: unknown = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!rawEntry) return err(promptNotFound(name, "not in registry"));
  const entry = parseRegistryEntry(rawEntry);
  return entry === undefined
    ? err(promptNotFound(name, "registry entry is malformed: expected { version: string, hash: string }"))
    : ok(entry);
};

export const FilePromptRegistry = ({
  dir,
  registryPath,
}: {
  readonly dir: string;
  readonly registryPath: string;
}): PromptRegistry => ({
  async load(name) {
    // 1. Read prompt file
    let text: string;
    try {
      text = await readFile(join(dir, `${name}.txt`), "utf-8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return err(promptNotFound(name, code === "ENOENT" ? "file not found" : `file read failed: ${code ?? (e instanceof Error ? e.message : String(e))}`));
    }

    // 2. Compute hash
    const hash = computePromptHash(text);

    // 3. Read registry — distinguish "file missing" (no registry deployed)
    // from "file present but malformed" (corrupt registry, possibly a half-
    // finished write). Collapsing them masks a recoverable operator condition.
    let raw: string;
    try {
      raw = await readFile(registryPath, "utf-8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return err(promptNotFound(name, code === "ENOENT" ? "registry file does not exist" : `registry read failed: ${code ?? (e instanceof Error ? e.message : String(e))}`));
    }
    let registry: unknown;
    try {
      registry = JSON.parse(raw);
    } catch (e) {
      return err(
        promptNotFound(
          name,
          `registry file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    // 4. Check registry entry
    const entry = lookupEntry(registry, name);
    if (!entry.ok) return entry;

    // 5. Cross-check hash
    if (entry.value.hash !== hash) {
      return err(
        promptNotFound(name, "hash mismatch — prompt edited without version bump"),
      );
    }

    return ok({ text, hash, version: entry.value.version });
  },
});
