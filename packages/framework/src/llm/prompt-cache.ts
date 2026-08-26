// prompt-cache — where provider-side cache breakpoints go, as a pure decision.
//
// Functional core: no SDK types, no I/O. The clients translate a `PromptCachePlan`
// into whatever their provider's wire format calls a breakpoint; keeping the
// decision here means the placement rules are testable without a provider and
// stated exactly once.
//
// THE RULES THIS MODULE OWNS (from the Anthropic prompt-caching contract):
//
//   1. Caching is a PREFIX match over the rendered `tools → system → messages`
//      order. A breakpoint at the end of `system` therefore caches tools AND
//      system together — there is no separate "cache the tools" step.
//   2. At most FOUR breakpoints per request. Exceeding it is a 400.
//   3. Content after the last breakpoint is never cached, so volatile content
//      (the per-call user message) must follow it. `LlmRequest` puts the user
//      message in `messages`, which renders last — this holds by construction.
//   4. A breakpoint walks back at most 20 content blocks to find a prior entry.
//      A single turn appending more than 20 blocks breaks the chain; that shows
//      up as an inert policy (FR-PC-009) rather than as silence.
//
// @satisfies FR-PC-001 — policy in, placement out
// @satisfies FR-PC-002 — `static-prefix` ⇒ one breakpoint, end of system
// @satisfies FR-PC-003 — `conversation` ⇒ plus one rolling per-turn breakpoint

import { match } from "ts-pattern";
import type { CacheTtl, ConversationCachePolicy } from "../types/llm.js";

/**
 * The provider's hard cap on `cache_control` breakpoints in one request.
 * Exported so the invariant test asserts against the real constraint rather
 * than a copy of it.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Where a request's breakpoints go.
 *
 * Deliberately not a list of indices: the two placements fugue emits are
 * structural (end of system, end of the latest turn), so booleans keep an
 * out-of-range or out-of-order index unrepresentable.
 *
 * Deliberately a UNION rather than three independent fields: a TTL belongs to
 * the breakpoints that carry it, so "no breakpoints but a TTL" and "a
 * breakpoint with no TTL to put on it" are both nonsense. Splitting on
 * `systemBreakpoint` makes each unrepresentable instead of merely unproduced —
 * the same treatment `BudgetDecision` and `AdmitDecision` get in the host meter.
 * A turn breakpoint without a system one is also excluded: the system prefix is
 * the cheapest and largest cacheable span, so caching a turn while leaving it
 * uncached is never the intent.
 */
export type PromptCachePlan =
  | {
      /** Emit a breakpoint at the end of the system block — caches tools + system. */
      readonly systemBreakpoint: false;
      readonly turnBreakpoint: false;
      /** No breakpoints, so there is no lifetime to carry. */
      readonly ttl: null;
    }
  | {
      readonly systemBreakpoint: true;
      /**
       * Roll a breakpoint onto the last block of each completed turn, so the
       * next turn reads the prefix this one wrote. Tool loops only.
       */
      readonly turnBreakpoint: boolean;
      /** TTL carried by every breakpoint this plan emits. */
      readonly ttl: CacheTtl;
    };

/** The plan that emits nothing — today's behaviour, and the default. */
export const NO_CACHE_PLAN: PromptCachePlan = Object.freeze({
  systemBreakpoint: false,
  turnBreakpoint: false,
  ttl: null,
});

/**
 * Derive breakpoint placement from a declared policy. Total over the union and
 * over `undefined` (an omitted policy means `none`).
 */
export const planPromptCache = (
  policy: ConversationCachePolicy | undefined,
): PromptCachePlan =>
  policy === undefined
    ? NO_CACHE_PLAN
    : match(policy)
        .returnType<PromptCachePlan>()
        .with({ kind: "none" }, () => NO_CACHE_PLAN)
        .with({ kind: "static-prefix" }, ({ ttl }) => ({
          systemBreakpoint: true as const,
          turnBreakpoint: false,
          ttl,
        }))
        .with({ kind: "conversation" }, ({ ttl }) => ({
          systemBreakpoint: true as const,
          turnBreakpoint: true,
          ttl,
        }))
        .exhaustive();

/**
 * How many breakpoints this plan emits in a single request.
 *
 * The per-turn breakpoint is ROLLING — the previous turn's is dropped when the
 * next is set — so a `conversation` plan emits two regardless of how long the
 * loop runs. This is what keeps fugue structurally clear of the four-slot cap
 * (INV-PC-5) instead of relying on a runtime count.
 */
export const plannedBreakpointCount = (plan: PromptCachePlan): number =>
  (plan.systemBreakpoint ? 1 : 0) + (plan.turnBreakpoint ? 1 : 0);

/** True when the plan asked the provider for caching and expects a report back. */
export const planRequestsCaching = (plan: PromptCachePlan): boolean =>
  plan.systemBreakpoint || plan.turnBreakpoint;

/**
 * The policy's discriminant, for span attributes and log lines. `undefined`
 * renders as `"none"` so telemetry never distinguishes "omitted" from
 * "explicitly off" — they are the same request.
 */
export const cachePolicyLabel = (
  policy: ConversationCachePolicy | undefined,
): ConversationCachePolicy["kind"] => policy?.kind ?? "none";
