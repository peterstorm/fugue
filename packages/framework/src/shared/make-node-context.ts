// Ergonomic NodeContext constructor.
//
// `logger`, `tracer`, and `observer` are always-present non-null fields on
// NodeContext; `makeNodeContext` accepts a partial init shape and fills the
// missing always-present fields with no-op defaults. Capability fields stay
// as the caller supplied them — the runtime validates them at run start.

import type { NodeContext, NodeContextInit } from "../types/node.js";
import { runId as brandRunId, dagId as brandDagId } from "../types/ids.js";
import type { RunId, DagId } from "../types/ids.js";
import { consoleLogger, noopObserver, noopTracer } from "./defaults.js";

// `NodeContextInit.runId` / `.dagId` accept either a raw string (which we
// validate + brand here) or an already-branded id (passed through). Branding
// at this single boundary means every NodeContext flowing into the runtime is
// guaranteed to carry validated ids — downstream code can rely on the type.
const asRunId = (s: string | RunId): RunId =>
  typeof s === "string" ? brandRunId(s) : s;
const asDagId = (s: string | DagId): DagId =>
  typeof s === "string" ? brandDagId(s) : s;

export const makeNodeContext = (init: NodeContextInit): NodeContext => ({
  runId: asRunId(init.runId),
  dagId: asDagId(init.dagId),
  logger: init.logger ?? consoleLogger,
  tracer: init.tracer ?? noopTracer,
  observer: init.observer ?? noopObserver,
  cache: init.cache ?? null,
  checkpointWriter: init.checkpointWriter ?? null,
  llm: init.llm ?? null,
  prompts: init.prompts ?? null,
  judgeLlm: init.judgeLlm ?? null,
  ...(init.signal !== undefined ? { signal: init.signal } : {}),
  ...(init.includeContent !== undefined ? { includeContent: init.includeContent } : {}),
  ...(init.contentFilter !== undefined ? { contentFilter: init.contentFilter } : {}),
});
