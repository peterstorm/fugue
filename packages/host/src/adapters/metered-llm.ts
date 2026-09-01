/**
 * Narrow run-scoped `LlmClient` decorator.
 *
 * All mutable accounting, enforcement, logging, and ledger sequencing live in
 * the shared `RunSpendAuthority`; this module exposes only the two standard
 * provider operations and delegates both through that authority. It deliberately
 * does not proxy subtype methods: an augmented capability declares aliases in
 * `CapabilityHandle.runScopedOperations`, and the host binds them to this
 * metered surface so provider aliases cannot self-call behind the budget gate.
 */

import {
  EXECUTOR_NODE_ID,
  err,
  ok,
  type Capability,
  type FrameworkError,
  type LlmClient,
  type LlmPricingModel,
  type LlmRequest,
  type LlmResponse,
  type NodeContext,
  type Result,
  type SendWithToolsRequest,
} from "@fuguejs/framework";
import type { RunSpendAuthority } from "./run-spend-authority.js";

const requestBoundaryError = (message: string): FrameworkError => ({
  kind: "validation",
  nodeId: EXECUTOR_NODE_ID,
  message: `LLM request boundary: ${message}`,
});

const snapshotDataObject = (
  value: unknown,
  label: string,
): Result<unknown, FrameworkError> => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return err(requestBoundaryError(`${label} must be an object`));
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const snapshot: Record<PropertyKey, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        return err(requestBoundaryError(`${label}.${String(key)} must be an own data property`));
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: false,
        writable: false,
      });
    }
    return ok(Object.freeze(snapshot));
  } catch {
    return err(requestBoundaryError(`${label} could not be inspected safely`));
  }
};

const snapshotRequest = <T extends object>(
  request: T,
  requiredKeys: readonly PropertyKey[],
  nestedKeys: readonly PropertyKey[],
  arrayKeys: readonly PropertyKey[],
): Result<T, FrameworkError> => {
  const outer = snapshotDataObject(request, "request");
  if (!outer.ok) return outer;
  const source = outer.value as Record<PropertyKey, unknown>;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(source, key)) {
      return err(requestBoundaryError(`request.${String(key)} is required`));
    }
  }

  const snapshot: Record<PropertyKey, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(source)) {
    let value = source[key];
    if (value !== undefined && nestedKeys.includes(key)) {
      const nested = snapshotDataObject(value, `request.${String(key)}`);
      if (!nested.ok) return nested;
      value = nested.value;
    } else if (value !== undefined && arrayKeys.includes(key)) {
      if (!Array.isArray(value)) {
        return err(requestBoundaryError(`request.${String(key)} must be an array`));
      }
      value = Object.freeze([...value]);
    }
    Object.defineProperty(snapshot, key, {
      value,
      enumerable: Object.prototype.propertyIsEnumerable.call(source, key),
      configurable: false,
      writable: false,
    });
  }
  return ok(Object.freeze(snapshot) as T);
};

const snapshotStructuredRequest = <O>(
  request: LlmRequest<O>,
): Result<LlmRequest<O>, FrameworkError> => snapshotRequest(
  request,
  ["system", "user", "model", "schema", "nodeId"],
  ["thinking", "cache"],
  [],
);

const snapshotToolsRequest = <O>(
  request: SendWithToolsRequest<O>,
): Result<SendWithToolsRequest<O>, FrameworkError> => snapshotRequest(
  request,
  ["system", "user", "model", "tools", "schema", "nodeId"],
  ["thinking", "cache"],
  ["tools"],
);

/** Own the deployment's pricing identity before issuing a run-scoped client. */
const snapshotPricingModel = (pricingModel: LlmPricingModel): LlmPricingModel => {
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(pricingModel) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new TypeError("LLM pricing model could not be inspected safely");
  }

  const keys = Reflect.ownKeys(descriptors);
  const hasExactly = (expected: readonly string[]): boolean =>
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key));
  const dataValue = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`LLM pricing model ${key} must be an own data property`);
    }
    return descriptor.value;
  };

  const kind = dataValue("kind");
  if (kind === "request" && hasExactly(["kind"])) {
    return Object.freeze({ kind: "request" });
  }
  if (kind === "fixed" && hasExactly(["kind", "model"])) {
    const model = dataValue("model");
    if (typeof model === "string") return Object.freeze({ kind: "fixed", model });
  }
  throw new TypeError("LLM pricing model must be exactly request or fixed with a string model");
};

export const createMeteredLlm = (
  inner: LlmClient,
  clientKey: Capability,
  authority: RunSpendAuthority,
  pricingModel: LlmPricingModel,
): LlmClient => {
  const boundPricingModel = snapshotPricingModel(pricingModel);
  return Object.freeze({
    sendStructured: <O>(
      req: LlmRequest<O>,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
      const request = snapshotStructuredRequest(req);
      return request.ok
        ? authority.execute({
            clientKey,
            operation: "sendStructured",
            pricingModel: boundPricingModel,
            request: request.value,
            call: () => inner.sendStructured(request.value),
          })
        : Promise.resolve(request);
    },

    sendWithTools: <O>(
      req: SendWithToolsRequest<O>,
      ctx: NodeContext,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
      const request = snapshotToolsRequest(req);
      return request.ok
        ? authority.execute({
            clientKey,
            operation: "sendWithTools",
            pricingModel: boundPricingModel,
            request: request.value,
            call: () => inner.sendWithTools(request.value, ctx),
          })
        : Promise.resolve(request);
    },
  });
};
