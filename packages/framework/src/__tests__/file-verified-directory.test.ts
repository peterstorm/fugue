/**
 * Direct tests for `src/file/verified-directory.ts` — the verified-directory
 * containment policy of the file backend (advisory A8 of the 2026-08-14 PR
 * remediation), extracted from the checkpointer adapter.
 *
 * The policy establishes a directory as a NON-SYMLINK TRUST ANCHOR (canonical
 * realpath + device/inode) before I/O, rejects pre-existing substitutions,
 * and re-proves directory identity around writes (FR-016/FR-029). Portable
 * Node path APIs cannot provide descriptor-relative openat traversal, so
 * these checks narrow check/use races without claiming safety against a
 * process concurrently renaming filesystem entries.
 *
 * Coverage:
 * - `verifyDirectory`: missing-path probe ⇒ `null`; recursive creation;
 *   EEXIST tolerance; symlink rejection at the base and at backend-managed
 *   descendants; non-directory rejection; canonical-parent containment
 *   (an intermediate symlink resolving outside the verified base fails
 *   closed); frozen `{ path, device, inode }` anchors.
 * - `assertDirectoryIdentity`: passes on an unchanged anchor; fails closed
 *   when the anchored entry is removed, recreated (inode change), or
 *   replaced by a symlink.
 * - `verifyExistingFile`: canonical-path return for a regular file; symlink
 *   file rejection; non-file rejection; canonical-parent containment; raw
 *   ENOENT propagation for a missing record file (the shell classifies it —
 *   never treated as a corrupt entry).
 * - One end-to-end chain mirroring the shell's addressing (base → run →
 *   nodes with `expectedParent` at each step) proving the policy is
 *   sufficient for the adapter's real traversal shape.
 *
 * Atomicity, load-order verdicts, and typed error mapping stay covered by
 * `file-checkpointer.test.ts`; this suite exercises the policy directly.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDirectoryIdentity,
  verifyDirectory,
  verifyExistingFile,
} from "../file/verified-directory.js";

// ---------------------------------------------------------------------------
// Temp-directory plumbing
// ---------------------------------------------------------------------------

const created: string[] = [];

const freshDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "fugue-verified-directory-"));
  created.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyDirectory — trust-anchor establishment
// ---------------------------------------------------------------------------

describe("verifyDirectory — establishing a non-symlink trust anchor", () => {
  it("returns null for a missing path when create is false", () => {
    const base = freshDirectory();
    expect(verifyDirectory(join(base, "missing"), null, false)).toBeNull();
    // Descendant probe under an existing base behaves the same way.
    const baseAnchor = verifyDirectory(base, null, false);
    expect(baseAnchor).not.toBeNull();
    if (baseAnchor === null) return;
    expect(verifyDirectory(join(baseAnchor.path, "no-run"), baseAnchor.path, false)).toBeNull();
  });

  it("creates a missing directory recursively when create is true and anchors it", () => {
    const base = freshDirectory();
    const nested = join(base, "a", "b");
    const anchor = verifyDirectory(nested, null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    expect(existsSync(anchor.path)).toBe(true);
    expect(anchor.path).toBe(realpathSync(nested));
    expect(anchor.device).toBe(lstatSync(anchor.path).dev);
    expect(anchor.inode).toBe(lstatSync(anchor.path).ino);
  });

  it("tolerates an existing directory when create is true", () => {
    const base = freshDirectory();
    const anchor = verifyDirectory(base, null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    expect(anchor.path).toBe(realpathSync(base));
  });

  it("rejects a symbolic-link base directory whether probing or creating", () => {
    const base = freshDirectory();
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link);

    expect(() => verifyDirectory(link, null, false)).toThrow(
      /refusing symbolic-link directory/,
    );
    // create=true must not paper over the substitution either (mkdirSync
    // EEXIST is the ONLY tolerated creation failure).
    expect(() => verifyDirectory(link, null, true)).toThrow(
      /refusing symbolic-link directory/,
    );
  });

  it("rejects a non-directory entry", () => {
    const base = freshDirectory();
    const file = join(base, "meta.json");
    writeFileSync(file, "{}");
    expect(() => verifyDirectory(file, null, false)).toThrow(/non-directory entry/);
    // create=true on an existing non-directory is rejected too.
    expect(() => verifyDirectory(file, null, true)).toThrow(/non-directory entry/);
  });

  it("rejects a descendant whose canonical parent disagrees with the verified base", () => {
    const base = freshDirectory();
    const outside = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;

    // `link` resolves to a REAL directory outside the base; a child path
    // THROUGH the link is itself a real directory (not a symlink), so only
    // the canonical-parent agreement can catch the escape.
    const link = join(parent.path, "link");
    symlinkSync(outside, link);
    const child = join(parent.path, "link", "child");
    mkdirSync(join(outside, "child"));

    expect(() => verifyDirectory(child, parent.path, false)).toThrow(
      /outside verified parent/,
    );
  });

  it("returns a frozen canonical anchor with the entry's device and inode", () => {
    const base = freshDirectory();
    const anchor = verifyDirectory(join(base, "run-1"), null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    expect(Object.isFrozen(anchor)).toBe(true);
    const stat = lstatSync(anchor.path);
    expect(anchor.device).toBe(stat.dev);
    expect(anchor.inode).toBe(stat.ino);
    expect(anchor.path).toBe(realpathSync(join(base, "run-1")));
  });
});

// ---------------------------------------------------------------------------
// assertDirectoryIdentity — re-proving the anchor around writes
// ---------------------------------------------------------------------------

describe("assertDirectoryIdentity — fail-closed recheck around writes", () => {
  it("passes while the anchored entry is unchanged", () => {
    const base = freshDirectory();
    const anchor = verifyDirectory(base, null, false);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    expect(() => assertDirectoryIdentity(anchor)).not.toThrow();
    // Anchoring the same path again must produce an agreeing identity.
    const again = verifyDirectory(anchor.path, null, false);
    expect(again).not.toBeNull();
    if (again === null) return;
    expect(again.device).toBe(anchor.device);
    expect(again.inode).toBe(anchor.inode);
  });

  it("fails closed when the anchored directory is swapped for a different directory (inode change)", () => {
    const base = freshDirectory();
    const path = join(base, "run-1");
    const anchor = verifyDirectory(path, null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;

    // Two simultaneously-existing directories on one filesystem always have
    // distinct inodes. Renaming the second over the anchored (empty) path
    // swaps the entry deterministically, so the identity recheck cannot pass
    // by inode reuse after an rm+mkdir.
    const other = join(base, "other");
    mkdirSync(other);
    const otherStat = lstatSync(other);
    expect(otherStat.ino).not.toBe(anchor.inode);
    rmSync(path, { recursive: true, force: true });
    renameSync(other, path);
    expect(() => assertDirectoryIdentity(anchor)).toThrow(/identity changed/);
  });

  it("fails closed when the anchored path is replaced by a symlink", () => {
    const base = freshDirectory();
    const path = join(base, "run-1");
    const anchor = verifyDirectory(path, null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;

    rmSync(path, { recursive: true, force: true });
    const elsewhere = freshDirectory();
    symlinkSync(elsewhere, path);
    expect(() => assertDirectoryIdentity(anchor)).toThrow(/identity changed/);
  });

  it("fails closed when the anchored path disappears entirely", () => {
    const base = freshDirectory();
    const anchor = verifyDirectory(join(base, "run-1"), null, true);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    rmSync(anchor.path, { recursive: true, force: true });
    expect(() => assertDirectoryIdentity(anchor)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyExistingFile — readable record-file containment
// ---------------------------------------------------------------------------

describe("verifyExistingFile — record-file containment inside a verified parent", () => {
  it("returns the canonical path for a regular file", () => {
    const base = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;
    const filePath = join(parent.path, "meta.json");
    writeFileSync(filePath, "{}");
    const canonical = verifyExistingFile(parent, "meta.json");
    expect(canonical).toBe(realpathSync(filePath));
  });

  it("rejects a symbolic-link file", () => {
    const base = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;
    const target = join(parent.path, "real.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(parent.path, "link.json"));
    expect(() => verifyExistingFile(parent, "link.json")).toThrow(
      /refusing symbolic-link file/,
    );
  });

  it("rejects a non-file entry", () => {
    const base = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;
    mkdirSync(join(parent.path, "sub"));
    expect(() => verifyExistingFile(parent, "sub")).toThrow(/non-file entry/);
  });

  it("rejects a file whose canonical parent is outside the verified parent", () => {
    const base = freshDirectory();
    const outside = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;
    writeFileSync(join(outside, "meta.json"), "{}");
    const link = join(parent.path, "escape");
    symlinkSync(outside, link);

    // path.join normalizes `..` away before lstat ever runs, so the escape
    // must route THROUGH a symlinked intermediate directory: lstat then sees
    // a regular file, and only canonical-parent agreement rejects it.
    expect(() => verifyExistingFile(parent, "escape/meta.json")).toThrow(
      /outside verified parent/,
    );
  });

  it("lets ENOENT propagate for a missing record file (classified by the shell, never corrupt)", () => {
    const base = freshDirectory();
    const parent = verifyDirectory(base, null, false);
    expect(parent).not.toBeNull();
    if (parent === null) return;
    let thrown: unknown;
    try {
      verifyExistingFile(parent, "absent.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// End-to-end chain — the shell's addressing shape
// ---------------------------------------------------------------------------

describe("verifyDirectory chain — the checkpointer's addressing shape", () => {
  it("establishes base → run → nodes with expectedParent agreement at every step", () => {
    const base = freshDirectory();
    const baseAnchor = verifyDirectory(base, null, true);
    expect(baseAnchor).not.toBeNull();
    if (baseAnchor === null) return;

    const runAnchor = verifyDirectory(join(baseAnchor.path, "run-1"), baseAnchor.path, true);
    expect(runAnchor).not.toBeNull();
    if (runAnchor === null) return;
    expect(runAnchor.path).toBe(realpathSync(join(baseAnchor.path, "run-1")));

    const nodesAnchor = verifyDirectory(join(runAnchor.path, "nodes"), runAnchor.path, true);
    expect(nodesAnchor).not.toBeNull();
    if (nodesAnchor === null) return;
    expect(nodesAnchor.path).toBe(realpathSync(join(runAnchor.path, "nodes")));

    // The chain stays usable across the rechecks the shell performs around
    // an atomic write.
    expect(() => assertDirectoryIdentity(runAnchor)).not.toThrow();
    expect(() => assertDirectoryIdentity(nodesAnchor)).not.toThrow();
    expect(() => assertDirectoryIdentity(baseAnchor)).not.toThrow();

    // A re-probed absent child under the verified run stays a clean null.
    expect(verifyDirectory(join(runAnchor.path, "missing"), runAnchor.path, false)).toBeNull();
  });
});
