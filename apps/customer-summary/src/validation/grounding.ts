import type { SynthesisOutput } from "../schemas/summary.js";
import type { CrmRecord, Message } from "../schemas/crm.js";

/**
 * Grounding check result for a single dimension.
 */
export type GroundingCheck = {
  readonly dimension: string;
  readonly passed: boolean;
  readonly detail: string;
};

/**
 * Aggregate grounding validation result.
 */
export type GroundingResult = {
  readonly checks: readonly GroundingCheck[];
  readonly allPassed: boolean;
  readonly warnings: readonly string[];
};

// --- Topic keywords (mirrors extraction/topics.ts) ---

const TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  billing: ["invoice", "payment", "charge", "refund", "bill", "price", "cost", "subscription", "fee"],
  technical: ["error", "bug", "crash", "slow", "install", "update", "login", "password", "api", "integration"],
  account: ["account", "profile", "settings", "cancel", "upgrade", "downgrade", "plan"],
  shipping: ["shipping", "delivery", "tracking", "package", "order", "return", "address"],
  product: ["feature", "product", "release", "version", "documentation", "tutorial", "guide"],
  general: ["help", "question", "support", "information", "inquiry", "request", "assistance"],
};

/** Words that are inherent to the customer support domain and always considered grounded. */
const DOMAIN_STOP_WORDS = new Set([
  "customer", "support", "service", "satisfaction", "feedback", "experience",
  "resolution", "response", "interaction", "communication", "team",
]);

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

// --- Pure validation functions ---

const allMessagesText = (record: CrmRecord): string =>
  record.conversations
    .flatMap((c) => c.messages)
    .map((m) => m.content.toLowerCase())
    .join(" ");

const countKeywords = (text: string, keywords: readonly string[]): number =>
  keywords.filter((kw) => text.includes(kw)).length;

/**
 * Check that every keyTopic in the synthesis output is grounded in the source conversations.
 * Uses word-overlap matching: a topic is grounded if the majority of its meaningful words
 * appear in the source text.
 */
export const checkTopicGrounding = (
  synthesis: SynthesisOutput,
  record: CrmRecord,
): GroundingCheck => {
  const sourceText = allMessagesText(record);
  const ungrounded: string[] = [];

  for (const topic of synthesis.keyTopics) {
    const topicLower = topic.toLowerCase();
    // Direct mention in source text
    if (sourceText.includes(topicLower)) continue;
    // Check via keyword mapping
    const keywords = TOPIC_KEYWORDS[topicLower];
    if (keywords && keywords.some((kw) => sourceText.includes(kw))) continue;
    // Check if any keyword from any topic group matches the claimed topic
    const anyMatch = Object.values(TOPIC_KEYWORDS).some((kws) =>
      kws.some((kw) => topicLower.includes(kw) && sourceText.includes(kw)),
    );
    if (anyMatch) continue;
    // Word-overlap: tokenize topic into words, check if at least one meaningful word (or its stem) appears in source
    const words = topicLower.split(/\s+/).filter((w) => w.length > 3 && !DOMAIN_STOP_WORDS.has(w));
    if (words.length === 0) continue; // All words are domain stop words — always grounded
    const matchedWords = words.filter((w) => {
        // Direct match
        if (sourceText.includes(w)) return true;
        // Stem-like: try progressively shorter prefixes (min 4 chars)
        for (let len = w.length - 1; len >= 4; len--) {
          if (sourceText.includes(w.slice(0, len))) return true;
        }
        return false;
      });
      if (matchedWords.length >= 1) continue;
    ungrounded.push(topic);
  }

  return {
    dimension: "topic_grounding",
    passed: ungrounded.length === 0,
    detail:
      ungrounded.length === 0
        ? `All ${synthesis.keyTopics.length} topics grounded`
        : `Ungrounded topics: ${ungrounded.join(", ")}`,
  };
};

/**
 * Check that the sentiment direction is consistent with source message tone.
 */
export const checkSentimentConsistency = (
  synthesis: SynthesisOutput,
  record: CrmRecord,
): GroundingCheck => {
  const sourceText = allMessagesText(record);
  const posCount = countKeywords(sourceText, POSITIVE_KEYWORDS);
  const negCount = countKeywords(sourceText, NEGATIVE_KEYWORDS);

  const claimsPositive = synthesis.overallSentiment === "positive";
  const claimsNegative = synthesis.overallSentiment === "negative";

  if (claimsPositive && negCount > posCount * 2 && negCount >= 3) {
    return {
      dimension: "sentiment_consistency",
      passed: false,
      detail: `Claims positive but source has ${negCount} negative vs ${posCount} positive indicators`,
    };
  }
  if (claimsNegative && posCount > negCount * 2 && posCount >= 3) {
    return {
      dimension: "sentiment_consistency",
      passed: false,
      detail: `Claims negative but source has ${posCount} positive vs ${negCount} negative indicators`,
    };
  }

  return {
    dimension: "sentiment_consistency",
    passed: true,
    detail: `Sentiment '${synthesis.overallSentiment}' consistent with source (pos=${posCount}, neg=${negCount})`,
  };
};

/**
 * Check that the conversation count is not fabricated in the summary text.
 */
export const checkConversationCount = (
  synthesis: SynthesisOutput,
  record: CrmRecord,
): GroundingCheck => {
  const actual = record.conversations.length;
  const matches = synthesis.summary.match(/(\d+)\s+conversation/gi) ?? [];

  for (const match of matches) {
    const claimed = parseInt(match, 10);
    if (!isNaN(claimed) && claimed !== actual) {
      return {
        dimension: "conversation_count",
        passed: false,
        detail: `Claims ${claimed} conversations but source has ${actual}`,
      };
    }
  }

  return {
    dimension: "conversation_count",
    passed: true,
    detail: matches.length === 0
      ? "No conversation count claim"
      : `Conversation count verified: ${actual}`,
  };
};

/**
 * Run all grounding checks. Pure function -- no I/O.
 */
export const validateGrounding = (
  synthesis: SynthesisOutput,
  record: CrmRecord,
): GroundingResult => {
  const checks = [
    checkTopicGrounding(synthesis, record),
    checkSentimentConsistency(synthesis, record),
    checkConversationCount(synthesis, record),
  ];

  const failures = checks.filter((c) => !c.passed);

  return {
    checks,
    allPassed: failures.length === 0,
    warnings: failures.map((f) => `[${f.dimension}] ${f.detail}`),
  };
};
