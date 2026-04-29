import { z } from "zod";

export const SynthesisOutputSchema = z.object({
  overallSentiment: z.enum(["positive", "negative", "neutral", "mixed"]),
  sentimentScore: z.number().min(-1).max(1),
  keyTopics: z.array(z.string()).min(1),
  summary: z.string(),
  actionItems: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
  customerSatisfaction: z.enum(["satisfied", "neutral", "dissatisfied", "unknown"]),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;
