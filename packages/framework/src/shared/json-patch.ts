import { fwLogger } from "../logger.js";

// Re-export types from their canonical home in `types/`.
export type { JsonPatchOp, JsonPatch } from "../types/json-patch.js";
import type { JsonPatchOp, JsonPatch } from "../types/json-patch.js";

/**
 * Lightweight RFC 6902 JSON Patch diff computation.
 *
 * - Primitives and arrays: single `replace` at root (`/`).
 * - Objects: per-key `add` / `remove` / `replace` (one level deep).
 * - Nested object changes produce a `replace` for the changed key.
 *
 * Comparison is deep (via JSON serialization) so structurally identical
 * nested values produce no patch. Only the patch *granularity* is shallow —
 * a changed nested object emits a single `replace` for the containing key,
 * not recursive per-field operations.
 *
 * This is intentionally shallow-granularity — deep recursive diff is
 * overkill for human-edit forensics where the operator cares about *which
 * fields* changed, not character-level diffs within nested structures.
 */
export const computeJsonPatch = (
  original: unknown,
  replacement: unknown,
): JsonPatch => {
  // Same value — no diff
  if (original === replacement) return [];

  // Non-object or array — wholesale replace
  if (
    original === null ||
    replacement === null ||
    typeof original !== "object" ||
    typeof replacement !== "object" ||
    Array.isArray(original) ||
    Array.isArray(replacement)
  ) {
    return [{ op: "replace", path: "/", value: replacement }];
  }

  const ops: JsonPatchOp[] = [];
  const origRecord = original as Record<string, unknown>;
  const replRecord = replacement as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(origRecord), ...Object.keys(replRecord)]);

  for (const key of allKeys) {
    const escapedKey = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const path = `/${escapedKey}`;
    const inOrig = key in origRecord;
    const inRepl = key in replRecord;

    if (inOrig && !inRepl) {
      ops.push({ op: "remove", path });
    } else if (!inOrig && inRepl) {
      ops.push({ op: "add", path, value: replRecord[key] });
    } else if (inOrig && inRepl) {
      // Deep equality check via JSON serialization for nested values
      const origVal = origRecord[key];
      const replVal = replRecord[key];
      if (origVal !== replVal) {
        try {
          if (JSON.stringify(origVal) !== JSON.stringify(replVal)) {
            ops.push({ op: "replace", path, value: replVal });
          }
        } catch (e) {
          fwLogger().warn(
            `[computeJsonPatch] JSON.stringify comparison failed for key '${key}': ${e instanceof Error ? e.message : e}; treating as changed`,
          );
          ops.push({ op: "replace", path, value: replVal });
        }
      }
    }
  }

  return ops;
};
