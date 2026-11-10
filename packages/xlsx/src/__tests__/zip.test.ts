/**
 * ZIP central-directory reader over in-memory bytes (zip.ts): entry listing,
 * random-access inflate (stored and deflated), chunked streaming inflate, the
 * zip-bomb guard, and the non-ZIP / corrupt / unsupported failure kinds.
 */
import { describe, expect, it } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { findEntry, inflateEntry, inflateSlices, readZip } from "../zip.js";
import { openWorkbook } from "../index.js";

const text = (n: number): string => Array.from({ length: n }, (_, i) => `row-${i};`).join("");

/** A two-entry archive: one STORED (level 0), one DEFLATED. */
const archiveBytes = (): Uint8Array =>
  zipSync({
    "stored.txt": [strToU8("hello stored"), { level: 0 }],
    "xl/Deflated.XML": [strToU8(text(2000)), { level: 9 }],
  });

const u32At = (bytes: Uint8Array, at: number, value: number): void => {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
};

const indexOfSig = (bytes: Uint8Array, sig: readonly number[], from = 0): number => {
  for (let i = from; i <= bytes.length - sig.length; i++) {
    if (sig.every((b, k) => bytes[i + k] === b)) return i;
  }
  return -1;
};

const CENTRAL_SIG = [0x50, 0x4b, 0x01, 0x02] as const;
const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04] as const;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("readZip — central directory", () => {
  it("lists every entry with its method and sizes from the central directory", () => {
    const r = readZip(archiveBytes());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.entries.map((e) => e.name);
    expect(names).toEqual(["stored.txt", "xl/Deflated.XML"]);
    const stored = r.value.entries[0]!;
    expect(stored.method).toBe(0);
    expect(stored.uncompressedSize).toBe("hello stored".length);
    expect(r.value.entries[1]!.method).toBe(8);
  });

  it("finds entries case-insensitively and tolerates a leading slash", () => {
    const r = readZip(archiveBytes());
    if (!r.ok) throw new Error("fixture");
    expect(findEntry(r.value, "xl/deflated.xml")?.name).toBe("xl/Deflated.XML");
    expect(findEntry(r.value, "/STORED.TXT")?.name).toBe("stored.txt");
    expect(findEntry(r.value, "missing.xml")).toBeUndefined();
  });

  it("rejects bytes that are not a ZIP archive as not-zip", () => {
    const r = readZip(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("not-zip");
  });

  it("rejects a truncated archive (no end-of-central-directory record) as corrupt", () => {
    const bytes = archiveBytes();
    const r = readZip(bytes.slice(0, bytes.length - 30));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("corrupt");
  });

  it("rejects an encrypted entry as unsupported when it is inflated", () => {
    const bytes = archiveBytes();
    const local = indexOfSig(bytes, LOCAL_SIG);
    bytes[local + 6] = (bytes[local + 6] ?? 0) | 0x01; // general-purpose flag bit 0: encrypted
    const r = readZip(bytes);
    if (!r.ok) throw new Error("directory itself is intact");
    const out = inflateEntry(r.value, r.value.entries[0]!, 1 << 20);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("unsupported");
  });
});

describe("inflateEntry — random access", () => {
  it("returns the exact bytes of stored and deflated entries in any order", () => {
    const r = readZip(archiveBytes());
    if (!r.ok) throw new Error("fixture");
    const deflated = inflateEntry(r.value, r.value.entries[1]!, 1 << 20);
    const stored = inflateEntry(r.value, r.value.entries[0]!, 1 << 20);
    expect(deflated.ok && new TextDecoder().decode(deflated.value)).toBe(text(2000));
    expect(stored.ok && new TextDecoder().decode(stored.value)).toBe("hello stored");
  });

  it("returns the full entry even when its declared size lies low, and still enforces the cap", () => {
    const bytes = archiveBytes();
    const first = indexOfSig(bytes, CENTRAL_SIG);
    const second = indexOfSig(bytes, CENTRAL_SIG, first + 4);
    u32At(bytes, second + 24, 1); // the deflated entry now claims to inflate to 1 byte
    const r = readZip(bytes);
    if (!r.ok) throw new Error("fixture");
    const full = inflateEntry(r.value, r.value.entries[1]!, 1 << 20);
    expect(full.ok && new TextDecoder().decode(full.value)).toBe(text(2000));
    const capped = inflateEntry(r.value, r.value.entries[1]!, 500);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error.kind).toBe("too-large");
  });

  it("refuses an entry whose declared size exceeds the cap (zip-bomb guard)", () => {
    const r = readZip(archiveBytes());
    if (!r.ok) throw new Error("fixture");
    const out = inflateEntry(r.value, r.value.entries[1]!, 100);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("too-large");
  });
});

describe("inflateSlices — chunked streaming inflate", () => {
  it("inflates in compressed slices whose concatenation equals the entry", () => {
    const r = readZip(archiveBytes());
    if (!r.ok) throw new Error("fixture");
    const entry = r.value.entries[1]!;
    const slices: Uint8Array[] = [];
    for (const step of inflateSlices(r.value, entry, { sliceBytes: 7, maxBytes: 1 << 20 })) {
      if (!step.ok) throw new Error(step.error.message);
      slices.push(step.value);
    }
    expect(slices.length).toBe(Math.ceil(entry.compressedSize / 7));
    expect(new TextDecoder().decode(concat(slices))).toBe(text(2000));
  });

  it("streams a stored entry slice by slice", () => {
    const r = readZip(archiveBytes());
    if (!r.ok) throw new Error("fixture");
    const parts = [...inflateSlices(r.value, r.value.entries[0]!, { sliceBytes: 5, maxBytes: 1 << 20 })];
    expect(parts.length).toBe(3);
    expect(new TextDecoder().decode(concat(parts.map((p) => (p.ok ? p.value : new Uint8Array()))))).toBe(
      "hello stored",
    );
  });

  it("stops with too-large when the inflated output overruns the cap despite a lying declared size", () => {
    const bytes = archiveBytes();
    // Second central-directory header = the deflated entry; patch its declared
    // uncompressed size (offset 24) down to 1 byte so only the running cap can catch it.
    const first = indexOfSig(bytes, CENTRAL_SIG);
    const second = indexOfSig(bytes, CENTRAL_SIG, first + 4);
    u32At(bytes, second + 24, 1);
    const r = readZip(bytes);
    if (!r.ok) throw new Error("fixture");
    const steps = [...inflateSlices(r.value, r.value.entries[1]!, { sliceBytes: 64, maxBytes: 500 })];
    const last = steps[steps.length - 1]!;
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error.kind).toBe("too-large");
    expect(steps.slice(0, -1).every((s) => s.ok)).toBe(true);
  });
});

describe("openWorkbook — non-ZIP input", () => {
  it("AS-010: bytes that are not a ZIP archive give a non-retriable node-crash", () => {
    for (const bytes of [new Uint8Array([1, 2, 3, 4]), new Uint8Array(), strToU8("PK not really a zip")]) {
      const r = openWorkbook(bytes);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("node-crash");
        if (r.error.kind === "node-crash") expect(r.error.retriability).toBe("non-retriable");
      }
    }
  });

  it("AS-010: a ZIP that is not a workbook gives a non-retriable node-crash", () => {
    const r = openWorkbook(zipSync({ "readme.txt": strToU8("not a workbook") }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "node-crash") expect(r.error.retriability).toBe("non-retriable");
    else throw new Error("expected node-crash");
  });
});
