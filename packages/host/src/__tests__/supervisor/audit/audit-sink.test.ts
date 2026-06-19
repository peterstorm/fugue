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
import { auditRecord } from "../../../supervisor/audit/audit-port.js";
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
});
