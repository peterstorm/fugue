/**
 * Prompt-cache placement — the rules `llm/prompt-cache.ts` owns.
 *
 * Pins INV-PC-5 (a plan never approaches the provider's four-slot cap) and the
 * policy → placement mapping the clients depend on.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  MAX_CACHE_BREAKPOINTS,
  NO_CACHE_PLAN,
  cachePolicyLabel,
  planPromptCache,
  planRequestsCaching,
  plannedBreakpointCount,
} from "../llm/prompt-cache.js";
import type { CacheTtl, ConversationCachePolicy } from "../types/llm.js";

const arbTtl: fc.Arbitrary<CacheTtl> = fc.constantFrom<CacheTtl>("5m", "1h");

const arbPolicy: fc.Arbitrary<ConversationCachePolicy> = fc.oneof(
  fc.constant<ConversationCachePolicy>({ kind: "none" }),
  arbTtl.map<ConversationCachePolicy>((ttl) => ({ kind: "static-prefix", ttl })),
  arbTtl.map<ConversationCachePolicy>((ttl) => ({ kind: "conversation", ttl })),
);

describe("planPromptCache — policy to placement", () => {
  it("emits nothing for an omitted policy", () => {
    expect(planPromptCache(undefined)).toEqual(NO_CACHE_PLAN);
  });

  it("treats an explicit `none` exactly like an omitted policy", () => {
    expect(planPromptCache({ kind: "none" })).toEqual(planPromptCache(undefined));
  });

  it("puts one breakpoint at the end of system for `static-prefix`", () => {
    expect(planPromptCache({ kind: "static-prefix", ttl: "5m" })).toEqual({
      systemBreakpoint: true,
      turnBreakpoint: false,
      ttl: "5m",
    });
  });

  it("adds the rolling turn breakpoint for `conversation`", () => {
    expect(planPromptCache({ kind: "conversation", ttl: "1h" })).toEqual({
      systemBreakpoint: true,
      turnBreakpoint: true,
      ttl: "1h",
    });
  });

  it("carries the declared TTL through unchanged", () => {
    fc.assert(
      fc.property(arbPolicy, (policy) => {
        const plan = planPromptCache(policy);
        expect(plan.ttl).toBe(policy.kind === "none" ? null : policy.ttl);
      }),
    );
  });
});

describe("INV-PC-5 — a plan never approaches the provider's breakpoint cap", () => {
  it("emits at most 2 breakpoints for any policy", () => {
    fc.assert(
      fc.property(fc.option(arbPolicy, { nil: undefined }), (policy) => {
        const count = plannedBreakpointCount(planPromptCache(policy));
        expect(count).toBeLessThanOrEqual(2);
        expect(count).toBeLessThan(MAX_CACHE_BREAKPOINTS);
      }),
    );
  });

  it("ties `planRequestsCaching` to emitting at least one breakpoint", () => {
    fc.assert(
      fc.property(fc.option(arbPolicy, { nil: undefined }), (policy) => {
        const plan = planPromptCache(policy);
        expect(planRequestsCaching(plan)).toBe(plannedBreakpointCount(plan) > 0);
      }),
    );
  });

  // "A TTL is emitted exactly when a breakpoint is" used to be a property test
  // here. It is now a property of the TYPE: `PromptCachePlan` is a union whose
  // no-breakpoint arm fixes `ttl: null` and whose breakpoint arm fixes
  // `ttl: CacheTtl`, so a plan that disagrees cannot be constructed. A test that
  // can no longer fail is noise — the guarantee moved up, it did not disappear.
});

describe("cachePolicyLabel", () => {
  it("renders an omitted policy as `none`, indistinguishable from explicit off", () => {
    expect(cachePolicyLabel(undefined)).toBe("none");
    expect(cachePolicyLabel({ kind: "none" })).toBe("none");
  });

  it("renders the declared discriminant otherwise", () => {
    expect(cachePolicyLabel({ kind: "static-prefix", ttl: "5m" })).toBe("static-prefix");
    expect(cachePolicyLabel({ kind: "conversation", ttl: "1h" })).toBe("conversation");
  });
});
