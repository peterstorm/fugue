// Example: diamond (fan-out + required fan-in) via `defineDiamond`.
//
// Like `defineFanOut`, but the `join` is *required* — the topology always
// reconverges. Use this when downstream work genuinely needs every branch's
// result (vs. fan-out, where the join is optional).

import { z } from "zod";
import {
  defineDiamond,
  createFetchNode,
  createTransformNode,
  ok,
} from "@fugue/framework";
import type { DagRegistration } from "@fugue/host/contract";

const InputSchema = z.object({ docId: z.string() });
const DocSchema = z.object({ docId: z.string(), text: z.string() });
const SummarySchema = z.object({ summary: z.string() });
const KeywordsSchema = z.object({ keywords: z.array(z.string()) });

const loadDoc = createFetchNode({
  id: "load-doc",
  inputSchema: InputSchema,
  outputSchema: DocSchema,
  fetch: async (input) => ok({ docId: input.docId, text: "lorem ipsum" }),
});

const summarize = createTransformNode({
  id: "summarize",
  inputSchema: DocSchema,
  outputSchema: SummarySchema,
  transform: (doc) => ok({ summary: doc.text.slice(0, 10) }),
});

const extractKeywords = createTransformNode({
  id: "extract-keywords",
  inputSchema: DocSchema,
  outputSchema: KeywordsSchema,
  transform: (doc) => ok({ keywords: doc.text.split(" ") }),
});

const FanInSchema = z.object({
  summarize: SummarySchema,
  "extract-keywords": KeywordsSchema,
});
const ReportSchema = z.object({ summary: z.string(), keywords: z.array(z.string()) });

const assemble = createTransformNode({
  id: "assemble",
  inputSchema: FanInSchema,
  outputSchema: ReportSchema,
  transform: (fanIn) =>
    ok({ summary: fanIn.summarize.summary, keywords: fanIn["extract-keywords"].keywords }),
});

const dag = defineDiamond({
  id: "analyze-doc",
  source: loadDoc,
  branches: [summarize, extractKeywords],
  join: assemble,
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Diamond: load a doc, summarize + extract keywords in parallel, assemble.", version: "1.0.0" },
};

export default registration;
