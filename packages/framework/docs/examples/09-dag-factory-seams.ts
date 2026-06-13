// Example: DAG factory with an injected model seam (+ the clock capability).
//
// A module-scope `const dag = defineDag(...)` is untestable the moment a node
// names a model id — a test can't route it to a fake. The fix is a FACTORY that
// takes the model as an option and threads it into the LLM node:
// `createReportDag({ model })`. Production calls it with no args (a real model
// id); a test passes a fake id wired to a `FakeLlmClient`.
//
// The clock is NOT a factory seam — it is a capability. A node that needs the
// time declares `requires: ["clock"]` and reads `ctx.clock.now()`; tests pin it
// by wiring `fixedClock(at)` into `makeNodeContext`, so the run is deterministic
// without threading a `now` option through the factory (see the test).
//
// Use module-scope `defineDag` only for a DAG with NO seams (examples 01–08).

import { z } from "zod";
import {
  confidence,
  createFetchNode,
  createLlmNode,
  createTransformNode,
  defineDag,
  DAG_INPUT,
  ok,
} from "@fuguejs/framework";
import type { LlmNodeDef } from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

export interface ReportDagOpts {
  /** Model seam; defaults to a current id. Tests pass a fake id + FakeLlmClient. */
  readonly model?: string;
}

/** A current model id — see `@fuguejs/framework/docs/llm-dag-authoring.md` "Model ids". */
const DEFAULT_MODEL = "claude-sonnet-4-6";

const InputSchema = z.object({ subject: z.string() });
const EventSchema = z.object({ subject: z.string(), asOf: z.string() });
const SummarySchema = z.object({
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});
const ReportSchema = z.object({ subject: z.string(), asOf: z.string(), summary: z.string() });

// The wall clock is read through the `clock` capability — the only place time
// enters the DAG. Pure transforms stay clock-free; tests inject `fixedClock`.
const stampEvent = createFetchNode({
  id: "stamp-event",
  inputSchema: InputSchema,
  outputSchema: EventSchema,
  requires: ["clock"] as const,
  fetch: async (input, ctx) =>
    ok({ subject: input.subject, asOf: ctx.clock.now().toISOString() }),
});

// The model seam lives in the LLM node. Bucketed confidence via spread-override.
const createSummarize = (model: string): LlmNodeDef<
  z.infer<typeof EventSchema>,
  z.infer<typeof SummarySchema>
> => {
  const node = createLlmNode({
    id: "summarize",
    inputSchema: EventSchema,
    outputSchema: SummarySchema,
    promptName: "report",
    model,
    buildInput: (e) => ({ subject: e.subject, asOf: e.asOf }),
  });
  return {
    ...node,
    confidence: {
      mode: "value",
      extract: (o) => confidence(o.confidence, "self-reported-bucket"),
    },
  };
};

const AssembleFanIn = z.object({
  "stamp-event": EventSchema,
  summarize: SummarySchema,
});
const assemble = createTransformNode({
  id: "assemble",
  inputSchema: AssembleFanIn,
  outputSchema: ReportSchema,
  transform: (input) =>
    ok({
      subject: input["stamp-event"].subject,
      asOf: input["stamp-event"].asOf,
      summary: input.summarize.summary,
    }),
});

export const createReportDag = (opts: ReportDagOpts = {}) =>
  defineDag({
    id: "factory-seams-report",
    nodes: {
      "stamp-event": stampEvent,
      summarize: createSummarize(opts.model ?? DEFAULT_MODEL),
      assemble,
    },
    edges: [
      { from: DAG_INPUT, to: "stamp-event" },
      { from: "stamp-event", to: "summarize" },
      { from: "stamp-event", to: "assemble" },
      { from: "summarize", to: "assemble" },
    ],
    outputNodeId: "assemble",
  });

const registration: DagRegistration = {
  dag: createReportDag(),
  inputSchema: InputSchema,
  meta: {
    description:
      "DAG factory with an injected model seam + the clock capability — the " +
      "testable form. Production calls createReportDag() with no args.",
    version: "1.0.0",
  },
};

export default registration;
