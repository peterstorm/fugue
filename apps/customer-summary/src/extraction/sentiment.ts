import type { Message } from "../schemas/crm.js";

type SentimentMarker = {
  readonly messageIndex: number;
  readonly sentiment: "positive" | "negative" | "neutral";
  readonly keywords: readonly string[];
};

/** Shared with the grounding guardrail (`validation/grounding.ts`) — one encoding, no private mirrors. */
export const POSITIVE_KEYWORDS = [
  "thank", "thanks", "great", "excellent", "awesome", "good", "love",
  "happy", "pleased", "wonderful", "fantastic", "perfect", "appreciate",
  "helpful", "satisfied", "amazing",
] as const;

export const NEGATIVE_KEYWORDS = [
  "terrible", "awful", "bad", "worst", "hate", "angry", "frustrated",
  "disappointed", "unacceptable", "horrible", "poor", "annoying",
  "broken", "failure", "useless", "complaint",
] as const;

const findKeywords = (text: string, keywords: readonly string[]): string[] => {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw));
};

/** Whichever side has more keyword hits wins; a tie is neutral. */
const sentimentOf = (positive: number, negative: number): SentimentMarker["sentiment"] => {
  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
};

export const analyzeSentiment = (messages: readonly Message[]): readonly SentimentMarker[] =>
  messages.map((msg, messageIndex) => {
    const positive = findKeywords(msg.content, POSITIVE_KEYWORDS);
    const negative = findKeywords(msg.content, NEGATIVE_KEYWORDS);

    const sentiment = sentimentOf(positive.length, negative.length);

    return {
      messageIndex,
      sentiment,
      keywords: [...positive, ...negative],
    };
  });
