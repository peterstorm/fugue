import type { Conversation } from "../schemas/crm.js";

export type ScoredConversation = {
  readonly conversation: Conversation;
  readonly score: number;
};

const MS_PER_DAY = 86_400_000;
const HALF_LIFE_DAYS = 30;

export const scoreByRecency = (
  conversations: readonly Conversation[],
  now: Date = new Date(),
): readonly ScoredConversation[] => {
  const nowMs = now.getTime();

  return conversations
    .map((conversation) => {
      const daysSince = Math.max(0, (nowMs - new Date(conversation.date).getTime()) / MS_PER_DAY);
      const score = Math.exp(-daysSince / HALF_LIFE_DAYS);
      return { conversation, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score);
};
