/**
 * Transparent LlmClient decorator. All mutable accounting, enforcement,
 * logging, and ledger sequencing live in the shared `RunSpendAuthority`; this
 * module only intercepts the two provider-call operations. Every other runtime
 * property remains available on the original subtype with `inner` as receiver.
 */

import type {
  Capability,
  FrameworkError,
  LlmClient,
  LlmRequest,
  LlmResponse,
  NodeContext,
  Result,
  SendWithToolsRequest,
} from "@fuguejs/framework";
import type { RunSpendAuthority } from "./run-spend-authority.js";

export const createMeteredLlm = <T extends LlmClient>(
  inner: T,
  clientKey: Capability,
  authority: RunSpendAuthority,
): T => {
  const sendStructured: LlmClient["sendStructured"] = <O>(
    req: LlmRequest<O>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    authority.execute({
      clientKey,
      operation: "sendStructured",
      request: req,
      call: () => inner.sendStructured(req),
    });

  const sendWithTools: LlmClient["sendWithTools"] = <O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    authority.execute({
      clientKey,
      operation: "sendWithTools",
      request: req,
      call: () => inner.sendWithTools(req, ctx),
    });

  // Calling a class method with the Proxy as `this` breaks private fields and
  // receiver-sensitive accessors. Cache target-bound delegates so subtype-only
  // methods retain both correct receiver semantics and stable identity.
  const boundMethods = new WeakMap<Function, Function>();
  const read = (property: PropertyKey): unknown => {
    if (property === "sendStructured") return sendStructured;
    if (property === "sendWithTools") return sendWithTools;
    const value = Reflect.get(inner, property, inner);
    if (typeof value !== "function") return value;
    const cached = boundMethods.get(value);
    if (cached !== undefined) return cached;
    const bound = value.bind(inner);
    boundMethods.set(value, bound);
    return bound;
  };

  // The facade stays extensible even when `inner` is frozen. Proxy invariants
  // therefore permit reporting inner-owned keys, but descriptors for properties
  // absent from the facade must remain configurable. Their observable flags and
  // receiver-safe values still mirror the subtype.
  const compatibleDescriptor = (
    property: PropertyKey,
  ): PropertyDescriptor | undefined => {
    const descriptor = Reflect.getOwnPropertyDescriptor(inner, property);
    if (descriptor === undefined) return undefined;
    if ("value" in descriptor) {
      return {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: read(property),
      };
    }
    return {
      configurable: true,
      enumerable: descriptor.enumerable,
      ...(descriptor.get !== undefined
        ? { get: () => Reflect.get(inner, property, inner) }
        : {}),
      ...(descriptor.set !== undefined
        ? { set: (value: unknown) => { Reflect.set(inner, property, value, inner); } }
        : {}),
    };
  };

  const facade = Object.create(Object.getPrototypeOf(inner)) as object;
  return new Proxy(facade, {
    get: (_target, property) => read(property),
    set: (_target, property, value) => Reflect.set(inner, property, value, inner),
    has: (_target, property) => Reflect.has(inner, property),
    ownKeys: () => Reflect.ownKeys(inner),
    getOwnPropertyDescriptor: (_target, property) => compatibleDescriptor(property),
    // A non-configurable facade property would have to exist on the Proxy target
    // with an invariant-compatible value, which is impossible for intercepted
    // provider methods. Refuse before mutating `inner`; configurable additions
    // remain reflectively forwarded.
    defineProperty: (_target, property, descriptor) =>
      descriptor.configurable === true && Reflect.defineProperty(inner, property, descriptor),
    deleteProperty: (_target, property) => Reflect.deleteProperty(inner, property),
    // Let neither Object.preventExtensions nor Object.freeze put the facade into
    // a state where forwarding newly-added inner keys would violate ownKeys.
    preventExtensions: () => false,
  }) as T;
};
