// pr53-repair-regression.test.ts — CRITICAL 3 + CRITICAL 4 remediation pins.
//
// CRITICAL 3: `closeEvalFailed` (arm kind "ok-eval-failed") and
// `closeGuardrailFailed` (arm "ok-guardrail-failed") in `run-telemetry.ts`
// were exercised by no test — a mis-wiring of `closeRootSpan`'s match arms
// (e.g. routing both to `closeOk`) would have silently downgraded the root
// span's ERROR status and dropped the failure attributes on every eval- or
// guardrail-failed run. These tests pin the arm bodies exactly.
//
// CRITICAL 4: no test asserted the GenAI message-event content redaction in
// `span-enrich.ts` — the filter-or-redact rule that keeps raw prompt and
// reasoning text out of traces when no content filter is wired. These tests
// pin the rule for all three events (system / user / assistant).

import { describe, test, expect } from "bun:test";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  closeRootSpan,
  outcomeFromMeta,
} from "../dag-runtime/run-telemetry.js";
import type { DagRunMeta } from "../dag-runtime/node-span.js";
import { createDagRunMeta } from "../dag-runtime/node-span.js";
import type { EvalJudgeResult } from "../nodes/eval-judge.js";
import { IDENTITY_FILTER } from "../tracing/content-filter.js";
import { tokensOnly } from "../types/token-usage.js";
import { captureEnrichment } from "./_span-capture.js";
import {
  AI_LLM_HAS_THINKING,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  EVENT_NODE_OUTPUT,
} from "../tracing/semantic-conventions.js";

// ---------------------------------------------------------------------------
// CRITICAL 3 — root-span eval-failed / guardrail-failed arms
// ---------------------------------------------------------------------------

interface RecordedStatus {
  readonly code: SpanStatusCode;
  readonly message: string;
}

interface RecordedEvent {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
}

/** A recording span: captures every setStatus/addEvent without OTel machinery. */
const captureSpan = (): { span: Span; statuses: RecordedStatus[]; events: RecordedEvent[] } => {
  const statuses: RecordedStatus[] = [];
  const events: RecordedEvent[] = [];
  const span = {
    setStatus: (status: RecordedStatus) => {
      statuses.push(status);
      return span;
    },
    addEvent: (name: string, attrs?: Record<string, unknown>) => {
      events.push({ name, attrs: attrs ?? {} });
      return span;
    },
    end: () => {},
  } as unknown as Span;
  return { span, statuses, events };
};

const failedJudgeResult = (criteria: readonly string[]): EvalJudgeResult => ({
  criteriaScores: Object.fromEntries(criteria.map((c) => [c, 0])),
  failedCriteria: criteria,
  reason: "criteria failed",
  outcome: "failed",
  score: 0,
});

const metaWithEvalFailure = (results: readonly EvalJudgeResult[]): DagRunMeta => ({
  ...createDagRunMeta(),
  evalJudgeFailed: true,
  evalJudgeResults: results,
});

const metaWithGuardrailFailure = (warnings: readonly string[]): DagRunMeta => ({
  ...createDagRunMeta(),
  guardrailFailed: true,
  guardrailWarnings: warnings,
});

describe("closeRootSpan — ok-eval-failed arm (CRITICAL 3)", () => {
  test("marks the span ERROR with the exact eval message and the failure event", () => {
    const results = [failedJudgeResult(["accuracy"]), failedJudgeResult(["tone"])];
    const { span, statuses, events } = captureSpan();

    closeRootSpan(span, outcomeFromMeta(metaWithEvalFailure(results)));

    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.code).toBe(SpanStatusCode.ERROR);
    expect(statuses[0]!.message).toBe("Eval-judge failed: accuracy, tone");

    const output = events.find((e) => e.name === EVENT_NODE_OUTPUT);
    expect(output).toBeDefined();
    expect(output!.attrs["status"]).toBe("ok");
    expect(output!.attrs["evalJudgeFailed"]).toBe("true");
    expect(output!.attrs["evalJudgeResults"]).toBe(JSON.stringify(results));
    // A guardrail warning must NOT ride along on the eval arm.
    expect("guardrailWarnings" in output!.attrs).toBe(false);
  });

  test("a single failed criterion renders without separators", () => {
    const { span, statuses } = captureSpan();
    closeRootSpan(span, outcomeFromMeta(metaWithEvalFailure([failedJudgeResult(["relevance"])])));
    expect(statuses[0]!.message).toBe("Eval-judge failed: relevance");
  });
});

describe("closeRootSpan — ok-guardrail-failed arm (CRITICAL 3)", () => {
  test("marks the span ERROR with the exact guardrail message and the warning event", () => {
    const warnings = ["pii-detected:email", "injection-pattern"];
    const { span, statuses, events } = captureSpan();

    closeRootSpan(span, outcomeFromMeta(metaWithGuardrailFailure(warnings)));

    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.code).toBe(SpanStatusCode.ERROR);
    expect(statuses[0]!.message).toBe("Guardrail failed: pii-detected:email; injection-pattern");

    const output = events.find((e) => e.name === EVENT_NODE_OUTPUT);
    expect(output).toBeDefined();
    expect(output!.attrs["status"]).toBe("ok");
    expect(output!.attrs["guardrailWarnings"]).toBe(JSON.stringify(warnings));
    // The eval attributes must NOT ride along on the guardrail arm.
    expect("evalJudgeFailed" in output!.attrs).toBe(false);
    expect("evalJudgeResults" in output!.attrs).toBe(false);
  });

  test("eval failure takes precedence when both failures are present", () => {
    const results = [failedJudgeResult(["accuracy"])];
    const { span, statuses, events } = captureSpan();
    const meta: DagRunMeta = {
      ...metaWithEvalFailure(results),
      guardrailFailed: true,
      guardrailWarnings: ["w1"],
    };

    closeRootSpan(span, outcomeFromMeta(meta));

    expect(statuses[0]!.message).toBe("Eval-judge failed: accuracy");
    expect(events.find((e) => e.name === EVENT_NODE_OUTPUT)!.attrs["evalJudgeFailed"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 4 — GenAI message-event content redaction
// ---------------------------------------------------------------------------

// The span-capture harness lives in `_span-capture.ts`, shared with the
// span-enrich suite.

interface EnrichedCapture {
  attributes: Record<string, unknown>;
  events: { name: string; attrs: Record<string, unknown> }[];
}

const eventOf = (events: EnrichedCapture["events"], name: string): Record<string, unknown> => {
  const event = events.find((e) => e.name === name);
  expect(event).toBeDefined();
  return event?.attrs ?? {};
};

const baseOpts = {
  model: "gpt-test",
  system: "system prompt",
  user: "user prompt",
  provider: "openai",
  usage: tokensOnly(10, 5),
  thinking: "secret reasoning",
};

describe("enrichLlmSpan — GenAI message redaction with no content filter (CRITICAL 4)", () => {
  test("system message carries content_redacted + content_chars and NO raw content", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: null });
    const attrs = eventOf(events, EVENT_GEN_AI_SYSTEM_MESSAGE);
    expect(attrs["content_redacted"]).toBe("true");
    expect(attrs["content_chars"]).toBe("system prompt".length);
    expect("content" in attrs).toBe(false);
  });

  test("user message carries content_redacted + content_chars and NO raw content", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: null });
    const attrs = eventOf(events, EVENT_GEN_AI_USER_MESSAGE);
    expect(attrs["content_redacted"]).toBe("true");
    expect(attrs["content_chars"]).toBe("user prompt".length);
    expect("content" in attrs).toBe(false);
  });

  test("assistant message carries reasoning_content_redacted + _chars and NO raw reasoning", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: null });
    const attrs = eventOf(events, EVENT_GEN_AI_ASSISTANT_MESSAGE);
    expect(attrs["reasoning_content_redacted"]).toBe("true");
    expect(attrs["reasoning_content_chars"]).toBe("secret reasoning".length);
    expect("reasoning_content" in attrs).toBe(false);
  });

  test("undefined contentFilter redacts exactly like an explicit null", () => {
    const { events } = captureEnrichment({ ...baseOpts });
    const system = eventOf(events, EVENT_GEN_AI_SYSTEM_MESSAGE);
    expect(system["content_redacted"]).toBe("true");
    expect("content" in system).toBe(false);
  });
});

describe("enrichLlmSpan — GenAI message content with a wired filter (CRITICAL 4)", () => {
  const uppercase: (s: string) => string = (s) => s.toUpperCase();

  test("system message carries the FILTERED content and no _redacted keys", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: uppercase });
    const attrs = eventOf(events, EVENT_GEN_AI_SYSTEM_MESSAGE);
    expect(attrs["content"]).toBe("SYSTEM PROMPT");
    expect("content_redacted" in attrs).toBe(false);
    expect("content_chars" in attrs).toBe(false);
  });

  test("user message carries the FILTERED content and no _redacted keys", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: uppercase });
    const attrs = eventOf(events, EVENT_GEN_AI_USER_MESSAGE);
    expect(attrs["content"]).toBe("USER PROMPT");
    expect("content_redacted" in attrs).toBe(false);
    expect("content_chars" in attrs).toBe(false);
  });

  test("assistant message carries the FILTERED reasoning and no _redacted keys", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: uppercase });
    const attrs = eventOf(events, EVENT_GEN_AI_ASSISTANT_MESSAGE);
    expect(attrs["reasoning_content"]).toBe("SECRET REASONING");
    expect("reasoning_content_redacted" in attrs).toBe(false);
    expect("reasoning_content_chars" in attrs).toBe(false);
  });

  test("IDENTITY_FILTER passes content through unmodified", () => {
    const { events } = captureEnrichment({ ...baseOpts, contentFilter: IDENTITY_FILTER });
    expect(eventOf(events, EVENT_GEN_AI_SYSTEM_MESSAGE)["content"]).toBe("system prompt");
    expect(eventOf(events, EVENT_GEN_AI_USER_MESSAGE)["content"]).toBe("user prompt");
  });
});

describe("enrichLlmSpan — ai.llm.has_thinking (CRITICAL 4)", () => {
  test("set (true) only when thinking is supplied", () => {
    const withThinking = captureEnrichment({ ...baseOpts, contentFilter: null });
    expect(withThinking.attributes[AI_LLM_HAS_THINKING]).toBe(true);
    expect(withThinking.events.some((e) => e.name === EVENT_GEN_AI_ASSISTANT_MESSAGE)).toBe(true);
  });

  test("absent when no thinking was supplied — no event either", () => {
    const { thinking: _thinking, ...noThinking } = baseOpts;
    const capture = captureEnrichment({ ...noThinking, contentFilter: null });
    expect(AI_LLM_HAS_THINKING in capture.attributes).toBe(false);
    expect(capture.events.some((e) => e.name === EVENT_GEN_AI_ASSISTANT_MESSAGE)).toBe(false);
  });
});
