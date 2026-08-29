/**
 * Boot-scoped capability lifecycle handle.
 *
 * `clientKind` is explicit adapter intent, not runtime duck typing. Any registry
 * client assignable to `LlmClient` must be marked `"llm"`; non-LLM handles
 * cannot carry the marker. The distributive conditional preserves that rule
 * after heterogeneous handles widen to `CapabilityHandle[]`.
 */

import type { LlmClient } from "./llm.js";
import type { Result } from "./result.js";
import type { CapabilityRegistry, Capability } from "./node.js";

type CapabilityHandleBase<K extends Capability> = {
  /** Capability name — must match a key in `CapabilityRegistry`. */
  readonly name: K;
  /** The boot-scoped client injected into `NodeContext`. */
  readonly client: CapabilityRegistry[K];
  readonly connect?: () => Promise<void>;
  readonly close?: () => Promise<void>;
  readonly healthCheck?: () => Promise<Result<void, string>>;
  /** Handle-backed capabilities that must connect before this one. */
  readonly dependsOn?: readonly Capability[];
};

export type CapabilityHandle<K extends Capability = Capability> =
  K extends Capability
    ? CapabilityHandleBase<K> &
        (CapabilityRegistry[K] extends LlmClient
          ? { readonly clientKind: "llm" }
          : { readonly clientKind?: never })
    : never;

/** Standard adapter factory shape. */
export type AdapterFactory<K extends Capability, C> = (
  config: C,
) => CapabilityHandle<K>;
