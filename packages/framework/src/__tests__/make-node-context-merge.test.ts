/**
 * Tests for `mergeScopedCapabilities` (shared/make-node-context.ts) — the
 * dispatch-time merge of broker-minted handles over the boot-scoped base
 * NodeContext.
 *
 * The guard under test (A11): RESERVED infrastructure keys (`logger`/`tracer`/
 * `observer`, plus the built-in capability keys) are NEVER overwritten by a
 * minted handle. `Capability = keyof CapabilityRegistry` is open to consumer
 * augmentation, so a hostile/buggy broker COULD return a record keyed
 * `"logger"` — without the filter, `Object.assign` would clobber
 * framework-guaranteed infrastructure.
 */

import { describe, test, expect } from "bun:test";
import { makeNodeContext, mergeScopedCapabilities } from "../shared/make-node-context.js";
import type { ScopedCapabilityHandle } from "../types/capability-broker.js";
import type { Logger } from "../types/node.js";
import type { Tracer } from "../types/tracer.js";

const baseLogger: Logger = {
  warn: () => {},
  error: () => {},
};

const baseTracer: Tracer = {
  withSpan: async (_name, _type, fn) => fn(),
};

const makeBase = () =>
  makeNodeContext({
    runId: "run-merge",
    dagId: "dag-merge",
    logger: baseLogger,
    tracer: baseTracer,
  });

describe("mergeScopedCapabilities — reserved keys never clobbered (A11)", () => {
  test("a minted handle named 'logger'/'tracer'/'observer' does NOT overwrite framework infrastructure", () => {
    const base = makeBase();
    const evil = { sendMail: async () => ({ ok: true as const, value: { messageId: "x" } }) };
    // A record a broker could only produce by augmenting the registry with a
    // reserved name — the merge must drop these keys, keeping the merge total.
    const scoped = {
      logger: evil,
      tracer: evil,
      observer: evil,
    } as unknown as ScopedCapabilityHandle;

    const merged = mergeScopedCapabilities(base, scoped);

    // Infrastructure survives BY REFERENCE — not replaced, not wrapped.
    expect(merged.logger).toBe(baseLogger);
    expect(merged.tracer).toBe(baseTracer);
    expect(merged.observer).toBe(base.observer);
  });

  test("a non-reserved minted key DOES merge over the base (the filter is not dropping everything)", () => {
    const base = makeBase();
    const handle = { sendMail: async () => ({ ok: true as const, value: { messageId: "m-1" } }) };
    const scoped = {
      "msgraph:mail.send": handle,
      logger: { warn: () => {}, error: () => {} },
    } as unknown as ScopedCapabilityHandle;

    const merged = mergeScopedCapabilities(base, scoped);

    expect((merged as unknown as Record<string, unknown>)["msgraph:mail.send"]).toBe(handle);
    expect(merged.logger).toBe(baseLogger); // reserved key still protected
    // The base context itself is untouched (the merge returns a NEW context).
    expect((base as unknown as Record<string, unknown>)["msgraph:mail.send"]).toBeUndefined();
  });

  test("built-in capability keys are reserved too — a minted 'llm' cannot replace the boot-scoped client", () => {
    const base = makeBase();
    const scoped = { llm: { bogus: true } } as unknown as ScopedCapabilityHandle;
    const merged = mergeScopedCapabilities(base, scoped);
    expect(merged.llm).toBe(base.llm);
  });

  test("a minted 'budget' cannot replace the runtime-owned read authority", () => {
    const budget = {
      spent: () => ({ tokens: 0, calls: 0, usd: { kind: "priced" as const, micros: 0 as never } }),
      remaining: () => ({ kind: "unbudgeted" as const }),
    };
    const base = makeNodeContext({ runId: "run-merge", dagId: "dag-merge", budget });
    const merged = mergeScopedCapabilities(
      base,
      { budget: { poisoned: true } } as unknown as ScopedCapabilityHandle,
    );
    expect(merged.budget).toBe(budget);
  });

  test("an empty (or all-null) mint result returns the base context BY REFERENCE (byte-identical no-op)", () => {
    const base = makeBase();
    expect(mergeScopedCapabilities(base, {} as ScopedCapabilityHandle)).toBe(base);
    expect(
      mergeScopedCapabilities(base, { logger: null } as unknown as ScopedCapabilityHandle),
    ).toBe(base);
  });
});

// ── Pass-4 A3: a dropped non-null reserved entry is WARNED, not silent ───────

import { setFrameworkLogger, __resetFrameworkLogger } from "../logger.js";

describe("mergeScopedCapabilities — dropped reserved entries are warned (capability.merge.dropped)", () => {
  test("a non-null minted entry under a built-in key emits one warn with key + run/dag correlation", () => {
    const warns: { msg: string; data: Record<string, unknown> }[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg, ...args) => warns.push({ msg, data: (args[0] ?? {}) as Record<string, unknown> }),
      error: () => {},
    });
    try {
      const base = makeBase();
      // validateCapabilities' loud rejection only covers brokers implementing
      // provides(); a passthrough-style broker built with a built-in key
      // reaches the merge unannounced — the warn is its only trace.
      const scoped = { http: { tag: "broker-http" } } as unknown as ScopedCapabilityHandle;
      const merged = mergeScopedCapabilities(base, scoped);

      // The entry was dropped (base unchanged) …
      expect(merged).toBe(base);
      // … and the drop was surfaced, not silent.
      const w = warns.find((x) => x.msg === "capability.merge.dropped");
      expect(w).toBeDefined();
      expect(w?.data.key).toBe("http");
      expect(w?.data.runId).toBe("run-merge");
      expect(w?.data.dagId).toBe("dag-merge");
    } finally {
      __resetFrameworkLogger();
    }
  });

  test("null/absent minted entries do NOT warn (a broker that resolved nothing is the documented no-op)", () => {
    const warns: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(msg),
      error: () => {},
    });
    try {
      const base = makeBase();
      const merged = mergeScopedCapabilities(base, {} as ScopedCapabilityHandle);
      expect(merged).toBe(base);
      expect(warns).toHaveLength(0);
    } finally {
      __resetFrameworkLogger();
    }
  });
});
