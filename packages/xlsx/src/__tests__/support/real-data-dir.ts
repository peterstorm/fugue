/**
 * `FUGUE_REAL_DATA_DIR` — the folder holding the local, never-committed real
 * source workbooks (dev-only test support).
 *
 * One parser for every consumer: the real-data differential, its pinned-TZ child
 * runs and the memory bench. They must agree on what a blank or relative value
 * means, so the rule lives here once.
 */
import { resolve } from "node:path";

export const REAL_DATA_DIR_ENV = "FUGUE_REAL_DATA_DIR";

export type RealDataDir = { readonly kind: "unset" } | { readonly kind: "set"; readonly dir: string };

/** Unset or blank → `unset`; otherwise the directory as an absolute path (a relative value resolves against `cwd`). */
export const realDataDir = (env: Readonly<Record<string, string | undefined>>, cwd: string): RealDataDir => {
  const raw = env[REAL_DATA_DIR_ENV]?.trim();
  if (raw === undefined || raw === "") return { kind: "unset" };
  return { kind: "set", dir: resolve(cwd, raw) };
};
