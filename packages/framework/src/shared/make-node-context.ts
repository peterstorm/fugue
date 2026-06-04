// Ergonomic NodeContext constructor.
//
// `logger`, `tracer`, and `observer` are always-present non-null fields on
// NodeContext; `makeNodeContext` accepts a partial init shape and fills the
// missing always-present fields with no-op defaults. Capability fields stay
// as the caller supplied them — the runtime validates them at run start.
//
// ADR-0051: Now supports extensible capabilities via the `capabilities` record.
// Built-in capabilities can be passed either as top-level fields (backward
// compat) or in the `capabilities` record. Custom capabilities are passed
// exclusively via the `capabilities` record.

import type { NodeContext, NodeContextInit } from "../types/node.js";
import { BUILTIN_CAPABILITY_KEYS, RESERVED_NON_CAPABILITY_KEYS } from "../types/node.js";
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

// Names a custom capability may NOT use, because the runtime guarantees them as
// named context fields: the built-in capability keys (handled explicitly in the
// `base` object below) plus the always-present non-capability infrastructure
// fields (`RESERVED_NON_CAPABILITY_KEYS`, the single source of truth shared with
// `validateCapabilities`). A same-named augmented capability spread would clobber
// framework-guaranteed infrastructure, so both groups are excluded below.
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set<string>([
  ...BUILTIN_CAPABILITY_KEYS,
  ...RESERVED_NON_CAPABILITY_KEYS,
]);

export const makeNodeContext = (init: NodeContextInit): NodeContext => {
  // Merge capabilities from both top-level fields and the capabilities record.
  // Top-level fields take precedence (explicit > bag).
  const caps = init.capabilities ?? {};

  const base: NodeContext = {
    runId: asRunId(init.runId),
    dagId: asDagId(init.dagId),
    logger: init.logger ?? consoleLogger,
    tracer: init.tracer ?? noopTracer,
    observer: init.observer ?? noopObserver,
    cache: init.cache ?? (caps.cache as NodeContext["cache"]) ?? null,
    checkpointWriter: init.checkpointWriter ?? null,
    llm: init.llm ?? (caps.llm as NodeContext["llm"]) ?? null,
    prompts: init.prompts ?? (caps.prompts as NodeContext["prompts"]) ?? null,
    judgeLlm: init.judgeLlm ?? (caps.judgeLlm as NodeContext["judgeLlm"]) ?? null,
    http: init.http ?? (caps.http as NodeContext["http"]) ?? null,
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
    ...(init.contentFilter !== undefined ? { contentFilter: init.contentFilter } : {}),
  };

  // Spread custom (non-built-in) capabilities onto the context object.
  // Built-in capabilities are already handled above. We filter against the
  // RESERVED set — built-in capability keys PLUS the always-present
  // infrastructure fields. `Capability = keyof CapabilityRegistry` is open to
  // consumer module augmentation, so a custom capability could collide with a
  // reserved name (`tracer`, `logger`, `observer`, …); without this guard the
  // `Object.assign` below would clobber framework-guaranteed infrastructure.
  const customEntries = Object.entries(caps).filter(
    ([k, v]) => !RESERVED_CONTEXT_KEYS.has(k) && v != null,
  );

  if (customEntries.length === 0) return base;

  return Object.assign({}, base, Object.fromEntries(customEntries)) as NodeContext;
};
