/**
 * Boot-scoped capability lifecycle handle.
 *
 * `clientKind` is explicit adapter intent, not runtime duck typing. Any registry
 * client assignable to `LlmClient` must be marked `"llm"`; non-LLM handles
 * cannot carry the marker. An augmented LLM subtype must declare how each
 * additional provider-operation alias maps to the standard LLM surface. The
 * host interprets that data into a facade around the authority-bearing client.
 * The distributive conditional preserves both rules after heterogeneous handles
 * widen to `CapabilityHandle[]`.
 */

import type { LlmClient, LlmPricingModel } from "./llm.js";
import type { Result } from "./result.js";
import type { CapabilityRegistry, Capability } from "./node.js";

type CapabilityHandleBase<K extends Capability> = {
  /** Capability name — must match a key in `CapabilityRegistry`. */
  readonly name: K;
  /**
   * Boot-scoped client. Non-LLM clients may be injected directly into a
   * `NodeContext`; LLM clients are transformed into run-scoped metered or
   * composed facades before injection.
   */
  readonly client: CapabilityRegistry[K];
  readonly connect?: () => Promise<void>;
  readonly close?: () => Promise<void>;
  readonly healthCheck?: () => Promise<Result<void, string>>;
  /** Handle-backed capabilities that must connect before this one. */
  readonly dependsOn?: readonly Capability[];
};

export type RunScopedLlmOperation = "sendStructured" | "sendWithTools";

type IsMutuallyAssignable<A, B> =
  [A] extends [B]
    ? [B] extends [A] ? true : false
    : false;

type RunScopedOperationFor<F> =
  IsMutuallyAssignable<F, LlmClient["sendStructured"]> extends true
    ? "sendStructured"
    : IsMutuallyAssignable<F, LlmClient["sendWithTools"]> extends true
      ? "sendWithTools"
      : never;

type HasCompatibleStandardOperations<T extends LlmClient> =
  IsMutuallyAssignable<T["sendStructured"], LlmClient["sendStructured"]> extends true
    ? IsMutuallyAssignable<T["sendWithTools"], LlmClient["sendWithTools"]>
    : false;

/**
 * Declarative aliases for an augmented LLM subtype.
 *
 * Extra fields must be operation-compatible functions. Adapters provide no
 * executable composition callback, so ignoring the metered client or closing
 * over a boot-scoped provider is not representable at this seam.
 */
export type RunScopedLlmOperations<T extends LlmClient> = {
  readonly [K in Extract<Exclude<keyof T, keyof LlmClient>, string>]:
    RunScopedOperationFor<T[K]>;
};

type LlmHandleFields<T extends LlmClient> =
  HasCompatibleStandardOperations<T> extends true
    ? [Extract<Exclude<keyof T, keyof LlmClient>, symbol>] extends [never]
      ? LlmClient extends T
        ? {
            readonly clientKind: "llm";
            readonly pricingModel: LlmPricingModel;
            readonly runScopedOperations?: never;
          }
        : {
            readonly clientKind: "llm";
            readonly pricingModel: LlmPricingModel;
            readonly runScopedOperations: RunScopedLlmOperations<T>;
          }
      : never
    : never;

type IsAny<T> = 0 extends (1 & T) ? true : false;

type UnclassifiedHandleMetadata =
  | {
      readonly clientKind?: never;
      readonly pricingModel?: never;
      readonly runScopedOperations?: never;
    }
  | {
      readonly clientKind: "llm";
      readonly pricingModel: LlmPricingModel;
      readonly runScopedOperations?: Readonly<Record<string, RunScopedLlmOperation>>;
    };

type LlmHandleMetadata<K extends Capability> =
  IsAny<CapabilityRegistry[K]> extends true
    ? UnclassifiedHandleMetadata
    : [Extract<CapabilityRegistry[K], LlmClient>] extends [never]
      ? {
          readonly clientKind?: never;
          readonly pricingModel?: never;
          readonly runScopedOperations?: never;
        }
      : [Exclude<CapabilityRegistry[K], LlmClient>] extends [never]
        ? LlmHandleFields<Extract<CapabilityRegistry[K], LlmClient>>
        : never;

export type CapabilityHandle<K extends Capability = Capability> =
  K extends Capability
    ? CapabilityHandleBase<K> & LlmHandleMetadata<K>
    : never;

/** Standard adapter factory shape. */
export type AdapterFactory<K extends Capability, C> = (
  config: C,
) => CapabilityHandle<K>;
