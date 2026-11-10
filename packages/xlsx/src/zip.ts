/**
 * ZIP central-directory reader over bytes that are already in memory.
 *
 * An `.xlsx` is a ZIP. Its bytes arrive whole from `documents.getContent`, so
 * the central directory gives free random access to every part: the small
 * parts (workbook, rels, styles, shared strings) are inflated first, and the
 * worksheet is then streamed in compressed slices. Nothing here buffers more
 * than one slice's inflated output.
 *
 * Pure: reads the input array, never writes it, does no I/O. Failures are
 * values (`ZipError`), never exceptions.
 *
 * Mirrors SheetJS's reader where it matters: entries are found by path
 * case-insensitively (`safegetzipfile`), the encrypted-flag mask is `0x2041`, and
 * only STORED (0) and DEFLATE (8) are supported. ZIP64 is refused: no Office
 * workbook needs it, and a 4 GiB part is far beyond the inflate cap anyway.
 */

import { Inflate, inflateSync } from "fflate";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";

/** Default per-entry inflate cap: a zip-bomb guard (512 MiB). */
export const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export type ZipErrorKind = "not-zip" | "corrupt" | "unsupported" | "too-large";

export interface ZipError {
  readonly kind: ZipErrorKind;
  readonly message: string;
}

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate (anything else is refused when inflated). */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  /** Central-directory order. */
  readonly entries: readonly ZipEntry[];
  /** Lower-cased, slash-normalised name → first entry with that name. */
  readonly byName: ReadonlyMap<string, ZipEntry>;
}

export interface InflateOpts {
  /** Compressed bytes per slice; one result is yielded per slice. */
  readonly sliceBytes: number;
  /** Inflated-size cap for the whole entry. */
  readonly maxBytes: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ENCRYPTED_FLAGS = 0x2041;
const UTF8_NAME_FLAG = 0x0800;

const zipErr = (kind: ZipErrorKind, message: string): Result<never, ZipError> => err({ kind, message });

const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return s;
};

/** Normalise a part path for lookup: no leading slash, forward slashes, lower case. */
const lookupKey = (path: string): string => path.replace(/\\/g, "/").replace(/^\//, "").toLowerCase();

const findEndOfCentralDirectory = (b: Uint8Array): number => {
  const floor = Math.max(0, b.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = b.length - EOCD_SIZE; at >= floor; at--) {
    if (u32(b, at) === SIG_EOCD) return at;
  }
  return -1;
};

/** Read the central directory. Entry data is located lazily, when inflated. */
export const readZip = (bytes: Uint8Array): Result<ZipArchive, ZipError> => {
  if (bytes.length < 4 || u32(bytes, 0) !== SIG_LOCAL) return zipErr("not-zip", "missing ZIP signature");
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) return zipErr("corrupt", "end of central directory not found");

  const count = u16(bytes, eocd + 10);
  const dirOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) return zipErr("unsupported", "ZIP64 archives are not supported");

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== SIG_CENTRAL) {
      return zipErr("corrupt", `central directory entry ${i} is malformed`);
    }
    const flags = u16(bytes, at + 8);
    const nameLength = u16(bytes, at + 28);
    const next = at + 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (next > bytes.length) return zipErr("corrupt", `central directory entry ${i} overruns the archive`);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const entry: ZipEntry = Object.freeze({
      name: flags & UTF8_NAME_FLAG ? new TextDecoder().decode(rawName) : latin1(rawName),
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      uncompressedSize: u32(bytes, at + 24),
      localHeaderOffset: u32(bytes, at + 42),
    });
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      return zipErr("unsupported", `ZIP64 entry '${entry.name}' is not supported`);
    }
    entries.push(entry);
    const key = lookupKey(entry.name);
    if (!byName.has(key)) byName.set(key, entry);
    at = next;
  }
  return ok(Object.freeze({ bytes, entries: Object.freeze(entries), byName }));
};

/** Find a part by path, case-insensitively, ignoring a leading slash. */
export const findEntry = (archive: ZipArchive, path: string): ZipEntry | undefined =>
  archive.byName.get(lookupKey(path));

/** The entry's compressed bytes, after checking its local header. */
const entryData = (archive: ZipArchive, entry: ZipEntry): Result<Uint8Array, ZipError> => {
  const b = archive.bytes;
  const at = entry.localHeaderOffset;
  if (at + 30 > b.length || u32(b, at) !== SIG_LOCAL) {
    return zipErr("corrupt", `local header of '${entry.name}' not found`);
  }
  if (u16(b, at + 6) & ENCRYPTED_FLAGS) return zipErr("unsupported", `'${entry.name}' is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) {
    return zipErr("unsupported", `'${entry.name}' uses unsupported compression method ${entry.method}`);
  }
  const start = at + 30 + u16(b, at + 26) + u16(b, at + 28);
  const end = start + entry.compressedSize;
  if (end > b.length) return zipErr("corrupt", `'${entry.name}' data overruns the archive`);
  return ok(b.subarray(start, end));
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const tooLarge = (entry: ZipEntry, maxBytes: number): Result<never, ZipError> =>
  zipErr("too-large", `'${entry.name}' inflates beyond the ${maxBytes}-byte cap`);

/**
 * Inflate an entry slice by slice: one result per `sliceBytes` of compressed
 * input, holding the bytes that slice inflated to (possibly empty). Iteration
 * ends after the first error. The cap is checked against the declared size up
 * front and against the running inflated total after every slice, so a lying
 * central directory cannot smuggle a bomb through.
 */
export function* inflateSlices(
  archive: ZipArchive,
  entry: ZipEntry,
  opts: InflateOpts,
): Generator<Result<Uint8Array, ZipError>, void, undefined> {
  const data = entryData(archive, entry);
  if (!data.ok) {
    yield data;
    return;
  }
  if (entry.uncompressedSize > opts.maxBytes) {
    yield tooLarge(entry, opts.maxBytes);
    return;
  }
  const compressed = data.value;
  const sliceBytes = Math.max(1, Math.floor(opts.sliceBytes));

  if (entry.method === 0) {
    for (let at = 0; at < compressed.length; at += sliceBytes) {
      if (Math.min(at + sliceBytes, compressed.length) > opts.maxBytes) {
        yield tooLarge(entry, opts.maxBytes);
        return;
      }
      yield ok(compressed.subarray(at, at + sliceBytes));
    }
    return;
  }

  // fflate pushes inflated chunks synchronously into `pending` during `push`.
  let pending: Uint8Array[] = [];
  const inflater = new Inflate((chunk) => {
    pending.push(chunk);
  });
  let total = 0;
  for (let at = 0; at < compressed.length; at += sliceBytes) {
    try {
      inflater.push(compressed.subarray(at, at + sliceBytes), at + sliceBytes >= compressed.length);
    } catch (e) {
      yield zipErr("corrupt", `'${entry.name}' failed to inflate: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const out = concat(pending);
    pending = [];
    total += out.length;
    if (total > opts.maxBytes) {
      yield tooLarge(entry, opts.maxBytes);
      return;
    }
    yield ok(out);
  }
}

const inflateStreamed = (archive: ZipArchive, entry: ZipEntry, maxBytes: number): Result<Uint8Array, ZipError> => {
  const parts: Uint8Array[] = [];
  for (const step of inflateSlices(archive, entry, { sliceBytes: 64 * 1024, maxBytes })) {
    if (!step.ok) return step;
    parts.push(step.value);
  }
  return ok(parts.length === 0 ? new Uint8Array() : concat(parts));
};

/**
 * Inflate a whole (small) entry into one buffer, under the same cap.
 *
 * The fast path inflates in one call into a buffer one byte larger than the
 * declared size: fflate silently truncates at the buffer's end, so a full
 * buffer proves the declared size lied, and the entry is re-inflated through
 * the capped streaming path instead.
 */
export const inflateEntry = (archive: ZipArchive, entry: ZipEntry, maxBytes: number): Result<Uint8Array, ZipError> => {
  if (entry.method !== 8 || entry.uncompressedSize >= maxBytes) return inflateStreamed(archive, entry, maxBytes);
  const data = entryData(archive, entry);
  if (!data.ok) return data;
  let out: Uint8Array;
  try {
    out = inflateSync(data.value, { out: new Uint8Array(entry.uncompressedSize + 1) });
  } catch (e) {
    return zipErr("corrupt", `'${entry.name}' failed to inflate: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out.length > entry.uncompressedSize ? inflateStreamed(archive, entry, maxBytes) : ok(out);
};
