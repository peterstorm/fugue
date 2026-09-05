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
  tryLlmModelId,
  tryNodeId,
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
import {
  isObjectLike,
  type MeteredLlmOperation,
  type MeteredRequest,
  type RunSpendAuthority,
} from "./run-spend-authority.js";

const requestBoundaryError = (message: string): FrameworkError => ({
  kind: "validation",
  nodeId: EXECUTOR_NODE_ID,
  message: `LLM request boundary: ${message}`,
});

const snapshotDataObject = (
  value: unknown,
  label: string,
): Result<Readonly<Record<PropertyKey, unknown>>, FrameworkError> => {
  if (!isObjectLike(value)) {
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

const snapshotDataArray = (
  value: unknown,
  label: string,
): Result<readonly unknown[], FrameworkError> => {
  try {
    if (!Array.isArray(value)) {
      return err(requestBoundaryError(`${label} must be an array`));
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      return err(requestBoundaryError(`${label}.length must be an own data property`));
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      return err(requestBoundaryError(`${label}.length must be a non-negative safe integer`));
    }
    const keys = Reflect.ownKeys(descriptors);
    const hasOnlyCanonicalIndices = keys.every((key) => {
      if (key === "length") return true;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const index = Number(key);
      return Number.isSafeInteger(index) && index < length;
    });
    if (keys.length !== length + 1 || !hasOnlyCanonicalIndices) {
      return err(requestBoundaryError(`${label} must be a dense own-data array`));
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        return err(requestBoundaryError(`${label}[${index}] must be an own data property`));
      }
      snapshot.push(descriptor.value);
    }
    return ok(Object.freeze(snapshot));
  } catch {
    return err(requestBoundaryError(`${label} could not be inspected safely`));
  }
};

const requiredData = (
  source: Readonly<Record<PropertyKey, unknown>>,
  key: PropertyKey,
): Result<unknown, FrameworkError> =>
  Object.hasOwn(source, key)
    ? ok(source[key])
    : err(requestBoundaryError(`request.${String(key)} is required`));

/**
 * `label` names the offending path so a tool schema rejection is not reported
 * as a top-level `request.schema` failure, and so callers can propagate the
 * specific reason (not an object / no safeParse / not inspectable) verbatim.
 */
const parseSchema = (
  value: unknown,
  label = "request.schema",
): Result<unknown, FrameworkError> => {
  if (!isObjectLike(value)) {
    return err(requestBoundaryError(`${label} must be a schema object`));
  }
  try {
    return typeof Reflect.get(value, "safeParse") === "function"
      ? ok(value)
      : err(requestBoundaryError(`${label} must expose safeParse`));
  } catch {
    return err(requestBoundaryError(`${label} could not be inspected safely`));
  }
};

const parseThinking = (value: unknown): Result<unknown, FrameworkError> => {
  const parsed = snapshotDataObject(value, "request.thinking");
  if (!parsed.ok) return parsed;
  const thinking = parsed.value;
  return Reflect.ownKeys(thinking).length === 2 &&
      thinking.type === "enabled" &&
      Number.isSafeInteger(thinking.budgetTokens) &&
      (thinking.budgetTokens as number) > 0
    ? parsed
    : err(requestBoundaryError(
        "request.thinking must be exactly enabled with positive safe-integer budgetTokens",
      ));
};

const parseCache = (
  value: unknown,
  allowConversation: boolean,
): Result<unknown, FrameworkError> => {
  const parsed = snapshotDataObject(value, "request.cache");
  if (!parsed.ok) return parsed;
  const cache = parsed.value;
  const keys = Reflect.ownKeys(cache);
  if (cache.kind === "none" && keys.length === 1) return parsed;
  const allowedKind = cache.kind === "static-prefix" ||
    (allowConversation && cache.kind === "conversation");
  return allowedKind && keys.length === 2 && (cache.ttl === "5m" || cache.ttl === "1h")
    ? parsed
    : err(requestBoundaryError("request.cache is not a valid cache policy"));
};

const parseTool = (value: unknown, index: number): Result<unknown, FrameworkError> => {
  const label = `request.tools[${index}]`;
  const parsed = snapshotDataObject(value, label);
  if (!parsed.ok) return parsed;
  const tool = parsed.value;
  const expected = ["name", "description", "inputSchema", "outputSchema", "run"] as const;
  const keys = Reflect.ownKeys(tool);
  if (keys.length !== expected.length || keys.some(
    (key) => typeof key !== "string" || !expected.includes(key as typeof expected[number]),
  )) {
    return err(requestBoundaryError(`${label} must contain exactly ${expected.join(", ")}`));
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    return err(requestBoundaryError(`${label}.name must be a non-empty string`));
  }
  if (typeof tool.description !== "string" || typeof tool.run !== "function") {
    return err(requestBoundaryError(`${label} requires a string description and function run`));
  }
  const inputSchema = parseSchema(tool.inputSchema, `${label}.inputSchema`);
  if (!inputSchema.ok) return inputSchema;
  const outputSchema = parseSchema(tool.outputSchema, `${label}.outputSchema`);
  if (!outputSchema.ok) return outputSchema;
  return parsed;
};

type RequestKind = "structured" | "tools";

const snapshotRequest = <T extends LlmRequest<unknown> | SendWithToolsRequest<unknown>>(
  request: T,
  kind: RequestKind,
): Result<T, FrameworkError> => {
  const outer = snapshotDataObject(request, "request");
  if (!outer.ok) return outer;
  const source = outer.value;
  const replacements = new Map<PropertyKey, unknown>();

  for (const key of ["system", "user", "model"] as const) {
    const value = requiredData(source, key);
    if (!value.ok) return value;
    if (typeof value.value !== "string" || (key === "model" && value.value.length === 0)) {
      return err(requestBoundaryError(
        `request.${key} must be ${key === "model" ? "a non-empty string" : "a string"}`,
      ));
    }
  }

  const rawNodeId = requiredData(source, "nodeId");
  if (!rawNodeId.ok) return rawNodeId;
  if (typeof rawNodeId.value !== "string") {
    return err(requestBoundaryError("request.nodeId must be a string"));
  }
  const parsedNodeId = tryNodeId(rawNodeId.value);
  if (!parsedNodeId.ok) return err(requestBoundaryError(`request.nodeId invalid: ${parsedNodeId.error}`));
  replacements.set("nodeId", parsedNodeId.value);

  const rawSchema = requiredData(source, "schema");
  if (!rawSchema.ok) return rawSchema;
  const schema = parseSchema(rawSchema.value);
  if (!schema.ok) return schema;

  if (source.thinking !== undefined) {
    const thinking = parseThinking(source.thinking);
    if (!thinking.ok) return thinking;
    replacements.set("thinking", thinking.value);
  }
  if (source.cache !== undefined) {
    const cache = parseCache(source.cache, kind === "tools");
    if (!cache.ok) return cache;
    replacements.set("cache", cache.value);
  }
  if (source.signal !== undefined &&
      (typeof source.signal !== "object" || source.signal === null)) {
    return err(requestBoundaryError("request.signal must be an object when present"));
  }

  if (kind === "structured") {
    if (source.temperature !== undefined &&
        (typeof source.temperature !== "number" ||
          !Number.isFinite(source.temperature) ||
          source.temperature < 0 ||
          source.temperature > 1)) {
      return err(requestBoundaryError("request.temperature must be finite and between 0 and 1"));
    }
    if (source.tracer !== undefined && source.tracer !== null &&
        (typeof source.tracer !== "object" || source.tracer === null)) {
      return err(requestBoundaryError("request.tracer must be an object or null when present"));
    }
  } else {
    const rawTools = requiredData(source, "tools");
    if (!rawTools.ok) return rawTools;
    const tools = snapshotDataArray(rawTools.value, "request.tools");
    if (!tools.ok) return tools;
    const parsedTools: unknown[] = [];
    for (const [index, tool] of tools.value.entries()) {
      const parsed = parseTool(tool, index);
      if (!parsed.ok) return parsed;
      parsedTools.push(parsed.value);
    }
    replacements.set("tools", Object.freeze(parsedTools));

    if (source.maxIterations !== undefined &&
        (!Number.isSafeInteger(source.maxIterations) || (source.maxIterations as number) <= 0)) {
      return err(requestBoundaryError("request.maxIterations must be a positive safe integer"));
    }
    if (source.deadlineMs !== undefined &&
        (typeof source.deadlineMs !== "number" ||
          !Number.isFinite(source.deadlineMs) ||
          source.deadlineMs <= 0)) {
      return err(requestBoundaryError("request.deadlineMs must be a positive finite number"));
    }
    if (source.toolChoice !== undefined &&
        source.toolChoice !== "auto" && source.toolChoice !== "any" && source.toolChoice !== "none") {
      return err(requestBoundaryError("request.toolChoice must be auto, any, or none"));
    }
  }

  const snapshot: Record<PropertyKey, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(source)) {
    Object.defineProperty(snapshot, key, {
      value: replacements.has(key) ? replacements.get(key) : source[key],
      enumerable: Object.prototype.propertyIsEnumerable.call(source, key),
      configurable: false,
      writable: false,
    });
  }
  return ok(Object.freeze(snapshot) as T);
};

const snapshotStructuredRequest = <O>(
  request: LlmRequest<O>,
): Result<LlmRequest<O>, FrameworkError> =>
  snapshotRequest(request, "structured") as Result<LlmRequest<O>, FrameworkError>;

const snapshotToolsRequest = <O>(
  request: SendWithToolsRequest<O>,
): Result<SendWithToolsRequest<O>, FrameworkError> =>
  snapshotRequest(request, "tools") as Result<SendWithToolsRequest<O>, FrameworkError>;

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
    const model = tryLlmModelId(dataValue("model"));
    if (model.ok) return Object.freeze({ kind: "fixed", model: model.value });
  }
  throw new TypeError("LLM pricing model must be exactly request or fixed with a non-empty model");
};

export const createMeteredLlm = (
  inner: LlmClient,
  clientKey: Capability,
  authority: RunSpendAuthority,
  pricingModel: LlmPricingModel,
): LlmClient => {
  const boundPricingModel = snapshotPricingModel(pricingModel);

  /**
   * The one path from a caller's request to the inner client: snapshot first,
   * then dispatch the SNAPSHOT through the authority. Both operations route
   * here so neither can grow a way to reach `inner` without being metered, and
   * so a failed snapshot always short-circuits to the typed `Err` rather than
   * an unmetered call.
   */
  const dispatch = <O, Req extends MeteredRequest<O>>(
    operation: MeteredLlmOperation,
    snapshot: Result<Req, FrameworkError>,
    call: (request: Req) => Promise<Result<LlmResponse<O>, FrameworkError>>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    snapshot.ok
      ? authority.execute({
          clientKey,
          operation,
          pricingModel: boundPricingModel,
          request: snapshot.value,
          call: () => call(snapshot.value),
        })
      : Promise.resolve(snapshot);

  return Object.freeze({
    sendStructured: <O>(
      req: LlmRequest<O>,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
      dispatch(
        "sendStructured",
        snapshotStructuredRequest(req),
        (request) => inner.sendStructured(request),
      ),

    sendWithTools: <O>(
      req: SendWithToolsRequest<O>,
      ctx: NodeContext,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
      dispatch(
        "sendWithTools",
        snapshotToolsRequest(req),
        (request) => inner.sendWithTools(request, ctx),
      ),
  });
};
