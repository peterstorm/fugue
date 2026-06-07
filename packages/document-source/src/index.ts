/**
 * @fuguejs/document-source — the provider-neutral document-source capability port.
 *
 * Defines the `DocumentSource` capability (registry key `documents`), the
 * `FileRef` addressing ADT, `FileMeta`, and a test fake. Adapter packages
 * (`@fuguejs/ms-graph`, `@fuguejs/fs`, …) depend on this package, import the port
 * types, and implement `DocumentSource` for one storage backend. A node
 * declares `requires: ["documents"]` and forwards whatever `FileRef` its
 * configuration provides — so the storage backend is a wiring choice, not a
 * code change.
 *
 * The capability is exactly two operations — `getContent` (bytes) and
 * `getMetadata`. Parsing bytes into typed rows is a separate pure transform in
 * the functional core, not part of this capability. Provider-specific
 * operations (listing, revisions, upload, search) must NOT be added to this
 * port — they belong on a provider-specific capability.
 *
 * @satisfies ADR-0052 — Document-source capability
 * @satisfies ADR-0051 — Extensible capability registry
 */

import { match } from "ts-pattern";
import type { Result, FrameworkError, CapabilityHandle } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// File reference ADT — how a DAG names the file it wants
// ---------------------------------------------------------------------------

/**
 * A reference to a file, independent of which provider stores it.
 *
 * A discriminated union: each variant is independently valid and complete, so
 * illegal states (a drive id without an item id, a half-specified SharePoint
 * path, mixed addressing modes) cannot be represented. New providers extend
 * this union additively. Each adapter handles the variants it understands and
 * fails closed (an `unsupported-ref` error) on the rest — see ADR-0052.
 */
export type FileRef =
  /** SharePoint (MS Graph): site host + server-relative site path + file path. */
  | {
      readonly kind: "sharePointPath";
      readonly siteHostname: string;
      readonly sitePath: string;
      readonly filePath: string;
    }
  /** MS Graph drive item, once the stable drive + item ids are already held. */
  | { readonly kind: "driveItem"; readonly driveId: string; readonly itemId: string }
  /** Any OneDrive/SharePoint sharing link — Graph resolves the backend via `/shares`. */
  | { readonly kind: "shareUrl"; readonly url: string }
  /** A file on the local filesystem, addressed relative to the adapter's root. */
  | { readonly kind: "localPath"; readonly path: string };

/**
 * Reject a blank (empty or whitespace-only) constructor argument.
 *
 * Smart constructors are wiring/authoring helpers, almost always called with
 * literals or DAG input. A blank field is a programmer/wiring error, not a
 * runtime I/O failure — so we fail loud at the call site (which is boot/authoring
 * time, or a node `fetch` where it surfaces as a `node-crash`) rather than let an
 * empty `siteHostname`/`itemId`/`url`/`path` flow to an adapter and resolve to a
 * surprising URL or the filesystem root. Returning `Result` here was rejected: it
 * would force every `localPathRef(...)` inside a node `fetch` to be unwrapped,
 * destroying ergonomics for no real safety gain over fail-loud construction.
 */
const requireNonBlank = (value: string, field: string): string => {
  if (value.trim() === "") {
    throw new Error(`FileRef: '${field}' must be a non-empty string`);
  }
  return value;
};

/** Smart constructor for the SharePoint path variant. */
export const sharePointPathRef = (args: {
  siteHostname: string;
  sitePath: string;
  filePath: string;
}): FileRef => ({
  kind: "sharePointPath",
  siteHostname: requireNonBlank(args.siteHostname, "siteHostname"),
  sitePath: requireNonBlank(args.sitePath, "sitePath"),
  filePath: requireNonBlank(args.filePath, "filePath"),
});

/** Smart constructor for the MS Graph drive-item-id variant. */
export const driveItemRef = (driveId: string, itemId: string): FileRef => ({
  kind: "driveItem",
  driveId: requireNonBlank(driveId, "driveId"),
  itemId: requireNonBlank(itemId, "itemId"),
});

/** Smart constructor for the sharing-link variant. */
export const shareUrlRef = (url: string): FileRef => ({
  kind: "shareUrl",
  url: requireNonBlank(url, "url"),
});

/** Smart constructor for the local-filesystem variant (path relative to the adapter root). */
export const localPathRef = (path: string): FileRef => ({
  kind: "localPath",
  path: requireNonBlank(path, "path"),
});

/**
 * Stable string key for a `FileRef`. Used by the fake to route canned
 * responses, and useful for logging/caching.
 */
export const fileRefKey = (ref: FileRef): string =>
  match(ref)
    .with({ kind: "driveItem" }, (r) => `driveItem:${r.driveId}/${r.itemId}`)
    .with(
      { kind: "sharePointPath" },
      (r) => `sharePointPath:${r.siteHostname}:${r.sitePath}:${r.filePath}`,
    )
    .with({ kind: "shareUrl" }, (r) => `shareUrl:${r.url}`)
    .with({ kind: "localPath" }, (r) => `localPath:${r.path}`)
    .exhaustive();

// ---------------------------------------------------------------------------
// ISO-8601-UTC timestamp — invariant carried by the type, not a comment
// ---------------------------------------------------------------------------

/**
 * A timestamp guaranteed to be canonical ISO 8601 UTC (e.g.
 * `2026-01-01T00:00:00.000Z`). Branded so an arbitrary `string` cannot be
 * assigned to `FileMeta.lastModified` — every adapter must mint one through
 * `isoUtcFromDate` or `parseIsoUtc`, so the "ISO 8601 UTC" contract lives in the
 * type rather than in per-adapter convention.
 */
export type IsoUtcTimestamp = string & { readonly __brand: "IsoUtcTimestamp" };

/**
 * Mint an `IsoUtcTimestamp` from a `Date`. Total: a `Date` is always
 * serialisable to canonical UTC via `toISOString()`. Use this when you already
 * hold a `Date` (e.g. `fs.stat().mtimeMs`).
 */
export const isoUtcFromDate = (d: Date): IsoUtcTimestamp =>
  d.toISOString() as IsoUtcTimestamp;

/**
 * Parse a string into a canonical-UTC `IsoUtcTimestamp`, normalising any valid
 * ISO 8601 input (including offset forms like `+02:00`) to the `…Z` form.
 * Returns an `Err` for unparseable input — use at the boundary where a backend
 * hands you a timestamp string (e.g. MS Graph `lastModifiedDateTime`).
 */
export const parseIsoUtc = (value: string): Result<IsoUtcTimestamp, FrameworkError> => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return err({
      kind: "node-crash",
      nodeId: nodeId("document-source"),
      message: `not a valid ISO 8601 timestamp: '${value}'`,
      retriability: "non-retriable",
    });
  }
  return ok(new Date(ms).toISOString() as IsoUtcTimestamp);
};

// ---------------------------------------------------------------------------
// Capability interface — what nodes see on `ctx.documents`
// ---------------------------------------------------------------------------

/** Lightweight file metadata. Lets a fetch node witness freshness / skip work. */
export interface FileMeta {
  /** Stable identifier (Graph driveItem id, or the relative path for local files). */
  readonly id: string;
  /** File name including extension. */
  readonly name: string;
  /** Size in bytes, or `null` when the backend doesn't report it (distinct from a genuinely empty `0`-byte file). */
  readonly sizeBytes: number | null;
  /** Last-modified timestamp, canonical ISO 8601 UTC (see {@link IsoUtcTimestamp}). */
  readonly lastModified: IsoUtcTimestamp;
  /** Opaque entity tag for change detection, when present. */
  readonly eTag?: string;
  /** MIME type, when present/derivable. */
  readonly mimeType?: string;
}

/** Per-call read options. */
export interface ReadOpts {
  /** Caller abort signal (composed with any adapter request timeout). */
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral document-source capability — the irreducible core every
 * backend shares. Holds ONLY content + metadata reads by design (ADR-0052);
 * provider-specific operations belong on a separate capability.
 *
 * All methods return `Result` — no exceptions escape.
 */
export interface DocumentSource {
  /** Fetch the raw bytes of a file. A missing file is a non-retriable error. */
  getContent(ref: FileRef, opts?: ReadOpts): Promise<Result<Uint8Array, FrameworkError>>;

  /** Fetch lightweight metadata for a file (also a way to test existence). */
  getMetadata(ref: FileRef, opts?: ReadOpts): Promise<Result<FileMeta, FrameworkError>>;
}

// ---------------------------------------------------------------------------
// Module Augmentation — registered once, here, for every adapter
// ---------------------------------------------------------------------------

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    /**
     * Generic cloud/local document-source capability. Access via `ctx.documents`
     * in nodes. Implemented by one of the adapter packages
     * (`@fuguejs/ms-graph`, `@fuguejs/fs`, …) — chosen at wiring time. See ADR-0052.
     */
    documents: DocumentSource;
  }
}

// ---------------------------------------------------------------------------
// Shared error helper for adapters
// ---------------------------------------------------------------------------

/**
 * Build the fail-closed error an adapter returns when handed a `FileRef`
 * variant it does not implement. This is the runtime half of the ref↔adapter
 * contract (ADR-0052): the type system cannot prove the wired adapter
 * understands the ref, so each adapter rejects foreign variants explicitly
 * rather than crashing.
 */
export const unsupportedRefError = (adapter: string, ref: FileRef): FrameworkError => ({
  kind: "node-crash",
  nodeId: nodeId(`${adapter}-capability`),
  message: `${adapter}: unsupported FileRef kind '${ref.kind}'`,
  retriability: "non-retriable",
});

// ---------------------------------------------------------------------------
// Fake for Testing
// ---------------------------------------------------------------------------

/** A canned response for one `FileRef` (keyed by `fileRefKey`). */
export interface FakeDocRoute {
  readonly content?: Uint8Array;
  readonly metadata?: FileMeta;
  /** If set, both reads return this error (takes precedence). */
  readonly error?: FrameworkError;
}

const FAKE_NODE_ID = nodeId("document-source-fake");

const fakeMiss = (ref: FileRef, op: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: FAKE_NODE_ID,
  message: `fake: no ${op} route for ${fileRefKey(ref)}`,
  retriability: "non-retriable",
});

/**
 * In-memory fake `DocumentSource` for unit-testing nodes that use
 * `ctx.documents`. Routes are keyed by `fileRefKey(ref)`. Backend-agnostic —
 * use it regardless of which real adapter the DAG will run against.
 *
 * @example
 * ```ts
 * const fakeDocs = createFakeDocumentSource({
 *   [fileRefKey(localPathRef("reports/q2.xlsx"))]: { content: new Uint8Array([1, 2, 3]) },
 * });
 * ```
 */
export const createFakeDocumentSource = (
  routes: Readonly<Record<string, FakeDocRoute>>,
): CapabilityHandle<"documents"> => {
  const client: DocumentSource = {
    getContent: async (ref): Promise<Result<Uint8Array, FrameworkError>> => {
      const route = routes[fileRefKey(ref)];
      if (route?.error) return err(route.error);
      if (route?.content) return ok(route.content);
      return err(fakeMiss(ref, "content"));
    },

    getMetadata: async (ref): Promise<Result<FileMeta, FrameworkError>> => {
      const route = routes[fileRefKey(ref)];
      if (route?.error) return err(route.error);
      if (route?.metadata) return ok(route.metadata);
      return err(fakeMiss(ref, "metadata"));
    },
  };

  return { name: "documents", client };
};
