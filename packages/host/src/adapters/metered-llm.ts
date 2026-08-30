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
  const facade = Object.create(Object.getPrototypeOf(inner)) as object;
  return new Proxy(facade, {
    get(_target, property) {
      if (property === "sendStructured") return sendStructured;
      if (property === "sendWithTools") return sendWithTools;
      const value = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      const cached = boundMethods.get(value);
      if (cached !== undefined) return cached;
      const bound = value.bind(inner);
      boundMethods.set(value, bound);
      return bound;
    },
    set: (_target, property, value) => Reflect.set(inner, property, value, inner),
  }) as T;
};
