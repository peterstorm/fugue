// Verified-directory containment policy for the file backend
// (`@fuguejs/framework/file`), extracted from `checkpointer.ts` (advisory A8
// of the 2026-08-14 PR remediation).
//
// The checkpointer addresses caller-supplied directories and backend-managed
// run/nodes descendants before every I/O operation. Portable Node path APIs
// cannot provide descriptor-relative openat traversal, so this module
// establishes a directory as a NON-SYMLINK TRUST ANCHOR — canonical
// realpath + device/inode, proven before I/O — and re-proves directory
// identity around writes. Pre-existing substitutions (symlinked or
// non-directory entries, canonical parents outside the verified base) are
// rejected; check/use races are narrowed without claiming safety against a
// process concurrently renaming filesystem entries (FR-016/FR-029).
//
// Policy surface:
//
//   - `verifyDirectory(path, expectedParent, create)` — establish
//     (optionally create) a directory, reject symlink/non-directory
//     entries, prove canonical-parent containment, and return the frozen
//     `{ path, device, inode }` anchor; `null` when a non-creating probe
//     finds no entry.
//   - `assertDirectoryIdentity(anchor)` — fail closed when the anchored
//     entry has been swapped, replaced by a symlink, or moved between
//     operations.
//   - `verifyExistingFile(parent, fileName)` — prove a record file inside a
//     verified parent is a regular non-symlink file whose canonical parent
//     is the anchor path; returns the canonical path.
//
// These helpers throw raw `Error`/`TypeError` values with actionable
// messages; the checkpointer shell converts every throw into its typed
// `cache-error(load|saveNode|setMeta)` boundary, so nothing untyped crosses
// the port (AD-6). Missing entries are distinguished ONLY by the caller:
// `verifyDirectory(…, create: false)` returns `null` for ENOENT, while
// `verifyExistingFile` lets ENOENT propagate because a missing record file
// mid-load is an environment failure the shell classifies explicitly.
//
// Import discipline (INV-1): `node:fs` and `node:path` only among the node
// built-ins; no broker modules.

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { probeErrorCode, safeDiagnosticRender } from "../types/safe-error.js";

/** Compact, total rendering for diagnostics that include arbitrary values. */
const render = safeDiagnosticRender;

export interface VerifiedDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

const isMissingPathError = (error: unknown): boolean => {
  const probe = probeErrorCode(error);
  return probe.kind === "code" && probe.code === "ENOENT";
};

/**
 * Establish a directory as a non-symlink trust anchor. The returned canonical
 * path, device, and inode are the only addressing material used below. The
 * final supplied base entry and every backend-managed descendant are checked;
 * portable Node does not expose openat-style traversal for pinning every
 * ancestor descriptor against a malicious concurrent rename.
 */
export const verifyDirectory = (
  path: string,
  expectedParent: string | null,
  create: boolean,
): VerifiedDirectory | null => {
  if (create) {
    try {
      mkdirSync(path, { recursive: expectedParent === null });
    } catch (error) {
      const probe = probeErrorCode(error);
      if (!(probe.kind === "code" && probe.code === "EEXIST")) throw error;
    }
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!create && isMissingPathError(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link directory ${render(path)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`expected directory at ${render(path)}, found a non-directory entry`);
  }

  const canonical = realpathSync(path);
  if (expectedParent !== null && dirname(canonical) !== expectedParent) {
    throw new Error(
      `directory ${render(path)} resolves to ${render(canonical)}, outside verified parent ${render(expectedParent)}`,
    );
  }
  return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
};

export const assertDirectoryIdentity = (directory: VerifiedDirectory): void => {
  const stat = lstatSync(directory.path);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() ||
    stat.dev !== directory.device || stat.ino !== directory.inode ||
    realpathSync(directory.path) !== directory.path
  ) {
    throw new Error(`verified directory identity changed during operation: ${render(directory.path)}`);
  }
};

export const verifyExistingFile = (
  parent: VerifiedDirectory,
  fileName: string,
): string => {
  assertDirectoryIdentity(parent);
  const candidate = join(parent.path, fileName);
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link file ${render(candidate)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`expected regular file at ${render(candidate)}, found a non-file entry`);
  }
  const canonical = realpathSync(candidate);
  if (dirname(canonical) !== parent.path) {
    throw new Error(
      `file ${render(candidate)} resolves to ${render(canonical)}, outside verified parent ${render(parent.path)}`,
    );
  }
  return canonical;
};
