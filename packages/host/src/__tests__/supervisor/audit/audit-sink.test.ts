/**
 * Audit port + sinks (FR-028, SC-008).
 *
 * Covers:
 *   - the AuditRecord smart constructor carries the four REQUIRED fields
 *     (actor / timestamp / tenant / action) — SC-008's record shape.
 *   - the log sink emits one structured line per record and never throws.
 *   - the redis-stream sink XADDs the flattened record and NEVER throws on a
 *     stream failure (never-throw contract — an audit outage must not crash the
 *     request path).
 *   - the compound sink fans out to every sink and isolates one sink's failure.
 */

import { describe, it, expect } from "bun:test";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import { auditRecord, rawAttemptedTenantId } from "../../../supervisor/audit/audit-port.js";
import type { AuditRecord } from "../../../supervisor/audit/audit-port.js";
import {
  createLogAuditSink,
  createRedisStreamAuditSink,
  createCompoundAuditSink,
  createFakeAuditSink,
  createFakeAuditStream,
  auditRecordToFields,
  AUDIT_STREAM_KEY,
} from "../../../supervisor/audit/audit-sink-log-redis.js";
import type { LogPort } from "../../../ports.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad id ${s}`);
  return r.value;
};

const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const rec = (overrides: Partial<AuditRecord> = {}): AuditRecord =>
  auditRecord({
    actor: { kind: "admin", label: "ops-1" },
    timestamp: 1_700_000_000_000,
    tenant: tid("acme"),
    action: "register",
    outcome: "succeeded",
    ...overrides,
  });

describe("auditRecord smart constructor (FR-028 required fields)", () => {
  it("carries actor, timestamp, tenant, action", () => {
    const r = rec();
    expect(r.actor.kind).toBe("admin");
    expect(r.timestamp).toBe(1_700_000_000_000);
    expect(r.tenant).toBe(tid("acme"));
    expect(r.action).toBe("register");
    expect(r.outcome).toBe("succeeded");
  });

  it("omits optional detail when not provided", () => {
    const r = auditRecord({ actor: { kind: "admin" }, timestamp: 1, tenant: tid("a"), action: "deregister", outcome: "succeeded" });
    expect("detail" in r).toBe(false);
  });
});

describe("rawAttemptedTenantId (bounded, attacker-influenced refusal id)", () => {
  const MAX = 128; // mirrors MAX_RAW_ATTEMPTED_TENANT_ID_LEN (module-private).

  it("returns a short id verbatim (no truncation, no ellipsis)", () => {
    const raw = "bad:tenant/../escape";
    expect(rawAttemptedTenantId(raw)).toBe(raw);
  });

  it("returns an exactly-max id verbatim (boundary: length === MAX)", () => {
    const raw = "a".repeat(MAX);
    const out = rawAttemptedTenantId(raw);
    expect(out).toBe(raw);
    expect(out.length).toBe(MAX);
    expect(out.endsWith("…")).toBe(false);
  });

  it("truncates an over-long id to AT MOST MAX code units, ellipsis included", () => {
    const out = rawAttemptedTenantId("a".repeat(MAX + 200));
    // The result length never exceeds MAX — the trailing `…` COUNTS toward the
    // bound (replaces the final retained char), so it is MAX, not MAX+1.
    expect(out.length).toBe(MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, MAX - 1)).toBe("a".repeat(MAX - 1));
  });

  it("bounds a hostile multi-kilobyte segment (no trail/log bloat)", () => {
    const out = rawAttemptedTenantId("x".repeat(10_000));
    expect(out.length).toBe(MAX);
  });

  it("drops a SPLIT surrogate pair at the cut (no lone high surrogate in the trail)", () => {
    // Place an astral emoji (😀 = U+1F600 = 😀, a surrogate PAIR) so its
    // high half lands at index MAX-2 (126) — the last unit the naive MAX-1 slice
    // would retain — and its low half at MAX-1 (127) is cut. The retained prefix
    // would then end on a LONE high surrogate, so the cut drops it too: the result
    // is one shorter than MAX and carries no dangling surrogate.
    const raw = `${"a".repeat(MAX - 2)}😀${"b".repeat(20)}`;
    expect(raw.charCodeAt(MAX - 2)).toBeGreaterThanOrEqual(0xd800); // high surrogate at the cut
    expect(raw.charCodeAt(MAX - 2)).toBeLessThanOrEqual(0xdbff);

    const out = rawAttemptedTenantId(raw);
    expect(out).toBe(`${"a".repeat(MAX - 2)}…`); // pair fully dropped, ellipsis appended
    expect(out.length).toBe(MAX - 1); // one shorter than MAX (a split pair was dropped)
    expect(out.endsWith("…")).toBe(true);
    // No lone surrogate survives anywhere in the result.
    const lastUnit = out.charCodeAt(out.length - 2); // unit before the trailing "…"
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });

  it("retains a surrogate pair WHOLLY inside the bound (only split pairs are dropped)", () => {
    // The emoji sits well within the retained prefix, so it is preserved intact;
    // only a pair straddling the cut is dropped. Guards against over-eager trimming.
    const raw = `😀${"a".repeat(MAX + 50)}`;
    const out = rawAttemptedTenantId(raw);
    expect(out.startsWith("😀")).toBe(true);
    expect(out.length).toBe(MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips control chars (CR/LF/NUL/ANSI escape) so a crafted id cannot inject a log line", () => {
    // The raw segment is attacker-influenced; a CRLF or terminal escape must not
    // survive into the audit trail / a structured log. Each control unit is
    // replaced with U+FFFD (not dropped), so no newline or escape remains.
    const out = rawAttemptedTenantId("acme\r\nADMIN refused\u001b[31m\u0000");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0000");
    // The benign prefix and a marker for each stripped unit remain.
    expect(out.startsWith("acme")).toBe(true);
    expect(out).toContain("�");
  });

  it("control-char replacement is 1:1 so the length bound still holds after sanitization", () => {
    // MAX control chars + overflow: each becomes exactly one U+FFFD, so the result
    // is still bounded to MAX code units with the ellipsis included.
    const out = rawAttemptedTenantId("\n".repeat(MAX + 20));
    expect(out.length).toBe(MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\n");
  });
});

describe("auditRecordToFields (stream serialization)", () => {
  it("flattens every field to a string", () => {
    const fields = auditRecordToFields(rec({ detail: "x" }));
    expect(fields).toEqual({
      actor: "admin",
      actorLabel: "ops-1",
      timestamp: "1700000000000",
      tenant: "acme",
      action: "register",
      outcome: "succeeded",
      detail: "x",
    });
  });
});

describe("log sink", () => {
  it("emits one info line per record with structured data", async () => {
    const lines: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const logger: LogPort = { info: (msg, data) => lines.push({ msg, data }), warn: () => {}, error: () => {} };
    const sink = createLogAuditSink(logger);
    await sink.record(rec());
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ tenant: "acme", action: "register", outcome: "succeeded" });
  });

  it("never throws even if the logger throws", async () => {
    const sink = createLogAuditSink({ info: () => { throw new Error("boom"); }, warn: () => {}, error: () => {} });
    await expect(sink.record(rec())).resolves.toBeUndefined();
  });

  it("a throwing logger is reported to stderr as a LAST RESORT — the floor is never silent (action/tenant + cause captured, bypassing the host logger)", async () => {
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const sink = createLogAuditSink({ info: () => { throw new Error("logger broke"); }, warn: () => {}, error: () => {} });
      await expect(sink.record(rec())).resolves.toBeUndefined();
      expect(written).toHaveLength(1);
      expect(written[0]!).toContain("LOG SINK FAILURE");
      expect(written[0]!).toContain("register"); // the record's action
      expect(written[0]!).toContain("acme"); // the record's tenant
      expect(written[0]!).toContain("logger broke"); // the cause, not a silent drop
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("redis-stream sink (never-throw contract)", () => {
  it("XADDs the flattened record to the audit stream", async () => {
    const stream = createFakeAuditStream();
    const sink = createRedisStreamAuditSink(stream, silentLog);
    await sink.record(rec());
    expect(stream.entries).toHaveLength(1);
    expect(stream.entries[0]!.streamKey).toBe(AUDIT_STREAM_KEY);
    expect(stream.entries[0]!.fields.tenant).toBe("acme");
  });

  it("does NOT throw when the stream fails — logs and resolves", async () => {
    const stream = createFakeAuditStream();
    stream.setFail(true);
    const warns: string[] = [];
    const logger: LogPort = { info: () => {}, warn: (m) => warns.push(m), error: () => {} };
    const sink = createRedisStreamAuditSink(stream, logger);
    await expect(sink.record(rec())).resolves.toBeUndefined();
    expect(warns.length).toBe(1);
    expect(stream.entries).toHaveLength(0);
  });

  it("still resolves when both XADD and its warning logger throw", async () => {
    const stream = createFakeAuditStream();
    stream.setFail(true);
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const logger: LogPort = {
        info: () => {},
        warn: () => { throw new Error("warning transport down"); },
        error: () => {},
      };
      const sink = createRedisStreamAuditSink(stream, logger);

      await expect(sink.record(rec())).resolves.toBeUndefined();
      expect(written.join("\n")).toContain("REDIS STREAM FAILURE");
      expect(written.join("\n")).toContain("warning transport down");
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("compound sink", () => {
  it("fans out to every sink", async () => {
    const a = createFakeAuditSink();
    const b = createFakeAuditSink();
    const sink = createCompoundAuditSink([a, b]);
    await sink.record(rec());
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  it("isolates one sink's failure — the others still record", async () => {
    const good = createFakeAuditSink();
    const bad = { record: async () => { throw new Error("sink down"); } };
    const sink = createCompoundAuditSink([bad, good]);
    await expect(sink.record(rec())).resolves.toBeUndefined();
    expect(good.records).toHaveLength(1);
  });

  it("logs a rejecting sink (never-throw contract violation) via the logger, with the reason", async () => {
    const errors: { msg: string; meta?: Record<string, unknown> }[] = [];
    const logger: LogPort = {
      info: () => {},
      warn: () => {},
      error: (msg, meta) => errors.push({ msg, meta: meta as Record<string, unknown> | undefined }),
    };
    const good = createFakeAuditSink();
    const bad = { record: async () => { throw new Error("sink down"); } };
    const sink = createCompoundAuditSink([bad, good], logger);

    await expect(sink.record(rec())).resolves.toBeUndefined();
    // isolate-failures preserved: the good sink still recorded.
    expect(good.records).toHaveLength(1);
    // the rejection was made observable, not swallowed.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.meta?.reason).toBe("sink down");
    expect(errors[0]?.meta?.sinkIndex).toBe(0);
  });

  it("a throwing contract-violation logger cannot make compound record reject", async () => {
    const good = createFakeAuditSink();
    const bad = { record: async () => { throw new Error("sink down"); } };
    const logger: LogPort = {
      info: () => {},
      warn: () => {},
      error: () => { throw new Error("error transport down"); },
    };
    const sink = createCompoundAuditSink([bad, good], logger);

    await expect(sink.record(rec())).resolves.toBeUndefined();
    expect(good.records).toHaveLength(1);
  });
});
