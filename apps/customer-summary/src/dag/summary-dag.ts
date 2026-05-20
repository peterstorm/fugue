import type { DagDef } from "@ai-summary/framework";
import { createEvalJudgeNode, defineDag } from "@ai-summary/framework";
import type { ConversationSource } from "../sources/conversation-source.js";
import { createFetchCustomerNode } from "./nodes/fetch-customer.js";
import { createExtractFeaturesNode } from "./nodes/extract-features.js";
import { createSynthesizeNode } from "./nodes/synthesize.js";
import { createGroundingGuardrailNode } from "./nodes/grounding-guardrail.js";
import { createAssembleResponseNode } from "./nodes/assemble-response.js";

export interface SummaryDagOpts {
  readonly model?: string;
  readonly judgeModel?: string;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /** Override the synthesize-node system prompt (e.g., loaded via the prompt registry). */
  readonly synthesisSystemPrompt?: string;
}

export const createSummaryDag = (
  source: ConversationSource,
  customerId: string,
  opts: SummaryDagOpts = {},
): DagDef => {
  const fetchCustomer = createFetchCustomerNode(source);
  const extractFeatures = createExtractFeaturesNode();
  const synthesize = createSynthesizeNode(opts.model, {
    thinking: opts.thinking,
    systemPrompt: opts.synthesisSystemPrompt,
  });
  const groundingGuardrail = createGroundingGuardrailNode();
  const assembleResponse = createAssembleResponseNode(customerId);

  const summaryEvalJudge = createEvalJudgeNode({
    id: "summary-quality-judge",
    criteria: ["factuality", "completeness", "relevance", "coherence"],
    threshold: 0.8,
    rubric: { source: "template", templateId: "summary-eval-rubric" },
    model: opts.judgeModel,
  });

  return defineDag({
    id: "customer-summary",
    nodes: {
      "fetch-crm": fetchCustomer,
      "extract-features": extractFeatures,
      "synthesize": synthesize,
      "grounding-guardrail": groundingGuardrail,
      "assemble-response": assembleResponse,
    },
    edges: [
      { from: "fetch-crm", to: "extract-features" },
      { from: "extract-features", to: "synthesize" },
      { from: "synthesize", to: "grounding-guardrail" },
      { from: "fetch-crm", to: "grounding-guardrail" },
      { from: "extract-features", to: "assemble-response" },
      { from: "grounding-guardrail", to: "assemble-response" },
    ],
    outputNodeId: "assemble-response",
    evalJudges: [summaryEvalJudge],
  });
};
