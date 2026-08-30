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
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import type { ScopedCapabilityHandle } from "../types/capability-broker.js";
import { BUILTIN_CAPABILITY_KEYS, RESERVED_NON_CAPABILITY_KEYS } from "../types/node.js";
import { runId as brandRunId, dagId as brandDagId } from "../types/ids.js";
import { consoleLogger, noopObserver, noopTracer } from "./defaults.js";

// Brands are erased at runtime, so every raw or already-branded string is
// revalidated at this boundary before it enters a NodeContext.

// Names a custom capability may NOT use, because the runtime guarantees them as
// named context fields: the built-in capability keys (handled explicitly in the
// `base` object below) plus the always-present non-capability infrastructure
// fields (`RESERVED_NON_CAPABILITY_KEYS`, the single source of truth shared with
// `validateCapabilities`). A same-named augmented capability spread would clobber
// framework-guaranteed infrastructure, so both groups are excluded below.
const PROTOTYPE_META_KEYS = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set<string>([
  ...BUILTIN_CAPABILITY_KEYS,
  ...RESERVED_NON_CAPABILITY_KEYS,
  ...PROTOTYPE_META_KEYS,
]);

const builtInCapability = <K extends (typeof BUILTIN_CAPABILITY_KEYS)[number]>(
  init: NodeContextInit,
  caps: NonNullable<NodeContextInit["capabilities"]>,
  key: K,
): NodeContext[K] => {
  const direct = Object.hasOwn(init, key) ? init[key] : undefined;
  const bagValue = Object.hasOwn(caps, key) ? caps[key] : null;
  return (direct !== undefined ? direct : bagValue ?? null) as NodeContext[K];
};

/** Create a null-prototype context of own data properties only. */
const contextWithOwnCapabilities = (
  base: NodeContext,
  entries: readonly (readonly [string, unknown])[],
): NodeContext => Object.setPrototypeOf(
  { ...base, ...Object.fromEntries(entries) },
  null,
);

export const makeNodeContext = (init: NodeContextInit): NodeContext => {
  // A present non-undefined top-level value wins, including explicit `null`;
  // absent or `undefined` falls back to the capabilities record.
  const caps = Object.hasOwn(init, "capabilities")
    ? init.capabilities ?? {}
    : {};

  const base = contextWithOwnCapabilities({
    runId: brandRunId(init.runId),
    dagId: brandDagId(init.dagId),
    logger: init.logger ?? consoleLogger,
    tracer: init.tracer ?? noopTracer,
    observer: init.observer ?? noopObserver,
    cache: builtInCapability(init, caps, "cache"),
    checkpointWriter: init.checkpointWriter ?? null,
    llm: builtInCapability(init, caps, "llm"),
    prompts: builtInCapability(init, caps, "prompts"),
    judgeLlm: builtInCapability(init, caps, "judgeLlm"),
    http: builtInCapability(init, caps, "http"),
    clock: builtInCapability(init, caps, "clock"),
    budget: builtInCapability(init, caps, "budget"),
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
    ...(init.contentFilter !== undefined ? { contentFilter: init.contentFilter } : {}),
  } as NodeContext, []);

  // Spread custom (non-built-in) capabilities onto the context object.
  // Built-in capabilities are already handled above. We filter against the
  // RESERVED set — built-in capability keys PLUS the always-present
  // infrastructure fields. `Capability = keyof CapabilityRegistry` is open to
  // consumer module augmentation, so a custom capability could collide with a
  // reserved name (`tracer`, `logger`, `observer`, …); without this guard the
  // own-property merge path would clobber framework-guaranteed infrastructure.
  const customEntries = Object.entries(caps).filter(
    ([k, v]) => !RESERVED_CONTEXT_KEYS.has(k) && v != null,
  );

  if (customEntries.length === 0) return base;

  return contextWithOwnCapabilities(base, customEntries);
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
 * Minted handles take precedence on collision. A non-null reserved
 * infrastructure or built-in key is a typed failure: continuing with the static
 * client would hide authority divergence. `null`/absent minted entries are
 * dropped (a broker that resolved nothing leaves the base untouched), so an
 * empty mint result returns the base context by reference inside `Ok`.
 *
 * SEAM CONTRACT with `validateCapabilities`: everything `provides()` exempts
 * from run-start validation must survive this merge. Because the guard below
 * rejects BUILT-IN capability keys, `validateCapabilities` also REJECTS a
 * broker that claims `provides()` for one. If broker-minted built-ins ever land
 * (FR-W2-009),
 * change this guard to filter only `RESERVED_NON_CAPABILITY_KEYS` in the same
 * commit that lifts that rejection.
 */
export type CapabilityMergeError = {
  readonly kind: "reserved-capability";
  readonly key: string;
};

export const mergeScopedCapabilities = (
  base: NodeContext,
  scoped: ScopedCapabilityHandle,
): Result<NodeContext, CapabilityMergeError> => {
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(scoped)) {
    if (v == null) continue;
    if (RESERVED_CONTEXT_KEYS.has(k)) {
      return err({ kind: "reserved-capability", key: k });
    }
    entries.push([k, v]);
  }
  if (entries.length === 0) return ok(base);
  return ok(contextWithOwnCapabilities(base, entries));
};
