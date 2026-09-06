// runNodeShared — single implementation of per-node execution.
// The only production caller is `dag-runtime/wave-execution.ts`; focused tests
// invoke this seam directly to pin pre-span behavior.
//
// Behavioral options:
//
//   - `checkpoint` — when provided and contains `node.id`, the node skips
//     execution, validates the cached value against `outputSchema`, emits
//     `node-skipped`, and returns the cached value.
//
// Checkpoint write: after a successful run + output validation, the node calls
// `ctx.checkpointWriter.write(runId, nodeId, output)` whenever a
// `checkpointWriter` is wired on the context. A write failure emits
// `node-error` with a `checkpoint-write-failed:` prefix and returns
// `Err({ kind: "checkpoint-write-failed" })`. No writer wired → no write;
// checkpointing is driven solely by the presence of the writer.
//
// Event shape follows the execution path: checkpoint hits emit `node-skipped`;
// input assembly/validation can fail before `node-start`; dispatched execution
// emits `node-start` followed by `node-end` or `node-error`.

import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import {
  messageOf,
  asNodeFrameworkError,
  PersistedFrameworkErrorSchema,
} from "../types/errors.js";
import { safeErrorMessage } from "../types/safe-error.js";
import type {
  Capability,
  NodeContext,
  NodeDef,
  ValidatedNodeContext,
} from "../types/node.js";
import type {
  MintingAuthority,
  ScopedLlmCapability,
  ScopedNonLlmCapability,
} from "../types/capability-broker.js";
import { invocationFor } from "../types/capability-broker.js";
import { mergeScopedCapabilities } from "../shared/make-node-context.js";
import type { NodeId, DagId } from "../types/ids.js";
import { tryLlmModelId } from "../types/llm.js";
import { emit } from "./emit.js";
import { readOwnDataProperty } from "../types/own-data.js";
import { bestEffort } from "./best-effort.js";
import { validateInput, validateOutput } from "../shared/validate.js";
import { buildNodeInput } from "../shared/build-input.js";
import { withTracedNodeSpan, EMPTY_OUTCOME, type NodeSpanOutcome } from "./node-span.js";
import { resolveContentFilter } from "../tracing/content-filter.js";
import type { IncomingSources } from "../shared/incoming.js";

const brokerContractViolation = (
  nodeId: NodeId,
  detail: string,
): FrameworkError => ({
  kind: "node-crash",
  nodeId,
  retriability: "non-retriable",
  message: `broker.mintFor violated the port contract: ${detail}`,
});

/**
 * Parse the untrusted outer capability bag without reading any capability value.
 * Opaque clients stay reference-identical; only their container is rebuilt as a
 * frozen null-prototype record of own string data properties.
 */
type CapabilityBagSnapshot = Readonly<Record<string, unknown>>;

const snapshotScopedCapabilities = (
  value: unknown,
): Result<CapabilityBagSnapshot, string> => {
  if (value === null || typeof value !== "object") {
    return err("ok(value) must contain a non-null object capability bag");
  }

  try {
    if (Array.isArray(value)) {
      return err("ok(value) must not contain an array capability bag");
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return err("capability bag keys must be strings");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        return err(`capability bag property '${key}' disappeared during inspection`);
      }
      if (!Object.hasOwn(descriptor, "value")) {
        return err(`capability bag property '${key}' must be a data property`);
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return ok(Object.freeze(snapshot));
  } catch (caught) {
    return err(`capability bag could not be inspected safely: ${safeErrorMessage(caught)}`);
  }
};

/** Parse the broker's whole Result envelope once; no hostile object escapes. */
const parseBrokerResult = (
  value: unknown,
  nodeId: NodeId,
): Result<CapabilityBagSnapshot, FrameworkError> => {
  const violation = (detail: string): Result<CapabilityBagSnapshot, FrameworkError> =>
    err(brokerContractViolation(nodeId, detail));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return violation("return value must be a Result object");
  }

  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return violation("Result keys must be strings");
    }

    const okRead = readOwnDataProperty(value, "ok");
    if (okRead === undefined) {
      return violation("Result.ok must be an own data property");
    }

    let payloadKey: "value" | "error";
    if (okRead.value === true) payloadKey = "value";
    else if (okRead.value === false) payloadKey = "error";
    else return violation("Result.ok must be exactly true or false");
    if (keys.length !== 2 || !keys.includes("ok") || !keys.includes(payloadKey)) {
      return violation(`Result must contain exactly 'ok' and '${payloadKey}'`);
    }

    const payloadRead = readOwnDataProperty(value, payloadKey);
    if (payloadRead === undefined) {
      return violation(`Result.${payloadKey} must be an own data property`);
    }

    if (payloadKey === "value") {
      const capabilities = snapshotScopedCapabilities(payloadRead.value);
      return capabilities.ok
        ? ok(capabilities.value)
        : violation(capabilities.error);
    }

    const frameworkError = PersistedFrameworkErrorSchema.safeParse(payloadRead.value);
    return frameworkError.success
      ? err(frameworkError.data)
      : violation("err(error) must contain a valid FrameworkError");
  } catch (caught) {
    return violation(`Result could not be inspected safely: ${safeErrorMessage(caught)}`);
  }
};

// The getter/proxy defence itself is `types/own-data.ts` — shared with
// `types/spend.ts`, `run-dag-stateful.ts`, and the host's request/pricing
// boundaries. Only the wording stays local: the two callers here name different
// things ("scoped binding", "Result.ok") and both wordings are observable.
const ownDataValue = (
  value: object,
  key: PropertyKey,
): Result<unknown, string> => {
  const read = readOwnDataProperty(value, key);
  return read !== undefined
    ? ok(read.value)
    : err(`scoped binding '${String(key)}' must be an own data property`);
};

const parseScopedBinding = (
  value: unknown,
): Result<ScopedNonLlmCapability<unknown> | ScopedLlmCapability, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err("scoped capability must be a tagged binding object");
  }
  try {
    const kind = ownDataValue(value, "clientKind");
    if (!kind.ok) return kind;
    const client = ownDataValue(value, "client");
    if (!client.ok || client.value == null) {
      return err("scoped binding requires a non-null own client data property");
    }
    if (kind.value === "non-llm") {
      return ok(Object.freeze({ clientKind: "non-llm", client: client.value }));
    }
    if (kind.value !== "llm") return err("scoped binding clientKind is invalid");

    const rawPricing = ownDataValue(value, "pricingModel");
    if (!rawPricing.ok || rawPricing.value === null || typeof rawPricing.value !== "object") {
      return err("LLM binding requires an own pricingModel data property");
    }
    const pricingKind = ownDataValue(rawPricing.value, "kind");
    if (!pricingKind.ok) return err("LLM pricingModel requires an own kind data property");
    let pricingModel: ScopedLlmCapability["pricingModel"];
    if (pricingKind.value === "request") {
      pricingModel = { kind: "request" };
    } else if (pricingKind.value === "fixed") {
      const model = ownDataValue(rawPricing.value, "model");
      if (!model.ok) return err("fixed LLM pricingModel requires an own model data property");
      const parsedModel = tryLlmModelId(model.value);
      if (!parsedModel.ok) return err("fixed LLM pricingModel requires a non-empty model");
      pricingModel = { kind: "fixed", model: parsedModel.value };
    } else {
      return err("LLM pricingModel is malformed");
    }

    const aliases = ownDataValue(value, "runScopedOperations");
    if (!aliases.ok) return err("LLM binding requires an own runScopedOperations map");
    const snapshot = snapshotScopedCapabilities(aliases.value);
    if (!snapshot.ok) return err(`LLM alias map is malformed: ${snapshot.error}`);
    const runScopedOperations: Record<string, "sendStructured" | "sendWithTools"> =
      Object.create(null);
    for (const [alias, operation] of Object.entries(snapshot.value)) {
      if (alias === "sendStructured" || alias === "sendWithTools") {
        return err(`LLM alias '${alias}' cannot replace a standard operation`);
      }
      if (operation !== "sendStructured" && operation !== "sendWithTools") {
        return err(`LLM alias '${alias}' names an unknown operation`);
      }
      runScopedOperations[alias] = operation;
    }

    return ok(Object.freeze({
      clientKind: "llm",
      client: client.value as ScopedLlmCapability["client"],
      pricingModel,
      runScopedOperations: Object.freeze(runScopedOperations),
    }));
  } catch (caught) {
    return err(`scoped binding could not be inspected safely: ${safeErrorMessage(caught)}`);
  }
};

const meterScopedLlmCapabilities = (
  scoped: CapabilityBagSnapshot,
  minting: MintingAuthority,
  nodeId: NodeId,
): Result<Readonly<Record<string, unknown>>, FrameworkError> => {
  const resolved: Record<string, unknown> = Object.create(null);
  try {
    for (const [key, value] of Object.entries(scoped)) {
      const parsed = parseScopedBinding(value);
      if (!parsed.ok) return err(brokerContractViolation(nodeId, parsed.error));
      if (parsed.value.clientKind === "non-llm") {
        resolved[key] = parsed.value.client;
        continue;
      }
      const decorated = minting.meterLlm(
        key as Capability,
        parsed.value,
        nodeId,
      );
      if (!decorated.ok) return decorated;
      resolved[key] = decorated.value;
    }
    return ok(Object.freeze(resolved));
  } catch (caught) {
    return err(brokerContractViolation(
      nodeId,
      `LLM metering failed across the authority boundary: ${safeErrorMessage(caught)}`,
    ));
  }
};

interface RunNodeOpts {
  /**
   * When provided and contains the node's id, the node skips execution.
   * The cached value is validated against `outputSchema` before being
   * returned (a deploy may have tightened the schema since the checkpoint
   * was written).
   */
  readonly checkpoint?: Map<string, unknown>;
  /**
   * Wall-clock source for observer-event `timestamp` fields and node duration
   * measurement. Threaded through from `DagRunOpts.now` / `RunOptions.now`;
   * defaults to `Date.now` when omitted. Tests pass a synthetic clock to make
   * event ordering deterministic.
   */
  readonly now?: () => number;
  /**
   * Per-invocation minting authority (broker + origin as one value — the
   * half-wired broker-without-origin state is unrepresentable). When wired,
   * the node's declared `requires` are resolved through `broker.mintFor` AT
   * DISPATCH — after `node-start`, only when the node actually runs (a
   * checkpoint-skipped node mints nothing) — and the minted narrowed handles
   * are merged over the base context for THIS node only. A mint refusal fails
   * the node fail-closed with the broker's error (no `run` is called).
   * Omitted ⇒ no per-node minting: the node runs against the shared base
   * context exactly as before.
   */
  readonly minting?: MintingAuthority;
}

/**
 * Resolve the node context this invocation actually runs with.
 *
 * With no broker wired this is the identity on `ctx` — the zero-regression
 * static path. With one, the node's declared `requires` are minted into handles
 * scoped to THIS node, against an `Invocation` carrying the real `nodeId` so
 * every mint/refusal audits per-node rather than run-global. Minted handles are
 * merged OVER the base context: broker-resolvable scope names get their narrowed
 * handle, plain capabilities keep their static client.
 *
 * Every failure is fail-closed and emitted before `run` is ever reached; the
 * caller only has to propagate the Err.
 */
const resolveMintedNodeContext = async (args: {
  readonly ctx: NodeContext;
  readonly node: NodeDef<unknown, unknown, FrameworkError, readonly Capability[]>;
  readonly nodeId: NodeId;
  readonly dagId: DagId;
  readonly minting: MintingAuthority | undefined;
  readonly emitNodeError: (message: string, error: FrameworkError) => void;
}): Promise<Result<NodeContext, FrameworkError>> => {
  const { ctx, node, nodeId, dagId, minting, emitNodeError } = args;
  if (!minting) return ok(ctx);

  // Derive the Invocation's origin from the authority (single construction
  // site) so the node is always minted AS the origin the authority gates
  // against — the half-consistent "origin Y on an authority-X mint" state
  // is unrepresentable here.
  const inv = invocationFor(minting, { runId: ctx.runId, dagId, nodeId });
  // Snapshot both sides of the broker claim before crossing the awaited
  // extension seam. A broker must not be able to mutate the caller-owned
  // requirements or change `provides()` answers and thereby rewrite the
  // authority proof after minting has begun.
  let requiredCapabilities: readonly Capability[];
  let brokerClaims: ReadonlySet<Capability>;
  try {
    requiredCapabilities = Object.freeze([...node.requires]);
    brokerClaims = new Set(
      requiredCapabilities.filter(
        (capability) => minting.broker.provides?.(capability) === true,
      ),
    );
  } catch (caught) {
    const violation = brokerContractViolation(
      nodeId,
      `requirements/claims snapshot threw: ${safeErrorMessage(caught)}`,
    );
    emitNodeError(`capability minting refused: ${messageOf(violation)}`, violation);
    return err(violation);
  }
  // The port contract says errors flow on the Result channel, never thrown
  // — but the broker is a public extension seam, so the contract is
  // enforced here rather than assumed. An unfenced throw would not even reach
  // the wave-level catch-all: this call sits inside the callback `node-span.ts`
  // wraps, and that wrapper's own `fn()` catch intercepts first and hardcodes
  // a RETRIABLE `node-crash` — re-firing the broker (token-endpoint egress) on
  // every retry and losing the 403/503 taxonomy.
  //
  // Why this fence classifies NON-retriable while `node-span.ts`'s outer
  // catch classifies a thrown `fn()` as RETRIABLE: the two catches sit at
  // different altitudes and know different things. `node-span` wraps the
  // whole node body, where a throw is an unclassified fault of unknown
  // origin. Here the broker violated its Result-returning port contract;
  // repeating the same invocation only repeats that deterministic
  // violation and any egress before it. A real transient broker outage must
  // be returned as typed `infra-unreachable`, which remains retriable.
  let minted: Result<CapabilityBagSnapshot, FrameworkError>;
  try {
    minted = parseBrokerResult(
      await minting.broker.mintFor(inv, requiredCapabilities),
      nodeId,
    );
  } catch (caught) {
    minted = err(brokerContractViolation(
      nodeId,
      `call/result inspection threw: ${safeErrorMessage(caught)}`,
    ));
  }
  if (!minted.ok) {
    emitNodeError(`capability minting refused: ${messageOf(minted.error)}`, minted.error);
    return err(minted.error);
  }
  // Validate the broker's authority before either metering or merge. A
  // returned key must be both declared by this node and claimed by the
  // snapshotted `provides` view; otherwise the broker could inject authority
  // the DAG never requested.
  const overdelivered = Object.keys(minted.value).filter(
    (key) =>
      !requiredCapabilities.includes(key as Capability) ||
      !brokerClaims.has(key as Capability),
  );
  if (overdelivered.length > 0) {
    const overdeliveryError = brokerContractViolation(
      nodeId,
      `returned undeclared or unclaimed capabilities: ${overdelivered.sort().join(", ")}`,
    );
    emitNodeError(
      `capability minting refused: ${messageOf(overdeliveryError)}`,
      overdeliveryError,
    );
    return err(overdeliveryError);
  }

  // Validate delivery against the broker result itself, before the static
  // base can participate in a merge. A base client must never satisfy a
  // capability that `provides()` promised to mint for this invocation.
  const undelivered = requiredCapabilities.filter(
    (cap) =>
      brokerClaims.has(cap) &&
      (!Object.hasOwn(minted.value, cap) || minted.value[cap] == null),
  );
  const [firstUndelivered, ...restUndelivered] = undelivered;
  if (firstUndelivered !== undefined) {
    const missingErr: FrameworkError = {
      kind: "missing-capability" as const,
      missing: [
        { nodeId, capability: firstUndelivered },
        ...restUndelivered.map((capability) => ({ nodeId, capability })),
      ],
    };
    emitNodeError(`broker claimed but did not deliver capabilities: ${messageOf(missingErr)}`, missingErr);
    return err(missingErr);
  }

  const metered = meterScopedLlmCapabilities(minted.value, minting, nodeId);
  if (!metered.ok) {
    emitNodeError(`capability metering refused: ${messageOf(metered.error)}`, metered.error);
    return err(metered.error);
  }

  const merged = mergeScopedCapabilities(ctx, metered.value);
  if (!merged.ok) {
    const mergeError: FrameworkError = {
      kind: "validation",
      nodeId,
      message:
        `capability broker returned non-null reserved/built-in key ` +
        `'${merged.error.key}'; static built-in authority remains authoritative`,
    };
    emitNodeError(`capability merge refused: ${messageOf(mergeError)}`, mergeError);
    return err(mergeError);
  }
  return ok(merged.value);
};

export const runNodeShared = async (
  node: NodeDef<unknown, unknown, FrameworkError, readonly Capability[]>,
  ctx: ValidatedNodeContext,
  dagId: DagId,
  outputs: ReadonlyMap<NodeId, unknown>,
  incoming: IncomingSources,
  opts: RunNodeOpts = {},
): Promise<{ result: Result<unknown, FrameworkError>; outcome: NodeSpanOutcome }> => {
  const nodeId = node.id;
  const nowFn = opts.now ?? Date.now;
  const stamp = (): Date => new Date(nowFn());

  /**
   * THE one `node-error` emission for this node. `sideEffects` is a static
   * property of the node, so it is carried on EVERY failure event; buffered
   * post-mortems can identify a writer even when input validation failed.
   */
  const emitNodeError = (
    error: string,
    frameworkError: FrameworkError,
    extra?: { readonly stack?: string },
  ): void => {
    // Fenced: `stamp()` runs `nowFn()` as an ARGUMENT, so a hostile clock throws
    // before `emit`/`dispatchEvent` is entered. Three call sites below
    // (checkpoint replay rejected, input assembly failed, input validation
    // failed) run BEFORE `withTracedNodeSpan` is entered, so its try/catch
    // cannot contain them: the throw would escape `runNodeShared` into
    // `executeWave`'s per-node catch, which would classify this node's failure
    // as a generic caught defect rather than the typed `Err` it actually is.
    // The siblings are NOT at risk here — that catch returns a per-node result
    // and `carriedOutputs` still carries their outputs (the wave-wide loss is
    // the hazard guarded at `wave-execution.ts`'s outermost fence, where an
    // escaping throw would reject `Promise.all` instead). The typed `Err`
    // returned alongside each call is the authoritative outcome
    // (`best-effort.ts`).
    bestEffort("runNodeShared", "node-error emission", () =>
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        sideEffects: node.sideEffects,
        timestamp: stamp(),
        error,
        ...(extra?.stack !== undefined ? { stack: extra.stack } : {}),
        frameworkError,
      }),
    );
  };

  // Checkpoint resume hit — validate against the current output schema and
  // return the cached value without entering a span.
  if (opts.checkpoint?.has(nodeId)) {
    const cached = opts.checkpoint.get(nodeId);
    const validated = validateOutput(node.outputSchema, cached, nodeId);
    if (!validated.ok) {
      emitNodeError(`checkpoint replay rejected: ${messageOf(validated.error)}`, validated.error);
      return { result: validated, outcome: EMPTY_OUTCOME };
    }
    // Also pre-span, also clock-in-argument: the replayed checkpoint value
    // returned below is the authoritative outcome.
    bestEffort("runNodeShared", "node-skipped emission", () =>
      emit(ctx, {
        type: "node-skipped",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: stamp(),
        reason: "checkpoint",
      }),
    );
    return { result: ok(validated.value), outcome: EMPTY_OUTCOME };
  }

  const nodeInputResult = buildNodeInput(outputs, incoming, nodeId);
  if (!nodeInputResult.ok) {
    // Same reason as the input-validation branch below: a missing required
    // source is checkpoint corruption or a framework ordering bug, and without
    // an event a buffered observer sees the node simply disappear.
    emitNodeError(`input assembly failed: ${messageOf(nodeInputResult.error)}`, nodeInputResult.error);
    return { result: nodeInputResult, outcome: EMPTY_OUTCOME };
  }
  const nodeInput = nodeInputResult.value;

  const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
  if (!inputResult.ok) {
    // Emit node-error so buffered observers don't see the node simply disappear
    // — without this, a node that fails input validation produces no event at
    // all, making post-mortems on a buffered run impossible.
    emitNodeError(`input validation failed: ${messageOf(inputResult.error)}`, inputResult.error);
    return { result: inputResult, outcome: EMPTY_OUTCOME };
  }

  return withTracedNodeSpan(nodeId, node.kind, inputResult.value, resolveContentFilter(ctx), node.sideEffects, async () => {
    const nodeStart = nowFn();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, sideEffects: node.sideEffects, timestamp: stamp() });

    // Per-invocation authority resolution (the per-node minting seam) — see
    // `resolveMintedNodeContext`. With no broker wired this is the identity on
    // `ctx`; with one, a refusal fails the node closed before `run` is called.
    const resolved = await resolveMintedNodeContext({
      ctx,
      node,
      nodeId,
      dagId,
      minting: opts.minting,
      emitNodeError,
    });
    if (!resolved.ok) return err(resolved.error);
    let runCtx: NodeContext = resolved.value;

    // Built-in nodes can emit sub-spans while executing. Bind those timestamps
    // to the same runtime clock as node-start/node-end; do not reuse the
    // node-visible ClockCapability, which is a separate domain-time seam.
    runCtx = { ...runCtx, eventTimestamp: stamp };

    let runResult: Result<unknown, FrameworkError>;
    try {
      // Capability erasure boundary: the node's `run` is typed against the
      // narrow `TypedNodeContext<R>` derived from its `requires`, but the
      // runtime carries the wide `BaseNodeContext`. Static/base capabilities
      // were proved present at run start by `validateCapabilities`; broker-
      // provided capabilities were proved by dispatch-time mint delivery and
      // reserved-key merge validation. Together those checks make this cast
      // sound — the runtime is the oracle for which fields are non-null.
      const runFn = node.run as (
        input: unknown,
        ctx: NodeContext,
      ) => Promise<Result<unknown, FrameworkError>>;
      runResult = await runFn(inputResult.value, runCtx);
    } catch (caught) {
      const frameworkError = asNodeFrameworkError(caught, nodeId);
      const message = messageOf(frameworkError);
      const stack = frameworkError.kind === "node-crash" ? frameworkError.stack : undefined;
      emitNodeError(message, frameworkError, { ...(stack !== undefined ? { stack } : {}) });
      return err(frameworkError);
    }

    if (!runResult.ok) {
      const frameworkError = asNodeFrameworkError(runResult.error, nodeId);

      const errorMsg = messageOf(frameworkError);

      emitNodeError(errorMsg, frameworkError);
      return err(frameworkError);
    }

    const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
    if (!outputResult.ok) {
      emitNodeError(`output validation failed: ${messageOf(outputResult.error)}`, outputResult.error);
      return outputResult;
    }

    if (ctx.checkpointWriter) {
      try {
        await ctx.checkpointWriter.write(ctx.runId, nodeId, outputResult.value);
      } catch (e) {
        const message = safeErrorMessage(e);
        const cpwError: FrameworkError = {
          kind: "checkpoint-write-failed" as const,
          runId: ctx.runId,
          nodeId,
          message,
        };
        emitNodeError(`checkpoint-write-failed: ${message}`, cpwError);
        return err(cpwError);
      }
    }

    const duration = nowFn() - nodeStart;
    emit(ctx, {
      type: "node-end",
      runId: ctx.runId,
      dagId,
      nodeId,
      sideEffects: node.sideEffects,
      timestamp: stamp(),
      duration,
      output: outputResult.value,
    });

    return ok(outputResult.value);
  });
};
