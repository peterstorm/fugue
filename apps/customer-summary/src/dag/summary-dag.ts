import type { DagDef } from "@ai-summary/framework";
import type { ConversationSource } from "../sources/conversation-source.js";
import { createFetchCustomerNode } from "./nodes/fetch-customer.js";
import { createExtractFeaturesNode } from "./nodes/extract-features.js";
import { createSynthesizeNode } from "./nodes/synthesize.js";
import { createAssembleResponseNode } from "./nodes/assemble-response.js";

export const createSummaryDag = (source: ConversationSource, customerId: string, model?: string): DagDef => {
  const fetchCustomer = createFetchCustomerNode(source);
  const extractFeatures = createExtractFeaturesNode();
  const synthesize = createSynthesizeNode(model);
  const assembleResponse = createAssembleResponseNode(customerId);

  return {
    id: "customer-summary",
    nodes: [fetchCustomer, extractFeatures, synthesize, assembleResponse],
    edges: [
      { from: "fetch-crm", to: "extract-features" },
      { from: "extract-features", to: "synthesize" },
      { from: "extract-features", to: "assemble-response" },
      { from: "synthesize", to: "assemble-response" },
    ],
  };
};
