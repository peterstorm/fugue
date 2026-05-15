// Stable JSON hashing — deterministic regardless of key order

import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys and produces a canonical JSON string.
 * Arrays preserve order; numbers use canonical representation.
 */
const canonicalize = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${sorted.join(",")}}`;
  }
  return String(value);
};

/**
 * Produces a stable sha256 hash (16 hex chars) for any value.
 * Semantically equal inputs (different key order) produce equal hashes.
 */
export const stableHash = (value: unknown): string =>
  createHash("sha256").update(canonicalize(value)).digest("hex").slice(0, 16);
