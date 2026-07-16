// Shared CLI path resolution. Pure by construction: the caller passes `cwd`
// (never read from `process.cwd()` in here), so this stays a functional-core
// helper the imperative shell feeds `process.cwd()` from the boundary. Single
// source for the `isAbsolute(p) ? p : resolve(cwd, p)` idiom that otherwise
// recurs across `compose`, `new`, and `lint`.

import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a possibly-relative path against an explicit working directory.
 * Absolute inputs pass through unchanged; relative inputs are resolved against
 * `cwd`. `cwd` is a REQUIRED param — the env read (`process.cwd()`) stays at
 * the shell call site so this helper is trivially testable with plain strings.
 */
export const resolveRoot = (p: string, cwd: string): string =>
  isAbsolute(p) ? p : resolve(cwd, p);
