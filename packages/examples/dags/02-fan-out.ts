// Example: fan-out with a join via `defineFanOut`.
//
// One source feeds N parallel branches that run concurrently; an optional
// `join` node fans them back in. The join receives a fan-in object keyed by
// each branch's id (see "Input Wiring Rules" in docs/llm-dag-authoring.md).

import { z } from "zod";
import {
  defineFanOut,
  createFetchNode,
  createTransformNode,
  ok,
} from "@fugue/framework";
import type { DagRegistration } from "@fugue/host/contract";

const InputSchema = z.object({ customerId: z.string() });
const CustomerSchema = z.object({ customerId: z.string() });
const CrmSchema = z.object({ tier: z.string() });
const BillingSchema = z.object({ balance: z.number() });

const trigger = createFetchNode({
  id: "trigger",
  inputSchema: InputSchema,
  outputSchema: CustomerSchema,
  fetch: async (input) => ok({ customerId: input.customerId }),
});

const fetchCrm = createFetchNode({
  id: "fetch-crm",
  inputSchema: CustomerSchema,
  outputSchema: CrmSchema,
  fetch: async () => ok({ tier: "gold" }),
});

const fetchBilling = createFetchNode({
  id: "fetch-billing",
  inputSchema: CustomerSchema,
  outputSchema: BillingSchema,
  fetch: async () => ok({ balance: 0 }),
});

// The join node sees both branches keyed by their node ids.
const FanInSchema = z.object({
  "fetch-crm": CrmSchema,
  "fetch-billing": BillingSchema,
});
const ProfileSchema = z.object({ tier: z.string(), balance: z.number() });

const merge = createTransformNode({
  id: "merge",
  inputSchema: FanInSchema,
  outputSchema: ProfileSchema,
  transform: (fanIn) =>
    ok({ tier: fanIn["fetch-crm"].tier, balance: fanIn["fetch-billing"].balance }),
});

const dag = defineFanOut({
  id: "enrich-customer",
  source: trigger,
  branches: [fetchCrm, fetchBilling],
  join: merge,
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Fan-out: enrich a customer from CRM + billing in parallel, then merge.", version: "1.0.0" },
};

export default registration;
