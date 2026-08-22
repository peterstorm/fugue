/**
 * Path-resolving Microsoft Graph adapter — a thin wrapper around the stock
 * `createMsGraphAdapter` that makes `sharePointPathRef` work in tenants where
 * **item-path addressing is rejected** (peterstorm/fugue#36).
 *
 * WHY THIS EXISTS (probed live, 2026-08-17, tenant 3online / 3online.sharepoint.com):
 * the stock adapter resolves `sharePointPathRef` to Graph's documented
 * item-path URLs (`sites/{host}:{path}:/drive/root:/{file}`,
 * `sites/{site-id}/drive/root:/{path}`). In THIS tenant every item-path form
 * 400s ("Url specified is invalid" / "Resource not found for the segment
 * 'root:'") — on multiple sites, via both site and drive context — while:
 *   ✓ `GET /sites/{hostname}:{path}`            (site entity lookup)
 *   ✓ `GET /sites/{site-id}/drive/root`         (navigation property)
 *   ✓ `GET /drives/{driveId}/items/{itemId}…`   (ID-based item addressing)
 * all work. ID-based addressing is the most fundamental Graph surface and is
 * what this wrapper degrades to: it resolves a sharePointPath ref to
 * (driveId, itemId) by listing children per path segment, then delegates the
 * actual metadata/content calls to the stock adapter's driveItem handling
 * (incl. its redirect-safe `/content` fetch and error mapping).
 *
 * Standard tenants keep the stock adapter (`createMsGraphAdapter`) with its
 * documented URL shape — this wrapper is an OPT-IN for the tenant class in
 * #36, so the stock code path is untouched.
 *
 * Caching (per adapter instance — the host process is long-lived):
 *   (siteHostname, sitePath) → siteId                     — forever
 *   siteId                   → { driveId, rootItemId }    — forever
 *   (driveId, folderPrefix)  → folder itemId              — until a 404
 *   (driveId, path)          → file itemId                — until a 404
 * Both 404 shapes are the self-heal, each with a bounded ONE re-walk/retry:
 *   • the business DELETES and re-uploads a file (new item id, same name)
 *     → the delegated byte I/O 404s on the cached file id → the path's cached
 *     ids (file + folder prefixes) are dropped and the call retries ONCE — if
 *     the re-walk itself fails, ITS error is what surfaces (a truly-gone file
 *     → the precise notFoundInFolder; a throttled re-walk stays transient),
 *     never the original 404 over a more precise or retriable failure;
 *   • a FOLDER is deleted + recreated under the same name → the children
 *     listing 404s on the stale folder id mid-walk → the path's cached ids
 *     are dropped and the walk retries ONCE (a file that is truly gone then
 *     surfaces the precise notFoundInFolder error instead of a raw 404).
 * In-place content replacement keeps the item id, so an eTag-keyed workbook
 * cache above the capability still works as designed.
 *
 * Errors: resolution failures use the stock adapter's status mapping
 * (`mapGraphStatus` — 401/408/429/5xx → transient, 4xx → non-retriable
 * node-crash); a segment missing from its folder is a non-retriable
 * node-crash naming the folder + segment. Nothing throws.
 */

import type { CapabilityHandle, FrameworkError, Result } from "@fuguejs/framework";
import { err, frameworkError, nodeId, ok, safeErrorMessage } from "@fuguejs/framework";
import type { DocumentSource, FileRef, ReadOpts } from "@fuguejs/document-source";
import {
  createMsGraphAdapter,
  driveItemRef,
  mapGraphStatus,
  DEFAULT_GRAPH_BASE,
  DEFAULT_TIMEOUT_MS,
} from "./index.js";
import type { FetchLike, MsGraphAdapterConfig } from "./index.js";

/** Sentinel node id for path-resolution errors (distinct from the stock adapter's). */
const SP_RESOLVE_NODE_ID = nodeId("ms-graph-path-resolve");

/**
 * The stock adapter's 404 mapping (non-retriable node-crash). ANCHORED to the
 * stock `mapGraphStatus` message shape — a non-retriable 403/other-4xx whose
 * URL merely CONTAINS "404" (a folder named 404) must never trigger the
 * self-heal. (Structured detection is impossible: the stock `crashErr` drops
 * the httpStatus that its `transientErr` keeps.)
 */
const isGraph404 = (e: FrameworkError): boolean =>
  e.kind === "node-crash" && e.retriability === "non-retriable" && e.message.startsWith("Graph 404 for ");

interface DriveRoot {
  readonly driveId: string;
  readonly rootItemId: string;
}

interface ResolvedItem {
  readonly driveId: string;
  readonly itemId: string;
}

/** One entry of a `listFolder` result (sizeBytes null for folders). */
export interface SharePointListItem {
  readonly name: string;
  readonly sizeBytes: number | null;
}

/**
 * The wrapped handle: the stock `documents` capability plus `listFolder` — an
 * id-based (tenant-safe) folder listing for ops tooling. Hosts that consume
 * the handle as a plain `CapabilityHandle<"documents">` simply ignore the
 * extra property.
 */
export interface PathResolvingMsGraphHandle extends CapabilityHandle<"documents"> {
  readonly listFolder: (
    siteHostname: string,
    sitePath: string,
    folderPath: string,
    opts?: ReadOpts,
  ) => Promise<Result<readonly SharePointListItem[], FrameworkError>>;
}

const enc = encodeURIComponent;

/** Per-segment encoding — the `/` separators of a site path must stay literal. */
const encSegments = (p: string): string =>
  p
    .split("/")
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join("/");

const normPath = (p: string): string => p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");

const itemCacheKey = (driveId: string, filePath: string): string => `${driveId}\n${normPath(filePath)}`;

const notFoundInFolder = (driveId: string, folderItem: string, segment: string): FrameworkError =>
  frameworkError.nodeCrash(
    SP_RESOLVE_NODE_ID,
    `SharePoint path resolution: no item named '${segment}' in drive ${driveId} folder ${folderItem}`,
    { retriability: "non-retriable" },
  );

/**
 * Create the wrapped capability handle for tenants whose Graph backend
 * rejects item-path URLs (peterstorm/fugue#36).
 *
 * `fetchImpl` (optional, for tests / proxy control) is shared by the wrapper's
 * resolution calls AND the inner stock adapter, so one injected fake covers
 * the whole request path. The token provider (`getAccessToken`) is the
 * caller's — the host wires `createMsGraphTokenProvider` (client
 * credentials); this module ships no auth, like the stock adapter.
 */
export const createPathResolvingMsGraphAdapter = (
  config: MsGraphAdapterConfig,
): PathResolvingMsGraphHandle => {
  const base = config.graphBaseUrl ?? DEFAULT_GRAPH_BASE;
  // Same defaults as the stock adapter — one meaning for the knob on both the
  // resolution path (graphJson, below) and the delegated byte I/O (the stock
  // adapter reads the same config fields itself).
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Cast-free exactly like the stock adapter's own default — `FetchLike` is
  // structurally satisfied by global `fetch`.
  const fetchImpl: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init));

  const inner = createMsGraphAdapter(config);
  const innerClient = inner.client;

  const siteIdCache = new Map<string, string>();
  const rootCache = new Map<string, DriveRoot>();
  const itemCache = new Map<string, ResolvedItem>();
  /** Intermediate folder segments: (driveId, prefixPath) → folder itemId. */
  const prefixCache = new Map<string, string>();

  const graphJson = async (
    path: string,
    opts: ReadOpts | undefined,
  ): Promise<Result<unknown, FrameworkError>> => {
    const url = base + path;
    // Fail fast on an already-aborted caller signal — a non-retriable
    // `aborted` (mirroring the stock adapter's `graphGet`): retrying a
    // deliberate cancel is wrong.
    if (opts?.signal?.aborted) {
      return err(frameworkError.aborted(`SharePoint path resolution aborted: ${url.split("?")[0]}`));
    }
    let tokenError: string | null = null;
    const token = await (async () => {
      try {
        return await config.getAccessToken();
      } catch (e) {
        // Preserve the provider's cause: the standard token provider throws
        // precise, actionable messages (endpoint host, HTTP status, missing
        // access_token) — collapsing them into a constant would force the
        // operator to re-derive the cause by hand. The stock adapter's twin
        // preserves the cause the same way.
        tokenError = safeErrorMessage(e);
        return "";
      }
    })();
    if (token.length === 0) {
      return err(
        frameworkError.transient(
          SP_RESOLVE_NODE_ID,
          `token acquisition failed for SharePoint path resolution${tokenError !== null ? `: ${tokenError}` : ""}`,
        ),
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        // Bounded exactly like the stock adapter's `graphGet`: the DAG
        // readers pass NO ReadOpts (no caller signal), so without this
        // per-request timeout a hung Graph endpoint would hang the source
        // node forever.
        signal: opts?.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs),
        redirect: "follow",
      });
    } catch (e) {
      // Mid-flight caller cancel is terminal, exactly like the stock `graphGet`:
      // the composed signal aborts on BOTH the caller signal and the timeout, so
      // discriminate on the caller's *own* signal — retrying a deliberate cancel
      // is wrong (a timeout, by contrast, stays a retriable `transient`).
      if (opts?.signal?.aborted) {
        return err(frameworkError.aborted(`SharePoint path resolution aborted: ${url.split("?")[0]}`));
      }
      return err(
        frameworkError.transient(
          SP_RESOLVE_NODE_ID,
          `SharePoint path resolution request failed: ${safeErrorMessage(e)}`,
        ),
      );
    }
    if (!res.ok) return err(mapGraphStatus(res.status, url));
    try {
      return ok((await res.json()) as unknown);
    } catch {
      return err(frameworkError.transient(SP_RESOLVE_NODE_ID, "SharePoint path resolution returned non-JSON"));
    }
  };

  const resolveSiteId = async (
    siteHostname: string,
    sitePath: string,
    opts?: ReadOpts,
  ): Promise<Result<string, FrameworkError>> => {
    const key = `${siteHostname}\n${sitePath}`;
    const hit = siteIdCache.get(key);
    if (hit !== undefined) return ok(hit);
    // The root site (sitePath "/") is the documented `sites/{host}:` form —
    // no trailing slash. Sub-sites keep the `sites/{host}:{path}` form.
    const pathPart = encSegments(sitePath);
    const r = await graphJson(
      pathPart === "" ? `/sites/${enc(siteHostname)}:` : `/sites/${enc(siteHostname)}:/${pathPart}`,
      opts,
    );
    if (!r.ok) return r;
    const id = (r.value as { id?: string }).id;
    if (typeof id !== "string" || id.length === 0) {
      return err(
        frameworkError.nodeCrash(SP_RESOLVE_NODE_ID, "SharePoint site lookup returned no id", {
          retriability: "non-retriable",
        }),
      );
    }
    siteIdCache.set(key, id);
    return ok(id);
  };

  const resolveDriveRoot = async (
    siteId: string,
    opts?: ReadOpts,
  ): Promise<Result<DriveRoot, FrameworkError>> => {
    const hit = rootCache.get(siteId);
    if (hit !== undefined) return ok(hit);
    const r = await graphJson(`/sites/${siteId}/drive/root`, opts);
    if (!r.ok) return r;
    const d = r.value as { id?: string; parentReference?: { driveId?: string } };
    if (typeof d.id !== "string" || typeof d.parentReference?.driveId !== "string") {
      return err(
        frameworkError.nodeCrash(SP_RESOLVE_NODE_ID, "SharePoint drive root returned an unexpected shape", {
          retriability: "non-retriable",
        }),
      );
    }
    const root: DriveRoot = { driveId: d.parentReference.driveId, rootItemId: d.id };
    rootCache.set(siteId, root);
    return ok(root);
  };

  /** List a folder's children and pick the child named `name` (exact, then case-insensitive). */
  const childItem = async (
    driveId: string,
    folderItemId: string,
    name: string,
    opts?: ReadOpts,
  ): Promise<Result<{ id: string }, FrameworkError>> => {
    const filter = `$filter=${enc(`name eq '${name.replace(/'/g, "''")}'`)}`;
    const r = await graphJson(
      `/drives/${driveId}/items/${folderItemId}/children?$top=200&${filter}`,
      opts,
    );
    if (!r.ok) return r;
    const value = (r.value as { value?: { name?: string; id?: string }[] }).value ?? [];
    const exact = value.find((c) => c.name === name);
    const chosen = exact ?? value.find((c) => c.name?.toLowerCase() === name.toLowerCase());
    if (!chosen || typeof chosen.id !== "string") return err(notFoundInFolder(driveId, folderItemId, name));
    return ok({ id: chosen.id });
  };

  const walkItem = async (
    drive: DriveRoot,
    path: string,
    opts?: ReadOpts,
  ): Promise<Result<ResolvedItem, FrameworkError>> => {
    const segments = normPath(path).split("/").filter((s) => s.length > 0);
    let current = drive.rootItemId;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const prefix = segments.slice(0, i + 1).join("/");
      if (!isLast) {
        // Intermediate folders are cached per prefix, so N files in one folder
        // cost ONE folder listing + N per-file lookups, not N full walks.
        const hit = prefixCache.get(itemCacheKey(drive.driveId, prefix));
        if (hit !== undefined) {
          current = hit;
          continue;
        }
      }
      const child = await childItem(drive.driveId, current, seg, opts);
      if (!child.ok) return child;
      current = child.value.id;
      if (!isLast) prefixCache.set(itemCacheKey(drive.driveId, prefix), current);
    }
    return ok({ driveId: drive.driveId, itemId: current });
  };

  /** Walk with the folder-level self-heal: a 404 from a children listing means
   *  a cached folder id went stale (folder deleted + recreated, same name) —
   *  drop the path's cached ids and re-walk ONCE. */
  const resolveItem = async (
    drive: DriveRoot,
    path: string,
    opts?: ReadOpts,
  ): Promise<Result<ResolvedItem, FrameworkError>> => {
    let r = await walkItem(drive, path, opts);
    if (!r.ok && isGraph404(r.error)) {
      dropPathCaches(drive.driveId, path);
      r = await walkItem(drive, path, opts);
    }
    return r;
  };

  /** Drop every cached id for `path` and its folder prefixes (self-heal on 404). */
  const dropPathCaches = (driveId: string, path: string): void => {
    const segments = normPath(path).split("/").filter((s) => s.length > 0);
    itemCache.delete(itemCacheKey(driveId, path));
    for (let i = 1; i < segments.length; i += 1) {
      prefixCache.delete(itemCacheKey(driveId, segments.slice(0, i).join("/")));
    }
  };

  const resolveRef = async (
    ref: FileRef,
    opts?: ReadOpts,
  ): Promise<Result<FileRef, FrameworkError>> => {
    if (ref.kind !== "sharePointPath") return ok(ref);
    const siteIdR = await resolveSiteId(ref.siteHostname, ref.sitePath, opts);
    if (!siteIdR.ok) return siteIdR;
    const rootR = await resolveDriveRoot(siteIdR.value, opts);
    if (!rootR.ok) return rootR;
    const key = itemCacheKey(rootR.value.driveId, ref.filePath);
    const hit = itemCache.get(key);
    if (hit !== undefined) return ok(driveItemRef(hit.driveId, hit.itemId));
    const itemR = await resolveItem(rootR.value, ref.filePath, opts);
    if (!itemR.ok) return itemR;
    itemCache.set(key, itemR.value);
    return ok(driveItemRef(itemR.value.driveId, itemR.value.itemId));
  };

  /**
   * Delegate to the inner adapter; on a 404, drop the item cache entry and
   * retry once. A FAILED re-walk surfaces its own error — the original 404
   * must never replace a precise notFoundInFolder (file truly gone) or, worse,
   * flip a transient re-walk failure (429/5xx under throttle) into a
   * non-retriable one.
   */
  const withStaleItemRetry = async <T>(
    ref: FileRef,
    call: (resolved: FileRef, opts?: ReadOpts) => Promise<Result<T, FrameworkError>>,
    opts?: ReadOpts,
  ): Promise<Result<T, FrameworkError>> => {
    const resolved = await resolveRef(ref, opts);
    if (!resolved.ok) return resolved;
    let r = await call(resolved.value, opts);
    // A 404 on a resolved sharePointPath ref means the cached item id went stale
    // (file deleted + re-uploaded under the same name). Drop the entry, re-walk,
    // retry once. The resolved ref carries the driveId, so the cache key is
    // reconstructed without any extra lookups.
    if (!r.ok && isGraph404(r.error) && ref.kind === "sharePointPath" && resolved.value.kind === "driveItem") {
      dropPathCaches(resolved.value.driveId, ref.filePath);
      const retry = await resolveRef(ref, opts);
      if (!retry.ok) return retry;
      r = await call(retry.value, opts);
    }
    return r;
  };

  const client: DocumentSource = {
    getContent: (ref, opts) => withStaleItemRetry(ref, (r, o) => innerClient.getContent(r, o), opts),
    getMetadata: (ref, opts) => withStaleItemRetry(ref, (r, o) => innerClient.getMetadata(r, o), opts),
  };

  const listFolder: PathResolvingMsGraphHandle["listFolder"] = async (
    siteHostname,
    sitePath,
    folderPath,
    opts,
  ) => {
    const siteIdR = await resolveSiteId(siteHostname, sitePath, opts);
    if (!siteIdR.ok) return siteIdR;
    const rootR = await resolveDriveRoot(siteIdR.value, opts);
    if (!rootR.ok) return rootR;
    // A folder path walks exactly like a file path (children listings include
    // folder ids); an empty folderPath lists the site's drive root.
    let folderItemId = rootR.value.rootItemId;
    const folderNorm = normPath(folderPath);
    if (folderNorm !== "") {
      const itemR = await resolveItem(rootR.value, folderNorm, opts);
      if (!itemR.ok) return itemR;
      folderItemId = itemR.value.itemId;
    }
    const r = await graphJson(`/drives/${rootR.value.driveId}/items/${folderItemId}/children?$top=500`, opts);
    if (!r.ok) return r;
    const value = (r.value as { value?: { name?: string; size?: number }[] }).value ?? [];
    return ok(
      value.map((c) => ({ name: c.name ?? "(unnamed)", sizeBytes: typeof c.size === "number" ? c.size : null })),
    );
  };

  return {
    name: "documents",
    client,
    // Lifecycle is the inner adapter's (token validation at boot, no-op close).
    connect: inner.connect,
    close: inner.close,
    healthCheck: inner.healthCheck,
    listFolder,
  };
};
