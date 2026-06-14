// Example: human-in-the-loop gate (ADR-0060) via `createHumanReviewNode`.
//
// A linear pipeline that PAUSES for a human decision before it completes. When
// the run reaches the gate it suspends after that node and awaits a decision —
// approve / reject / approve-with-edit / reroute — delivered by the host's HITL
// engine (the host wires `RunOptions.onHumanReview`; the DAG only declares the
// gate). Reach for this whenever a step needs sign-off before the run proceeds.
//
// `createHumanReviewNode` is the typed PASSTHROUGH gate: its `schema` is both
// input and output, so the reviewer sees (and may edit) the upstream node's
// output. To gate a node that ALSO does work — e.g. pause on an LLM draft before
// it is sent — wrap it instead: `withHumanReview(node, { prompt })`.

import { z } from "zod";
import {
  createFetchNode,
  createHumanReviewNode,
  createTransformNode,
  defineLinearDag,
  ok,
} from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({ orderId: z.string() });
const OrderSchema = z.object({ orderId: z.string(), amount: z.number() });
const RefundSchema = z.object({ orderId: z.string(), amount: z.number(), proposal: z.string() });

const fetchOrder = createFetchNode({
  id: "fetch-order",
  inputSchema: InputSchema,
  outputSchema: OrderSchema,
  fetch: async (input) => ok({ orderId: input.orderId, amount: 25 }),
});

const draftRefund = createTransformNode({
  id: "draft-refund",
  inputSchema: OrderSchema,
  outputSchema: RefundSchema,
  transform: (order) =>
    ok({
      orderId: order.orderId,
      amount: order.amount,
      proposal: `Refund $${order.amount} for order ${order.orderId}`,
    }),
});

// The gate: the run suspends after this node and the reviewer sees `draftRefund`'s
// output (the refund proposal). On approve, the DAG completes with that output.
const review = createHumanReviewNode({
  id: "review",
  schema: RefundSchema,
  prompt: "Approve this refund before it is issued? Check the amount and order id.",
});

const dag = defineLinearDag({
  id: "human-review-refund",
  nodes: [fetchOrder, draftRefund, review],
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Refund pipeline that pauses for human approval (ADR-0060 gate).", version: "1.0.0" },
};

export default registration;
