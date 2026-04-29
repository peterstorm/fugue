import type { Message } from "../schemas/crm.js";

const CHARS_PER_TOKEN = 4;

const estimateTokens = (msg: Message): number =>
  Math.ceil(msg.content.length / CHARS_PER_TOKEN);

export const selectWithinBudget = (
  messages: readonly Message[],
  budgetTokens: number = 6000,
): readonly Message[] => {
  let remaining = budgetTokens;
  const selected: Message[] = [];

  // Walk from most recent backward
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i]);
    if (tokens <= remaining) {
      selected.unshift(messages[i]);
      remaining -= tokens;
    } else {
      break;
    }
  }

  return selected;
};
