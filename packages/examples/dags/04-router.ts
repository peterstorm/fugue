// Example: conditional routing via `defineRouter`.
//
// A classifier feeds predicate-driven cases. The `default` branch is
// *required* at the type level — that is what eliminates "else-totality"
// errors you'd otherwise have to hand-maintain with raw `defineDag`.

import { z } from "zod";
import {
  defineRouter,
  createFetchNode,
  createTransformNode,
  ok,
} from "@fugue/framework";
import type { DagRegistration } from "@fugue/host/contract";

const InputSchema = z.object({ message: z.string() });
const IntentSchema = z.object({ category: z.enum(["billing", "support", "other"]) });
const ReplySchema = z.object({ reply: z.string() });

const classify = createFetchNode({
  id: "classify",
  inputSchema: InputSchema,
  outputSchema: IntentSchema,
  fetch: async (input) =>
    ok({ category: input.message.includes("invoice") ? "billing" : "other" }),
});

const handleBilling = createTransformNode({
  id: "handle-billing",
  inputSchema: IntentSchema,
  outputSchema: ReplySchema,
  transform: () => ok({ reply: "Routed to billing." }),
});

const handleSupport = createTransformNode({
  id: "handle-support",
  inputSchema: IntentSchema,
  outputSchema: ReplySchema,
  transform: () => ok({ reply: "Routed to support." }),
});

const handleOther = createTransformNode({
  id: "handle-other",
  inputSchema: IntentSchema,
  outputSchema: ReplySchema,
  transform: () => ok({ reply: "Routed to a human." }),
});

const dag = defineRouter({
  id: "intent-router",
  classifier: classify,
  cases: {
    billing: { when: (out) => (out as z.infer<typeof IntentSchema>).category === "billing", to: handleBilling },
    support: { when: (out) => (out as z.infer<typeof IntentSchema>).category === "support", to: handleSupport },
  },
  default: handleOther, // REQUIRED
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Router: classify a message, route to billing/support, default to a human.", version: "1.0.0" },
};

export default registration;
