import { describe, test, expect } from "bun:test";
import { scoreByRecency } from "../extraction/recency.js";
import type { Conversation } from "../schemas/crm.js";

const conv = (date: string): Conversation => ({
  id: date,
  date,
  channel: "chat",
  messages: [{ role: "customer", content: "hi", timestamp: date }],
});

describe("scoreByRecency", () => {
  const now = new Date("2025-06-01T00:00:00Z");

  test("more recent conversations score higher", () => {
    const result = scoreByRecency(
      [conv("2025-01-01"), conv("2025-05-30"), conv("2025-03-15")],
      now,
    );
    expect(result[0].conversation.date).toBe("2025-05-30");
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  test("scoring is monotonic", () => {
    const result = scoreByRecency(
      [conv("2025-01-01"), conv("2025-02-01"), conv("2025-03-01"), conv("2025-04-01"), conv("2025-05-01")],
      now,
    );
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
    }
  });
});
