const PRICE_TABLE: Record<string, { readonly inputPer1M: number; readonly outputPer1M: number }> = {
  // Anthropic
  "claude-sonnet-4-20250514": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-20250514": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-sonnet-20240229": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o-2024-11-20": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "gpt-5-mini": { inputPer1M: 0.3, outputPer1M: 1.25 },
};

export { PRICE_TABLE };

export function computeCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const entry = PRICE_TABLE[model];
  if (!entry) {
    console.warn(`[cost] Unknown model "${model}", returning cost 0`);
    return 0;
  }
  return (tokensIn * entry.inputPer1M + tokensOut * entry.outputPer1M) / 1_000_000;
}
