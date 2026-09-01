/** Tests for the fail-closed dispatch-time capability merge. */

import { describe, expect, test } from "bun:test";
import { makeNodeContext, mergeScopedCapabilities } from "../shared/make-node-context.js";
import type { ScopedCapabilityHandle } from "../types/capability-broker.js";
import type { Logger } from "../types/node.js";
import type { DagId, RunId } from "../types/ids.js";
import type { Tracer } from "../types/tracer.js";

const baseLogger: Logger = { warn: () => {}, error: () => {} };
const baseTracer: Tracer = { withSpan: async (_name, _type, fn) => fn() };

const makeBase = () => makeNodeContext({
  runId: "run-merge",
  dagId: "dag-merge",
  logger: baseLogger,
  tracer: baseTracer,
});

const mergeOk = (
  base: ReturnType<typeof makeBase>,
  scoped: ScopedCapabilityHandle,
) => {
  const merged = mergeScopedCapabilities(base, scoped);
  expect(merged.ok).toBe(true);
  if (!merged.ok) throw new Error(`unexpected merge failure for ${merged.error.key}`);
  return merged.value;
};

describe("makeNodeContext built-in capability ownership", () => {
  test("revalidates forged branded identifiers because brands erase at runtime", () => {
    expect(() => makeNodeContext({
      runId: "bad run" as RunId,
      dagId: "valid-dag",
    })).toThrow(/Invalid runId/);
    expect(() => makeNodeContext({
      runId: "valid-run",
      dagId: "bad:dag" as DagId,
    })).toThrow(/Invalid dagId/);
  });

  test("ignores Object.prototype pollution instead of satisfying a built-in", () => {
    const inherited = { request: async () => ({ ok: true }) };
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "http");
    Object.defineProperty(Object.prototype, "http", {
      value: inherited,
      configurable: true,
    });
    try {
      const ctx = makeNodeContext({
        runId: "run-polluted",
        dagId: "dag-polluted",
        capabilities: {},
      });
      expect(ctx.http).toBeNull();
      expect(Object.hasOwn(ctx, "http")).toBe(true);
    } finally {
      if (prior === undefined) delete (Object.prototype as Record<string, unknown>).http;
      else Object.defineProperty(Object.prototype, "http", prior);
    }
  });

  test("checks ownership before evaluating an inherited built-in getter", () => {
    let reads = 0;
    const prototype = Object.defineProperty({}, "http", {
      get() {
        reads += 1;
        throw new Error("inherited built-in getter must not run");
      },
    });
    const init = Object.assign(Object.create(prototype), {
      runId: "run-hostile-built-in",
      dagId: "dag-hostile-built-in",
    });

    const ctx = makeNodeContext(init);
    expect(ctx.http).toBeNull();
    expect(reads).toBe(0);
  });

  test("ignores a capabilities bag inherited by the init object", () => {
    const inheritedHttp = { tag: "inherited-http" };
    const inheritedCustom = { tag: "inherited-custom" };
    const init = Object.assign(Object.create({
      capabilities: {
        http: inheritedHttp,
        "svc:inherited": inheritedCustom,
      },
    }), {
      runId: "run-inherited-init",
      dagId: "dag-inherited-init",
    });

    const ctx = makeNodeContext(init);
    expect(ctx.http).toBeNull();
    expect((ctx as unknown as Record<string, unknown>)["svc:inherited"]).toBeUndefined();
  });

  test("ignores an Object.prototype capabilities bag", () => {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "capabilities");
    Object.defineProperty(Object.prototype, "capabilities", {
      value: {
        http: { tag: "prototype-http" },
        "svc:prototype": { tag: "prototype-custom" },
      },
      configurable: true,
    });
    try {
      const ctx = makeNodeContext({
        runId: "run-prototype-init",
        dagId: "dag-prototype-init",
      });
      expect(ctx.http).toBeNull();
      expect((ctx as unknown as Record<string, unknown>)["svc:prototype"]).toBeUndefined();
    } finally {
      if (prior === undefined) {
        delete (Object.prototype as Record<string, unknown>).capabilities;
      } else {
        Object.defineProperty(Object.prototype, "capabilities", prior);
      }
    }
  });

  test("accepts only own values from a custom-prototype bag and preserves top-level precedence", () => {
    const inherited = { tag: "inherited-http" };
    const own = { tag: "own-http" };
    const bag = Object.assign(Object.create({ http: inherited }), { http: own });

    const fromBag = makeNodeContext({
      runId: "run-own",
      dagId: "dag-own",
      capabilities: bag,
    });
    expect(fromBag.http as unknown).toBe(own);

    delete bag.http;
    const inheritedOnly = makeNodeContext({
      runId: "run-inherited",
      dagId: "dag-inherited",
      capabilities: bag,
    });
    expect(inheritedOnly.http).toBeNull();

    const explicitNull = makeNodeContext({
      runId: "run-null",
      dagId: "dag-null",
      http: null,
      capabilities: Object.assign(Object.create({ http: inherited }), { http: own }),
    });
    expect(explicitNull.http).toBeNull();
  });
});

describe("mergeScopedCapabilities", () => {
  test("fails closed for every non-null reserved infrastructure key", () => {
    const base = makeBase();
    const evil = { sendMail: async () => ({ ok: true as const, value: { messageId: "x" } }) };
    for (const key of ["logger", "tracer", "observer"] as const) {
      const merged = mergeScopedCapabilities(
        base,
        { [key]: evil } as unknown as ScopedCapabilityHandle,
      );
      expect(merged).toEqual({
        ok: false,
        error: { kind: "reserved-capability", key },
      });
      expect(base.logger).toBe(baseLogger);
      expect(base.tracer).toBe(baseTracer);
    }
  });

  test("fails closed for broker-minted built-ins while the static client stays authoritative", () => {
    const budget = {
      spent: () => ({
        usage: "known" as const,
        tokens: 0,
        calls: 0,
        usd: { kind: "priced" as const, micros: 0 as never },
      }),
      remaining: () => ({ kind: "unbudgeted" as const }),
    };
    const base = makeNodeContext({ runId: "run-merge", dagId: "dag-merge", budget });

    for (const key of ["llm", "budget", "http"] as const) {
      expect(mergeScopedCapabilities(
        base,
        { [key]: { poisoned: true } } as unknown as ScopedCapabilityHandle,
      )).toEqual({
        ok: false,
        error: { kind: "reserved-capability", key },
      });
    }
    expect(base.budget).toBe(budget);
  });

  test("rejects prototype-meta keys from parsed broker output without prototype or inherited injection", () => {
    const base = makeBase();
    const parsed = JSON.parse(
      '{"__proto__":{"injectedCapability":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
    ) as ScopedCapabilityHandle;

    for (const key of ["__proto__", "constructor", "prototype"] as const) {
      const single = JSON.parse(JSON.stringify({ [key]: { polluted: true } })) as ScopedCapabilityHandle;
      expect(mergeScopedCapabilities(base, single)).toEqual({
        ok: false,
        error: { kind: "reserved-capability", key },
      });
    }

    const merged = mergeScopedCapabilities(base, parsed);
    expect(merged.ok).toBe(false);
    expect(Object.getPrototypeOf(base)).toBeNull();
    expect(Object.hasOwn(base, "__proto__")).toBe(false);
    expect((base as unknown as Record<string, unknown>).__proto__).toBeUndefined();
    expect((base as unknown as Record<string, unknown>).constructor).toBeUndefined();
    expect((base as unknown as Record<string, unknown>).prototype).toBeUndefined();
    expect((base as unknown as Record<string, unknown>).injectedCapability).toBeUndefined();
    expect(({} as Record<string, unknown>).injectedCapability).toBeUndefined();
  });

  test("merges a non-reserved minted key over a new context", () => {
    const base = makeBase();
    const handle = { sendMail: async () => ({ ok: true as const, value: { messageId: "m-1" } }) };
    const merged = mergeOk(
      base,
      { "msgraph:mail.send": handle } as unknown as ScopedCapabilityHandle,
    );

    expect((merged as unknown as Record<string, unknown>)["msgraph:mail.send"]).toBe(handle);
    expect((base as unknown as Record<string, unknown>)["msgraph:mail.send"]).toBeUndefined();
  });

  test("empty and all-null mint results return the base context by reference", () => {
    const base = makeBase();
    expect(mergeOk(base, {} as ScopedCapabilityHandle)).toBe(base);
    expect(mergeOk(
      base,
      { logger: null } as unknown as ScopedCapabilityHandle,
    )).toBe(base);
  });
});
