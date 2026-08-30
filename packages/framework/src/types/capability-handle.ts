/**
 * Boot-scoped capability lifecycle handle.
 *
 * `clientKind` is explicit adapter intent, not runtime duck typing. Any registry
 * client assignable to `LlmClient` must be marked `"llm"`; non-LLM handles
 * cannot carry the marker. An augmented LLM subtype must also author a
 * run-scoped composition hook: the host supplies the metered standard surface,
 * and the hook builds the subtype facade around that authority-bearing client.
 * The distributive conditional preserves both rules after heterogeneous handles
 * widen to `CapabilityHandle[]`.
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

export type RunScopedLlmComposer<T extends LlmClient> = (
  metered: LlmClient,
) => T;

type LlmHandleMetadata<K extends Capability> =
  CapabilityRegistry[K] extends LlmClient
    ? LlmClient extends CapabilityRegistry[K]
      ? {
          readonly clientKind: "llm";
          /** Optional for the exact standard surface; required for strict subtypes. */
          readonly composeRunClient?: RunScopedLlmComposer<LlmClient>;
        }
      : {
          readonly clientKind: "llm";
          readonly composeRunClient: RunScopedLlmComposer<CapabilityRegistry[K]>;
        }
    : {
        readonly clientKind?: never;
        readonly composeRunClient?: never;
      };

export type CapabilityHandle<K extends Capability = Capability> =
  K extends Capability
    ? CapabilityHandleBase<K> & LlmHandleMetadata<K>
    : never;

/** Standard adapter factory shape. */
export type AdapterFactory<K extends Capability, C> = (
  config: C,
) => CapabilityHandle<K>;
