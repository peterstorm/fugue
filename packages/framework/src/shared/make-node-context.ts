// Ergonomic NodeContext constructor.
//
// `logger`, `tracer`, and `observer` are always-present non-null fields on
// NodeContext; `makeNodeContext` accepts a partial init shape and fills the
// missing always-present fields with no-op defaults. Capability fields stay
// as the caller supplied them — the runtime validates them at run start.

import type { NodeContext, NodeContextInit } from "../types/node.js";
import { consoleLogger, noopObserver, noopTracer } from "./defaults.js";

export const makeNodeContext = (init: NodeContextInit): NodeContext => ({
  runId: init.runId,
  dagId: init.dagId,
  logger: init.logger ?? consoleLogger,
  tracer: init.tracer ?? noopTracer,
  observer: init.observer ?? noopObserver,
  cache: init.cache ?? null,
  llm: init.llm ?? null,
  prompts: init.prompts ?? null,
  judgeLlm: init.judgeLlm ?? null,
  ...(init.signal !== undefined ? { signal: init.signal } : {}),
  ...(init.includeContent !== undefined ? { includeContent: init.includeContent } : {}),
});
