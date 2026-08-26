/**
 * NFR-PC-001 — usage records written before prompt caching existed must still
 * parse.
 *
 * Durable journals written by 0.5.x carry `{ tokensIn, tokensOut }` and nothing
 * else. Parse, don't validate: the wire schema defaults the two cache fields to
 * zero — which is exactly what their absence means — so the parsed value is a
 * complete `TokenUsage` and no in-memory consumer needs an `undefined` branch.
 * The in-memory type keeps all four fields REQUIRED, so no construction site
 * can silently omit one.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { PersistedFrameworkErrorSchema } from "../types/errors.js";
import { uncachedInputTokens } from "../types/token-usage.js";

const persistedNodeCrash = (usage: unknown) => ({
  kind: "node-crash",
  nodeId: "n1",
  message: "boom",
  retriability: "retriable",
  usage,
});

describe("persisted usage — backward compatibility", () => {
  it("parses a pre-caching record, defaulting the cache figures to zero", () => {
    const parsed = PersistedFrameworkErrorSchema.safeParse(
      persistedNodeCrash({ tokensIn: 100, tokensOut: 50 }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const error = parsed.data;
    expect(error.kind).toBe("node-crash");
    if (error.kind !== "node-crash") return;
    expect(error.usage).toEqual({
      tokensIn: 100,
      tokensOut: 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    // The whole point: an old record yields a value the new code can use
    // arithmetically without a presence check.
    expect(uncachedInputTokens(error.usage!)).toBe(100);
  });

  it("round-trips a record that DOES carry cache figures", () => {
    const usage = { tokensIn: 910, tokensOut: 7, cacheWriteTokens: 900, cacheReadTokens: 0 };
    const parsed = PersistedFrameworkErrorSchema.safeParse(persistedNodeCrash(usage));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const error = parsed.data;
    if (error.kind !== "node-crash") return;
    expect(error.usage).toEqual(usage);
  });

  it("keeps an absent usage absent — 'no attributable tokens' stays distinguishable from zero", () => {
    const parsed = PersistedFrameworkErrorSchema.safeParse({
      kind: "node-crash",
      nodeId: "n1",
      message: "boom",
      retriability: "retriable",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const error = parsed.data;
    if (error.kind !== "node-crash") return;
    expect(error.usage).toBeUndefined();
  });

  it("parses any legacy two-field record into a well-formed TokenUsage", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (tokensIn, tokensOut) => {
        const parsed = PersistedFrameworkErrorSchema.safeParse(
          persistedNodeCrash({ tokensIn, tokensOut }),
        );
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        const error = parsed.data;
        if (error.kind !== "node-crash" || error.usage === undefined) return;
        expect(error.usage.cacheWriteTokens).toBe(0);
        expect(error.usage.cacheReadTokens).toBe(0);
        expect(uncachedInputTokens(error.usage)).toBe(tokensIn);
      }),
    );
  });
});
