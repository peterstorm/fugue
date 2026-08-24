/**
 * @fuguejs/ms-graph — Microsoft Graph adapter for the generic `DocumentSource`
 * capability (`@fuguejs/document-source`).
 *
 * Reads files from SharePoint and OneDrive for nodes that declare
 * `requires: ["documents"]` and use `ctx.documents`. The port types
 * (`DocumentSource`, `FileRef`, `FileMeta`) live in `@fuguejs/document-source`
 * and are re-exported here for convenience.
 *
 * The capability is exactly two operations — `getContent` (bytes) and
 * `getMetadata`. Parsing `.xlsx`/`.csv` bytes into typed rows is a *separate*
 * pure transform in the functional core, not part of this capability.
 *
 * ## Usage
 *
 * ```ts
 * import { createMsGraphAdapter, sharePointPathRef } from "@fuguejs/ms-graph";
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
 * Importing this package (via `@fuguejs/document-source`) augments
 * `CapabilityRegistry` so `requires: ["documents"]` becomes valid and
 * `ctx.documents` is typed as `DocumentSource`.
 *
 * @satisfies ADR-0052 — Document-source capability (MS Graph adapter)
 * @satisfies ADR-0051 — Extensible capability registry
 */

import { z } from "zod";
import { encodePathSegments } from "./path-encoding.js";
import { buildSignal } from "./request-signal.js";
import { match } from "ts-pattern";
import type { Result, FrameworkError, CapabilityHandle } from "@fuguejs/framework";
import { ok, err, nodeId, frameworkError, safeErrorMessage } from "@fuguejs/framework";
import type { DocumentSource, FileRef, FileMeta, ReadOpts } from "@fuguejs/document-source";
import { unsupportedRefError, parseIsoUtc } from "@fuguejs/document-source";

// Re-export the port surface so `@fuguejs/ms-graph` is a one-stop import.
// `localPathRef` is re-exported for port-surface completeness only — this
// adapter fails closed on the `localPath` variant (see `resolveUrls`); use
// `@fuguejs/fs` to actually read local files.
export {
  sharePointPathRef,
  driveItemRef,
  shareUrlRef,
  localPathRef,
  fileRefKey,
  createFakeDocumentSource,
  isoUtcFromDate,
  parseIsoUtc,
} from "@fuguejs/document-source";
export type {
  FileRef,
  FileMeta,
  ReadOpts,
  DocumentSource,
  FakeDocRoute,
  IsoUtcTimestamp,
} from "@fuguejs/document-source";

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

export const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const DEFAULT_TIMEOUT_MS = 30_000;

// Route through the canonical `frameworkError.transient` factory so the
// `httpStatus` spread logic lives in exactly one place; this helper just pins
// the ms-graph sentinel node id.
const transientErr = (message: string, httpStatus?: number): FrameworkError =>
  frameworkError.transient(MS_GRAPH_NODE_ID, message, httpStatus);

const crashErr = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: MS_GRAPH_NODE_ID,
  message,
  retriability: "non-retriable",
});

const abortedErr = (url: string): FrameworkError => ({
  kind: "aborted",
  reason: `Graph request aborted by caller signal: ${url.split("?")[0]}`,
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
 * Resolve a `FileRef` to its Graph content + metadata URLs. Handles the three
 * MS Graph variants; any other variant (e.g. `localPath`, or a future foreign
 * provider) fails closed with an `unsupported-ref` error — the runtime half of
 * the ref↔adapter contract (ADR-0052). Exported for testing.
 */
export const resolveUrls = (
  ref: FileRef,
  base: string = DEFAULT_GRAPH_BASE,
): Result<{ content: string; metadata: string }, FrameworkError> =>
  match(ref)
    .with({ kind: "driveItem" }, (r) => {
      const item = `${base}/drives/${encodeURIComponent(r.driveId)}/items/${encodeURIComponent(r.itemId)}`;
      return ok({ content: `${item}/content`, metadata: item });
    })
    .with({ kind: "sharePointPath" }, (r) => {
      const site = `${base}/sites/${encodeURIComponent(r.siteHostname)}:/${encodePathSegments(r.sitePath)}:`;
      const item = `${site}/drive/root:/${encodePathSegments(r.filePath)}`;
      return ok({ content: `${item}:/content`, metadata: item });
    })
    .with({ kind: "shareUrl" }, (r) => {
      const item = `${base}/shares/${encodeShareUrl(r.url)}/driveItem`;
      return ok({ content: `${item}/content`, metadata: item });
    })
    .otherwise((r) => err(unsupportedRefError("ms-graph", r)));

/** Shape of the Graph driveItem JSON the adapter relies on. */
const DriveItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().optional(),
  // Validated as ISO 8601 here; re-normalised to canonical UTC via `parseIsoUtc`
  // before it becomes `FileMeta.lastModified` (an `IsoUtcTimestamp`), so this
  // adapter and the fs adapter can never disagree on timestamp format.
  lastModifiedDateTime: z.string().datetime({ offset: true }),
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
    return err(transientErr(`token acquisition failed: ${safeErrorMessage(e)}`));
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
  // Fail fast on a caller signal that's already aborted — a non-retriable
  // `aborted` (not a retriable `transient`), so the retry policy fast-fails it.
  if (opts?.signal?.aborted) return err(abortedErr(url));
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: buildSignal(opts, timeoutMs),
      // Graph `/content` 302-redirects to a pre-authenticated, short-lived
      // download URL on a foreign storage host. Follow the redirect manually so
      // the bearer token is NOT forwarded off the Graph origin — the redirect
      // target is already authenticated via its signed query string.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location == null || location.length === 0) {
        return err(transientErr(`Graph ${res.status} redirect missing Location for ${url.split("?")[0]}`));
      }
      const redirected = await fetchImpl(location, {
        method: "GET",
        headers: { Accept: accept }, // deliberately no Authorization on the off-origin hop
        signal: buildSignal(opts, timeoutMs),
        redirect: "follow",
      });
      if (!redirected.ok) return err(mapGraphStatus(redirected.status, url));
      return ok(redirected);
    }
    if (!res.ok) return err(mapGraphStatus(res.status, url));
    return ok(res);
  } catch (e) {
    // A caller-initiated cancel is terminal (non-retriable `aborted`); the
    // adapter's own per-request timeout is a retriable `transient`. Both surface
    // as an AbortError on the composed signal (`buildSignal`), so discriminate on
    // the caller's *own* signal rather than the error name — retrying a timeout
    // is correct, retrying a deliberate cancel is not.
    if (opts?.signal?.aborted) return err(abortedErr(url));
    return err(transientErr(`Graph request failed for ${url.split("?")[0]}: ${safeErrorMessage(e)}`));
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
      const urls = resolveUrls(ref, base);
      if (!urls.ok) return urls;
      const res = await graphGet(fetchImpl, urls.value.content, token.value, "application/octet-stream", opts, timeoutMs);
      if (!res.ok) return res;
      try {
        const buf = await res.value.arrayBuffer();
        return ok(new Uint8Array(buf));
      } catch (e) {
        return err(transientErr(`failed reading Graph response body: ${safeErrorMessage(e)}`));
      }
    },

    getMetadata: async (ref, opts): Promise<Result<FileMeta, FrameworkError>> => {
      const token = await acquireToken(config.getAccessToken);
      if (!token.ok) return token;
      const urls = resolveUrls(ref, base);
      if (!urls.ok) return urls;
      const res = await graphGet(fetchImpl, urls.value.metadata, token.value, "application/json", opts, timeoutMs);
      if (!res.ok) return res;
      let json: unknown;
      try {
        json = await res.value.json();
      } catch (e) {
        return err(transientErr(`failed parsing Graph metadata JSON: ${safeErrorMessage(e)}`));
      }
      const parsed = DriveItemSchema.safeParse(json);
      if (!parsed.success) {
        return err(crashErr(`unexpected Graph driveItem shape: ${parsed.error.message}`));
      }
      const d = parsed.data;
      const lastModified = parseIsoUtc(d.lastModifiedDateTime);
      // Unreachable in practice (zod already validated the datetime shape), but
      // keeps the brand honest rather than casting an unvalidated string.
      if (!lastModified.ok) return lastModified;
      return ok({
        id: d.id,
        name: d.name,
        sizeBytes: d.size ?? null,
        lastModified: lastModified.value,
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
        return err(`ms-graph: ${safeErrorMessage(e)}`);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Path-resolving wrapper (opt-in, peterstorm/fugue#36)
// ---------------------------------------------------------------------------

/**
 * The path-resolving wrapper for tenants whose Graph backend rejects the
 * documented item-path URL forms tenant-wide (probed live — see
 * `path-resolving.ts` header). Opt-in: standard tenants keep
 * `createMsGraphAdapter`; the host selects this one via
 * `MSGRAPH_RESOLVE_PATHS` (see `@fuguejs/host` config).
 */
export {
  createPathResolvingMsGraphAdapter,
  type PathResolvingMsGraphHandle,
  type SharePointListItem,
} from "./path-resolving.js";
