/**
 * Audit sinks — the IMPERATIVE SHELL behind `AuditPort` (FR-028, SC-008).
 *
 * Two concrete sinks plus a compound sink that fans out to both:
 *   - `createLogAuditSink(logger)`        — structured-log sink. Emits one
 *     `info` log line per record (a durable-enough trail wherever logs ship).
 *   - `createRedisStreamAuditSink(stream)` — Redis-stream sink. Appends each
 *     record to an append-only audit stream (`fugue:supervisor:audit`) via
 *     `XADD`, so the trail is queryable/replayable independent of log retention.
 *   - `createCompoundAuditSink([...])`     — write to every sink; one sink's
 *     failure NEVER suppresses the others, and NEVER throws into the caller.
 *
 * NEVER-THROW CONTRACT (the whole point of a sink): the admin lifecycle handler
 * writes an audit record on the request path. An audit sink that threw — or
 * propagated a Redis-stream outage — would turn a successful tenant op into a
 * failed request, which would be WORSE than a best-effort trail. So every sink
 * catches its own failure, logs it, and resolves. The audit trail is best-effort
 * AT THE INFRA LAYER; SC-008's "100% emit a record" is satisfied by the handler
 * ALWAYS CALLING `record` for every op — the sink layer just must not crash.
 *
 * The Redis stream is a SUPERVISOR/admin keyspace (`fugue:supervisor:audit`),
 * NOT a per-tenant `fugue:<tenant>:*` key — it is written over the supervisor's
 * own connection, never a tenant's scoped ACL user, so the audit trail is not
 * reachable (read or write) by any worker.
 */

import type { LogPort } from "../../ports.js";
import { match } from "ts-pattern";
import type { AuditPort, AuditRecord } from "./audit-port.js";

// ── Redis stream port (narrow, audit-only) ───────────────────────────────────

/**
 * The NARROW append-only-stream capability the Redis audit sink needs — a single
 * `XADD`. Modelled as a dedicated port (not the data-plane `RedisPort`, which has
 * no stream op) so the production adapter can wrap `ioredis.xadd` without this
 * sink importing ioredis. `xAdd` returns the generated stream entry id on success.
 *
 * Returns a plain Promise (not a `Result`) because the sink swallows failures
 * internally (never-throw contract) — a thrown error here is caught by the sink.
 */
export interface AuditStreamPort {
  /**
   * `XADD <streamKey> * <…field/value pairs>` → the new entry id. The `*` is the
   * literal Redis XADD argument asking the SERVER to assign the entry id (a
   * monotonic `<ms>-<seq>` stream id), which is what this returns.
   */
  readonly xAdd: (streamKey: string, fields: Readonly<Record<string, string>>) => Promise<string>;
}

/** The supervisor audit stream key (admin keyspace — never tenant-scoped). */
export const AUDIT_STREAM_KEY = "fugue:supervisor:audit";

// ── Serialization (pure) ──────────────────────────────────────────────────────

/**
 * Flatten an `AuditRecord` into the string field map a Redis stream entry holds.
 * Pure — exported so tests can assert the EXACT fields written. Every field is a
 * string (Redis stream values are strings); `timestamp` is rendered as its
 * decimal millis and the optional `actorLabel`/`detail` are omitted when absent.
 */
export const auditRecordToFields = (rec: AuditRecord): Record<string, string> => ({
  actor: rec.actor.kind,
  ...(rec.actor.label !== undefined ? { actorLabel: rec.actor.label } : {}),
  timestamp: String(rec.timestamp),
  tenant: rec.tenant,
  action: rec.action,
  outcome: rec.outcome,
  ...(rec.detail !== undefined ? { detail: rec.detail } : {}),
});

/** Human-readable single-line summary for the log sink. */
const summarize = (rec: AuditRecord): string =>
  match(rec.outcome)
    .with("succeeded", () => `[audit] ${rec.action} tenant='${rec.tenant}' by ${rec.actor.kind}`)
    .with("refused", () => `[audit] REFUSED ${rec.action} tenant='${rec.tenant}' by ${rec.actor.kind}${rec.detail ? ` (${rec.detail})` : ""}`)
    .with("partial", () => `[audit] PARTIAL ${rec.action} tenant='${rec.tenant}' by ${rec.actor.kind}${rec.detail ? ` (${rec.detail})` : ""}`)
    .exhaustive();

// ── Log sink ──────────────────────────────────────────────────────────────────

/**
 * Structured-log audit sink. Emits one `info` line per record with the full
 * record as structured data (so log aggregators capture actor/timestamp/tenant/
 * action). Never throws — a logger that threw is caught and dropped (a sink must
 * not crash the request path).
 */
export const createLogAuditSink = (logger: LogPort): AuditPort => ({
  record: async (rec) => {
    try {
      logger.info(summarize(rec), {
        actor: rec.actor.kind,
        ...(rec.actor.label !== undefined ? { actorLabel: rec.actor.label } : {}),
        timestamp: rec.timestamp,
        tenant: rec.tenant,
        action: rec.action,
        outcome: rec.outcome,
        ...(rec.detail !== undefined ? { detail: rec.detail } : {}),
      });
    } catch {
      // A logger that throws must not break the request path. Nothing else to do.
    }
  },
});

// ── Redis stream sink ───────────────────────────────────────────────────────

/**
 * Redis-stream audit sink. Appends each record to the append-only audit stream
 * via `XADD`. Never throws: an `xAdd` failure (Redis down) is caught, logged via
 * the optional logger, and dropped — the in-band log sink (when composed) still
 * carries the trail, and the tenant op still succeeds.
 */
export const createRedisStreamAuditSink = (
  stream: AuditStreamPort,
  logger?: LogPort,
  streamKey: string = AUDIT_STREAM_KEY,
): AuditPort => ({
  record: async (rec) => {
    try {
      await stream.xAdd(streamKey, auditRecordToFields(rec));
    } catch (e) {
      logger?.warn("[audit] Redis stream XADD failed — audit record not persisted to stream", {
        tenant: rec.tenant,
        action: rec.action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});

// ── Compound sink ─────────────────────────────────────────────────────────────

/**
 * Fan a record out to EVERY sink. Each sink is awaited independently and its
 * failure is isolated — one sink throwing (despite the contract) never suppresses
 * another, and the compound resolves once all have settled. This is what the
 * admin handler injects: log + redis-stream together, with the log sink as the
 * resilient floor if the stream is unavailable.
 *
 * A sink that REJECTS has violated the never-throw contract (each sink is meant
 * to swallow its own failure). Rather than let that rejection vanish silently,
 * the settled results are inspected and every `rejected` entry is logged via the
 * optional `logger` — so a misbehaving sink is OBSERVABLE without breaking the
 * others (isolate-failures behaviour is preserved).
 */
export const createCompoundAuditSink = (
  sinks: readonly AuditPort[],
  logger?: LogPort,
): AuditPort => ({
  record: async (rec) => {
    const settled = await Promise.allSettled(sinks.map((s) => s.record(rec)));
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        logger?.error("[audit] compound sink: a sink violated the never-throw contract (rejected)", {
          sinkIndex: index,
          tenant: rec.tenant,
          action: rec.action,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  },
});

// ── In-memory fake (tests) ────────────────────────────────────────────────────

/**
 * In-memory audit sink for tests — captures every record in order so a test can
 * assert SC-008 (every op emitted a record with the required fields). Mirrors the
 * recorded-call fake style used across the supervisor adapters.
 */
export interface FakeAuditSink extends AuditPort {
  readonly records: readonly AuditRecord[];
}

export const createFakeAuditSink = (): FakeAuditSink => {
  const records: AuditRecord[] = [];
  return {
    get records() {
      return records as readonly AuditRecord[];
    },
    record: async (rec) => {
      records.push(rec);
    },
  };
};

/**
 * In-memory `AuditStreamPort` fake — records every `xAdd` (key + fields) and can
 * be flipped to throw, exercising the redis-stream sink's never-throw path.
 */
interface FakeAuditStream extends AuditStreamPort {
  readonly entries: readonly { streamKey: string; fields: Record<string, string> }[];
  setFail: (fail: boolean) => void;
}

export const createFakeAuditStream = (): FakeAuditStream => {
  const entries: { streamKey: string; fields: Record<string, string> }[] = [];
  let failing = false;
  let seq = 0;
  return {
    get entries() {
      return entries as readonly { streamKey: string; fields: Record<string, string> }[];
    },
    setFail: (fail) => {
      failing = fail;
    },
    xAdd: async (streamKey, fields) => {
      if (failing) throw new Error("fake-audit-stream: XADD failed");
      entries.push({ streamKey, fields: { ...fields } });
      seq += 1;
      // `0-<n>` mirrors the Redis `<ms>-<seq>` stream-id shape (a fixed `0` ms
      // part + a monotonic seq) so callers asserting on the id see a real-shaped,
      // monotonically increasing entry id.
      return `0-${seq}`;
    },
  };
};
