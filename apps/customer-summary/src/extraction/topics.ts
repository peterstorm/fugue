import type { Message } from "../schemas/crm.js";

const TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  billing: ["invoice", "payment", "charge", "refund", "bill", "price", "cost", "subscription", "fee"],
  technical: ["error", "bug", "crash", "slow", "install", "update", "login", "password", "api", "integration"],
  account: ["account", "profile", "settings", "cancel", "upgrade", "downgrade", "plan"],
  shipping: ["shipping", "delivery", "tracking", "package", "order", "return", "address"],
  product: ["feature", "product", "release", "version", "documentation", "tutorial", "guide"],
  general: ["help", "question", "support", "information", "contact"],
} as const;

export const extractTopics = (messages: readonly Message[]): readonly string[] => {
  const allText = messages.map((m) => m.content.toLowerCase()).join(" ");

  const found = new Set<string>();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => allText.includes(kw))) {
      found.add(topic);
    }
  }

  return [...found].sort();
};
