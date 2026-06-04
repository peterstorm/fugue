// Example: linear pipeline (A → B → C) via `defineLinearDag`.
//
// The simplest topology: each node feeds the next. Edges are inferred from
// array order; the last node is the output. Reach for this whenever the work
// is a straight sequence with no branching.

import { z } from "zod";
import {
  defineLinearDag,
  createFetchNode,
  createTransformNode,
  ok,
} from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({ orderId: z.string() });
const OrderSchema = z.object({ orderId: z.string(), total: z.number() });
const ReceiptSchema = z.object({ receipt: z.string() });

const fetchOrder = createFetchNode({
  id: "fetch-order",
  inputSchema: InputSchema,
  outputSchema: OrderSchema,
  fetch: async (input) => ok({ orderId: input.orderId, total: 42 }),
});

const formatReceipt = createTransformNode({
  id: "format-receipt",
  inputSchema: OrderSchema,
  outputSchema: ReceiptSchema,
  transform: (order) => ok({ receipt: `Order ${order.orderId}: $${order.total}` }),
});

const dag = defineLinearDag({
  id: "linear-receipt",
  nodes: [fetchOrder, formatReceipt],
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Linear pipeline: fetch an order, format a receipt.", version: "1.0.0" },
};

export default registration;
