import type { Message } from "../schemas/crm.js";

export type SentimentMarker = {
  readonly messageIndex: number;
  readonly sentiment: "positive" | "negative" | "neutral";
  readonly keywords: readonly string[];
};

const POSITIVE_KEYWORDS = [
  "thank", "thanks", "great", "excellent", "awesome", "good", "love",
  "happy", "pleased", "wonderful", "fantastic", "perfect", "appreciate",
  "helpful", "satisfied", "amazing",
] as const;

const NEGATIVE_KEYWORDS = [
  "terrible", "awful", "bad", "worst", "hate", "angry", "frustrated",
  "disappointed", "unacceptable", "horrible", "poor", "annoying",
  "broken", "failure", "useless", "complaint",
] as const;

const findKeywords = (text: string, keywords: readonly string[]): string[] => {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw));
};

export const analyzeSentiment = (messages: readonly Message[]): readonly SentimentMarker[] =>
  messages.map((msg, messageIndex) => {
    const positive = findKeywords(msg.content, POSITIVE_KEYWORDS);
    const negative = findKeywords(msg.content, NEGATIVE_KEYWORDS);

    const sentiment: SentimentMarker["sentiment"] =
      positive.length > negative.length
        ? "positive"
        : negative.length > positive.length
          ? "negative"
          : "neutral";

    return {
      messageIndex,
      sentiment,
      keywords: [...positive, ...negative],
    };
  });
