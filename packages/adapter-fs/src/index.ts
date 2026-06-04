/**
 * @fugue/fs — local-filesystem adapter for the generic `DocumentSource`
 * capability (`@fugue/document-source`).
 *
 * Reads files from a mounted directory for nodes that declare
 * `requires: ["documents"]` and use `ctx.documents`. This is the adapter with
 * no external unknowns (no auth, no network): wire a DAG end-to-end against a
 * local `.xlsx` for dev/test, then swap in `@fugue/ms-graph` by configuration
 * with no node changes.
 *
 * Handles the `localPath` `FileRef` variant only; any other variant fails
 * closed (the runtime half of the ref↔adapter contract, ADR-0052).
 *
 * ## Security — paths are confined to `rootDir`
 *
 * Every `localPath` is resolved *relative to* the configured `rootDir` and
 * rejected (non-retriable) if it escapes that root (`../` traversal, absolute
 * paths). This is the local equivalent of SharePoint's `Sites.Selected`. Note:
 * confinement is lexical — for untrusted input over symlinked roots, mount the
 * volume read-only and/or disallow symlink-following at the mount.
 *
 * ## Usage
 *
 * ```ts
 * import { createFsAdapter } from "@fugue/fs";
 * import { localPathRef } from "@fugue/document-source";
 *
 * const docs = createFsAdapter({ rootDir: "/data/reports" });   // a mounted volume
 *
 * createFetchNode({
 *   id: "fetch-sheet",
 *   requires: ["documents"] as const,
 *   fetch: (input, ctx) => ctx.documents.getContent(localPathRef(`${input.period}.xlsx`)),
 * });
 * ```
 *
 * @satisfies ADR-0052 — Document-source capability (filesystem adapter)
 */

import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { match } from "ts-pattern";
import type { Result, FrameworkError, CapabilityHandle } from "@fugue/framework";
import { ok, err, nodeId } from "@fugue/framework";
import type { DocumentSource, FileRef, FileMeta } from "@fugue/document-source";
import { unsupportedRefError } from "@fugue/document-source";

// Re-export the port surface so `@fugue/fs` is a one-stop import.
export { localPathRef, fileRefKey, createFakeDocumentSource } from "@fugue/document-source";
export type { FileRef, FileMeta, ReadOpts, DocumentSource, FakeDocRoute } from "@fugue/document-source";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimal slice of `node:fs/promises` the adapter uses. Tests inject a fake. */
export interface FsLike {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
}

/** Configuration for the filesystem adapter. */
export interface FsAdapterConfig {
  /**
   * Root directory all `localPath` references resolve against. Reads are
   * confined to this tree; references that escape it are rejected. Point this
   * at your mounted volume (e.g. a PVC mount path).
   */
  readonly rootDir: string;
  /** Injected filesystem, for testing. Defaults to `node:fs/promises`. */
  readonly fsImpl?: FsLike;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const FS_NODE_ID = nodeId("fs-capability");

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const crashErr = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: FS_NODE_ID,
  message,
  retriability: "non-retriable",
});

const transientErr = (message: string): FrameworkError => ({
  kind: "transient",
  nodeId: FS_NODE_ID,
  message,
});

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".json": "application/json",
};

/**
 * Map a `node:fs` error to a `FrameworkError`. Missing file / permission /
 * is-a-directory are non-retriable; transient I/O errors (EIO, EBUSY, EAGAIN)
 * are retriable. Exported for testing.
 */
export const mapFsError = (e: unknown, path: string): FrameworkError => {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (code === "ENOENT") return crashErr(`file not found: ${path}`);
  if (code === "EACCES" || code === "EPERM") return crashErr(`permission denied: ${path}`);
  if (code === "EISDIR") return crashErr(`path is a directory: ${path}`);
  return transientErr(`fs error reading ${path}: ${msg(e)}`);
};

/**
 * Resolve a relative path against `rootDir`, confined to that tree. Rejects
 * `../` traversal, absolute paths that escape, and the root itself. Exported
 * for testing.
 */
export const resolveWithinRoot = (
  rootDir: string,
  path: string,
): Result<string, FrameworkError> => {
  const root = resolve(rootDir);
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return err(crashErr(`path escapes root '${rootDir}': '${path}'`));
  }
  return ok(abs);
};

const defaultFs: FsLike = {
  readFile: (p) => nodeReadFile(p),
  stat: async (p) => {
    const s = await nodeStat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
};

// ---------------------------------------------------------------------------
// Adapter Factory
// ---------------------------------------------------------------------------

/**
 * Create a filesystem `DocumentSource` capability handle rooted at
 * `config.rootDir`.
 *
 * Lifecycle:
 * - `connect()`: stats `rootDir` to validate the mount exists at boot.
 * - `close()`: no-op.
 * - `healthCheck()`: re-stats `rootDir`.
 */
export const createFsAdapter = (config: FsAdapterConfig): CapabilityHandle<"documents"> => {
  const fs = config.fsImpl ?? defaultFs;
  const root = resolve(config.rootDir);

  /** Resolve the absolute, confined path for a localPath ref (or fail closed). */
  const pathFor = (ref: FileRef): Result<string, FrameworkError> =>
    match(ref)
      .with({ kind: "localPath" }, (r) => resolveWithinRoot(root, r.path))
      .otherwise((r) => err(unsupportedRefError("fs", r)));

  const client: DocumentSource = {
    getContent: async (ref): Promise<Result<Uint8Array, FrameworkError>> => {
      const abs = pathFor(ref);
      if (!abs.ok) return abs;
      try {
        return ok(await fs.readFile(abs.value));
      } catch (e) {
        return err(mapFsError(e, abs.value));
      }
    },

    getMetadata: async (ref): Promise<Result<FileMeta, FrameworkError>> => {
      const abs = pathFor(ref);
      if (!abs.ok) return abs;
      try {
        const s = await fs.stat(abs.value);
        const name = basename(abs.value);
        const mime = MIME_BY_EXT[extname(name).toLowerCase()];
        // `ref.path` is the stable, root-relative identifier the DAG authored.
        const id = ref.kind === "localPath" ? ref.path : name;
        return ok({
          id,
          name,
          sizeBytes: s.size,
          lastModified: new Date(s.mtimeMs).toISOString(),
          ...(mime !== undefined ? { mimeType: mime } : {}),
        });
      } catch (e) {
        return err(mapFsError(e, abs.value));
      }
    },
  };

  return {
    name: "documents",
    client,

    connect: async () => {
      try {
        await fs.stat(root);
      } catch (e) {
        throw new Error(`fs: rootDir '${config.rootDir}' is not accessible at connect: ${msg(e)}`);
      }
    },

    close: async () => {
      // Nothing to drain.
    },

    healthCheck: async (): Promise<Result<void, string>> => {
      try {
        await fs.stat(root);
        return ok(undefined);
      } catch (e) {
        return err(`fs: rootDir '${config.rootDir}' inaccessible: ${msg(e)}`);
      }
    },
  };
};
