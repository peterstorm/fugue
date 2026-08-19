import type { SynthesisOutput } from "../schemas/summary.js";
import type { CrmRecord } from "../schemas/crm.js";
import { TOPIC_KEYWORDS } from "../extraction/topics.js";
import { POSITIVE_KEYWORDS, NEGATIVE_KEYWORDS } from "../extraction/sentiment.js";

/**
 * Grounding check result for a single dimension.
 */
type GroundingCheck = {
  readonly dimension: string;
  readonly passed: boolean;
  readonly detail: string;
};

/**
 * Aggregate grounding validation result.
 */
type GroundingResult = {
  readonly checks: readonly GroundingCheck[];
  readonly allPassed: boolean;
  readonly warnings: readonly string[];
};

// --- Grounding vocabulary: the SHARED tables (one encoding, no mirrors) ---
// `TOPIC_KEYWORDS` is owned by `extraction/topics.ts` (the extractor is the
// vocabulary's source of truth); `POSITIVE_KEYWORDS`/`NEGATIVE_KEYWORDS` by
// `extraction/sentiment.ts`. The private copies this module once kept here
// drifted from their sources — the `general` topic net in particular — and
// the guardrail scored grounding against a vocabulary the extractor no longer
// shared. Import instead of mirror: copies drift.

/** Words that are inherent to the customer support domain and always considered grounded. */
const DOMAIN_STOP_WORDS = new Set([
  "customer", "support", "service", "satisfaction", "feedback", "experience",
  "resolution", "response", "interaction", "communication", "team",
]);

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
 *
 * A topic is grounded when ANY of these hold:
 * - the topic text appears verbatim in the source text;
 * - a TOPIC_KEYWORDS entry for the topic has a keyword appearing in the source;
 * - some keyword from ANY topic group appears inside the topic string AND in the source;
 * - word-overlap: at least ONE meaningful word of the topic (length > 3, not a domain
 *   stop word) — or a stem prefix of it (>= 4 chars) — appears in the source text.
 *   There is NO majority rule: one matching word suffices regardless of how many
 *   meaningful words the topic has (pinned in grounding.test.ts).
 * - the topic's meaningful-word set is empty (every word is a DOMAIN_STOP_WORD): it
 *   always passes with zero source overlap — editing DOMAIN_STOP_WORDS changes which
 *   topics get this unconditional pass.
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
 *
 * Numeric contract (asymmetric per direction, pinned in grounding.test.ts):
 * - claiming "positive" fails when the source has MORE THAN 2x negative keywords
 *   AND at least 3 negative indicators;
 * - claiming "negative" fails when the source has MORE THAN 2x positive keywords
 *   AND at least 3 positive indicators;
 * - a neutral claim always passes; a 2x imbalance with fewer than 3 opposing
 *   indicators passes (the thresholds exist to reject noise, not single words).
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
