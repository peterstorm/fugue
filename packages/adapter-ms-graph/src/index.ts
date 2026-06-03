/**
 * @fugue/ms-graph — Microsoft Graph adapter for the generic `DocumentSource`
 * capability.
 *
 * Provides a provider-neutral `DocumentSource` interface that nodes access via
 * `requires: ["documents"]` and `ctx.documents`, plus a Microsoft Graph
 * implementation (`createMsGraphAdapter`) that reads files from SharePoint and
 * OneDrive. The same interface is intended to gain a Google Drive adapter
 * later; see ADR-0052 for the extraction trigger.
 *
 * The capability is exactly two operations — `getContent` (bytes) and
 * `getMetadata`. Parsing `.xlsx`/`.csv` bytes into typed rows is a *separate*
 * pure transform in the functional core, not part of this capability.
 *
 * ## Usage
 *
 * ```ts
 * import { createMsGraphAdapter, sharePointPathRef } from "@fugue/ms-graph";
 *
 * // `getAccessToken` is the caller's MSAL / @azure/identity wiring
 * // (app-only client credentials). This adapter never bundles an auth SDK.
 * const docsHandle = createMsGraphAdapter({
 *   getAccessToken: () => credential.getToken("https://graph.microsoft.com/.default").then(t => t.token),
 * });
 *
 * // Register with the host:
 * const sharedInfra = { ..., capabilities: [docsHandle] };
 *
 * // In a node — the file location is known to the DAG, so no LLM tool is needed:
 * createFetchNode({
 *   id: "fetch-sheet",
 *   requires: ["documents"] as const,
 *   fetch: async (input, ctx) => {
 *     const ref = sharePointPathRef({
 *       siteHostname: "contoso.sharepoint.com",
 *       sitePath: "/sites/Finance",
 *       filePath: "/Reports/2026-Q2.xlsx",
 *     });
 *     return ctx.documents.getContent(ref);
 *   },
 * });
 * ```
 *
 * ## Module Augmentation
 *
 * This package augments `@fugue/framework`'s `CapabilityRegistry` to add the
 * `"documents"` capability. After importing this package, `requires:
 * ["documents"]` becomes valid and `ctx.documents` is typed as `DocumentSource`.
 *
 * @satisfies ADR-0052 — Document-source capability (MS Graph adapter)
 * @satisfies ADR-0051 — Extensible capability registry
 */

import { z } from "zod";
import { match } from "ts-pattern";
import type { Result, FrameworkError, CapabilityHandle } from "@fugue/framework";
import { ok, err, nodeId } from "@fugue/framework";

// ---------------------------------------------------------------------------
// File reference ADT — how a DAG names the file it wants
// ---------------------------------------------------------------------------

/**
 * A reference to a file, independent of which provider stores it.
 *
 * A discriminated union: each variant is independently valid and complete, so
 * illegal states (a drive id without an item id, a half-specified SharePoint
 * path, mixed addressing modes) cannot be represented. New providers extend
 * this union additively — e.g. a future `{ kind: "googleDriveFile"; fileId }`.
 */
export type FileRef =
  /** SharePoint, human-authored in config: site host + server-relative site path + file path. */
  | {
      readonly kind: "sharePointPath";
      readonly siteHostname: string;
      readonly sitePath: string;
      readonly filePath: string;
    }
  /** Either backend, once the stable Graph drive + item ids are already held. */
  | { readonly kind: "driveItem"; readonly driveId: string; readonly itemId: string }
  /** Any OneDrive/SharePoint sharing link — Graph resolves the backend via `/shares`. */
  | { readonly kind: "shareUrl"; readonly url: string };

/** Smart constructor for the SharePoint path variant. */
export const sharePointPathRef = (args: {
  siteHostname: string;
  sitePath: string;
  filePath: string;
}): FileRef => ({ kind: "sharePointPath", ...args });

/** Smart constructor for the drive-item-id variant. */
export const driveItemRef = (driveId: string, itemId: string): FileRef => ({
  kind: "driveItem",
  driveId,
  itemId,
});

/** Smart constructor for the sharing-link variant. */
export const shareUrlRef = (url: string): FileRef => ({ kind: "shareUrl", url });

/**
 * Stable string key for a `FileRef`. Used by the fake to route canned
 * responses, and useful for logging/caching. Exported for testing.
 */
export const fileRefKey = (ref: FileRef): string =>
  match(ref)
    .with({ kind: "driveItem" }, (r) => `driveItem:${r.driveId}/${r.itemId}`)
    .with(
      { kind: "sharePointPath" },
      (r) => `sharePointPath:${r.siteHostname}:${r.sitePath}:${r.filePath}`,
    )
    .with({ kind: "shareUrl" }, (r) => `shareUrl:${r.url}`)
    .exhaustive();

// ---------------------------------------------------------------------------
// Capability interface — what nodes see on `ctx.documents`
// ---------------------------------------------------------------------------

/** Lightweight file metadata. Lets a fetch node witness freshness / skip work. */
export interface FileMeta {
  /** Graph driveItem id. */
  readonly id: string;
  /** File name including extension. */
  readonly name: string;
  /** Size in bytes (0 if Graph omits it). */
  readonly sizeBytes: number;
  /** Last-modified timestamp, ISO 8601 UTC. */
  readonly lastModified: string;
  /** Opaque entity tag for change detection, when present. */
  readonly eTag?: string;
  /** MIME type, when present. */
  readonly mimeType?: string;
}

/** Per-call read options. */
export interface ReadOpts {
  /** Caller abort signal (composed with the adapter's request timeout). */
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral document-source capability — the irreducible core every
 * backend shares. Holds ONLY content + metadata reads by design (ADR-0052);
 * provider-specific operations (listing, revisions, upload, search) must NOT
 * be added here — they belong on a provider-specific capability.
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
// Module Augmentation
// ---------------------------------------------------------------------------

declare module "@fugue/framework" {
  interface CapabilityRegistry {
    /**
     * Generic cloud document-source capability. Access via `ctx.documents` in
     * nodes. Backed here by Microsoft Graph; intended to gain peer adapters
     * (e.g. Google Drive) sharing this same interface — see ADR-0052.
     */
    documents: DocumentSource;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimal slice of the global `fetch` the adapter uses. Tests inject a fake. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly redirect?: RequestRedirect;
  },
) => Promise<Response>;

/** Configuration for the Microsoft Graph adapter. */
export interface MsGraphAdapterConfig {
  /**
   * Acquire a bearer token for the Microsoft Graph resource. This is the
   * caller's auth wiring (MSAL / `@azure/identity`, app-only client
   * credentials). Keeping it injected means this adapter ships no auth SDK and
   * the token-cache/refresh policy stays the caller's choice.
   */
  readonly getAccessToken: () => Promise<string>;
  /** Per-request timeout in milliseconds. Default: 30000 (30s). */
  readonly requestTimeoutMs?: number;
  /**
   * Graph base URL. Default: the global cloud. Override for sovereign clouds
   * (e.g. `https://graph.microsoft.us`) or to point tests at a local server.
   */
  readonly graphBaseUrl?: string;
  /** Injected `fetch`, for testing. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Sentinel node ID for ms-graph capability errors. */
const MS_GRAPH_NODE_ID = nodeId("ms-graph-capability");

const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_TIMEOUT_MS = 30_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const transientErr = (message: string, httpStatus?: number): FrameworkError => ({
  kind: "transient",
  nodeId: MS_GRAPH_NODE_ID,
  message,
  ...(httpStatus !== undefined ? { httpStatus } : {}),
});

const crashErr = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: MS_GRAPH_NODE_ID,
  message,
  retriability: "non-retriable",
});

/**
 * Map a Graph HTTP status to a `FrameworkError`. Auth-token expiry (401),
 * request-timeout (408), throttling (429), and server errors (5xx) are
 * `transient` (retriable); permission denials (403), missing files (404), and
 * other 4xx are non-retriable `node-crash`. Exported for testing — this
 * classification drives retry behaviour.
 */
export const mapGraphStatus = (status: number, url: string): FrameworkError => {
  const where = url.split("?")[0];
  if (status === 401 || status === 408 || status === 429 || status >= 500) {
    return transientErr(`Graph ${status} for ${where}`, status);
  }
  return crashErr(`Graph ${status} for ${where}`);
};

/** Compose the caller signal with a per-request timeout. */
const buildSignal = (opts: ReadOpts | undefined, timeoutMs: number): AbortSignal | undefined => {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
};

/** Percent-encode each path segment while preserving `/` separators. */
const encodePath = (p: string): string =>
  p
    .split("/")
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join("/");

/**
 * Encode a sharing URL into a Graph share token (`u!{base64url}`), per the
 * Graph `/shares` addressing scheme. Exported for testing.
 */
export const encodeShareUrl = (url: string): string => {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  const b64url = b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${b64url}`;
};

/**
 * Resolve a `FileRef` to its Graph content + metadata URLs. Exported for
 * testing. Exhaustive over the current union; a new variant (e.g. a foreign
 * `googleDriveFile`) becomes a compile error here until handled, and — once the
 * port type is shared across adapters (ADR-0052) — a runtime fail-closed error.
 */
export const resolveUrls = (
  ref: FileRef,
  base: string = DEFAULT_GRAPH_BASE,
): { content: string; metadata: string } =>
  match(ref)
    .with({ kind: "driveItem" }, (r) => {
      const item = `${base}/drives/${encodeURIComponent(r.driveId)}/items/${encodeURIComponent(r.itemId)}`;
      return { content: `${item}/content`, metadata: item };
    })
    .with({ kind: "sharePointPath" }, (r) => {
      const site = `${base}/sites/${encodeURIComponent(r.siteHostname)}:/${encodePath(r.sitePath)}:`;
      const item = `${site}/drive/root:/${encodePath(r.filePath)}`;
      return { content: `${item}:/content`, metadata: item };
    })
    .with({ kind: "shareUrl" }, (r) => {
      const item = `${base}/shares/${encodeShareUrl(r.url)}/driveItem`;
      return { content: `${item}/content`, metadata: item };
    })
    .exhaustive();

/** Shape of the Graph driveItem JSON the adapter relies on. */
const DriveItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().optional(),
  lastModifiedDateTime: z.string(),
  eTag: z.string().optional(),
  file: z.object({ mimeType: z.string().optional() }).optional(),
});

const acquireToken = async (
  getAccessToken: () => Promise<string>,
): Promise<Result<string, FrameworkError>> => {
  try {
    const token = await getAccessToken();
    if (!token) return err(transientErr("token provider returned an empty token"));
    return ok(token);
  } catch (e) {
    return err(transientErr(`token acquisition failed: ${msg(e)}`));
  }
};

const graphGet = async (
  fetchImpl: FetchLike,
  url: string,
  token: string,
  accept: string,
  opts: ReadOpts | undefined,
  timeoutMs: number,
): Promise<Result<Response, FrameworkError>> => {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: buildSignal(opts, timeoutMs),
      // Graph `/content` 302-redirects to a pre-authenticated download URL.
      // Default redirect-following works; a hardened impl would refetch the
      // location without the Authorization header.
      redirect: "follow",
    });
    if (!res.ok) return err(mapGraphStatus(res.status, url));
    return ok(res);
  } catch (e) {
    return err(transientErr(`Graph request failed for ${url.split("?")[0]}: ${msg(e)}`));
  }
};

// ---------------------------------------------------------------------------
// Adapter Factory
// ---------------------------------------------------------------------------

/**
 * Create a Microsoft Graph `DocumentSource` capability handle.
 *
 * Lifecycle:
 * - `connect()`: acquires a token once to validate the auth wiring at boot.
 * - `close()`: no-op (no pooled resources; the token provider owns its cache).
 * - `healthCheck()`: re-acquires a token (liveness proxy for the auth path).
 */
export const createMsGraphAdapter = (config: MsGraphAdapterConfig): CapabilityHandle<"documents"> => {
  const base = config.graphBaseUrl ?? DEFAULT_GRAPH_BASE;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init));

  const client: DocumentSource = {
    getContent: async (ref, opts): Promise<Result<Uint8Array, FrameworkError>> => {
      const token = await acquireToken(config.getAccessToken);
      if (!token.ok) return token;
      const { content } = resolveUrls(ref, base);
      const res = await graphGet(fetchImpl, content, token.value, "application/octet-stream", opts, timeoutMs);
      if (!res.ok) return res;
      try {
        const buf = await res.value.arrayBuffer();
        return ok(new Uint8Array(buf));
      } catch (e) {
        return err(transientErr(`failed reading Graph response body: ${msg(e)}`));
      }
    },

    getMetadata: async (ref, opts): Promise<Result<FileMeta, FrameworkError>> => {
      const token = await acquireToken(config.getAccessToken);
      if (!token.ok) return token;
      const { metadata } = resolveUrls(ref, base);
      const res = await graphGet(fetchImpl, metadata, token.value, "application/json", opts, timeoutMs);
      if (!res.ok) return res;
      let json: unknown;
      try {
        json = await res.value.json();
      } catch (e) {
        return err(transientErr(`failed parsing Graph metadata JSON: ${msg(e)}`));
      }
      const parsed = DriveItemSchema.safeParse(json);
      if (!parsed.success) {
        return err(crashErr(`unexpected Graph driveItem shape: ${parsed.error.message}`));
      }
      const d = parsed.data;
      return ok({
        id: d.id,
        name: d.name,
        sizeBytes: d.size ?? 0,
        lastModified: d.lastModifiedDateTime,
        ...(d.eTag !== undefined ? { eTag: d.eTag } : {}),
        ...(d.file?.mimeType !== undefined ? { mimeType: d.file.mimeType } : {}),
      });
    },
  };

  return {
    name: "documents",
    client,

    connect: async () => {
      const token = await config.getAccessToken();
      if (!token) {
        throw new Error("ms-graph: token provider returned an empty token at connect");
      }
    },

    close: async () => {
      // No pooled resources to drain; the injected token provider owns its cache.
    },

    healthCheck: async (): Promise<Result<void, string>> => {
      try {
        const token = await config.getAccessToken();
        return token ? ok(undefined) : err("ms-graph: empty token");
      } catch (e) {
        return err(`ms-graph: ${msg(e)}`);
      }
    },
  };
};

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

/**
 * In-memory fake `DocumentSource` for unit-testing nodes that use
 * `ctx.documents`. Routes are keyed by `fileRefKey(ref)`.
 *
 * @example
 * ```ts
 * const fakeDocs = createFakeDocumentSource({
 *   [fileRefKey(driveItemRef("d1", "i1"))]: { content: new Uint8Array([1, 2, 3]) },
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
      return err(crashErr(`fake: no content route for ${fileRefKey(ref)}`));
    },

    getMetadata: async (ref): Promise<Result<FileMeta, FrameworkError>> => {
      const route = routes[fileRefKey(ref)];
      if (route?.error) return err(route.error);
      if (route?.metadata) return ok(route.metadata);
      return err(crashErr(`fake: no metadata route for ${fileRefKey(ref)}`));
    },
  };

  return { name: "documents", client };
};
