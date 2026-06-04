// Example: a node requiring the adapter-provided `documents` capability.
//
// `documents` is NOT built-in — it becomes a valid capability name because we
// import `@fuguejs/document-source` (which augments `CapabilityRegistry`). At
// deploy time the host wires an adapter (@fuguejs/fs, @fuguejs/ms-graph, …); the
// DAG never names the provider. See docs/llm-document-source.md.
//
// I/O (getContent) and parsing are deliberately separate: the capability does
// the read, a pure parser turns bytes into typed rows.

import { z } from "zod";
import { defineLinearDag, createFetchNode } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { localPathRef } from "@fuguejs/document-source";
import type { DagRegistration } from "@fuguejs/host/contract";

const InputSchema = z.object({ period: z.string() }); // e.g. "2026-Q2"
const ReportSchema = z.object({ bytes: z.number() });

const fetchReport = createFetchNode({
  id: "fetch-report",
  inputSchema: InputSchema,
  outputSchema: ReportSchema,
  requires: ["documents"] as const, // ← adapter-provided; ctx.documents is non-null
  fetch: async (
    input,
    ctx,
  ): Promise<Result<z.infer<typeof ReportSchema>, FrameworkError>> => {
    const ref = localPathRef(`${input.period}.xlsx`); // swap for sharePointPathRef in prod
    const content = await ctx.documents.getContent(ref);
    if (!content.ok) return content; // propagate FrameworkError (never throws)
    // Real DAGs parse here, e.g. `parseWorkbook(content.value, RowSchema)` from
    // @fuguejs/xlsx; this example just reports the byte count to stay dependency-light.
    return { ok: true, value: { bytes: content.value.byteLength } };
  },
});

const dag = defineLinearDag({
  id: "documents-read-report",
  nodes: [fetchReport],
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  meta: { description: "Capability (adapter): read a file via the `documents` capability, provider chosen by the host.", version: "1.0.0" },
};

export default registration;
