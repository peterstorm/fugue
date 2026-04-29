import { describe, test, expect } from "bun:test";
import { extractFeatures } from "../dag/nodes/extract-features.js";
import type { CrmRecord, Conversation, Message } from "../schemas/crm.js";

const makeMsg = (content: string): Message => ({
  role: "customer",
  content,
  timestamp: "2025-05-01T00:00:00Z",
});

const makeConv = (msgs: Message[]): Conversation => ({
  id: "c1",
  date: "2025-05-01",
  channel: "chat",
  messages: msgs,
});

const makeCustomer = (conversations: Conversation[]): CrmRecord => ({
  customerId: "cust-1",
  name: "Test User",
  createdAt: "2025-01-01",
  conversations,
});

describe("extractFeatures", () => {
  test("null customer → not_found", () => {
    expect(extractFeatures({ customer: null })).toEqual({ branch: "not_found" });
  });

  test("empty conversations → no_history", () => {
    expect(extractFeatures({ customer: makeCustomer([]) })).toEqual({ branch: "no_history" });
  });

  test("very few messages → insufficient_data", () => {
    const result = extractFeatures({
      customer: makeCustomer([makeConv([makeMsg("hi"), makeMsg("hello")])]),
    });
    expect(result.branch).toBe("insufficient_data");
  });

  test("normal customer → ok with features populated", () => {
    const msgs = [
      makeMsg("I need help with my invoice payment"),
      makeMsg("The error keeps happening when I login"),
      makeMsg("Thank you for the great support"),
      makeMsg("Can you check my account settings?"),
    ];
    const result = extractFeatures({ customer: makeCustomer([makeConv(msgs)]) });
    expect(result.branch).toBe("ok");
    if (result.branch === "ok") {
      expect(result.recentUtterances.length).toBe(4);
      expect(result.scoredConversations.length).toBe(1);
    }
  });

  test("token budget caps message selection", () => {
    // Each message ~6 chars = ~2 tokens. With budget 6000, we can fit many.
    // Create messages that are very large to test budget cap.
    const bigMsg = makeMsg("x".repeat(24000)); // 6000 tokens each
    const msgs = [bigMsg, bigMsg, bigMsg];
    const result = extractFeatures({ customer: makeCustomer([makeConv(msgs)]) });
    // 3 messages * 6000 tokens = 18000 > 6000 budget, so only 1 fits
    if (result.branch === "ok") {
      expect(result.recentUtterances.length).toBe(1);
    } else {
      // With only 1 message selected, < 3, so insufficient_data
      expect(result.branch).toBe("insufficient_data");
    }
  });
});
