import { describe, it, expect } from "bun:test";
import {
  validateGrounding,
  checkTopicGrounding,
  checkSentimentConsistency,
  checkConversationCount,
} from "../validation/grounding.js";
import type { SynthesisOutput } from "../schemas/summary.js";
import type { CrmRecord } from "../schemas/crm.js";
import { TOPIC_KEYWORDS } from "../extraction/topics.js";

const makeRecord = (overrides: Partial<CrmRecord> = {}): CrmRecord => ({
  customerId: "test-001",
  name: "Test User",
  createdAt: "2024-01-01T00:00:00Z",
  conversations: [
    {
      id: "conv-1",
      date: "2024-06-01",
      channel: "chat",
      messages: [
        { role: "customer", content: "I have a billing question about my invoice.", timestamp: "2024-06-01T10:00:00Z" },
        { role: "agent", content: "Let me check your account.", timestamp: "2024-06-01T10:01:00Z" },
        { role: "customer", content: "Thanks, that was helpful!", timestamp: "2024-06-01T10:02:00Z" },
      ],
    },
  ],
  ...overrides,
});

const makeSynthesis = (overrides: Partial<SynthesisOutput> = {}): SynthesisOutput => ({
  overallSentiment: "positive",
  sentimentScore: 0.5,
  keyTopics: ["billing"],
  summary: "Customer had a billing inquiry that was resolved.",
  actionItems: [],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
  ...overrides,
});

describe("checkTopicGrounding", () => {
  it("passes when topics are grounded in source", () => {
    const result = checkTopicGrounding(makeSynthesis({ keyTopics: ["billing"] }), makeRecord());
    expect(result.passed).toBe(true);
  });

  it("fails when topics are not grounded", () => {
    const result = checkTopicGrounding(makeSynthesis({ keyTopics: ["shipping"] }), makeRecord());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("shipping");
  });

  // Round-13 C1: the guardrail's topic table is the SHARED extractor table
  // (`extraction/topics.ts`). This module once kept a private "mirror" copy
  // whose `general` net had drifted — an undocumented inquiry/request/
  // assistance widening and a MISSING `contact` — so a `general` topic
  // grounded only by "contact" in the source produced a spurious ungrounded-
  // topic warning plus a false ERROR span in a shipped ok response.
  it("a `general` topic grounded only by 'contact' passes (the drifted-mirror case)", () => {
    const record = makeRecord({
      conversations: [
        {
          id: "conv-1",
          date: "2024-06-01",
          channel: "chat",
          messages: [
            { role: "customer", content: "Please contact us.", timestamp: "2024-06-01T10:00:00Z" },
          ],
        },
      ],
    });
    const result = checkTopicGrounding(makeSynthesis({ keyTopics: ["general"] }), record);
    expect(result.passed).toBe(true);
  });

  it("every EXTRACTOR `general` keyword grounds the `general` topic (one shared table, no private mirror)", () => {
    for (const keyword of TOPIC_KEYWORDS["general"]) {
      const record = makeRecord({
        conversations: [
          {
            id: "conv-1",
            date: "2024-06-01",
            channel: "chat",
            messages: [
              { role: "customer", content: `hello ${keyword} hello`, timestamp: "2024-06-01T10:00:00Z" },
            ],
          },
        ],
      });
      const result = checkTopicGrounding(makeSynthesis({ keyTopics: ["general"] }), record);
      expect(result.passed).toBe(true);
    }
  });
});

describe("checkSentimentConsistency", () => {
  it("passes when sentiment matches source tone", () => {
    const result = checkSentimentConsistency(makeSynthesis({ overallSentiment: "positive" }), makeRecord());
    expect(result.passed).toBe(true);
  });

  it("fails when claiming positive but source is negative", () => {
    const record = makeRecord({
      conversations: [
        {
          id: "conv-1",
          date: "2024-06-01",
          channel: "chat",
          messages: [
            { role: "customer", content: "This is terrible, awful, and broken. I'm frustrated and disappointed.", timestamp: "2024-06-01T10:00:00Z" },
            { role: "customer", content: "Unacceptable and horrible service.", timestamp: "2024-06-01T10:01:00Z" },
          ],
        },
      ],
    });
    const result = checkSentimentConsistency(makeSynthesis({ overallSentiment: "positive" }), record);
    expect(result.passed).toBe(false);
  });
});

describe("checkConversationCount", () => {
  it("passes when no count is mentioned", () => {
    const result = checkConversationCount(makeSynthesis(), makeRecord());
    expect(result.passed).toBe(true);
  });

  it("fails when wrong count is claimed", () => {
    const synthesis = makeSynthesis({ summary: "Across 5 conversations, the customer discussed billing." });
    const result = checkConversationCount(synthesis, makeRecord());
    expect(result.passed).toBe(false);
  });

  it("passes when correct count is claimed", () => {
    const synthesis = makeSynthesis({ summary: "In 1 conversation, the customer asked about billing." });
    const result = checkConversationCount(synthesis, makeRecord());
    expect(result.passed).toBe(true);
  });
});

describe("validateGrounding", () => {
  it("returns allPassed true when everything is grounded", () => {
    const result = validateGrounding(makeSynthesis(), makeRecord());
    expect(result.allPassed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns warnings for ungrounded claims", () => {
    const synthesis = makeSynthesis({
      keyTopics: ["shipping"],
      summary: "Across 10 conversations about shipping delays.",
    });
    const result = validateGrounding(synthesis, makeRecord());
    expect(result.allPassed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
