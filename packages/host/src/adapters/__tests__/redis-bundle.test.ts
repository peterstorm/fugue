/**
 * `createRedisBundle` — the supervisor's five ioredis-backed ports.
 *
 * These pins exist because this wiring previously had NO seam to test through:
 * it lived inside `main-supervisor.ts` as a module-private `const`, in a file
 * whose last statement is `main().catch(...)`, so importing it to reach the
 * function booted the supervisor and called `process.exit`. A regression that
 * dropped either `attachRedisErrorListener` call — the pair guarding the process
 * that owns every tenant's HTTP listener, admission, and sweep timers, in a
 * binary with no `uncaughtException` handler — passed the whole suite.
 *
 * Every test here injects a fake client. No live Redis, no mocking framework.
 */

import { describe, it, expect } from "bun:test";
import { isOk, isErr } from "@fuguejs/framework";
import type { Redis as IoRedis } from "ioredis";
import { createRedisBundle } from "../redis-bundle.js";
import type { RedisClientFactory } from "../redis-connectivity.js";
import type { LogPort } from "../../ports.js";

const URL = "redis://user:hunter2@localhost:6379";

/**
 * Fake ioredis client. Records every command as `{ m, args }` so a test asserts
 * the EXACT argv a port issues, and records `error`-listener registrations
 * separately — a listener is not a Redis command and must not read as one in
 * the `calls` log every other assertion here matches against.
 */
class FakeClient {
  status: string;
  connectCalls = 0;
  readonly calls: Array<{ readonly m: string; readonly args: readonly unknown[] }> = [];
  readonly errorListeners: Array<(error: unknown) => void> = [];
  readonly messageListeners: Array<(channel: string, message: string) => void> = [];
  /** How many commands had been issued when the `error` listener registered. */
  errorListenerAttachedAfterCommands = -1;

  constructor(private readonly throwOn: ReadonlySet<string> = new Set()) {
    this.status = "wait";
  }

  private rec(m: string, args: readonly unknown[]): void {
    this.calls.push({ m, args });
    if (this.throwOn.has(m)) throw new Error(`${m} boom`);
  }

  on(event: string, listener: (...a: never[]) => void): this {
    if (event === "error") {
      this.errorListeners.push(listener as (error: unknown) => void);
      this.errorListenerAttachedAfterCommands = this.calls.length;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (channel: string, message: string) => void);
    }
    return this;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = "ready";
  }
  async ping(): Promise<string> { this.rec("ping", []); return "PONG"; }
  async publish(channel: string, message: string): Promise<number> {
    this.rec("publish", [channel, message]);
    return 1;
  }
  async subscribe(channel: string): Promise<number> { this.rec("subscribe", [channel]); return 1; }
  async unsubscribe(channel: string): Promise<number> { this.rec("unsubscribe", [channel]); return 1; }
  async call(...args: readonly unknown[]): Promise<unknown> { this.rec("call", args); return "OK"; }
  async xadd(...args: readonly unknown[]): Promise<string> {
    this.rec("xadd", args);
    return "1700000000000-0";
  }
  async quit(): Promise<string> { this.rec("quit", []); return "OK"; }
}

const silentLogger = (): LogPort & { readonly errors: string[] } => {
  const errors: string[] = [];
  return { info: () => {}, warn: () => {}, error: (m) => { errors.push(m); }, errors };
};

/**
 * Hand back both clients in construction order. The bundle builds the command
 * client first and the subscriber second — the order matters to every assertion
 * that distinguishes the two.
 */
const factoryFor = (
  clients: readonly FakeClient[],
): { readonly factory: RedisClientFactory; readonly options: Record<string, unknown>[] } => {
  const options: Record<string, unknown>[] = [];
  let next = 0;
  return {
    factory: (_url, opts) => {
      options.push(opts as unknown as Record<string, unknown>);
      const client = clients[next++];
      if (client === undefined) throw new Error("factory called more times than the test staged");
      return client as unknown as IoRedis;
    },
    options,
  };
};

const wire = async (command: FakeClient, sub: FakeClient, logger: LogPort = silentLogger()) => {
  const { factory, options } = factoryFor([command, sub]);
  const result = await createRedisBundle(URL, logger, factory);
  if (!isOk(result)) throw new Error("expected createRedisBundle to succeed");
  return { bundle: result.value, options };
};

// ── The listener pair: the defect this seam exists for ───────────────────────

describe("createRedisBundle — connection-error listeners", () => {
  it("attaches an error listener to BOTH clients, before either issues a command", async () => {
    const command = new FakeClient();
    const sub = new FakeClient();
    await wire(command, sub);

    expect(command.errorListeners).toHaveLength(1);
    expect(sub.errorListeners).toHaveLength(1);
    // Zero commands had been issued when each registered — the window between
    // construction and the first dial is exactly where the initial connection
    // failure lands, and an unlistened `error` there is the crash.
    expect(command.errorListenerAttachedAfterCommands).toBe(0);
    expect(sub.errorListenerAttachedAfterCommands).toBe(0);
  });

  it("an error event on either client is logged, not thrown", async () => {
    const command = new FakeClient();
    const sub = new FakeClient();
    const logger = silentLogger();
    await wire(command, sub, logger);

    // Node THROWS an `error` event with no listener. Firing it here is the
    // whole property: the process must survive both.
    for (const listener of command.errorListeners) {
      expect(() => listener(new Error("ECONNRESET"))).not.toThrow();
    }
    for (const listener of sub.errorListeners) {
      expect(() => listener(new Error("ECONNRESET"))).not.toThrow();
    }
    expect(logger.errors).toHaveLength(2);
  });

  it("labels the two clients distinctly, so a log names which connection dropped", async () => {
    const command = new FakeClient();
    const sub = new FakeClient();
    const contexts: unknown[] = [];
    const logger: LogPort = {
      info: () => {}, warn: () => {},
      error: (_m, data) => { contexts.push(data?.client); },
    };
    await wire(command, sub, logger);

    command.errorListeners[0]?.(new Error("boom"));
    sub.errorListeners[0]?.(new Error("boom"));
    expect(contexts).toEqual(["command", "pubsub"]);
  });
});

// ── Client construction ──────────────────────────────────────────────────────

describe("createRedisBundle — client construction", () => {
  it("builds both clients lazily and with a bounded retry count", async () => {
    const { options } = await wire(new FakeClient(), new FakeClient());
    expect(options).toHaveLength(2);
    for (const opts of options) {
      expect(opts.lazyConnect).toBe(true);
      expect(opts.maxRetriesPerRequest).toBe(3);
    }
  });

  it("a factory that throws yields Err with the URL credential redacted", async () => {
    const exploding: RedisClientFactory = () => { throw new Error("no driver"); };
    const result = await createRedisBundle(URL, silentLogger(), exploding);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(JSON.stringify(result.error)).not.toContain("hunter2");
  });
});

// ── The `status === "wait"` connect guard ────────────────────────────────────

describe("createRedisBundle — connect guard", () => {
  it("dials a 'wait' client exactly once; later commands do not reconnect", async () => {
    const command = new FakeClient();
    const { bundle } = await wire(command, new FakeClient());

    expect(isOk(await bundle.connectivity.ping())).toBe(true);
    expect(command.connectCalls).toBe(1);
    expect(command.status).toBe("ready");

    // ioredis owns reconnection once connected. Calling connect() again would
    // reject and flap the host into degraded:redis-disconnected.
    await bundle.connectivity.ping();
    await bundle.aclAdmin.delUser("t");
    expect(command.connectCalls).toBe(1);
  });

  it("a failing ping yields Err naming the PING operation", async () => {
    const command = new FakeClient(new Set(["ping"]));
    const { bundle } = await wire(command, new FakeClient());

    const result = await bundle.connectivity.ping();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(JSON.stringify(result.error)).toContain("PING");
  });
});

// ── ACL admin ────────────────────────────────────────────────────────────────

describe("createRedisBundle — aclAdmin", () => {
  it("issues the exact ACL SETUSER argv, rules spread as separate arguments", async () => {
    const command = new FakeClient();
    const { bundle } = await wire(command, new FakeClient());

    expect(isOk(await bundle.aclAdmin.setUser("fugue:t1", ["on", ">pw", "~fugue:t1:*"]))).toBe(true);
    expect(command.calls).toEqual([
      { m: "call", args: ["ACL", "SETUSER", "fugue:t1", "on", ">pw", "~fugue:t1:*"] },
    ]);
  });

  it("issues the exact ACL DELUSER argv", async () => {
    const command = new FakeClient();
    const { bundle } = await wire(command, new FakeClient());

    expect(isOk(await bundle.aclAdmin.delUser("fugue:t1"))).toBe(true);
    expect(command.calls).toEqual([{ m: "call", args: ["ACL", "DELUSER", "fugue:t1"] }]);
  });

  it("converts a thrown ACL denial into a redacted Err, never a rejection", async () => {
    const command = new FakeClient(new Set(["call"]));
    const { bundle } = await wire(command, new FakeClient());

    const result = await bundle.aclAdmin.setUser("fugue:t1", ["on"]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(JSON.stringify(result.error)).toContain("ACL SETUSER fugue:t1");
      expect(JSON.stringify(result.error)).not.toContain("hunter2");
    }
  });
});

// ── Audit stream ─────────────────────────────────────────────────────────────

describe("createRedisBundle — auditStream", () => {
  it("issues XADD <key> * <field/value…> and returns the server-assigned id", async () => {
    const command = new FakeClient();
    const { bundle } = await wire(command, new FakeClient());

    const id = await bundle.auditStream.xAdd("fugue:supervisor:audit", {
      actor: "admin",
      action: "register",
    });

    expect(id).toBe("1700000000000-0");
    expect(command.calls).toEqual([
      {
        m: "xadd",
        // `*` is the literal XADD argument asking the SERVER to assign the id.
        args: ["fugue:supervisor:audit", "*", "actor", "admin", "action", "register"],
      },
    ]);
  });

  it("rejects rather than swallowing, because the audit sink owns the catch", async () => {
    // `AuditStreamPort` returns a plain Promise on purpose:
    // `createRedisStreamAuditSink` catches and logs. Swallowing here would hide
    // the failure the sink is built to report.
    const command = new FakeClient(new Set(["xadd"]));
    const { bundle } = await wire(command, new FakeClient());

    await expect(bundle.auditStream.xAdd("k", { a: "b" })).rejects.toThrow("xadd boom");
  });
});

// ── Pub/sub ──────────────────────────────────────────────────────────────────

describe("createRedisBundle — pubsub", () => {
  it("publishes on the COMMAND client and subscribes on the SUBSCRIBER client", async () => {
    const command = new FakeClient();
    const sub = new FakeClient();
    const { bundle } = await wire(command, sub);

    expect(isOk(await bundle.pubsub.publish("ch", "hi"))).toBe(true);
    expect(isOk(await bundle.pubsub.subscribe("ch", () => {}))).toBe(true);

    // A subscribed connection cannot issue ordinary commands — that separation
    // is why the bundle holds two clients at all.
    expect(command.calls.map((c) => c.m)).toEqual(["publish"]);
    expect(sub.calls.map((c) => c.m)).toEqual(["subscribe"]);
  });

  it("delivers only messages for the subscribed channel", async () => {
    const sub = new FakeClient();
    const { bundle } = await wire(new FakeClient(), sub);

    const received: string[] = [];
    await bundle.pubsub.subscribe("wanted", (m) => received.push(m));

    for (const listener of sub.messageListeners) {
      listener("other", "no");
      listener("wanted", "yes");
    }
    expect(received).toEqual(["yes"]);
  });

  it("unsubscribe releases the channel", async () => {
    const sub = new FakeClient();
    const { bundle } = await wire(new FakeClient(), sub);

    const result = await bundle.pubsub.subscribe("ch", () => {});
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    await result.value.unsubscribe();
    expect(sub.calls.map((c) => c.m)).toEqual(["subscribe", "unsubscribe"]);
  });
});

// ── Disconnect ───────────────────────────────────────────────────────────────

describe("createRedisBundle — disconnect", () => {
  it("quits BOTH clients, so a restart loop cannot leak a connection per attempt", async () => {
    const command = new FakeClient();
    const sub = new FakeClient();
    const { bundle } = await wire(command, sub);

    await bundle.disconnect();
    expect(command.calls.map((c) => c.m)).toContain("quit");
    expect(sub.calls.map((c) => c.m)).toContain("quit");
  });
});
