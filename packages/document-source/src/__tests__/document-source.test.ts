import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fuguejs/framework";
import {
  sharePointPathRef,
  driveItemRef,
  shareUrlRef,
  localPathRef,
  fileRefKey,
  unsupportedRefError,
  createFakeDocumentSource,
  isoUtcFromDate,
  parseIsoUtc,
  type FileMeta,
} from "../index.js";

describe("FileRef constructors", () => {
  it("build the expected discriminated variants", () => {
    expect(driveItemRef("d", "i")).toEqual({ kind: "driveItem", driveId: "d", itemId: "i" });
    expect(shareUrlRef("https://x/y")).toEqual({ kind: "shareUrl", url: "https://x/y" });
    expect(localPathRef("a/b.xlsx")).toEqual({ kind: "localPath", path: "a/b.xlsx" });
    expect(sharePointPathRef({ siteHostname: "h", sitePath: "/s", filePath: "/f.xlsx" })).toEqual({
      kind: "sharePointPath",
      siteHostname: "h",
      sitePath: "/s",
      filePath: "/f.xlsx",
    });
  });
});

describe("fileRefKey", () => {
  it("is stable and distinct per variant (all four kinds)", () => {
    expect(fileRefKey(driveItemRef("d", "i"))).toBe("driveItem:d/i");
    expect(fileRefKey(shareUrlRef("https://x"))).toBe("shareUrl:https://x");
    expect(fileRefKey(localPathRef("p/q.xlsx"))).toBe("localPath:p/q.xlsx");
    expect(fileRefKey(sharePointPathRef({ siteHostname: "h", sitePath: "/s", filePath: "/f" }))).toBe(
      "sharePointPath:h:/s:/f",
    );
    expect(fileRefKey(localPathRef("a"))).not.toBe(fileRefKey(localPathRef("b")));
  });
});

describe("FileRef constructor validation", () => {
  it("rejects blank fields (empty or whitespace-only) loudly at construction", () => {
    expect(() => localPathRef("")).toThrow(/non-empty/);
    expect(() => localPathRef("   ")).toThrow(/path/);
    expect(() => shareUrlRef("")).toThrow(/url/);
    expect(() => driveItemRef("d", "")).toThrow(/itemId/);
    expect(() => driveItemRef("", "i")).toThrow(/driveId/);
    expect(() => sharePointPathRef({ siteHostname: "", sitePath: "/s", filePath: "/f" })).toThrow(
      /siteHostname/,
    );
    expect(() => sharePointPathRef({ siteHostname: "h", sitePath: " ", filePath: "/f" })).toThrow(
      /sitePath/,
    );
  });

  it("accepts non-blank fields unchanged", () => {
    expect(localPathRef(" a/b.xlsx ")).toEqual({ kind: "localPath", path: " a/b.xlsx " });
  });
});

describe("IsoUtcTimestamp", () => {
  it("isoUtcFromDate produces canonical UTC", () => {
    expect(isoUtcFromDate(new Date("2026-01-01T00:00:00Z")) as string).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parseIsoUtc normalises an offset form to canonical UTC", () => {
    const r = parseIsoUtc("2026-01-01T02:00:00+02:00");
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value as string).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parseIsoUtc rejects an unparseable timestamp as a non-retriable node-crash", () => {
    const r = parseIsoUtc("not-a-date");
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.kind).toBe("node-crash");
  });
});

describe("unsupportedRefError", () => {
  it("is a non-retriable node-crash naming the adapter and ref kind", () => {
    const e = unsupportedRefError("fs", driveItemRef("d", "i"));
    expect(e.kind).toBe("node-crash");
    if (e.kind === "node-crash") {
      expect(e.retriability).toBe("non-retriable");
      expect(e.message).toContain("fs");
      expect(e.message).toContain("driveItem");
    }
  });
});

describe("createFakeDocumentSource", () => {
  const ref = localPathRef("reports/q2.xlsx");
  const meta: FileMeta = { id: "reports/q2.xlsx", name: "q2.xlsx", sizeBytes: 4, lastModified: isoUtcFromDate(new Date("2026-01-01T00:00:00Z")) };

  it("returns canned content and metadata by ref key", async () => {
    const h = createFakeDocumentSource({ [fileRefKey(ref)]: { content: new Uint8Array([1, 2, 3, 4]), metadata: meta } });
    const c = await h.client.getContent(ref);
    const m = await h.client.getMetadata(ref);
    expect(isOk(c)).toBe(true);
    if (c.ok) expect(Array.from(c.value)).toEqual([1, 2, 3, 4]);
    if (m.ok) expect(m.value).toEqual(meta);
  });

  it("returns the configured error", async () => {
    const h = createFakeDocumentSource({
      [fileRefKey(ref)]: { error: { kind: "transient", nodeId: "n" as never, message: "boom" } },
    });
    const c = await h.client.getContent(ref);
    expect(isErr(c)).toBe(true);
  });

  it("errors on an unrouted ref instead of returning empty bytes", async () => {
    const h = createFakeDocumentSource({});
    expect(isErr(await h.client.getContent(ref))).toBe(true);
  });

  it("registers under the documents capability", () => {
    expect(createFakeDocumentSource({}).name).toBe("documents");
  });
});
