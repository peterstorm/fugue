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
import type { ScopedCapabilityHandle } from "../types/capability-broker.js";
import { BUILTIN_CAPABILITY_KEYS, RESERVED_NON_CAPABILITY_KEYS } from "../types/node.js";
import { runId as brandRunId, dagId as brandDagId } from "../types/ids.js";
import type { RunId, DagId } from "../types/ids.js";
import { consoleLogger, noopObserver, noopTracer } from "./defaults.js";
import { fwLogger } from "../logger.js";

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
    clock: init.clock ?? (caps.clock as NodeContext["clock"]) ?? null,
    budget: init.budget ?? (caps.budget as NodeContext["budget"]) ?? null,
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

/**
 * Merge per-node minted capability handles over a base NodeContext, producing a
 * NEW context the node's `run` is invoked with. Used by the runtime when a
 * minting `CapabilityBroker` is wired: the broker resolves a node's declared
 * scopes into narrowed handles at dispatch, and those handles are layered over
 * the boot-scoped static client set (`http`/`db`/`llm`/…) the base context
 * already carries — broker-resolvable `"<provider>:<operation>"` names get their
 * minted handle, every plain capability keeps its static client.
 *
 * Minted handles take precedence on collision. Reserved infrastructure keys
 * (`logger`/`tracer`/…) and built-in capability keys are never overwritten — a
 * broker could only mint a key colliding with those by augmenting the registry
 * with a reserved name, which the runtime forbids elsewhere; guarding here keeps
 * the merge total and framework infrastructure intact. `null`/absent minted
 * entries are dropped (a broker that resolved nothing leaves the base untouched),
 * so an empty mint result returns the base context by reference — preserving the
 * byte-identical no-op when a node declares no broker-resolvable scopes.
 *
 * SEAM CONTRACT with `validateCapabilities`: everything `provides()` exempts
 * from run-start validation must survive this merge. Because the guard below
 * silently drops BUILT-IN capability keys, `validateCapabilities` REJECTS a
 * broker that claims `provides()` for one (a loud wiring error instead of a
 * silently-dropped handle). If broker-minted built-ins ever land (FR-W2-009),
 * change this guard to filter only `RESERVED_NON_CAPABILITY_KEYS` in the same
 * commit that lifts that rejection.
 */
export const mergeScopedCapabilities = (
  base: NodeContext,
  scoped: ScopedCapabilityHandle,
): NodeContext => {
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(scoped)) {
    if (v == null) continue;
    if (RESERVED_CONTEXT_KEYS.has(k)) {
      // A NON-NULL broker-minted entry under a reserved/built-in key is being
      // discarded. `validateCapabilities` rejects a broker that CLAIMS a
      // built-in via `provides()`, but `provides` is optional — a broker
      // without it (e.g. a passthrough constructed with a built-in key) reaches
      // this guard unannounced, and the node would silently run against the
      // static client while the embedder believes the broker's is in effect.
      // Warn (mirrors the `llm.usage-unattributed` precedent) so the wiring
      // mistake is debuggable instead of an invisible authority divergence.
      fwLogger().warn("capability.merge.dropped", {
        key: k,
        runId: base.runId as string,
        dagId: base.dagId as string,
        reason: "broker-minted entry under a reserved/built-in context key is never merged",
      });
      continue;
    }
    entries.push([k, v]);
  }
  if (entries.length === 0) return base;
  return Object.assign({}, base, Object.fromEntries(entries)) as NodeContext;
};
