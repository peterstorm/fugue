// Example: DAG factory with injected seams (clock + model).
//
// A module-scope `const dag = defineDag(...)` is untestable the moment a node
// reads the wall clock or names a model — a test can't pin either. The fix is a
// FACTORY that takes the seams as options and threads them into the nodes:
// `createReportDag({ now, model })`. Production calls it with no args (system
// clock, real model id); a test passes a fixed clock and a fake model id wired
// to a `FakeLlmClient` (see 09-dag-factory-seams.test.ts).
//
// Use module-scope `defineDag` only for a DAG with NO seams (examples 01–08).

import { z } from "zod";
import {
  confidence,
  createFetchNode,
  createLlmNode,
  createTransformNode,
  defineDag,
  ok,
} from "@fuguejs/framework";
import type { LlmNodeDef } from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

export interface ReportDagOpts {
  /** Clock seam for the `asOf` stamp; defaults to the system clock. Tests pin it. */
  readonly now?: () => Date;
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

// The clock seam lives in a fetch node — the only place the wall clock is read.
// Pure transforms stay clock-free.
const createStampEvent = (now: () => Date) =>
  createFetchNode({
    id: "stamp-event",
    inputSchema: InputSchema,
    outputSchema: EventSchema,
    fetch: async (input) => ok({ subject: input.subject, asOf: now().toISOString() }),
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
      "stamp-event": createStampEvent(opts.now ?? (() => new Date())),
      summarize: createSummarize(opts.model ?? DEFAULT_MODEL),
      assemble,
    },
    edges: [
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
      "DAG factory with injected clock + model seams — the testable form. " +
      "Production calls createReportDag() with no args.",
    version: "1.0.0",
  },
};

export default registration;
