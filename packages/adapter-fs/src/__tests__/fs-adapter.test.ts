import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fuguejs/framework";
import { driveItemRef, localPathRef } from "@fuguejs/document-source";
import {
  createFsAdapter,
  resolveWithinRoot,
  mapFsError,
  type FsLike,
} from "../index.js";

const ROOT = "/data/reports";

/** A fake FsLike backed by an in-memory map of absolute path → bytes. */
const fakeFs = (
  files: Readonly<Record<string, Uint8Array>>,
  mtimeMs = Date.parse("2026-05-30T12:00:00Z"),
): FsLike => ({
  readFile: async (p) => {
    const f = files[p];
    if (!f) throw Object.assign(new Error("nope"), { code: "ENOENT" });
    return f;
  },
  stat: async (p) => {
    const f = files[p];
    if (!f) throw Object.assign(new Error("nope"), { code: "ENOENT" });
    return { size: f.byteLength, mtimeMs };
  },
});

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

describe("resolveWithinRoot", () => {
  it("resolves a relative path inside the root", () => {
    const r = resolveWithinRoot(ROOT, "q2/report.xlsx");
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value).toBe("/data/reports/q2/report.xlsx");
  });

  it.each(["../etc/passwd", "../../secret", "/etc/passwd", "q2/../../escape"])(
    "rejects path traversal / escape: %s",
    (bad) => {
      const r = resolveWithinRoot(ROOT, bad);
      expect(isErr(r)).toBe(true);
      if (!r.ok) expect(r.error.kind).toBe("node-crash");
    },
  );

  it("rejects the root itself (not a file)", () => {
    expect(isErr(resolveWithinRoot(ROOT, ""))).toBe(true);
    expect(isErr(resolveWithinRoot(ROOT, "."))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getContent / getMetadata
// ---------------------------------------------------------------------------

describe("createFsAdapter — getContent", () => {
  it("reads bytes for a confined localPath", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/q2.xlsx": bytes }) });
    const c = await h.client.getContent(localPathRef("q2.xlsx"));
    expect(isOk(c)).toBe(true);
    if (c.ok) expect(Array.from(c.value)).toEqual([10, 20, 30]);
  });

  it("returns a non-retriable error for a missing file (ENOENT)", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({}) });
    const c = await h.client.getContent(localPathRef("missing.xlsx"));
    expect(isErr(c)).toBe(true);
    if (!c.ok && c.error.kind === "node-crash") expect(c.error.retriability).toBe("non-retriable");
  });

  it("fails closed on a traversal attempt without touching the fs", async () => {
    let touched = false;
    const spyFs: FsLike = {
      readFile: async () => {
        touched = true;
        return new Uint8Array();
      },
      stat: async () => {
        touched = true;
        return { size: 0, mtimeMs: 0 };
      },
    };
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: spyFs });
    const c = await h.client.getContent(localPathRef("../../etc/passwd"));
    expect(isErr(c)).toBe(true);
    expect(touched).toBe(false);
  });

  it("fails closed (non-retriable) on a foreign FileRef variant", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({}) });
    const c = await h.client.getContent(driveItemRef("d", "i"));
    expect(isErr(c)).toBe(true);
    if (!c.ok && c.error.kind === "node-crash") expect(c.error.message).toContain("unsupported");
  });
});

describe("createFsAdapter — getMetadata", () => {
  it("maps stat to FileMeta with mime inferred from extension", async () => {
    const bytes = new Uint8Array(2048);
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/sub/q2.xlsx": bytes }) });
    const m = await h.client.getMetadata(localPathRef("sub/q2.xlsx"));
    expect(isOk(m)).toBe(true);
    if (m.ok) {
      expect(m.value.id).toBe("sub/q2.xlsx");
      expect(m.value.name).toBe("q2.xlsx");
      expect(m.value.sizeBytes).toBe(2048);
      expect(m.value.lastModified as string).toBe("2026-05-30T12:00:00.000Z");
      expect(m.value.mimeType).toContain("spreadsheetml");
    }
  });

  it("omits mimeType for an unknown extension", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/notes.bin": new Uint8Array(1) }) });
    const m = await h.client.getMetadata(localPathRef("notes.bin"));
    expect(isOk(m)).toBe(true);
    if (m.ok) expect(m.value.mimeType).toBeUndefined();
  });

  it("reports sizeBytes 0 for an empty file (distinct from null 'unreported')", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/empty.xlsx": new Uint8Array(0) }) });
    const m = await h.client.getMetadata(localPathRef("empty.xlsx"));
    expect(isOk(m)).toBe(true);
    if (m.ok) {
      expect(m.value.sizeBytes).toBe(0);
      expect(m.value.sizeBytes).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Abort signal (ReadOpts.signal) — honored like the ms-graph adapter
// ---------------------------------------------------------------------------

describe("createFsAdapter — abort signal", () => {
  it("returns an aborted error when the signal is already aborted (getContent)", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/q2.xlsx": new Uint8Array([1]) }) });
    const c = await h.client.getContent(localPathRef("q2.xlsx"), { signal: AbortSignal.abort() });
    expect(isErr(c)).toBe(true);
    if (!c.ok) expect(c.error.kind).toBe("aborted");
  });

  it("returns an aborted error when the signal is already aborted (getMetadata)", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports/q2.xlsx": new Uint8Array([1]) }) });
    const m = await h.client.getMetadata(localPathRef("q2.xlsx"), { signal: AbortSignal.abort() });
    expect(isErr(m)).toBe(true);
    if (!m.ok) expect(m.error.kind).toBe("aborted");
  });

  it("threads the signal to readFile and maps a mid-read AbortError to aborted", async () => {
    let received: AbortSignal | undefined;
    const fsImpl: FsLike = {
      readFile: async (_p, opts) => {
        received = opts?.signal;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      stat: async () => ({ size: 1, mtimeMs: 0 }),
    };
    const ctrl = new AbortController();
    const h = createFsAdapter({ rootDir: ROOT, fsImpl });
    const c = await h.client.getContent(localPathRef("q2.xlsx"), { signal: ctrl.signal });
    expect(received).toBe(ctrl.signal);
    expect(isErr(c)).toBe(true);
    if (!c.ok) expect(c.error.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + error mapping
// ---------------------------------------------------------------------------

describe("createFsAdapter — lifecycle", () => {
  it("connect succeeds when rootDir is statable", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({ "/data/reports": new Uint8Array(0) }) });
    await expect(h.connect?.()).resolves.toBeUndefined();
  });

  it("connect throws (aborting boot) when rootDir is missing", async () => {
    const h = createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({}) });
    await expect(h.connect?.()).rejects.toThrow();
  });

  it("registers under the documents capability", () => {
    expect(createFsAdapter({ rootDir: ROOT, fsImpl: fakeFs({}) }).name).toBe("documents");
  });
});

describe("mapFsError", () => {
  it("classifies ENOENT/EACCES/EISDIR as non-retriable, EIO as transient", () => {
    expect(mapFsError({ code: "ENOENT" }, "/p").kind).toBe("node-crash");
    expect(mapFsError({ code: "EACCES" }, "/p").kind).toBe("node-crash");
    expect(mapFsError({ code: "EISDIR" }, "/p").kind).toBe("node-crash");
    expect(mapFsError({ code: "EIO" }, "/p").kind).toBe("transient");
  });
});
