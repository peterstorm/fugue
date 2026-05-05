import type { DagDef } from "@ai-summary/framework";
import { createEvalJudgeNode } from "@ai-summary/framework";
import type { ConversationSource } from "../sources/conversation-source.js";
import { createFetchCustomerNode } from "./nodes/fetch-customer.js";
import { createExtractFeaturesNode } from "./nodes/extract-features.js";
import { createSynthesizeNode } from "./nodes/synthesize.js";
import { createGroundingGuardrailNode } from "./nodes/grounding-guardrail.js";
import { createAssembleResponseNode } from "./nodes/assemble-response.js";

export const createSummaryDag = (source: ConversationSource, customerId: string, model?: string, judgeModel?: string): DagDef => {
  const fetchCustomer = createFetchCustomerNode(source);
  const extractFeatures = createExtractFeaturesNode();
  const synthesize = createSynthesizeNode(model);
  const groundingGuardrail = createGroundingGuardrailNode();
  const assembleResponse = createAssembleResponseNode(customerId);

  const summaryEvalJudge = createEvalJudgeNode({
    id: "summary-quality-judge",
    criteria: ["factuality", "completeness", "relevance", "coherence"],
    threshold: 0.8,
    rubricTemplateId: "summary-eval-rubric",
    model: judgeModel,
  });

  return {
    id: "customer-summary",
    nodes: [fetchCustomer, extractFeatures, synthesize, groundingGuardrail, assembleResponse],
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
  };
};
