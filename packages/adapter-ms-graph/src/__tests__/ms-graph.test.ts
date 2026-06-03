import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fugue/framework";
import {
  createMsGraphAdapter,
  createFakeDocumentSource,
  driveItemRef,
  sharePointPathRef,
  shareUrlRef,
  localPathRef,
  fileRefKey,
  resolveUrls,
  encodeShareUrl,
  mapGraphStatus,
  type FetchLike,
  type FileMeta,
  type MsGraphAdapterConfig,
} from "../index.js";

/** Unwrap a resolveUrls Result in tests, failing loudly on the error path. */
const urls = (...args: Parameters<typeof resolveUrls>) => {
  const r = resolveUrls(...args);
  if (!r.ok) throw new Error(`resolveUrls unexpectedly failed: ${JSON.stringify(r.error)}`);
  return r.value;
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TOKEN = "fake-token";

/** A FetchLike that records the last request and returns a canned Response. */
const stubFetch = (
  responder: (url: string, headers: Readonly<Record<string, string>>) => Response,
): { fetchImpl: FetchLike; lastUrl: () => string; lastHeaders: () => Record<string, string> } => {
  let url = "";
  let headers: Record<string, string> = {};
  const fetchImpl: FetchLike = async (u, init) => {
    url = u;
    headers = { ...init.headers };
    return responder(u, init.headers);
  };
  return { fetchImpl, lastUrl: () => url, lastHeaders: () => headers };
};

const baseConfig = (over: Partial<MsGraphAdapterConfig> = {}): MsGraphAdapterConfig => ({
  getAccessToken: async () => TOKEN,
  ...over,
});

// ---------------------------------------------------------------------------
// FileRef ADT + keys
// ---------------------------------------------------------------------------

describe("FileRef constructors and keys", () => {
  it("driveItemRef builds the driveItem variant", () => {
    expect(driveItemRef("d1", "i1")).toEqual({ kind: "driveItem", driveId: "d1", itemId: "i1" });
  });

  it("sharePointPathRef builds the sharePointPath variant", () => {
    expect(
      sharePointPathRef({ siteHostname: "h", sitePath: "/sites/F", filePath: "/a.xlsx" }),
    ).toEqual({ kind: "sharePointPath", siteHostname: "h", sitePath: "/sites/F", filePath: "/a.xlsx" });
  });

  it("fileRefKey is stable and distinct per variant", () => {
    expect(fileRefKey(driveItemRef("d1", "i1"))).toBe("driveItem:d1/i1");
    expect(fileRefKey(shareUrlRef("https://x/y"))).toBe("shareUrl:https://x/y");
    expect(fileRefKey(driveItemRef("d1", "i1"))).not.toBe(fileRefKey(driveItemRef("d1", "i2")));
  });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe("resolveUrls", () => {
  it("driveItem → /drives/{id}/items/{id}[/content]", () => {
    const { content, metadata } = urls(driveItemRef("drive 1", "item/2"));
    expect(metadata).toBe("https://graph.microsoft.com/v1.0/drives/drive%201/items/item%2F2");
    expect(content).toBe(`${metadata}/content`);
  });

  it("sharePointPath → colon-addressed site + drive path, content delimits with a trailing colon", () => {
    const { content, metadata } = urls(
      sharePointPathRef({
        siteHostname: "contoso.sharepoint.com",
        sitePath: "/sites/Finance",
        filePath: "/Reports/2026 Q2.xlsx",
      }),
    );
    expect(metadata).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Finance:/drive/root:/Reports/2026%20Q2.xlsx",
    );
    expect(content).toBe(`${metadata}:/content`);
  });

  it("shareUrl → /shares/{u!base64url}/driveItem", () => {
    const url = "https://contoso.sharepoint.com/:x:/s/Finance/abc?e=1";
    const { content, metadata } = urls(shareUrlRef(url));
    expect(metadata).toBe(`https://graph.microsoft.com/v1.0/shares/${encodeShareUrl(url)}/driveItem`);
    expect(content).toBe(`${metadata}/content`);
  });

  it("honours a custom graph base URL (sovereign cloud / test server)", () => {
    const { metadata } = urls(driveItemRef("d", "i"), "https://graph.microsoft.us/v1.0");
    expect(metadata).toBe("https://graph.microsoft.us/v1.0/drives/d/items/i");
  });

  it("fails closed (non-retriable) on a foreign FileRef variant (localPath)", () => {
    const r = resolveUrls(localPathRef("reports/q2.xlsx"));
    expect(isErr(r)).toBe(true);
    if (!r.ok) {
      expect(r.error.kind).toBe("node-crash");
      if (r.error.kind === "node-crash") expect(r.error.retriability).toBe("non-retriable");
    }
  });
});

describe("encodeShareUrl", () => {
  it("produces a u! token with base64url alphabet and no padding", () => {
    const token = encodeShareUrl("https://x/y?a=b");
    expect(token.startsWith("u!")).toBe(true);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// Status → FrameworkError classification
// ---------------------------------------------------------------------------

describe("mapGraphStatus", () => {
  it.each([401, 408, 429, 500, 503])("treats %d as transient (retriable)", (status) => {
    const e = mapGraphStatus(status, "https://graph/x");
    expect(e.kind).toBe("transient");
    if (e.kind === "transient") expect(e.httpStatus).toBe(status);
  });

  it.each([403, 404, 400])("treats %d as a non-retriable node-crash", (status) => {
    const e = mapGraphStatus(status, "https://graph/x");
    expect(e.kind).toBe("node-crash");
    if (e.kind === "node-crash") expect(e.retriability).toBe("non-retriable");
  });

  it("strips the query string from the logged URL", () => {
    const e = mapGraphStatus(404, "https://graph/x?token=secret");
    expect(e.kind).toBe("node-crash");
    if (e.kind === "node-crash") expect(e.message).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// getContent
// ---------------------------------------------------------------------------

describe("createMsGraphAdapter — getContent", () => {
  it("returns the file bytes and sends a bearer token", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stub = stubFetch(() => new Response(bytes, { status: 200 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isOk(res)).toBe(true);
    if (res.ok) expect(Array.from(res.value)).toEqual([1, 2, 3, 4]);
    expect(stub.lastHeaders().Authorization).toBe(`Bearer ${TOKEN}`);
    expect(stub.lastUrl()).toBe("https://graph.microsoft.com/v1.0/drives/d/items/i/content");
  });

  it("maps a 404 to a non-retriable node-crash", async () => {
    const stub = stubFetch(() => new Response("not found", { status: 404 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.kind).toBe("node-crash");
      if (res.error.kind === "node-crash") expect(res.error.retriability).toBe("non-retriable");
    }
  });

  it("maps a 429 to a transient error carrying the status", async () => {
    const stub = stubFetch(() => new Response("slow down", { status: 429 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok && res.error.kind === "transient") expect(res.error.httpStatus).toBe(429);
  });

  it("surfaces a token-acquisition failure as transient, without calling fetch", async () => {
    let fetched = false;
    const handle = createMsGraphAdapter({
      getAccessToken: async () => {
        throw new Error("AADSTS700016");
      },
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 200 });
      },
    });

    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) expect(res.error.kind).toBe("transient");
    expect(fetched).toBe(false);
  });

  it("treats an empty token as transient", async () => {
    const handle = createMsGraphAdapter({ getAccessToken: async () => "" });
    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) expect(res.error.kind).toBe("transient");
  });

  it("maps a thrown fetch (network error) to a transient error", async () => {
    const handle = createMsGraphAdapter(
      baseConfig({
        fetchImpl: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    );
    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.kind).toBe("transient");
      if (res.error.kind === "transient") expect(res.error.message).toContain("ECONNRESET");
    }
  });

  it("maps a body-read failure (arrayBuffer throws) to a transient error", async () => {
    // A 2xx response whose body cannot be read — graphGet returns ok(res),
    // then getContent's arrayBuffer() rejects.
    const brokenBody = {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error("stream aborted");
      },
    } as unknown as Response;
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: async () => brokenBody }));

    const res = await handle.client.getContent(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.kind).toBe("transient");
      if (res.error.kind === "transient") expect(res.error.message).toContain("reading Graph response body");
    }
  });
});

// ---------------------------------------------------------------------------
// getMetadata
// ---------------------------------------------------------------------------

describe("createMsGraphAdapter — getMetadata", () => {
  const driveItemJson = {
    id: "01ABC",
    name: "2026-Q2.xlsx",
    size: 20480,
    lastModifiedDateTime: "2026-05-30T12:00:00Z",
    eTag: "\"{etag},3\"",
    file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  };

  it("maps the Graph driveItem JSON to FileMeta", async () => {
    const stub = stubFetch(
      () => new Response(JSON.stringify(driveItemJson), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getMetadata(driveItemRef("d", "i"));
    expect(isOk(res)).toBe(true);
    if (res.ok) {
      const meta: FileMeta = res.value;
      expect(meta.id).toBe("01ABC");
      expect(meta.name).toBe("2026-Q2.xlsx");
      expect(meta.sizeBytes).toBe(20480);
      expect(meta.lastModified).toBe("2026-05-30T12:00:00Z");
      expect(meta.mimeType).toContain("spreadsheetml");
    }
    // metadata URL omits the /content suffix
    expect(stub.lastUrl()).toBe("https://graph.microsoft.com/v1.0/drives/d/items/i");
  });

  it("reports sizeBytes as null when Graph omits size (distinct from a 0-byte file)", async () => {
    const { size: _omit, ...noSize } = driveItemJson;
    const stub = stubFetch(() => new Response(JSON.stringify(noSize), { status: 200 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getMetadata(driveItemRef("d", "i"));
    expect(isOk(res)).toBe(true);
    if (res.ok) expect(res.value.sizeBytes).toBeNull();
  });

  it("surfaces a malformed metadata JSON body as transient", async () => {
    const stub = stubFetch(() => new Response("{ not json", { status: 200 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getMetadata(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) expect(res.error.kind).toBe("transient");
  });

  it("rejects an unexpected driveItem shape as a non-retriable node-crash", async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    const handle = createMsGraphAdapter(baseConfig({ fetchImpl: stub.fetchImpl }));

    const res = await handle.client.getMetadata(driveItemRef("d", "i"));
    expect(isErr(res)).toBe(true);
    if (!res.ok) expect(res.error.kind).toBe("node-crash");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("createMsGraphAdapter — lifecycle", () => {
  it("connect succeeds when a token is acquired", async () => {
    const handle = createMsGraphAdapter(baseConfig());
    await expect(handle.connect?.()).resolves.toBeUndefined();
  });

  it("connect throws (aborting boot) when the token provider fails", async () => {
    const handle = createMsGraphAdapter({
      getAccessToken: async () => {
        throw new Error("no creds");
      },
    });
    await expect(handle.connect?.()).rejects.toThrow();
  });

  it("healthCheck reports ok with a token and err without", async () => {
    const okHandle = createMsGraphAdapter(baseConfig());
    expect(isOk((await okHandle.healthCheck?.())!)).toBe(true);

    const badHandle = createMsGraphAdapter({ getAccessToken: async () => "" });
    expect(isErr((await badHandle.healthCheck?.())!)).toBe(true);
  });

  it("registers under the documents capability", () => {
    expect(createMsGraphAdapter(baseConfig()).name).toBe("documents");
  });
});

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

describe("createFakeDocumentSource", () => {
  const ref = driveItemRef("d1", "i1");

  it("returns canned content and metadata by ref key", async () => {
    const meta: FileMeta = { id: "x", name: "f.xlsx", sizeBytes: 10, lastModified: "2026-01-01T00:00:00Z" };
    const handle = createFakeDocumentSource({
      [fileRefKey(ref)]: { content: new Uint8Array([9]), metadata: meta },
    });

    const c = await handle.client.getContent(ref);
    const m = await handle.client.getMetadata(ref);
    expect(isOk(c)).toBe(true);
    if (c.ok) expect(Array.from(c.value)).toEqual([9]);
    expect(isOk(m)).toBe(true);
    if (m.ok) expect(m.value).toEqual(meta);
  });

  it("returns the configured error for a ref", async () => {
    const handle = createFakeDocumentSource({
      [fileRefKey(ref)]: { error: { kind: "transient", nodeId: "n" as never, message: "boom" } },
    });
    const c = await handle.client.getContent(ref);
    expect(isErr(c)).toBe(true);
    if (!c.ok) expect(c.error.kind).toBe("transient");
  });

  it("errors on an unrouted ref instead of returning empty bytes", async () => {
    const handle = createFakeDocumentSource({});
    const c = await handle.client.getContent(ref);
    expect(isErr(c)).toBe(true);
  });
});
