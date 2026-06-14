// HITL smoke DAG — a refund-approval pipeline that PARKS for human review.
//
// Topology (linear): draft → review[gate] → finalize
//   - `draft`    builds a refund proposal from the input (pure).
//   - `review`   is the human-review GATE: it carries a `humanReview` config, so
//                the run SUSPENDS after this node completes and awaits a decision.
//   - `finalize` runs only AFTER the reviewer approves, marking the refund executed.
//
// This exercises the whole ADR-0060 durable suspend → decision → resume loop with
// NO Azure / Teams / bot credentials: the host's webhook notifier fires (a failure
// is non-fatal — the run still parks) and the decision is delivered over the
// authenticated HTTP API (`POST /runs/:id/approve`). See ../../README.md.
//
// The review gate uses `createHumanReviewNode` — the first-class HITL gate helper
// (a typed passthrough that pauses for a human decision). For gating a node that
// also does work, `withHumanReview(node, { prompt })` is the combinator.

import { z } from "zod";
import { defineLinearDag, createTransformNode, createHumanReviewNode, ok } from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
});

// The proposal shape under review — also the gate node's input AND output (the
// gate is an identity passthrough, so what the reviewer sees is what flows on).
const ProposalSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
  proposal: z.string(),
});

const ReceiptSchema = z.object({
  orderId: z.string(),
  status: z.literal("refund-executed"),
  proposal: z.string(),
});

const draft = createTransformNode({
  id: "draft",
  inputSchema: InputSchema,
  outputSchema: ProposalSchema,
  transform: (input) =>
    ok({
      orderId: input.orderId,
      amount: input.amount,
      proposal: `Refund $${input.amount} for order ${input.orderId}`,
    }),
});

// The GATE. The run pauses AFTER this node and the reviewer sees its output
// (`proposal`). `createHumanReviewNode` is the typed passthrough gate — one call,
// no identity-transform boilerplate.
const review = createHumanReviewNode({
  id: "review",
  schema: ProposalSchema,
  prompt: "Approve this refund? Check the amount and order id before approving.",
});

const finalize = createTransformNode({
  id: "finalize",
  inputSchema: ProposalSchema,
  outputSchema: ReceiptSchema,
  transform: (proposal) =>
    ok({
      orderId: proposal.orderId,
      status: "refund-executed" as const,
      proposal: proposal.proposal,
    }),
});

const dag = defineLinearDag({
  id: "approval-demo",
  nodes: [draft, review, finalize],
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: {
    description: "Refund approval pipeline that parks for human review (ADR-0060 smoke test).",
    version: "1.0.0",
  },
};

export default registration;
