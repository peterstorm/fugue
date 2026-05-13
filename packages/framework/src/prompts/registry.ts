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
    let registry: Record<string, { version: string; hash: string }>;
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
    const entry = registry[name];
    if (!entry) {
      return err(promptNotFound(name, "not in registry"));
    }

    // 5. Cross-check hash
    if (entry.hash !== hash) {
      return err(
        promptNotFound(name, "hash mismatch — prompt edited without version bump"),
      );
    }

    return ok({ text, hash, version: entry.version });
  },
});
