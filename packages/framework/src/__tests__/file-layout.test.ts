// file-layout.test.ts — boundary validator matrix + digest/filename mapping
//
// Covers the single source of truth for the on-disk contract (AD-2):
//   - constant surface (names, schema version, TTL)
//   - isBoundaryId: charset/`{1,128}` boundary matrix incl. hostile strings
//     (`../`, absolute paths, NUL, 129-char ids, `@`/`|` separators, `$input`,
//     non-strings)
//   - keyDigest: deterministic sha256 hex, 64 chars, known vectors
//   - eventFileName: pad6 zero-padding, shape, fail-fast guards, NAME_MAX bound
//   - eventDigestOf: keyed vs keyless distinction, content-addressing,
//     determinism through toJson (Map/Set/Date), and the same non-negative
//     safe-integer sequence guard as eventFileName (input-domain symmetry)
//   - FR-015 digest-level acceptance of the full 1..256-char dedupKey range
//     (charset validation proper lives in event-record.ts, Phase 2)
//   - keyed/keyless disjointness pinned at its ENFORCEMENT point: a
//     `|`-bearing dedupKey is rejected by event-record.ts's codec — the one
//     place the FR-015 charset exclusion lives

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { toJson } from "../state-machine/serialize.js";
import { parseFileEventRecord } from "../file/event-record.js";
import {
  EVENTS_DIR,
  CHECKPOINT_FILE,
  PROGRESS_FILE,
  META_FILE,
  NODES_DIR,
  APPEND_LOCK,
  JOURNAL_SCHEMA_VERSION,
  MAX_LEXICOGRAPHIC_SEQUENCE,
  isBoundaryId,
  keyDigest,
  eventFileName,
  eventDigestOf,
  parseEventFileName,
} from "../file/layout.js";
import { TTL_SECONDS } from "../checkpoint/checkpointer.js";

const NAME_MAX = 255;
const ID_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-:";
const ILL_FORMED_UTF16_DOMAIN = Uint8Array.of(
  0xff,
  0x46, 0x55, 0x47, 0x55, 0x45, 0x2d, 0x55, 0x54, 0x46, 0x31, 0x36, 0x2d, 0x42, 0x45,
  0x00, 0x01,
);

const isWellFormedUtf16Reference = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const malformedUtf16DigestReference = (value: string): string => {
  const input = new Uint8Array(ILL_FORMED_UTF16_DOMAIN.length + value.length * 2);
  input.set(ILL_FORMED_UTF16_DOMAIN);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const offset = ILL_FORMED_UTF16_DOMAIN.length + index * 2;
    input[offset] = codeUnit >>> 8;
    input[offset + 1] = codeUnit & 0xff;
  }
  return createHash("sha256").update(input).digest("hex");
};

const utf16StringArbitrary = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 48 })
  .map((codeUnits) => String.fromCharCode(...codeUnits));

const illFormedUtf16StringArbitrary = fc.oneof(
  fc
    .tuple(utf16StringArbitrary, fc.integer({ min: 0xd800, max: 0xdbff }))
    .map(([prefix, loneHigh]) => `${prefix}${String.fromCharCode(loneHigh)}`),
  fc
    .tuple(fc.integer({ min: 0xdc00, max: 0xdfff }), utf16StringArbitrary)
    .map(([loneLow, suffix]) => `${String.fromCharCode(loneLow)}${suffix}`),
);

describe("layout constants — the on-disk contract", () => {
  it("names the journal/checkpointer layout exactly", () => {
    expect(EVENTS_DIR).toBe("events");
    expect(CHECKPOINT_FILE).toBe("checkpoint.json");
    expect(PROGRESS_FILE).toBe("progress.json");
    expect(META_FILE).toBe("meta.json");
    expect(NODES_DIR).toBe("nodes");
    expect(APPEND_LOCK).toBe("append.lock");
  });

  it("pins the journal schema version and TTL", () => {
    expect(JOURNAL_SCHEMA_VERSION).toBe(1);
    expect(TTL_SECONDS).toBe(86_400);
    expect(TTL_SECONDS).toBe(24 * 60 * 60); // matches Redis lazy-expiry window
  });

  it("parseEventFileName is the exact encoded inverse of eventFileName (single naming encoding)", () => {
    const digest = "a".repeat(64);
    for (const sequence of [0, 1, 42, 999_999]) {
      const name = eventFileName(sequence, digest);
      expect(parseEventFileName(name)).toEqual({ sequence, digest });
    }
    // Names no eventFileName call can have produced — each shape a private
    // re-encoding (journal regex, event-log padding) used to admit or miss:
    for (const foreign of [
      "README.json",
      "00001-abc.json",
      "0000000-" + digest + ".json", // 7-digit prefix (past the ceiling)
      "000001-" + "A".repeat(64) + ".json", // uppercase digest
      "000001-" + "g".repeat(64) + ".json", // non-hex digest
      "1-" + digest + ".json",
      "000001-" + digest + ".tmp",
      "",
    ]) {
      expect(parseEventFileName(foreign)).toBeNull();
    }
  });

  it("pins the shared 6-digit lexicographic sequence domain", () => {
    // The naming layer and the codec (event-record.ts) share ONE sequence
    // domain: eventFileName throws past the ceiling, serializeFileEventRecord
    // throws on it, parseFileEventRecord errs on it — all naming the same
    // constant, so a 7-digit sequence can never sort before a 6-digit one.
    expect(MAX_LEXICOGRAPHIC_SEQUENCE).toBe(999_999);
    // The ceiling is the last sequence the naming layer accepts.
    expect(eventFileName(MAX_LEXICOGRAPHIC_SEQUENCE, "ab".repeat(32))).toBe(
      `999999-${"ab".repeat(32)}.json`,
    );
    expect(() => eventFileName(MAX_LEXICOGRAPHIC_SEQUENCE + 1, "ab".repeat(32))).toThrow(
      /6-digit lexicographic ceiling/,
    );
  });
});

describe("isBoundaryId — valid boundary matrix", () => {
  it("accepts every single character of the ID charset", () => {
    for (const ch of ID_CHARSET) {
      expect(isBoundaryId(ch), `single char ${JSON.stringify(ch)}`).toBe(true);
    }
  });

  it("accepts typical ids: plain, namespaced, dashed, underscored", () => {
    expect(isBoundaryId("abc123")).toBe(true);
    expect(isBoundaryId("tenant:run-abc")).toBe(true);
    expect(isBoundaryId("my_node-1")).toBe(true);
    expect(isBoundaryId("run_2026-08-12T00:00:00Z")).toBe(true);
    expect(isBoundaryId("a")).toBe(true); // 1-char minimum
  });

  it("accepts ids up to the 128-char ceiling", () => {
    expect(isBoundaryId("a".repeat(128))).toBe(true);
    // charset-mixed 128-char id
    let mixed = "";
    for (let i = 0; i < 128; i++) mixed += ID_CHARSET[i % ID_CHARSET.length];
    expect(isBoundaryId(mixed)).toBe(true);
  });

  it("accepts every charset-class string for lengths 1..128 (deterministic sweep)", () => {
    for (let len = 1; len <= 128; len++) {
      let s = "";
      for (let i = 0; i < len; i++) s += ID_CHARSET[i % ID_CHARSET.length];
      expect(isBoundaryId(s), `length ${len}`).toBe(true);
    }
  });
});

describe("isBoundaryId — hostile identifier matrix (FR-016/FR-029, NFR-010)", () => {
  const hostile: Array<[string, string]> = [
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["129-char id", "a".repeat(129)],
    ["256-char id", "a".repeat(256)],
    ["1000-char id", "a".repeat(1000)],
    ["path traversal ../x", "../x"],
    ["path traversal ../", "../"],
    ["double dot", ".."],
    ["dot slash", "./x"],
    ["embedded traversal", "a/../b"],
    ["encoded traversal ..%2F", "..%2F"],
    ["absolute unix path", "/etc/passwd"],
    ["bare root", "/"],
    ["embedded slash", "a/b"],
    ["backslash", "a\\b"],
    ["windows drive", "C:\\x"],
    ["NUL byte", "a\u0000b"],
    ["bare NUL", "\u0000"],
    ["at separator (AD-1 composite)", "a@b"],
    ["leading at", "@a"],
    ["pipe separator", "a|b"],
    ["dollar (DAG_INPUT reserved)", "$input"],
    ["space", "a b"],
    ["leading space", " a"],
    ["trailing space", "a "],
    ["tab", "a\tb"],
    ["newline", "a\nb"],
    ["carriage return", "a\r\nb"],
    ["control char", "a\u0001b"],
    ["dot", "a.b"],
    ["comma", "a,b"],
    ["semicolon", "a;b"],
    ["paren", "a(b"],
    ["bracket", "a[b"],
    ["brace", "a{b"],
    ["percent", "a%20b"],
    ["plus", "a+b"],
    ["equals", "a=b"],
    ["ampersand", "a&b"],
    ["hash", "a#b"],
    ["question", "a?b"],
    ["bang", "a!b"],
    ["quote", "a'b"],
    ["double quote", 'a"b'],
    ["backtick", "a`b"],
    ["tilde", "a~b"],
    ["star", "a*b"],
    ["unicode é", "é"],
    ["unicode ñ", "ñ"],
    ["unicode ß", "aßb"],
    ["cjk", "日本語"],
    ["emoji", "🚀"],
    ["zero-width", "a\u200bb"],
  ];

  for (const [label, value] of hostile) {
    it(`rejects ${label}`, () => {
      expect(isBoundaryId(value), `${label}: ${JSON.stringify(value)}`).toBe(false);
    });
  }

  it("rejects every charset character extended with one hostile char", () => {
    for (const ch of ID_CHARSET) {
      expect(isBoundaryId(ch + "@"), `charset char ${ch} + @`).toBe(false);
      expect(isBoundaryId(ch + "|"), `charset char ${ch} + |`).toBe(false);
      expect(isBoundaryId(ch + "/"), `charset char ${ch} + /`).toBe(false);
      expect(isBoundaryId(ch + "."), `charset char ${ch} + .`).toBe(false);
      expect(isBoundaryId(ch + " "), `charset char ${ch} + space`).toBe(false);
    }
  });

  it("rejects all non-string values (no regex coercion)", () => {
    const nonStrings: unknown[] = [null, undefined, 123, 0, 1.5, true, false, {}, [], ["a"], Symbol("x"), new String("abc")];
    for (const value of nonStrings) {
      expect(isBoundaryId(value), `non-string ${String(value)}`).toBe(false);
    }
  });

  it("rejects ids that look valid but are on the wrong side of the length ceiling", () => {
    // 129 chars composed purely of the allowed charset must still fail
    let s = "";
    for (let i = 0; i < 129; i++) s += ID_CHARSET[i % ID_CHARSET.length];
    expect(s.length).toBe(129);
    expect(isBoundaryId(s)).toBe(false);
  });
});

describe("keyDigest — sha256 hex mapping (AD-2)", () => {
  const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

  it("matches known sha256 vectors", () => {
    expect(keyDigest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(keyDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("always returns 64 lowercase hex chars", () => {
    for (const s of ["", "a", "node-1", "a".repeat(256), "日本語", "a\u0000b"]) {
      expect(keyDigest(s)).toMatch(/^[0-9a-f]{64}$/);
      expect(keyDigest(s).length).toBe(64);
    }
  });

  it("is deterministic", () => {
    expect(keyDigest("run-abc")).toBe(keyDigest("run-abc"));
    expect(keyDigest("")).toBe(keyDigest(""));
  });

  it("maps distinct keys to distinct digests (spot checks)", () => {
    const pairs: Array<[string, string]> = [
      ["a", "b"],
      ["node-1", "node-2"],
      ["run-a", "run-b"],
      [ID_CHARSET, ID_CHARSET + "x"],
      ["x".repeat(255) + "a", "x".repeat(255) + "b"],
    ];
    for (const [a, b] of pairs) {
      expect(keyDigest(a)).not.toBe(keyDigest(b));
    }
  });

  it("preserves the legacy sha256(UTF-8) mapping for well-formed Unicode", () => {
    const samples = [
      "",
      "a",
      "run-abc",
      "a".repeat(256),
      "日本語",
      "a\u0000b",
      "\uFFFD",
      "🚀",
      `${ID_CHARSET}|${ID_CHARSET}`,
    ];
    for (const s of samples) {
      expect(keyDigest(s), JSON.stringify(s)).toBe(sha256hex(s));
    }
  });

  it("losslessly separates lone surrogates from each other, U+FFFD, and literal escape text", () => {
    const resources = [
      "\uD800",
      "\uD801",
      "\uDC00",
      "\uDC01",
      "\uFFFD",
      "\\uD800",
      "prefix\uD800suffix",
    ] as const;

    expect(new Set(resources).size).toBe(resources.length);
    expect(new Set(resources.map(keyDigest)).size).toBe(resources.length);
    expect(keyDigest("\uD800")).not.toBe(sha256hex("\uD800"));
    expect(sha256hex("\uD800")).toBe(sha256hex("\uFFFD")); // Node's lossy UTF-8 replacement
    expect(keyDigest("\uD800")).not.toBe(keyDigest("\uFFFD"));
    expect(keyDigest("\uD800")).not.toBe(keyDigest("\\uD800"));

    for (const resource of resources.slice(0, 4).concat(resources.slice(6))) {
      expect(keyDigest(resource), JSON.stringify(resource)).toBe(
        malformedUtf16DigestReference(resource),
      );
    }
  });

  it("property: generated UTF-16 strings retain every code-unit distinction", () => {
    fc.assert(
      fc.property(utf16StringArbitrary, (resource) => {
        const expected = isWellFormedUtf16Reference(resource)
          ? sha256hex(resource)
          : malformedUtf16DigestReference(resource);
        expect(keyDigest(resource)).toBe(expected);
      }),
      { numRuns: 1_000 },
    );

    fc.assert(
      fc.property(
        illFormedUtf16StringArbitrary,
        illFormedUtf16StringArbitrary,
        (left, right) => {
          fc.pre(left !== right);
          expect(keyDigest(left)).not.toBe(keyDigest(right));
          expect(keyDigest(left)).toBe(malformedUtf16DigestReference(left));
          expect(keyDigest(right)).toBe(malformedUtf16DigestReference(right));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("eventFileName — pad6 zero-padding and shape (AD-2)", () => {
  const d = "ab".repeat(32); // 64 hex chars

  it("zero-pads sequences to 6 digits", () => {
    expect(eventFileName(0, d)).toBe(`000000-${d}.json`);
    expect(eventFileName(1, d)).toBe(`000001-${d}.json`);
    expect(eventFileName(42, d)).toBe(`000042-${d}.json`);
    expect(eventFileName(999, d)).toBe(`000999-${d}.json`);
    expect(eventFileName(999999, d)).toBe(`999999-${d}.json`);
  });

  it("rejects sequences past the 6-digit lexicographic ceiling (1,000,000)", () => {
    // "1000000-…" would sort BEFORE "999999-…" in a listing, silently
    // breaking sorted-listing = append order — so the ceiling is enforced
    // with a throw naming the 6-digit bound instead of silently truncating
    // or emitting an out-of-order name.
    expect(() => eventFileName(1_000_000, d)).toThrow(/6-digit lexicographic ceiling/);
    expect(() => eventFileName(1_234_567, d)).toThrow(/6-digit lexicographic ceiling/);
    expect(() => eventFileName(Number.MAX_SAFE_INTEGER, d)).toThrow(/6-digit lexicographic ceiling/);
    // The ceiling itself still works.
    expect(eventFileName(999_999, d)).toBe(`999999-${d}.json`);
  });

  it("produces sorted-listing = append-order filenames", () => {
    const names = [eventFileName(12, d), eventFileName(2, d), eventFileName(105, d)];
    const sorted = [...names].sort();
    expect(sorted).toEqual([eventFileName(2, d), eventFileName(12, d), eventFileName(105, d)]);
  });

  it("is exactly 76 bytes for a 64-hex digest — within NAME_MAX", () => {
    expect(`${eventFileName(999999, d)}`).toHaveLength(76);
    expect(`${eventFileName(999999, d)}`.length).toBeLessThanOrEqual(NAME_MAX);
  });

  it("matches the canonical record filename shape (always exactly 6 digits)", () => {
    expect(eventFileName(7, d)).toMatch(/^\d{6}-[0-9a-f]{64}\.json$/);
  });

  it("round-trips the sequence from the numeric prefix", () => {
    for (const seq of [0, 1, 42, 999, 999999]) {
      expect(parseInt(eventFileName(seq, d).slice(0, 6), 10)).toBe(seq);
    }
  });

  it("is lexicographically order-preserving across the whole 0..999999 range (sampled)", () => {
    const seqs = [0, 1, 9, 10, 99, 100, 999, 1000, 99999, 100000, 999998, 999999];
    const names = seqs.map((s) => eventFileName(s, d));
    const sorted = [...names].sort();
    expect(sorted).toEqual(names); // listing order === numeric order
    expect(sorted[0]).toBe(`000000-${d}.json`);
    expect(sorted[sorted.length - 1]).toBe(`999999-${d}.json`);
  });

  it("fails fast on invalid sequences (invariant guards)", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => eventFileName(bad, d), `sequence ${bad}`).toThrow(/non-negative safe integer/);
    }
  });

  it("fails fast on malformed digests (invariant guards)", () => {
    for (const bad of ["", "xyz", "ab".repeat(31), "ab".repeat(32).toUpperCase(), "ab".repeat(32) + "c"]) {
      expect(() => eventFileName(0, bad), `digest ${bad.length}`).toThrow(/64 lowercase hex/);
    }
  });
});

describe("eventDigestOf — keyed vs keyless (AD-2)", () => {
  const event = { kind: "node-ran", nodeId: "n1" };

  it("keyed: digests the dedupKey and ignores sequence/event", () => {
    const record = { dedupKey: "node-1", sequence: 3, event };
    expect(eventDigestOf(record)).toBe(keyDigest("node-1"));
    expect(eventDigestOf(record)).toBe(eventDigestOf({ dedupKey: "node-1", sequence: 99, event: { other: true } }));
  });

  it("keyed: empty dedupKey must NOT take the keyed path", () => {
    expect(eventDigestOf({ dedupKey: "", sequence: 0, event })).not.toBe(keyDigest(""));
  });

  it("keyless: digests `${sequence}|${toJson(event)}`", () => {
    const record = { dedupKey: "", sequence: 5, event };
    expect(eventDigestOf(record)).toBe(keyDigest(`5|${toJson(event)}`));
  });

  it("keyless: same event at different sequences never collides", () => {
    const a = eventDigestOf({ dedupKey: "", sequence: 5, event });
    const b = eventDigestOf({ dedupKey: "", sequence: 6, event });
    expect(a).not.toBe(b);
  });

  it("keyless: same sequence with different events never collides", () => {
    const a = eventDigestOf({ dedupKey: "", sequence: 5, event });
    const b = eventDigestOf({ dedupKey: "", sequence: 5, event: { kind: "node-ran", nodeId: "n2" } });
    expect(a).not.toBe(b);
  });

  it("keyless: repeated keyless appends of an identical record are content-addressed identically", () => {
    const a = eventDigestOf({ dedupKey: "", sequence: 5, event });
    const b = eventDigestOf({ dedupKey: "", sequence: 5, event: { ...event } });
    expect(a).toBe(b);
    expect(a).toBe(keyDigest(`5|${toJson(event)}`));
  });

  it("keyed vs keyless are always distinct digests", () => {
    for (const key of ["x", "node-1", "a".repeat(256)]) {
      expect(eventDigestOf({ dedupKey: key, sequence: 5, event })).not.toBe(
        eventDigestOf({ dedupKey: "", sequence: 5, event }),
      );
    }
  });

  it("keyless: digest is stable through toJson for Map/Set/Date events", () => {
    const makeEvent = (): unknown => ({
      counts: new Map([["a", 1], ["b", 2]]),
      seen: new Set(["x", "y"]),
      at: new Date("2026-08-12T00:00:00.000Z"),
    });
    const a = eventDigestOf({ dedupKey: "", sequence: 0, event: makeEvent() });
    const b = eventDigestOf({ dedupKey: "", sequence: 0, event: makeEvent() });
    expect(a).toBe(b);
    expect(a).toBe(keyDigest(`0|${toJson(makeEvent())}`));
  });

  it("keyless: handles null/primitive events deterministically", () => {
    expect(eventDigestOf({ dedupKey: "", sequence: 1, event: null })).toBe(keyDigest(`1|${toJson(null)}`));
    expect(eventDigestOf({ dedupKey: "", sequence: 1, event: "hello" })).toBe(keyDigest(`1|${toJson("hello")}`));
    expect(eventDigestOf({ dedupKey: "", sequence: 1, event: 42 })).toBe(keyDigest(`1|${toJson(42)}`));
  });

  it("keyless: empty key with same sequence+event is deterministic across calls", () => {
    const record = { dedupKey: "", sequence: 5, event };
    expect(eventDigestOf(record)).toBe(eventDigestOf(record));
  });

  it("throws on sequences outside the eventFileName domain (non-negative safe integer)", () => {
    // eventDigestOf is the digest producer for names eventFileName will emit:
    // the seed domain must mirror the filename domain. A keyless seed with a
    // fractional or negative sequence could never be named by eventFileName,
    // so hashing it would produce a digest for a record the layout contract
    // cannot represent.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => eventDigestOf({ dedupKey: "", sequence: bad, event }),
        `keyless sequence ${bad}`,
      ).toThrow(/non-negative safe integer/);
    }
    // The guard is on the PRODUCER's input domain, so it applies to keyed
    // records too — even though the keyed digest does not use the sequence.
    expect(() => eventDigestOf({ dedupKey: "k", sequence: -1.5, event })).toThrow(
      /non-negative safe integer/,
    );
    for (const dedupKey of ["", "k"]) {
      expect(() => eventDigestOf({ dedupKey, sequence: 1_000_000, event })).toThrow(
        /6-digit lexicographic ceiling 999999/,
      );
    }
  });

  it("still accepts the boundary of the domain (0 and the 6-digit ceiling)", () => {
    expect(eventDigestOf({ dedupKey: "", sequence: 0, event })).toBe(keyDigest(`0|${toJson(event)}`));
    expect(eventDigestOf({ dedupKey: "", sequence: 999999, event })).toBe(
      keyDigest(`999999|${toJson(event)}`),
    );
  });
});

describe("keyed/keyless digest disjointness — enforcement point (AD-2/FR-015)", () => {
  const event = { kind: "node-ran", nodeId: "n1" };

  it("pins the load-bearing argument: a `|`-bearing dedupKey would collide with a keyless seed, so the codec rejects it", () => {
    // The disjointness argument, made concrete: a keyless seed is
    // `${sequence}|${toJson(event)}` and ALWAYS contains `|`; a keyed key
    // containing `|` would therefore hash to the SAME digest as the keyless
    // record for that (sequence, event) — two genuinely different events
    // fighting for one filename. `|` is excluded from the FR-015 dedupKey
    // charset, so the keyed and keyless digest input domains stay
    // structurally disjoint.
    const collidingKey = `5|${toJson(event)}`;
    expect(eventDigestOf({ dedupKey: collidingKey, sequence: 5, event })).toBe(
      eventDigestOf({ dedupKey: "", sequence: 5, event }),
    );

    // ...and the ENFORCEMENT point is event-record.ts's codec (layout.ts
    // deliberately never re-checks the charset): a `|`-bearing dedupKey must
    // be rejected there, naming the source file.
    const parsed = parseFileEventRecord(
      {
        schemaVersion: 1,
        sequence: 5,
        dedupKey: collidingKey,
        recordedAtMs: 0,
        event,
      },
      "collision.json",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("|");
      expect(parsed.error).toContain("collision.json");
    }
  });

  it("keyed keys from the FR-015 charset (including `:` and `-`) stay accepted by the codec", () => {
    // Sanity on the other side of the boundary: the FR-015 charset minus `|`
    // is the keyed domain, and the codec (not layout) is the judge.
    const parsed = parseFileEventRecord(
      {
        schemaVersion: 1,
        sequence: 5,
        dedupKey: "node:ran-1",
        recordedAtMs: 0,
        event,
      },
      "ok.json",
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("AD-2 NAME_MAX contract — full dedupKey range at the digest level (FR-015)", () => {
  it("accepts 256-char dedupKeys (spec maximum) and maps them to 76-byte names", () => {
    const dedupKey = "k".repeat(256);
    expect(dedupKey.length).toBe(256);
    const digest = keyDigest(dedupKey);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const name = eventFileName(999999, digest);
    expect(name.length).toBe(76); // 6 + 1 + 64 + 5 — never NAME_MAX blowup
    expect(name.length).toBeLessThanOrEqual(NAME_MAX);
  });

  it("accepts 1-char dedupKeys (spec minimum)", () => {
    const digest = keyDigest("a");
    expect(eventFileName(0, digest)).toBe(`000000-${digest}.json`);
  });

  it("digests the 256-char range for keyed event records too", () => {
    const record = { dedupKey: "k".repeat(256), sequence: 999999, event: { x: 1 } };
    expect(eventDigestOf(record)).toBe(keyDigest("k".repeat(256)));
    expect(eventFileName(record.sequence, eventDigestOf(record)).length).toBe(76);
  });

  it("keyless digest of a large event also yields a 76-byte name", () => {
    const bigEvent = { payload: "x".repeat(10_000), nested: { a: [1, 2, 3] } };
    const name = eventFileName(123456, eventDigestOf({ dedupKey: "", sequence: 123456, event: bigEvent }));
    expect(name).toMatch(/^\d{6,}-[0-9a-f]{64}\.json$/);
    expect(name.length).toBeLessThanOrEqual(NAME_MAX);
  });
});
