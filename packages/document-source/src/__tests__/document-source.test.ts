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
  createCachedDocumentParser,
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

describe("createCachedDocumentParser", () => {
  const ref = localPathRef("report.xlsx");
  const meta = (lastModified: string, sizeBytes = 100, eTag?: string): FileMeta => ({
    id: "report.xlsx", name: "report.xlsx", sizeBytes,
    lastModified: isoUtcFromDate(new Date(lastModified)),
    ...(eTag !== undefined ? { eTag } : {}),
  });

  /** Counting DocumentSource: tracks getContent/getMetadata calls; mutable routes. */
  const countingSource = (initial: { content: Uint8Array; metadata: FileMeta }) => {
    const state = { ...initial, contentCalls: 0, metadataCalls: 0 };
    const source = {
      getContent: async () => { state.contentCalls++; return { ok: true as const, value: state.content }; },
      getMetadata: async () => { state.metadataCalls++; return { ok: true as const, value: state.metadata }; },
    };
    return { source, state };
  };

  it("parses once while the fingerprint is unchanged — repeats cost one getMetadata", async () => {
    let parses = 0;
    const read = createCachedDocumentParser(async (bytes) => {
      parses++;
      return { ok: true as const, value: bytes.length };
    });
    const { source, state } = countingSource({ content: new Uint8Array(7), metadata: meta("2026-06-01T00:00:00Z", 7) });

    const a = await read(source, ref);
    await read(source, ref);
    const c = await read(source, ref);

    expect(isOk(a) && a.value).toBe(7);
    expect(isOk(c) && c.value).toBe(7);
    expect(parses).toBe(1);
    expect(state.contentCalls).toBe(1);
    expect(state.metadataCalls).toBe(3);
  });

  it("re-parses when the file changes (lastModified+size fingerprint)", async () => {
    let parses = 0;
    const read = createCachedDocumentParser(async (bytes) => {
      parses++;
      return { ok: true as const, value: bytes.length };
    });
    const { source, state } = countingSource({ content: new Uint8Array(7), metadata: meta("2026-06-01T00:00:00Z", 7) });

    await read(source, ref);
    // Newer export dropped with the same name:
    state.content = new Uint8Array(9);
    state.metadata = meta("2026-06-02T00:00:00Z", 9);
    const after = await read(source, ref);

    expect(isOk(after) && after.value).toBe(9);
    expect(parses).toBe(2);
    expect(state.contentCalls).toBe(2);
  });

  it("prefers eTag over lastModified for the fingerprint", async () => {
    let parses = 0;
    const read = createCachedDocumentParser(async () => { parses++; return { ok: true as const, value: parses }; });
    const { source, state } = countingSource({ content: new Uint8Array(1), metadata: meta("2026-06-01T00:00:00Z", 1, "v1") });

    await read(source, ref);
    // lastModified changes but eTag is stable → still cached
    state.metadata = meta("2026-06-02T00:00:00Z", 1, "v1");
    await read(source, ref);
    expect(parses).toBe(1);

    state.metadata = meta("2026-06-02T00:00:00Z", 1, "v2");
    await read(source, ref);
    expect(parses).toBe(2);
  });

  it("fails open to a direct read when getMetadata errors — and does not cache", async () => {
    let parses = 0;
    const read = createCachedDocumentParser(async () => { parses++; return { ok: true as const, value: parses }; });
    const source = {
      getContent: async () => ({ ok: true as const, value: new Uint8Array(1) }),
      getMetadata: async () => ({ ok: false as const, error: { kind: "transient", nodeId: "n", message: "no stat" } as never }),
    };

    const a = await read(source, ref);
    const b = await read(source, ref);
    expect(isOk(a) && isOk(b)).toBe(true);
    expect(parses).toBe(2); // no fingerprint → no memo
  });

  it("does not cache parse failures", async () => {
    let parses = 0;
    const read = createCachedDocumentParser<number>(async () => {
      parses++;
      if (parses === 1) return { ok: false as const, error: { kind: "validation", nodeId: "n", message: "bad row" } as never };
      return { ok: true as const, value: 42 };
    });
    const { source } = countingSource({ content: new Uint8Array(1), metadata: meta("2026-06-01T00:00:00Z", 1) });

    const first = await read(source, ref);
    const second = await read(source, ref);
    expect(isErr(first)).toBe(true);
    expect(isOk(second) && second.value).toBe(42);
  });

  it("dedupes concurrent reads of the same fingerprint into one parse", async () => {
    let parses = 0;
    const read = createCachedDocumentParser(async () => {
      parses++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const, value: "parsed" };
    });
    const { source, state } = countingSource({ content: new Uint8Array(1), metadata: meta("2026-06-01T00:00:00Z", 1) });

    const [a, b, c] = await Promise.all([read(source, ref), read(source, ref), read(source, ref)]);
    expect(isOk(a) && isOk(b) && isOk(c)).toBe(true);
    expect(parses).toBe(1);
    expect(state.contentCalls).toBe(1);
  });
});
