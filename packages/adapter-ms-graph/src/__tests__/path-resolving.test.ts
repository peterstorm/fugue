import { describe, expect, test } from "bun:test";
import { createPathResolvingMsGraphAdapter, driveItemRef, sharePointPathRef } from "../index.js";
import type { FetchLike } from "../index.js";

/**
 * The path-resolving ms-graph wrapper (path-resolving.ts, opt-in for the
 * tenant class in peterstorm/fugue#36). Tested with
 * the REAL inner stock adapter underneath — one scripted fake fetch covers
 * both the wrapper's resolution calls (site lookup, drive root, folder
 * children) and the inner adapter's driveItem metadata/content calls.
 */

interface RecordedCall {
  readonly url: string;
  readonly path: string;
}

const BASE = "https://graph.microsoft.com/v1.0";

interface FakeGraphState {
  /** folder itemId → children (name, id, size?) */
  children: Map<string, { name: string; id: string; size?: number }[]>;
  /** item id → metadata or undefined (= 404) */
  items: Map<string, Record<string, unknown>>;
  /** item id → content bytes */
  content: Map<string, Uint8Array>;
  /** item id → forced 404 for the metadata/content call (self-heal tests) */
  missing: Set<string>;
  calls: RecordedCall[];
}

const meta = (id: string, name: string, size: number, eTag: string): Record<string, unknown> => ({
  id,
  name,
  size,
  eTag,
  lastModifiedDateTime: "2026-07-11T04:26:14Z",
  file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
});

const makeFakeGraph = (state: FakeGraphState): FetchLike =>
  async (url, _init) => {
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    state.calls.push({ url, path });

    // ── wrapper resolution calls ──────────────────────────────────────────
    if (path === "/sites/contoso.sharepoint.com:" || path === "/sites/contoso.sharepoint.com:/sites/Finance") {
      return Response.json({ id: "site-1", name: "Finance", webUrl: "https://contoso.sharepoint.com/sites/Finance" });
    }
    if (path === "/sites/site-1/drive/root") {
      return Response.json({ id: "root-item", name: "root", parentReference: { driveId: "drv-1", id: "root-item" } });
    }
    const childrenMatch = path.match(/^\/drives\/drv-1\/items\/([^/?]+)\/children\?/);
    if (childrenMatch) {
      const folder = decodeURIComponent(childrenMatch[1]);
      // Real Graph 404s a children listing on a deleted item — the fake must
      // too (the folder self-heal test depends on it).
      if (!state.children.has(folder)) {
        return new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      const kids = state.children.get(folder) ?? [];
      const filter = new URLSearchParams(path.split("?")[1]).get("$filter") ?? "";
      const name = /name eq '(.+)'/.exec(filter)?.[1];
      return Response.json({ value: name === undefined ? kids : kids.filter((k) => k.name.toLowerCase() === name.toLowerCase()) });
    }

    // ── inner adapter calls (driveItem addressing) ────────────────────────
    const itemMatch = path.match(/^\/drives\/drv-1\/items\/([^/?]+)(\/content)?$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const isContent = itemMatch[2] !== undefined;
      if (state.missing.has(id)) {
        return new Response(JSON.stringify({ error: { code: "itemNotFound", message: "item not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (isContent) {
        // Graph /content 302s to a pre-authenticated storage URL.
        return new Response(null, { status: 302, headers: { location: `https://storage.example/dl/${id}` } });
      }
      const m = state.items.get(id);
      if (m === undefined) {
        return new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return Response.json(m);
    }
    if (url.startsWith("https://storage.example/dl/")) {
      const id = url.split("/").pop()!;
      const bytes = state.content.get(id);
      if (bytes === undefined) {
        return new Response(JSON.stringify({ error: {} }), { status: 404 });
      }
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }

    return new Response(JSON.stringify({ error: { code: "unexpected", url: path } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };

const SITE = { siteHostname: "contoso.sharepoint.com", sitePath: "/sites/Finance" };
const ref = (filePath: string) => sharePointPathRef({ ...SITE, filePath });

const boot = (state: FakeGraphState) =>
  createPathResolvingMsGraphAdapter({
    getAccessToken: async () => "tok",
    fetchImpl: makeFakeGraph(state),
  });

const freshState = (): FakeGraphState => {
  const state: FakeGraphState = {
    children: new Map([
      ["root-item", [{ name: "workbooks", id: "folder-wb" }]],
      [
        "folder-wb",
        [
          { name: "Brancheliste.xlsx", id: "item-branch", size: 2180000 },
          { name: "Scoringsmodel.xlsx", id: "item-wt", size: 21000 },
        ],
      ],
    ]),
    items: new Map([
      ["item-branch", meta("item-branch", "Brancheliste.xlsx", 2180000, "etag-1")],
      ["item-wt", meta("item-wt", "Scoringsmodel.xlsx", 21000, "etag-2")],
    ]),
    content: new Map([["item-branch", new Uint8Array([1, 2, 3, 4])]]),
    missing: new Set(),
    calls: [],
  };
  return state;
};

const countCalls = (state: FakeGraphState, needle: string): number =>
  state.calls.filter((c) => c.path.includes(needle)).length;

describe("createPathResolvingMsGraphAdapter — resolution", () => {
  test("sharePointPath ref → site lookup → drive root → folder walk → inner driveItem metadata", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Brancheliste.xlsx");
      expect(r.value.sizeBytes).toBe(2180000);
      expect(r.value.eTag).toBe("etag-1");
    }
    // The full walk, and ONLY id-based addressing below the site level.
    expect(state.calls.some((c) => c.path === "/sites/contoso.sharepoint.com:/sites/Finance")).toBe(true);
    expect(state.calls.some((c) => c.path === "/sites/site-1/drive/root")).toBe(true);
    expect(countCalls(state, "/items/root-item/children")).toBe(1); // → workbooks
    expect(countCalls(state, "/items/folder-wb/children")).toBe(1); // → Brancheliste.xlsx
    expect(state.calls.some((c) => c.path === "/drives/drv-1/items/item-branch")).toBe(true);
    // No item-PATH urls (the form this tenant rejects).
    expect(state.calls.some((c) => c.path.includes("root:"))).toBe(false);
  });

  test("repeated reads of the same file do NOT re-walk (item id cached)", async () => {
    const state = freshState();
    const handle = boot(state);
    await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(countCalls(state, "/sites/contoso.sharepoint.com:/sites/Finance")).toBe(1);
    expect(countCalls(state, "/items/root-item/children")).toBe(1);
    expect(countCalls(state, "/items/folder-wb/children")).toBe(1);
  });

  test("different files in the same folder share the folder walk, cache their own items", async () => {
    const state = freshState();
    const handle = boot(state);
    await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    await handle.client.getMetadata(ref("/workbooks/Scoringsmodel.xlsx"));
    expect(countCalls(state, "/items/root-item/children")).toBe(1);
    expect(countCalls(state, "/items/folder-wb/children")).toBe(2);
  });

  test("root site (sitePath '/') uses the documented sites/{host}: form — no trailing slash", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.client.getMetadata(
      sharePointPathRef({ siteHostname: "contoso.sharepoint.com", sitePath: "/", filePath: "/workbooks/Brancheliste.xlsx" }),
    );
    expect(r.ok).toBe(true);
    expect(state.calls.some((c) => c.path === "/sites/contoso.sharepoint.com:")).toBe(true);
  });
});

describe("createPathResolvingMsGraphAdapter — request bounds", () => {
  test("a hung resolution request times out via requestTimeoutMs (bounded transient)", async () => {
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => "tok",
      requestTimeoutMs: 50,
      // Mimics global fetch: the request resolves only if its signal aborts.
      fetchImpl: ((
        _url: string,
        init?: { signal?: AbortSignal },
      ) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig === undefined) return; // no signal → hang (test would time out)
          if (sig.aborted) reject(sig.reason);
          else sig.addEventListener("abort", () => reject(sig.reason), { once: true });
        })) as FetchLike,
    });
    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("transient");
      if (r.error.kind === "transient") expect(r.error.message).toContain("request failed");
    }
  }, 5_000); // a regression (no timeout signal) would hang — fail fast instead

  test("a caller cancel MID-FLIGHT surfaces as non-retriable `aborted` (stock `graphGet` parity), not a retriable transient", async () => {
    const ac = new AbortController();
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => "tok",
      // Short timeout so its AbortSignal expires quickly and cannot hold the
      // test process alive after this test settles (the caller aborts first).
      requestTimeoutMs: 50,
      // Mimics global fetch: the request resolves only if its signal aborts.
      fetchImpl: ((
        _url: string,
        init?: { signal?: AbortSignal },
      ) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig === undefined) return; // no signal → hang (test would time out)
          if (sig.aborted) reject(sig.reason);
          else sig.addEventListener("abort", () => reject(sig.reason), { once: true });
        })) as FetchLike,
    });
    const pending = handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"), { signal: ac.signal });
    // Let the (simulated) request register its listener, THEN cancel — this is
    // the mid-flight case, not the already-aborted pre-check.
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // `aborted` (terminal), NOT `transient` (which would burn the node's
      // retry budget on a deliberate cancel).
      expect(r.error.kind).toBe("aborted");
      if (r.error.kind === "aborted") expect(r.error.reason).toContain("aborted");
    }
  }, 5_000);

  test("an already-aborted caller signal fails fast as non-retriable `aborted` (no request made)", async () => {
    const state = freshState();
    const handle = boot(state);
    const ac = new AbortController();
    ac.abort();
    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"), { signal: ac.signal });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("aborted");
      if (r.error.kind === "aborted") expect(r.error.reason).toContain("aborted");
    }
    expect(state.calls).toHaveLength(0);
  });
});

describe("createPathResolvingMsGraphAdapter — content", () => {
  test("getContent walks, then the inner adapter's redirect-safe /content fetch delivers bytes", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.client.getContent(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.value]).toEqual([1, 2, 3, 4]);
    expect(state.calls.some((c) => c.path === "/drives/drv-1/items/item-branch/content")).toBe(true);
    expect(state.calls.some((c) => c.url === "https://storage.example/dl/item-branch")).toBe(true);
  });
});

describe("createPathResolvingMsGraphAdapter — self-heal", () => {
  test("stale cached item (404) → cache dropped, path re-walked, retried once", async () => {
    const state = freshState();
    const handle = boot(state);
    const first = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(first.ok).toBe(true);

    // The business DELETED + re-uploaded the workbook: same name, NEW item id.
    state.children.set("folder-wb", [
      { name: "Brancheliste.xlsx", id: "item-branch-v2" },
      { name: "Scoringsmodel.xlsx", id: "item-wt" },
    ]);
    state.items.set("item-branch-v2", meta("item-branch-v2", "Brancheliste.xlsx", 2200000, "etag-9"));

    // The CACHED id now 404s — the wrapper must notice, re-walk, and recover.
    state.missing.add("item-branch");
    const second = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.eTag).toBe("etag-9");
      expect(second.value.sizeBytes).toBe(2200000);
    }
    // Re-walk happened exactly once more — including the folder PREFIX, which
    // must have been invalidated too (otherwise the re-walk would skip it).
    expect(countCalls(state, "/items/root-item/children")).toBe(2);
    expect(countCalls(state, "/items/folder-wb/children")).toBe(2);
    // …and the retry hit the NEW item.
    expect(state.calls.some((c) => c.path === "/drives/drv-1/items/item-branch-v2")).toBe(true);
    // No infinite retry loop: the OLD item is attempted exactly twice (first
    // read + the 404'd retry), the NEW item once. Exact path match — the
    // substring "item-branch" would also count "item-branch-v2".
    expect(state.calls.filter((c) => c.path === "/drives/drv-1/items/item-branch").length).toBe(2);
  });

  test("a truly-gone file (deleted, NOT re-uploaded) → the re-walk's notFoundInFolder surfaces, not the raw 404", async () => {
    const state = freshState();
    const handle = boot(state);
    const first = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(first.ok).toBe(true);

    // The workbook is deleted and never re-uploaded: the cached id 404s, and
    // the re-walk finds no such child in the folder.
    state.children.set("folder-wb", [{ name: "Scoringsmodel.xlsx", id: "item-wt" }]);
    state.missing.add("item-branch");

    const second = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The PRECISE error — naming folder + segment — not "Graph 404 for …/items/item-branch".
      expect(second.error.kind).toBe("node-crash");
      if (second.error.kind === "node-crash") {
        expect(second.error.retriability).toBe("non-retriable");
        expect(second.error.message).toContain("Brancheliste.xlsx");
        expect(second.error.message).toContain("folder-wb");
        expect(second.error.message).not.toContain("/items/item-branch");
      }
    }
  });

  test("a transient re-walk failure (503 mid-walk) stays TRANSIENT — retriability is never inverted", async () => {
    const state = freshState();
    // 503 the folder listing exactly ONCE, on the next hit (the self-heal re-walk).
    let throttleNextListing = false;
    const fetchImpl: FetchLike = async (url, init) => {
      if (throttleNextListing && url.includes("/items/folder-wb/children")) {
        throttleNextListing = false;
        return new Response(JSON.stringify({ error: { code: "throttled" } }), { status: 503 });
      }
      return makeFakeGraph(state)(url, init);
    };
    const handle = createPathResolvingMsGraphAdapter({ getAccessToken: async () => "tok", fetchImpl });
    expect((await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"))).ok).toBe(true);

    // The cached id goes stale (delete-and-reupload) — but the re-walk itself
    // gets throttled. The original non-retriable 404 must NOT be returned over
    // the retriable transient (that would kill the node's retry budget).
    state.children.set("folder-wb", [{ name: "Brancheliste.xlsx", id: "item-branch-v2" }]);
    state.items.set("item-branch-v2", meta("item-branch-v2", "Brancheliste.xlsx", 2200000, "etag-9"));
    state.missing.add("item-branch");
    throttleNextListing = true;

    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("transient");
      if (r.error.kind === "transient") expect(r.error.message).toContain("503");
    }
  });

  test("stale cached FOLDER id (folder deleted + recreated, same name) → prefix dropped, re-walked ONCE", async () => {
    const state = freshState();
    const handle = boot(state);

    // First read caches the folder prefix (workbooks → folder-wb).
    const first = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(first.ok).toBe(true);
    const staleListings = countCalls(state, "/items/folder-wb/children"); // the first walk

    // The business DELETED the workbooks folder and recreated it: same path,
    // NEW folder id; the workbook was re-uploaded (new item id).
    state.children.delete("folder-wb");
    state.children.set("root-item", [{ name: "workbooks", id: "folder-wb-v2" }]);
    state.children.set("folder-wb-v2", [{ name: "Brancheliste.xlsx", id: "item-branch-v2", size: 2200000 }]);
    state.items.set("item-branch-v2", meta("item-branch-v2", "Brancheliste.xlsx", 2200000, "etag-9"));
    state.items.delete("item-branch");
    state.missing.add("item-branch");

    // A path NOT in the item cache forces a walk: it hits the STALE folder id,
    // the children listing 404s, the prefix is dropped, the walk retries once —
    // and Other.xlsx, truly gone, surfaces the precise notFoundInFolder (naming
    // the NEW folder), not a raw 404.
    const r = await handle.client.getMetadata(ref("/workbooks/Other.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("node-crash");
      if (r.error.kind === "node-crash") {
        expect(r.error.retriability).toBe("non-retriable");
        expect(r.error.message).toContain("Other.xlsx");
        expect(r.error.message).toContain("folder-wb-v2");
      }
    }
    // The STALE folder id was listed exactly ONCE more (the 404 that
    // triggered the self-heal) — the drop prevents any further listing of it.
    // The fresh folder is listed at least once (the file-level self-heal on r2
    // below drops the path's prefixes wholesale, so a second fresh listing is
    // expected and bounded).
    expect(countCalls(state, "/items/folder-wb/children")).toBe(staleListings + 1);
    expect(countCalls(state, "/items/folder-wb-v2/children")).toBeGreaterThanOrEqual(1);

    // And the re-uploaded workbook resolves through the fresh walk — without
    // re-listing the stale folder.
    const r2 = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.eTag).toBe("etag-9");
    expect(countCalls(state, "/items/folder-wb/children")).toBe(staleListings + 1);
  });
});

describe("createPathResolvingMsGraphAdapter — failures", () => {
  test("missing segment → non-retriable node-crash naming folder + segment", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.client.getMetadata(ref("/workbooks/Nope.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("node-crash");
      if (r.error.kind === "node-crash") {
        expect(r.error.retriability).toBe("non-retriable");
        expect(r.error.message).toContain("Nope.xlsx");
        expect(r.error.message).toContain("folder-wb");
      }
    }
  });

  test("site lookup 403 → non-retriable node-crash (no folder walk attempted)", async () => {
    const state = freshState();
    // A site the app cannot see.
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => "tok",
      fetchImpl: (async (url: string) => {
        if (url.includes("/sites/other.sharepoint.com:")) {
          return new Response(JSON.stringify({ error: { code: "accessDenied" } }), { status: 403 });
        }
        return makeFakeGraph(state)(url, { method: "GET", headers: {} });
      }) as FetchLike,
    });
    const r = await handle.client.getMetadata(
      sharePointPathRef({ siteHostname: "other.sharepoint.com", sitePath: "/sites/Nope", filePath: "/a.xlsx" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("node-crash");
      if (r.error.kind === "node-crash") expect(r.error.retriability).toBe("non-retriable");
    }
    expect(countCalls(state, "/children")).toBe(0);
  });

  test("token acquisition failure → transient (retriable), preserving the provider's cause (parity with the stock adapter's token-failure surface)", async () => {
    const state = freshState();
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => {
        throw new Error("AADSTS7000215: Invalid client secret provided");
      },
      fetchImpl: makeFakeGraph(state),
    });
    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("transient");
      if (r.error.kind === "transient") {
        // The cause is preserved: the standard token provider's messages are
        // secret-free by design (endpoint host / HTTP status / AADSTS code —
        // the client secret rides in the request body, never in a message),
        // and the stock adapter's twin surfaces the same cause.
        expect(r.error.message).toContain("token acquisition failed for SharePoint path resolution");
        expect(r.error.message).toContain("AADSTS7000215");
      }
    }
  });

  test("an empty token (no provider throw) → transient WITHOUT a spurious cause suffix", async () => {
    const state = freshState();
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => "",
      fetchImpl: makeFakeGraph(state),
    });
    const r = await handle.client.getMetadata(ref("/workbooks/Brancheliste.xlsx"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("transient");
      if (r.error.kind === "transient") {
        expect(r.error.message).toBe("token acquisition failed for SharePoint path resolution");
      }
    }
  });
});

describe("createPathResolvingMsGraphAdapter — listFolder (ops listing, id-based)", () => {
  test("lists a folder's children by id-walk — no item-path urls", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.listFolder("contoso.sharepoint.com", "/sites/Finance", "/workbooks");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((i) => i.name).sort()).toEqual(["Brancheliste.xlsx", "Scoringsmodel.xlsx"]);
      expect(r.value.every((i) => i.sizeBytes !== null)).toBe(true);
    }
    expect(state.calls.some((c) => c.path.includes("root:"))).toBe(false);
  });

  test("an empty folderPath lists the drive root's children (folders: sizeBytes null)", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.listFolder("contoso.sharepoint.com", "/sites/Finance", "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.name).toBe("workbooks");
      expect(r.value[0]?.sizeBytes).toBeNull();
    }
  });
});

describe("createPathResolvingMsGraphAdapter — passthrough", () => {
  test("driveItemRef passes straight through to the inner adapter (no walk)", async () => {
    const state = freshState();
    const handle = boot(state);
    const r = await handle.client.getMetadata(driveItemRef("drv-1", "item-wt"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("Scoringsmodel.xlsx");
    expect(countCalls(state, "/children")).toBe(0);
    expect(state.calls.some((c) => c.path.startsWith("/sites/"))).toBe(false);
  });
});
